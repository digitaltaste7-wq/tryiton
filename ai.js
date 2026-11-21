// The AI step: shopper photo + product photo -> a polished photo of the shopper (or pet) wearing the product.
// Uses Google Gemini image models, then a quick AI quality check; a bad result is regenerated once.
import { safeFetch } from './net.js';
import crypto from 'node:crypto';

// Vertex AI login with a service-account JSON key (paste the whole JSON into GOOGLE_SA_JSON)
let SA = null;
try { if (process.env.GOOGLE_SA_JSON) SA = JSON.parse(process.env.GOOGLE_SA_JSON); } catch { console.error('[tryon] GOOGLE_SA_JSON is not valid JSON'); }
// Bridge running inside Google Cloud (see cloud-function/): set VERTEX_PROXY_URL + VERTEX_PROXY_KEY
const PROXY = process.env.VERTEX_PROXY_URL || '';
const REGIONS = (process.env.VERTEX_REGIONS || 'global,us-central1,us-east4,us-east5,us-west1,europe-west1,europe-west4,europe-west9').split(',').map((x) => x.trim()).filter(Boolean);
let regionCursor = 0;
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
// Jewellery is small detail work: by default it always uses the best model first.
LADDER.jewellery = (process.env.JEWELLERY_MODELS || [...new Set([...LADDER.premium, ...LADDER.standard])].join(',')).split(',').map((s) => s.trim()).filter(Boolean);
// Clothing must keep the exact print and design: by default it also uses the best model first.
LADDER.clothing = (process.env.CLOTHING_MODELS || LADDER.jewellery.join(',')).split(',').map((s) => s.trim()).filter(Boolean);
// Extra camera angles made for each jewellery look (0 switches them off)
export const JEWELLERY_ANGLES = Math.max(0, Math.min(3, Number(process.env.JEWELLERY_ANGLES ?? 2)));
// How many times a look that fails the quality check is made again
const REGEN = { clothing: 2, jewellery: 2, pet: 1 };
const QC_MODEL = process.env.GEMINI_QC_MODEL || 'gemini-2.5-flash';
const JEWELLERY_QC = process.env.JEWELLERY_QC !== '0';
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
  bangle: 'on a visible wrist; if no wrist is visible, raise one hand naturally so the wrist shows',
  anklet: 'around a visible ankle, resting loosely just above the ankle bone',
  watch: 'on a visible wrist; if no wrist is visible, raise one hand naturally so the wrist shows',
};
// How each kind of jewellery behaves in a real photograph (used for every jewellery look)
const JEWEL_REAL = {
  ring: 'RING: on the ring finger (fourth finger) unless image 2 clearly shows another finger. The hand must be posed like in a real jewellery photo: fingers relaxed, gently curved and slightly apart, never stiff, splayed, clawed or perfectly flat; the hand turned about 30-45 degrees so a little of the side of the ring and the height of the stone show; the hand is the right size for the face and body and clearly belongs to the same arm and skin tone; the wrist bends naturally. It sits at the base of the finger between the knuckles, the band wraps fully around the finger (the back of the band is hidden behind the finger), the skin is very slightly pressed under the band, the stone faces the camera on the top of the finger. True scale: a band is usually 1.5-4 mm wide and a centre stone is a few millimetres, never bigger than the fingernail unless image 2 is a statement cocktail ring. The hand has natural anatomy: five fingers, real knuckles, nails and skin creases, a relaxed believable pose.',
  bracelet: 'BRACELET: it rests loosely around the wrist just above the wrist bone, gravity pulls it slightly towards the hand, the part behind the wrist is hidden, there is a thin contact shadow where it touches skin. True scale relative to the wrist. The hand has natural anatomy: five fingers, real knuckles and nails, a relaxed pose.',
  bangle: 'BANGLE: a rigid circle that hangs loosely on the wrist, slipping down towards the hand by gravity, tilted (an ellipse in perspective, never a flat ring facing the camera), the back half hidden behind the wrist, a gap between metal and skin on the upper side and a contact shadow where it rests. If image 2 is a set of several bangles, stack them together the same way. True scale: the inner diameter just fits over the hand (about 6 cm). The hand has natural anatomy: five fingers, real knuckles and nails, a relaxed pose.',
  watch: 'WATCH: the case sits on top of the wrist just above the wrist bone, the strap wraps around and is hidden behind the wrist, correct case size (about 3.5-4.5 cm across). The hand has natural anatomy and a relaxed pose.',
  earrings: 'EARRINGS: the ear must be clearly visible: tuck the hair behind the ear if it covers it. Each one hangs from the earlobe through a piercing, gravity pulls drops and hoops straight down, hair may partly cover them, both ears match where visible, the far ear follows the head perspective. True scale: studs are a few millimetres, drops are usually shorter than the earlobe-to-jaw distance unless image 2 shows a long statement earring.',
  necklace: 'NECKLACE: the chain follows the curve of the neck and collarbone, it lies on the skin or on top of the clothing neckline, gravity pulls the pendant to the lowest point, the chain disappears behind the neck at the sides, there are tiny contact shadows on the skin. True scale: chain thickness and pendant size match image 2 relative to a real neck.',
  anklet: 'ANKLET: a thin chain resting loosely around the ankle above the ankle bone, sagging slightly by gravity, the back part hidden.',
};
const REAL_PHOTO = 'PHOTOGRAPHIC REALISM: the result must be indistinguishable from a real camera photograph (full-frame camera, 50-85 mm lens), never a 3D render, illustration or "AI look". Keep real skin texture with pores, fine hairs and natural variation; no airbrushing, no plastic or waxy skin, no beauty filter, no over-sharpening, no HDR glow. Real fabric shows its weave or knit, natural creases, seams, slight wrinkles and believable weight. Light falls off naturally with soft real shadows that match the light direction of image 1. Keep natural colour, mild camera grain and realistic depth of field. Hands, fingers, ears and teeth have correct anatomy.';
const PET_PHOTO = 'PHOTOGRAPHIC REALISM: it must look like a real photograph from a professional pet shoot, never a render or illustration. Keep individual fur strands and their natural direction and texture, real eyes with natural catchlights, the fur pressed slightly under straps and fabric, soft real shadows. No smoothing, no cartoon look.';
// Clothing: the most common failure is the AI redesigning the garment. These rules stop it.
const GARMENT_EXACT = 'THE GARMENT MUST BE THE SAME PRODUCT AS IMAGE 2 - a shopper will buy exactly what is in image 2. Copy its design exactly: the same print or pattern (same motifs, same colours, same scale and the same placement on the garment), the same embroidery, prints, lace, sequins, logos and graphics in the same positions, the same neckline, collar, sleeve type and length, garment length, cut and silhouette, the same buttons (number and position), zips, pockets, pleats, belts, borders and trims, and the same fabric colour and sheen. Do NOT redesign, simplify, re-imagine, recolour, mirror or "improve" the pattern, and do not invent new details. If part of the garment is hidden in image 2, continue the visible pattern naturally. The only change allowed is how the fabric drapes and folds on this person\'s body.';
const JEWEL_PHOTO = 'PHOTOGRAPHIC REALISM: it must look like a real photograph of a real piece of jewellery, not a render. Match image 1 exactly for lighting direction, colour temperature, exposure, sharpness, depth of field, noise and grain. Metal reflects the surroundings of image 1 (soft, realistic highlights, never neon glow or a CGI shine); gold, silver and platinum keep their true tone; gemstones show real facets and light refraction, diamonds sparkle only with small natural highlights; pearls have a soft lustre. Keep the skin texture, pores and fine hairs; do not smooth, beautify or retouch the face. No extra jewellery anywhere else.';
function jewelKind(sub) {
  const s = String(sub || '').toLowerCase();
  if (/bangle|kada|kara|cuff/.test(s)) return 'bangle';
  if (/bracelet|tennis|chain bracelet/.test(s)) return 'bracelet';
  if (/ring/.test(s) && !/earring/.test(s)) return 'ring';
  if (/earring|stud|hoop|jhumka|drop/.test(s)) return 'earrings';
  if (/necklace|pendant|chain|choker|mangalsutra/.test(s)) return 'necklace';
  if (/watch/.test(s)) return 'watch';
  if (/anklet|payal/.test(s)) return 'anklet';
  return '';
}

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
${PET_PHOTO}
If image 2 shows the product on another animal, use only the product. If image 2 shows several items or colour options together (a flat-lay or bundle), pick the single most prominent one${sub === 'leash' ? ' (one collar with its matching leash)' : ''} and use only that. The product must be properly worn and fitted, not pasted on. Always return an image.`;
  }
  if (category === 'jewellery') {
    const place = PLACE[sub] || 'where this piece is naturally worn';
    return `Edit image 1 so the person is wearing the jewellery from image 2 ("${title}", ${sub || 'jewellery'}).
