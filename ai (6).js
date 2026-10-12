// The AI step: shopper photo + product photo -> a polished photo of the shopper (or pet) wearing the product.
// Uses Google Gemini image models, then a quick AI quality check; a bad result is regenerated once.
import { safeFetch } from './net.js';
import crypto from 'node:crypto';

// Vertex AI login with a service-account JSON key (paste the whole JSON into GOOGLE_SA_JSON)
let SA = null;
try { if (process.env.GOOGLE_SA_JSON) SA = JSON.parse(process.env.GOOGLE_SA_JSON); } catch { console.error('[tryon] GOOGLE_SA_JSON is not valid JSON'); }
// Bridge running inside Google Cloud (see cloud-function/): set VERTEX_PROXY_URL + VERTEX_PROXY_KEY
const PROXY = process.env.VERTEX_PROXY_URL || '';
const KEY = PROXY ? 'proxy' : (process.env.GEMINI_API_KEY || (SA ? 'service-account' : ''));
// GEMINI_VERTEX=1 sends everything through Google Cloud Vertex AI (works with Google Cloud free-trial credits)
const VERTEX = process.env.GEMINI_VERTEX === '1' || !!SA;
const LOCATION = process.env.GEMINI_LOCATION || 'global';
let tok = { value: '', exp: 0 };
async function accessToken() {
  if (tok.value && tok.exp > Date.now() + 60e3) return tok.value;
  const now = Math.floor(Date.now() / 1000);
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const head = b64({ alg: 'RS256', typ: 'JWT' });
  const claim = b64({ iss: SA.client_email, scope: 'https://www.googleapis.com/auth/cloud-platform', aud: 'https://oauth2.googleapis.com/token', iat: now, exp: now + 3600 });
  const sig = crypto.createSign('RSA-SHA256').update(`${head}.${claim}`).sign(SA.private_key, 'base64url');
  const r = await fetch(process.env.GOOGLE_TOKEN_URL || 'https://oauth2.googleapis.com/token', {
    method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${head}.${claim}.${sig}` }),
  });
  const j = await r.json().catch(() => ({}));
  if (!j.access_token) { const e = new Error('Google login failed: ' + (j.error_description || j.error || r.status)); e.status = 403; throw e; }
  tok = { value: j.access_token, exp: Date.now() + (j.expires_in || 3600) * 1000 };
  return tok.value;
}
const BASE = process.env.GEMINI_BASE || (VERTEX ? 'https://aiplatform.googleapis.com' : 'https://generativelanguage.googleapis.com');
// Model ladders, best first. A model that is unavailable (404) is skipped automatically.
const LADDER = {
  standard: (process.env.GEMINI_MODELS || 'gemini-3.1-flash-image-preview,gemini-2.5-flash-image').split(',').map((s) => s.trim()).filter(Boolean),
  premium: (process.env.GEMINI_PREMIUM_MODELS || 'gemini-3-pro-image-preview,gemini-3.1-flash-image-preview,gemini-2.5-flash-image').split(',').map((s) => s.trim()).filter(Boolean),
};
const QC_MODEL = process.env.GEMINI_QC_MODEL || 'gemini-2.5-flash';
const QC_ON = process.env.TRYON_QC !== '0';
export const MOCK = !KEY || process.env.TRYON_MOCK === '1';
const dead = new Set(); // models Google said do not exist for this key

const sharp = null; // image re-compression disabled to keep the build simple

const RATIOS = { '1:1': 1, '4:5': 0.8, '3:4': 0.75, '2:3': 0.667, '9:16': 0.5625, '5:4': 1.25, '4:3': 1.333, '3:2': 1.5, '16:9': 1.778 };
export function nearestRatio(w, h) {
  const r = w && h ? w / h : 0.8;
  return Object.entries(RATIOS).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}

// Width/height straight from the file header (PNG, JPEG, WebP)
export function imageSize(buf) {
  try {
    if (buf[0] === 0x89 && buf.toString('ascii', 1, 4) === 'PNG') return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    if (buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') {
      const t = buf.toString('ascii', 12, 16);
      if (t === 'VP8X') return { w: 1 + buf.readUIntLE(24, 3), h: 1 + buf.readUIntLE(27, 3) };
      if (t === 'VP8 ') return { w: buf.readUInt16LE(26) & 0x3fff, h: buf.readUInt16LE(28) & 0x3fff };
      if (t === 'VP8L') { const b = buf.readUInt32LE(21); return { w: (b & 0x3fff) + 1, h: ((b >> 14) & 0x3fff) + 1 }; }
    }
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      let i = 2;
      while (i < buf.length) {
        if (buf[i] !== 0xff) { i++; continue; }
        const m = buf[i + 1];
        if (m >= 0xc0 && m <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(m)) return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
        i += 2 + buf.readUInt16BE(i + 2);
      }
    }
  } catch {}
  return null;
}

// ---------------- instructions to the AI ----------------
const PLACE = {
  necklace: 'around the neck, resting naturally on the collarbone and chest, with the chain following the neck and the pendant hanging by gravity',
  earrings: 'on the earlobes (both ears where visible), hanging naturally',
  ring: 'on a finger of a visible hand; if no hand is visible, raise one hand naturally to the chin or collarbone so the ring shows',
  bracelet: 'on a visible wrist; if no wrist is visible, raise one hand naturally so the wrist shows',
  watch: 'on a visible wrist; if no wrist is visible, raise one hand naturally so the wrist shows',
};
const GARMENT = {
  top: 'Dress them in this top; keep plain, neutral bottoms that do not compete with it.',
  bottom: 'Dress them in this bottom; keep a plain, neutral top that does not compete with it.',
  dress: 'Dress them in this dress.',
  outerwear: 'Dress them in this outerwear piece over a plain neutral outfit.',
};
const PET_FIT = {
  harness: 'a harness: straps around the chest and behind the front legs, buckles closed, sitting snugly on the body',
  collar: 'a collar: around the neck, sitting snugly',
  leash: 'a collar and leash: collar around the neck, leash clipped on and hanging naturally',
  apparel: 'a garment (coat/jacket/vest/suit): the neck opening around the neck, the body panel wrapped around the torso and following its curves, straps or belly band fastened under the chest, leg openings around the legs, correct size for this dog',
};
const RULES = 'Image 2 may show the product on a model, mannequin or another animal, or on its own; take ONLY the product from it and ignore whoever is wearing it. Reproduce the product exactly: design, colour, fabric/material, pattern, trims, reflective details, logos on the product, hardware and proportions. It must look physically worn — wrapping around the body in 3D with correct perspective, folds, contact shadows and occlusion — never a flat cut-out, sticker or floating overlay. Do not add text, watermarks, borders, extra items or extra limbs. Return only the photo.';

export function buildPrompt({ category, sub, title, name, species }) {
  if (category === 'pet') {
    // The prompt that produced the original PetFit demo, word for word, plus which image is which
    const animal = species === 'cat' ? 'cat' : 'dog';
    return `Image 1 is a studio photo of the ${animal}${name ? ` (${name})` : ''}. Image 2 is the product "${title}" (${PET_FIT[sub] ? sub : 'apparel'}).
Show this exact ${animal} wearing this exact product. Keep the ${animal}'s breed, fur color, markings and face identical. Keep the product's exact color, pattern and logo. Natural photo, clean light background, product clearly visible, product catalogue style, the ${animal}'s full body in frame.
Keep the same pose, camera angle, background, lighting and framing as image 1.
If image 2 shows the product on another animal, use only the product. If image 2 shows several items or colour options together (a flat-lay or bundle), pick the single most prominent one${sub === 'leash' ? ' (one collar with its matching leash)' : ''} and use only that. The product must be properly worn and fitted, not pasted on. Always return an image.`;
  }
  if (category === 'jewellery') {
    const place = PLACE[sub] || 'where this piece is naturally worn';
    return `Edit image 1 so the person is wearing the jewellery from image 2 ("${title}", ${sub || 'jewellery'}).
Place it ${place}. Remove any similar jewellery already worn in that spot.
Keep the person exactly the same: face, identity, skin, hair, expression, clothing, background, lighting and framing. Keep the jewellery's real-life scale on the body, with true metal colour, stones and sparkle, and natural reflections and shadows on the skin.
${RULES}`;
  }
  return `Image 1 is a studio photo of a person. Image 2 is the product "${title}" (${sub || 'clothing'}).
Show this exact same person — identical face, identity, skin tone, hair, body shape and proportions — wearing this item, fitted naturally to their body with realistic drape, folds and seams. ${GARMENT[sub] || ''}
Image 1 is already a clean studio photo: keep its pose, camera angle, background, lighting and framing exactly, and change only the clothing.
${RULES}`;
}

// ---------------- product image cache (1 hour) ----------------
const imgCache = new Map();
function sizedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'cdn.shopify.com' || u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', '1024');
    return u.href;
  } catch { return url; }
}
export async function loadProductImage(url) {
  const hit = imgCache.get(url);
  if (hit && hit.t > Date.now() - 3600e3) return hit;
  const r = await safeFetch(sizedUrl(url), { headers: { Accept: 'image/jpeg,image/png,image/webp' } }, 12_000_000, true);
  if (!r.ok) throw new Error('Product image unavailable');
  let buf = r.buffer;
  let mime = (r.contentType.split(';')[0] || '').trim();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
    mime = buf[0] === 0x89 ? 'image/png' : buf[0] === 0xff ? 'image/jpeg' : (buf.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : '');
    if (!mime && sharp) { buf = await sharp(buf).jpeg({ quality: 90 }).toBuffer(); mime = 'image/jpeg'; }
    if (!mime) throw new Error('Unsupported product image format');
  }
  const v = { t: Date.now(), mime, data: buf.toString('base64'), size: imageSize(buf) };
  imgCache.set(url, v);
  if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
  return v;
}

// ---------------- Google calls ----------------
async function post(model, body, ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  try {
    if (PROXY) {
      const r = await fetch(PROXY, {
        method: 'POST', signal: ctrl.signal,
        headers: { 'Content-Type': 'application/json', 'x-proxy-key': process.env.VERTEX_PROXY_KEY || '' },
        body: JSON.stringify({ model, body }),
      });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) { const e = new Error(j.error?.message || 'AI error ' + r.status); e.status = r.status; throw e; }
      return j;
    }
    const url = SA
      ? `${BASE}/v1/projects/${SA.project_id}/locations/${LOCATION}/publishers/google/models/${model}:generateContent`
      : VERTEX
        ? `${BASE}/v1/publishers/google/models/${model}:generateContent?key=${encodeURIComponent(KEY)}`
        : `${BASE}/v1beta/models/${model}:generateContent`;
    const auth = SA ? { Authorization: 'Bearer ' + await accessToken() } : { 'x-goog-api-key': KEY };
    const r = await fetch(url, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', ...auth },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || 'AI error ' + r.status); e.status = r.status; throw e; }
    return j;
  } finally { clearTimeout(timer); }
}

async function callImage(model, prompt, images, ratio) {
  const j = await post(model, {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      ...images.map((im) => ({ inline_data: { mime_type: im.mime, data: im.data } })),
    ] }],
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio } },
  }, 120_000);
  // Newer models can return draft "thought" images first; the final image is the last non-thought one.
  const parts = (j.candidates?.[0]?.content?.parts || []).filter((p) => (p.inlineData || p.inline_data) && !p.thought);
  const img = parts[parts.length - 1];
  if (!img) {
    const e = new Error('AI returned no image (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown') + ')');
    e.status = 422; throw e;
  }
  const d = img.inlineData || img.inline_data;
  return { mime: d.mimeType || d.mime_type || 'image/png', data: d.data };
}

// Ask a fast text model to look at the result like a picky art director.
async function qualityCheck({ product, result, category, sub, item }) {
  if (!QC_ON) return { ok: true };
  const subject = category === 'pet' ? 'the same animal' : 'the person';
  const what = category === 'jewellery' ? `the ${sub || 'jewellery'}` : 'the product';
  try {
    const j = await post(QC_MODEL, {
      contents: [{ role: 'user', parts: [
        { text: `Image 1 is a product photo. Image 2 is an AI-generated photo that should show ${subject} wearing ${what} from image 1, realistically.${item ? ` The product to check is: ${item.slice(0, 400)} (other items in image 1 are not required).` : ''}
Reply as JSON {"ok": boolean, "problem": string}. Set ok=false only for a clear failure: the product is missing or a different product; it looks pasted on, flat, floating or misaligned instead of worn; it is clearly the wrong size or position on the body; or the body/face/animal is distorted (extra or missing limbs, warped face). Minor colour or lighting differences are fine. "problem" is one short sentence (empty if ok).` },
        { inline_data: { mime_type: product.mime, data: product.data } },
        { inline_data: { mime_type: result.mime, data: result.data } },
      ] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0 },
    }, 30_000);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const v = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    return { ok: v.ok !== false, problem: String(v.problem || '').slice(0, 200) };
  } catch (e) {
    console.error('[tryon] quality check skipped:', String(e.message).slice(0, 160));
    return { ok: true };
  }
}


// ---------------- Product brief: understand THIS product, then write a prompt for it ----------------
// A fast vision model studies the product photo once and writes product-specific directions
// (which single item to use, exactly how it is worn, what its materials should look like, what to avoid).
// The result is cached, so each product is analysed only once.
const briefCache = new Map();
const BRIEF_ON = process.env.TRYON_BRIEF !== '0';

export async function analyzeProduct({ product, title, category, sub, species }) {
  if (!BRIEF_ON || MOCK) return null;
  const key = crypto.createHash('md5').update(`${category}|${sub}|${title}|`).update(product.data.slice(0, 20000)).digest('hex');
  const hit = briefCache.get(key);
  if (hit) return hit;
  const wearer = category === 'pet' ? (species === 'cat' ? 'a cat' : 'a dog') : 'a person';
  const ask = `You are the creative director for a premium e-commerce photo shoot. The attached image is a product photo for "${title}" (shop category: ${category}${sub ? ', ' + sub : ''}). An image AI will later be given a photo of ${wearer} plus this product photo, and must make a believable, authentic catalogue photo of ${wearer} wearing this product.
Study the product photo carefully and reply as JSON with these fields:
"item": the ONE item to put on (if the photo shows several items, colours or a bundle, choose the main one, or the matching set that is clearly sold together). Describe it precisely: type, exact colours, material and finish (e.g. matte leather, brushed gold, ribbed knit), hardware, stitching, logos/tags, size and any distinctive details.
"ignore": anything in the photo that must NOT be copied (other colour options, packaging, props, a model or animal wearing it, text). Empty if nothing.
"wear": exactly where and how it is worn on ${wearer}: placement, how it is fastened, how it sits or drapes, tension, fit and scale relative to the body, which parts are hidden behind the body or fur/hair/skin.
"realism": 3-4 concrete details that make this specific product look real in a photo (how its material catches light, creases, weight, contact shadows, fur/fabric compression, reflections on skin).
"avoid": the 2-3 most likely mistakes an image AI would make with THIS product.
"sub": one word for what it really is (e.g. harness, collar, leash, coat, sweater, necklace, ring, earrings, bracelet, dress, top, trousers).
Write plain, specific sentences. No marketing language.`;
  try {
    const j = await post(QC_MODEL, {
      contents: [{ role: 'user', parts: [{ text: ask }, { inline_data: { mime_type: product.mime, data: product.data } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }, 30_000);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const b = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    const clean = (v) => String(Array.isArray(v) ? v.join(' ') : v || '').replace(/\s+/g, ' ').trim().slice(0, 900);
    const brief = { item: clean(b.item), ignore: clean(b.ignore), wear: clean(b.wear), realism: clean(b.realism), avoid: clean(b.avoid), sub: clean(b.sub).toLowerCase().slice(0, 30) };
    if (!brief.item || !brief.wear) return null;
    briefCache.set(key, brief);
    if (briefCache.size > 2000) briefCache.delete(briefCache.keys().next().value);
    console.log(`[tryon] product brief for "${title}": ${brief.item.slice(0, 120)}`);
    return brief;
  } catch (e) {
    console.error('[tryon] product brief skipped:', String(e.message).slice(0, 160));
    return null;
  }
}

// The fixed parts (who must stay identical) never change; the product parts come from the brief.
export function promptFromBrief({ brief, category, title, name, species }) {
  const lines = [];
  if (category === 'pet') {
    const animal = species === 'cat' ? 'cat' : 'dog';
    lines.push(`Image 1 is a studio photo of the ${animal}${name ? ` (${name})` : ''}. Image 2 is a product photo of "${title}".`);
    lines.push(`Make a natural, believable product-catalogue photo of this exact ${animal} wearing the product. Keep the ${animal}'s breed, size, body shape, fur colour, markings, face, eyes and ears identical. Keep the same pose, camera angle, background, lighting and framing as image 1, with the ${animal}'s full body in frame.`);
  } else if (category === 'jewellery') {
    lines.push(`Edit image 1 so the person is wearing the jewellery shown in image 2 ("${title}").`);
    lines.push('Keep the person exactly the same: face, identity, skin, hair, expression, clothing, background, lighting and framing. Remove any similar jewellery already worn in that spot. Keep true real-life scale.');
  } else {
    lines.push(`Image 1 is a studio photo of a person. Image 2 is a product photo of "${title}".`);
    lines.push('Show this exact same person - identical face, identity, skin tone, hair, body shape and proportions - wearing this item. Keep the pose, camera angle, background, lighting and framing of image 1 exactly, and change only the clothing needed for this item.');
  }
  lines.push(`THE PRODUCT: ${brief.item}`);
  if (brief.ignore) lines.push(`Do not copy from image 2: ${brief.ignore}`);
  lines.push(`HOW IT IS WORN: ${brief.wear}`);
  lines.push(`MAKE IT LOOK REAL: ${brief.realism}`);
  if (brief.avoid) lines.push(`AVOID: ${brief.avoid}`);
  lines.push('Reproduce the product exactly (colour, material, pattern, hardware, logos). It must be physically worn in 3D with correct perspective, contact shadows and occlusion - never a flat cut-out, sticker or floating overlay. Only the product described above, nothing else added, no text, watermarks or borders. Always return one photo.');
  return lines.join('\n');
}

async function generateWith(ladder, prompt, images, ratio) {
  let last = null;
  const models = ladder.filter((m) => !dead.has(m));
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; attempt < 4; attempt++) {
      try {
        const t0 = Date.now();
        const out = await callImage(model, prompt, images, ratio);
        console.log(`[tryon] made image with ${model} in ${((Date.now() - t0) / 1000).toFixed(1)}s`);
        return { ...out, model };
      } catch (e) {
        last = e;
        console.error(`[tryon] google said (${model}, try ${attempt + 1}):`, e.status || '', String(e.message).slice(0, 300));
        if (e.status === 404 || (e.status === 400 && /model|not (found|supported)/i.test(e.message))) { dead.add(model); break; }
        if (e.status === 429 && /limit:\s*0\b|free.?tier/i.test(e.message)) {
          if (mi < models.length - 1) break; // this model has no quota on the key: try the next one
          throw new Error('Google quota is 0 - billing is not active on this API key');
        }
        if (e.status === 422) { if (attempt >= 1) break; continue; } // no image: retry once, then next model
        if ([429, 500, 502, 503, 504].includes(e.status) || e.name === 'AbortError') {
          const hint = /retry in ([\d.]+)s/i.exec(e.message || '');
          await new Promise((r) => setTimeout(r, (hint ? Math.min(30, Number(hint[1]) + 1) * 1000 : 2500 * 2 ** attempt) + Math.random() * 800));
          continue;
        }
        if (e.status === 400 || e.status === 403) throw e; // bad key / bad request: no point retrying
        break;
      }
    }
  }
  throw new Error('Could not create this look: ' + (last?.status || '') + ' ' + String(last?.message || '').slice(0, 160));
}

async function toJpegDataUrl(img) {
  if (sharp) {
    try {
      const out = await sharp(Buffer.from(img.data, 'base64')).jpeg({ quality: 86, mozjpeg: true }).toBuffer();
      return 'data:image/jpeg;base64,' + out.toString('base64');
    } catch {}
  }
  return `data:${img.mime};base64,${img.data}`;
}

// Main entry: returns a data URL of the finished look
export async function tryOn({ person, personSize, product, category, sub, title, name, species, quality, ratio: fixedRatio }) {
  // Pets and clothing use the studio photo's shape (fixedRatio); jewellery keeps the shopper's photo shape.
  const ratio = fixedRatio || nearestRatio(personSize?.w, personSize?.h);
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
    return `data:${person.mime};base64,${person.data}`;
  }
  // Understand this product first and write a prompt just for it; fall back to the general prompt if that fails.
  const brief = await analyzeProduct({ product, title, category, sub, species });
  const prompt = brief ? promptFromBrief({ brief, category, title, name, species }) : buildPrompt({ category, sub, title, name, species });
  const ladder = LADDER[quality === 'premium' ? 'premium' : 'standard'];
  let img;
  try {
    img = await generateWith(ladder, prompt, [person, product], ratio);
  } catch (e) {
    if (/quota/i.test(e.message)) throw e;
    // Usually the model replied with words instead of a picture (busy photo, several items). Try once more, simpler and stronger.
    console.error('[tryon] first pass failed, retrying simpler:', String(e.message).slice(0, 160));
    const simple = `${prompt}\nKeep it simple: use just one item from image 2 and return one photo.`;
    img = await generateWith(LADDER.premium, simple, [person, product], ratio);
  }
  const qc = await qualityCheck({ product, result: img, category, sub: brief?.sub || sub, item: brief?.item });
  if (!qc.ok) {
    console.error(`[tryon] quality check failed (${img.model}) "${title}": ${qc.problem} — regenerating`);
    try {
      const fix = `${prompt}\nIMPORTANT — a previous attempt had this problem, avoid it: ${qc.problem}`;
      img = await generateWith(LADDER.premium, fix, [person, product], ratio);
    } catch (e) { console.error('[tryon] regenerate failed, keeping first result:', String(e.message).slice(0, 160)); }
  }
  return toJpegDataUrl(img);
}

// Step 1 for pets and clothing: turn the shopper's snapshot into one clean studio photo,
// so every look afterwards has the same catalogue background, pose and lighting.
export async function makeStudioBase({ person, category, species, ratio, quality }) {
  if (MOCK) { await new Promise((r) => setTimeout(r, 1200)); return person; }
  const animal = species === 'cat' ? 'cat' : 'dog';
  const prompt = category === 'pet'
    ? `Create a professional product-catalogue studio photograph of this exact ${animal}. Keep the ${animal}'s breed, size, body shape, fur color, markings, face, eyes and ears identical. Show the ${animal}'s full body in frame, standing on all four legs in a natural three-quarter side view with the head turned towards the camera, centred. Plain clean warm off-white seamless studio background, soft even lighting, a soft natural shadow under the feet. Remove any collar, clothing or accessories. Natural photo, sharp focus. Do not add text or watermarks.`
    : `Create a professional e-commerce catalogue studio photograph of this exact person. Keep the face, identity, skin tone, hair, body shape and proportions identical. Full body in frame, standing upright facing the camera in a relaxed natural pose, arms slightly away from the body. Plain fitted neutral clothing (simple white t-shirt and light grey trousers). Plain clean light warm-grey seamless studio background, soft even lighting. Natural photo, sharp focus. Do not add text or watermarks.`;
  const ladder = LADDER[quality === 'premium' ? 'premium' : 'standard'];
  const img = await generateWith(ladder, prompt, [person], ratio);
  return { mime: img.mime, data: img.data };
}
