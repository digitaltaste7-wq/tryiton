// The AI step: shopper photo + product photo -> shopper wearing the product (Google Gemini image model).
import { safeFetch } from './net.js';

const KEY = process.env.GEMINI_API_KEY || '';
const BASE = process.env.GEMINI_BASE || 'https://generativelanguage.googleapis.com';
const MODEL = process.env.GEMINI_MODEL || 'gemini-3.1-flash-lite-image';         // "Nano Banana 2 Lite"
const FALLBACK = process.env.GEMINI_FALLBACK_MODEL || 'gemini-2.5-flash-image';    // used if the first model is unavailable
export const MOCK = !KEY || process.env.TRYON_MOCK === '1';

const RATIOS = { '1:1': 1, '4:5': 0.8, '3:4': 0.75, '2:3': 0.667, '9:16': 0.5625, '5:4': 1.25, '4:3': 1.333, '3:2': 1.5, '16:9': 1.778 };
export function nearestRatio(w, h) {
  const r = w && h ? w / h : 0.8;
  return Object.entries(RATIOS).sort((a, b) => Math.abs(a[1] - r) - Math.abs(b[1] - r))[0][0];
}

const PLACE = {
  necklace: 'around the neck, resting naturally on the collarbone/chest',
  earrings: 'on the ears (both ears if visible), hanging naturally',
  ring: 'on a finger of the visible hand',
  bracelet: 'on the visible wrist',
  watch: 'on the visible wrist',
};
const GARMENT = {
  top: 'Replace only the upper-body garment with it; keep the lower-body clothing unchanged.',
  bottom: 'Replace only the lower-body garment with it; keep the upper-body clothing unchanged.',
  dress: 'Replace the outfit with this dress.',
  outerwear: 'Put this layer on over the existing outfit.',
};

export function buildPrompt({ category, sub, title, name, species }) {
  const keep = 'Keep everything else exactly the same as image 1: identity, face, features, expression, pose, body, hair, background, lighting, camera angle and framing. Make it photorealistic with correct scale, fit, shadows and reflections. Reproduce the product exactly as in image 2 (design, colour, material, pattern, details, proportions). Do not add text, logos, watermarks, borders or extra items. Return only the edited photo.';
  if (category === 'pet') {
    const what = { harness: 'harness', collar: 'collar', leash: 'collar and leash' }[sub] || 'garment';
    return `Image 1 is a photo of a ${species || 'dog'}${name ? ` named ${name}` : ''}. Image 2 is a product photo of a pet ${what}: "${title}". Edit image 1 so this same ${species || 'dog'} is wearing exactly this ${what}, fitted correctly to its body size and shape. Keep the animal's breed, fur colour, markings, face and eyes unchanged. ${keep}`;
  }
  if (category === 'jewellery') {
    const place = PLACE[sub] || 'where this piece is naturally worn';
    return `Image 1 is a photo of a person. Image 2 is a product photo of a piece of jewellery (${sub || 'jewellery'}): "${title}". Edit image 1 so the same person is wearing exactly this piece ${place}. Remove any similar jewellery already worn in that spot. Keep the metal colour, stones, size and proportions true to image 2 — a real-life scale on the body. ${keep}`;
  }
  return `Image 1 is a photo of a person. Image 2 is a product photo of a clothing item (${sub || 'garment'}): "${title}". Edit image 1 so the same person is wearing exactly this item, fitted naturally to their body with realistic folds and drape. ${GARMENT[sub] || ''} ${keep}`;
}

// --- product image cache (1 hour) ---
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
  let mime = (r.contentType.split(';')[0] || '').trim();
  if (!/^image\/(jpeg|png|webp)$/.test(mime)) {
    const b = r.buffer;
    mime = b[0] === 0x89 ? 'image/png' : b[0] === 0xff ? 'image/jpeg' : (b.slice(8, 12).toString() === 'WEBP' ? 'image/webp' : '');
    if (!mime) throw new Error('Unsupported product image format');
  }
  const v = { t: Date.now(), mime, data: r.buffer.toString('base64') };
  imgCache.set(url, v);
  if (imgCache.size > 300) imgCache.delete(imgCache.keys().next().value);
  return v;
}

async function callGemini(model, prompt, person, product, ratio) {
  const body = {
    contents: [{ role: 'user', parts: [
      { text: prompt },
      { inline_data: { mime_type: person.mime, data: person.data } },
      { inline_data: { mime_type: product.mime, data: product.data } },
    ] }],
    generationConfig: { responseModalities: ['IMAGE'], imageConfig: { aspectRatio: ratio } },
  };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 90_000);
  try {
    const r = await fetch(`${BASE}/v1beta/models/${model}:generateContent`, {
      method: 'POST', signal: ctrl.signal,
      headers: { 'Content-Type': 'application/json', 'x-goog-api-key': KEY },
      body: JSON.stringify(body),
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) { const e = new Error(j.error?.message || 'AI error ' + r.status); e.status = r.status; throw e; }
    const parts = j.candidates?.[0]?.content?.parts || [];
    const img = parts.find((p) => p.inlineData || p.inline_data);
    if (!img) { const e = new Error('AI returned no image (' + (j.candidates?.[0]?.finishReason || j.promptFeedback?.blockReason || 'unknown') + ')'); e.status = 422; throw e; }
    const d = img.inlineData || img.inline_data;
    return `data:${d.mimeType || d.mime_type || 'image/png'};base64,${d.data}`;
  } finally { clearTimeout(timer); }
}

export async function tryOn({ person, product, prompt, ratio }) {
  if (MOCK) {
    await new Promise((r) => setTimeout(r, 1500 + Math.random() * 2500));
    return `data:${person.mime};base64,${person.data}`;
  }
  let model = MODEL, last = null;
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      return await callGemini(model, prompt, person, product, ratio);
    } catch (e) {
      last = e;
      console.error(`[tryon] google said (${model}, try ${attempt + 1}):`, e.status || '', String(e.message).slice(0, 300));
      if ((e.status === 404 || (e.status === 400 && /model/i.test(e.message))) && model !== FALLBACK) { model = FALLBACK; continue; }
      // "limit: 0" = this Google project has no image quota (billing not active) - retrying will not help
      if (e.status === 429 && /limit:\s*0\b|free.?tier/i.test(e.message)) throw new Error('Google quota is 0 - billing is not active on this API key: ' + e.message.slice(0, 160));
      if ([429, 500, 502, 503, 504].includes(e.status) || e.name === 'AbortError') {
        const hint = /retry in ([\d.]+)s/i.exec(e.message || '');
        const wait = hint ? Math.min(30, Number(hint[1]) + 1) * 1000 : 3000 * 2 ** attempt;
        await new Promise((r) => setTimeout(r, wait + Math.random() * 1000));
        continue;
      }
      throw e;
    }
  }
  throw new Error('Google kept refusing: ' + (last?.status || '') + ' ' + String(last?.message || '').slice(0, 160));
}