Place it ${place}. Remove any similar jewellery already worn in that spot.
Keep the person exactly the same: face, identity, skin, hair, expression, clothing, background, lighting and framing. Keep the jewellery's real-life scale on the body, with true metal colour, stones and sparkle, and natural reflections and shadows on the skin.
${JEWEL_REAL[jewelKind(sub)] || ''}
${JEWEL_PHOTO}
${RULES}`;
  }
  return `Image 1 is a studio photo of a person. Image 2 is the product "${title}" (${sub || 'clothing'}).
Show this exact same person — identical face, identity, skin tone, hair, body shape and proportions — wearing this item, fitted naturally to their body with realistic drape, folds and seams. ${GARMENT[sub] || ''}
Image 1 is already a clean studio photo: keep its pose, camera angle, background, lighting and framing exactly, and change only the clothing.
${GARMENT_EXACT}
${REAL_PHOTO}
${RULES}`;
}

// ---------------- product image cache (1 hour) ----------------
const imgCache = new Map();
function sizedUrl(url) {
  try {
    const u = new URL(url);
    if (u.hostname === 'cdn.shopify.com' || u.pathname.includes('/cdn/shop/')) u.searchParams.set('width', '1600');
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
      // Google limits each region separately: when one region is busy (429), try the next one straight away.
      let last;
      for (let i = 0; i < REGIONS.length; i++) {
        const location = REGIONS[(regionCursor + i) % REGIONS.length];
        const r = await fetch(PROXY, {
          method: 'POST', signal: ctrl.signal,
          headers: { 'Content-Type': 'application/json', 'x-proxy-key': process.env.VERTEX_PROXY_KEY || '' },
          body: JSON.stringify({ model, body, location }),
        });
        const j = await r.json().catch(() => ({}));
        if (r.ok) { regionCursor = (regionCursor + i + 1) % REGIONS.length; return j; }
        last = new Error(j.error?.message || 'AI error ' + r.status); last.status = r.status;
        if (r.status !== 429 && r.status !== 404) throw last;
      }
      throw last;
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
    // Gemini 3 image models can return a larger, sharper image (2K); older models ignore nothing, so only ask them.
    generationConfig: { responseModalities: ['TEXT', 'IMAGE'], imageConfig: { aspectRatio: ratio, ...(/^gemini-3/.test(model) && process.env.TRYON_2K !== '0' ? { imageSize: '2K' } : {}) } },
  }, 150_000);
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
  if (!QC_ON && !(category === 'jewellery' && JEWELLERY_QC)) return { ok: true };
  const subject = category === 'pet' ? 'the same animal' : 'the person';
  const what = category === 'jewellery' ? `the ${sub || 'jewellery'}` : 'the product';
  try {
    const j = await post(QC_MODEL, {
      contents: [{ role: 'user', parts: [
        { text: `Image 1 is a product photo. Image 2 is an AI-generated photo that should show ${subject} wearing ${what} from image 1, realistically.${item ? ` The product to check is: ${item.slice(0, 400)} (other items in image 1 are not required).` : ''}
Reply as JSON {"ok": boolean, "problem": string}. Set ok=false only for a clear failure: the product is missing or a different product; it looks pasted on, flat, floating or misaligned instead of worn; it is clearly the wrong size or position on the body; or the body/face/animal is distorted (extra or missing limbs, warped face). ${category === 'jewellery' ? 'For jewellery also set ok=false if: it is clearly too big or too small for a real piece on that body part; a ring or bangle faces the camera flat instead of wrapping around the finger or wrist; metal merges into or cuts through skin; the hand has extra, missing or deformed fingers; or it looks like a plastic/CGI render instead of real metal and stones. ' : ''}${category === 'clothing' ? 'For clothing also set ok=false if the garment is not the same design as image 1: a different or simplified print or pattern, motifs in different places, a clearly different colour, a different neckline, collar, sleeves, length or cut, or embroidery, buttons, prints or details that are missing or invented. Also set ok=false if the skin looks plastic or airbrushed or the photo looks like a render. ' : ''}Minor colour or lighting differences are fine. "problem" is one short sentence (empty if ok).` },
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
${category === 'clothing' ? '"design": an exact inventory of the garment design so it can be copied without changes: the print or pattern (motifs, colours, scale, spacing, where it sits - e.g. border only, all-over, yoke), embroidery, lace or embellishment and their positions, neckline and collar, sleeve type and length, garment length, cut and silhouette, closures (number of buttons, zips), pockets, pleats, belts, borders, trims and lining. Be very specific.\n' : ''}${category === 'jewellery' ? '"size": the real-life size of this piece in millimetres or centimetres (band width, stone size, bangle diameter, pendant height, earring drop length), estimated from the photo and the type of piece.\n"finish": the exact metal colour and finish (yellow/rose/white gold, silver, polished, matte, hammered, textured) and each stone: colour, cut, setting and how it catches light.\n' : ''}Write plain, specific sentences. No marketing language.`;
  try {
    const j = await post(QC_MODEL, {
      contents: [{ role: 'user', parts: [{ text: ask }, { inline_data: { mime_type: product.mime, data: product.data } }] }],
      generationConfig: { responseMimeType: 'application/json', temperature: 0.2 },
    }, 30_000);
    const text = (j.candidates?.[0]?.content?.parts || []).map((p) => p.text || '').join('');
    const b = JSON.parse(text.replace(/^```json|```$/g, '').trim());
    const clean = (v) => String(Array.isArray(v) ? v.join(' ') : v || '').replace(/\s+/g, ' ').trim().slice(0, 1400);
    const brief = { item: clean(b.item), ignore: clean(b.ignore), wear: clean(b.wear), realism: clean(b.realism), avoid: clean(b.avoid), size: clean(b.size), finish: clean(b.finish), design: clean(b.design), sub: clean(b.sub).toLowerCase().slice(0, 30) };
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
  if (brief.design) lines.push(`EXACT DESIGN TO COPY: ${brief.design}`);
  if (brief.size) lines.push(`TRUE SIZE: ${brief.size}`);
  if (brief.finish) lines.push(`METAL AND STONES: ${brief.finish}`);
  lines.push(`MAKE IT LOOK REAL: ${brief.realism}`);
  if (category === 'jewellery') {
    const kind = jewelKind(brief.sub);
    if (JEWEL_REAL[kind]) lines.push(JEWEL_REAL[kind]);
    if (PLACE[kind]) lines.push(`If needed: place it ${PLACE[kind]}.`);
    lines.push(JEWEL_PHOTO);
  } else if (category === 'pet') {
    lines.push(PET_PHOTO);
  } else {
    lines.push(GARMENT_EXACT);
    lines.push(REAL_PHOTO);
  }
  if (brief.avoid) lines.push(`AVOID: ${brief.avoid.replace(/[.\s]*$/, '.')}${category === 'jewellery' ? ' Also avoid: oversized jewellery, a flat ring or bangle facing the camera, metal fused into or cutting through the skin, extra or deformed fingers, plastic-looking metal, and a retouched face.' : category === 'clothing' ? ' Also avoid: a different print or pattern, changed colours, a changed neckline, sleeves or length, missing or invented embroidery and details, and plastic-looking skin.' : ''}`);
  lines.push('Reproduce the product exactly (colour, material, pattern, hardware, logos). It must be physically worn in 3D with correct perspective, contact shadows and occlusion - never a flat cut-out, sticker or floating overlay. Only the product described above, nothing else added, no text, watermarks or borders. Always return one photo.');
  return lines.join('\n');
}

async function generateWith(ladder, prompt, images, ratio) {
  let last = null;
  const models = ladder.filter((m) => !dead.has(m));
  for (let mi = 0; mi < models.length; mi++) {
    const model = models[mi];
    for (let attempt = 0; attempt < (PROXY ? 6 : 4); attempt++) {
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
          const base = e.status === 429 ? 6000 * (attempt + 1) : 2500 * 2 ** attempt;
          await new Promise((r) => setTimeout(r, (hint ? Math.min(30, Number(hint[1]) + 1) * 1000 : base) + Math.random() * 1500));
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
  const ladder = category === 'jewellery' ? LADDER.jewellery : category === 'clothing' ? LADDER.clothing : LADDER[quality === 'premium' ? 'premium' : 'standard'];
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
  // Check the result; if it is wrong (e.g. the dress design changed), make it again with the problem spelled out.
  const problems = [];
  for (let round = 0; round < (REGEN[category] ?? 1); round++) {
    const qc = await qualityCheck({ product, result: img, category, sub: brief?.sub || sub, item: brief?.item });
    if (qc.ok) break;
    problems.push(qc.problem);
    console.error(`[tryon] quality check failed (${img.model}) "${title}": ${qc.problem} — regenerating`);
    try {
      const fix = `${prompt}\nIMPORTANT — earlier attempts had these problems, avoid them: ${problems.join(' | ')}`;
      img = await generateWith(LADDER.premium, fix, [person, product], ratio);
    } catch (e) { console.error('[tryon] regenerate failed, keeping last result:', String(e.message).slice(0, 160)); break; }
  }
  return toJpegDataUrl(img);
}

// Step 1 for pets and clothing: turn the shopper's snapshot into one clean studio photo,
// so every look afterwards has the same catalogue background, pose and lighting.
export async function makeStudioBase({ person, category, species, ratio, quality }) {
  if (MOCK) { await new Promise((r) => setTimeout(r, 1200)); return person; }
  const animal = species === 'cat' ? 'cat' : 'dog';
  const prompt = category === 'pet'
    ? `Create a professional product-catalogue studio photograph of this exact ${animal}. Keep the ${animal}'s breed, size, body shape, fur color, markings, face, eyes and ears identical. Show the ${animal}'s full body in frame, standing on all four legs in a natural three-quarter side view with the head turned towards the camera, centred. Plain clean warm off-white seamless studio background, soft even lighting, a soft natural shadow under the feet. Remove any collar, clothing or accessories. ${PET_PHOTO} Do not add text or watermarks.`
    : `Create a professional e-commerce catalogue studio photograph of this exact person. Keep the face, identity, facial features, skin tone, hair, body shape and proportions identical - it must clearly be the same real person, not a prettier or different-looking model. Full body in frame, standing upright facing the camera in a relaxed natural pose, arms slightly away from the body. Plain fitted neutral clothing (simple white t-shirt and light grey trousers). Plain clean light warm-grey seamless studio background, soft natural studio lighting with gentle real shadows. ${REAL_PHOTO} Do not add text or watermarks.`;
  const ladder = LADDER[quality === 'premium' ? 'premium' : 'standard'];
  const img = await generateWith(ladder, prompt, [person], ratio);
  return { mime: img.mime, data: img.data };
}


// ---------------- extra camera angles for jewellery ----------------
// After the main look is made, the same person is shown again from closer / different angles,
// so the shopper can see how the piece really looks (earring from the side, ring on a relaxed hand, ...).
const ANGLE_VIEWS = {
  earrings: [
    'a close-up side-profile shot: the head turned about 90 degrees, framed from the top of the head to the shoulder, hair tucked behind the ear, the near ear fully visible with the earring hanging from the earlobe in sharp focus and the background softly blurred',
    'a three-quarter portrait: the head turned about 45 degrees and slightly tilted, a soft natural smile, hair tucked behind the ear, both the face and the earring clearly visible',
    'a close-up from slightly below and behind the jaw line showing how the earring hangs and moves, with the neck and ear in frame',
  ],
  ring: [
    'a close-up of the hand wearing the ring: the back of the hand towards the camera, fingers relaxed, gently curved and slightly apart, resting lightly on the collarbone or the chest of the same outfit, the ring on the ring finger in sharp focus with real knuckles, nails and skin creases, the face softly out of frame or out of focus',
    'a natural lifestyle shot: the person gently touching the jaw or cheek with the fingertips of the ring hand, hand turned so the side of the ring, the band thickness and the stone height show, the face visible and the ring in sharp focus',
    'a close-up of the hand resting naturally on a soft fabric surface, palm down, fingers relaxed and slightly curved, the ring in sharp focus from a slight side angle',
  ],
  necklace: [
    'a close-up framed from the chin to the chest, the necklace lying on the collarbone with the pendant in sharp focus and tiny contact shadows on the skin',
    'a three-quarter portrait with the head turned slightly to one side, showing how the chain follows the curve of the neck and disappears behind it',
    'a close-up from the side of the neck showing the chain thickness and how it rests on the skin',
  ],
  bangle: [
    'a close-up of the wrist from the side: the arm relaxed, the hand resting naturally, the bangle hanging loosely and tilted in perspective, in sharp focus',
    'the hand raised gracefully near the face or tucking the hair behind the ear, the forearm tilted so the bangle is seen in perspective, sliding slightly down by gravity',
    'a close-up of both hands loosely clasped at waist height with the bangle on the wrist, in sharp focus',
  ],
  anklet: [
    'a close-up of the foot and ankle from the side, standing on a soft surface, the anklet resting just above the ankle bone in sharp focus',
    'the person seated with legs crossed, the ankle with the anklet in clear view and in sharp focus',
    'a close-up of the ankle from the front with the foot slightly pointed',
  ],
};
ANGLE_VIEWS.bracelet = ANGLE_VIEWS.bangle.map((v) => v.replace(/bangle/g, 'bracelet'));
ANGLE_VIEWS.watch = ANGLE_VIEWS.bangle.map((v) => v.replace(/the bangle hanging loosely and tilted in perspective/, 'the watch face turned towards the camera').replace(/bangle/g, 'watch').replace(/, sliding slightly down by gravity/, ''));
const ANGLE_DEFAULT = [
  'a close-up shot that shows the jewellery in sharp focus from a natural angle',
  'a three-quarter portrait from a slightly different camera angle with the jewellery clearly visible',
];

export async function jewelleryAngles({ look, product, sub, title, count = JEWELLERY_ANGLES }) {
  if (MOCK || !count) return [];
  const m = /^data:([^;]+);base64,(.*)$/s.exec(look || '');
  if (!m) return [];
  const lookImg = { mime: m[1], data: m[2] };
  const brief = await analyzeProduct({ product, title, category: 'jewellery', sub }); // cached from the main look
  const kind = jewelKind(brief?.sub || sub) || jewelKind(title);
  const views = (ANGLE_VIEWS[kind] || ANGLE_DEFAULT).slice(0, count);
  const out = [];
  for (const view of views) {
    const prompt = `Image 1 is a photo of a person wearing a piece of jewellery. Image 2 is the product photo of that exact piece ("${title}").
Create a NEW photograph from the same photo shoot: the same real person (identical face, identity, skin tone, hair, makeup and clothing), wearing the same jewellery, in the same setting and light, but this time: ${view}.
The jewellery must be exactly the piece in image 2${brief?.item ? ` - ${brief.item}` : ''}. Same metal colour, stones, design and real-life size${brief?.size ? ` (${brief.size})` : ''}. Do not add any other jewellery.
${JEWEL_REAL[kind] || ''}
${JEWEL_PHOTO}
Do not add text, watermarks or borders. Return one photo.`;
    try {
      let img = await generateWith(LADDER.jewellery, prompt, [lookImg, product], '4:5');
      const qc = await qualityCheck({ product, result: img, category: 'jewellery', sub: kind || sub, item: brief?.item });
      if (!qc.ok) {
        console.error(`[tryon] angle check failed "${title}": ${qc.problem} — regenerating`);
        try { img = await generateWith(LADDER.premium, `${prompt}\nIMPORTANT — a previous attempt had this problem, avoid it: ${qc.problem}`, [lookImg, product], '4:5'); } catch {}
      }
      out.push(await toJpegDataUrl(img));
    } catch (e) {
      console.error('[tryon] extra angle skipped:', String(e.message).slice(0, 160));
    }
  }
  return out;
}
