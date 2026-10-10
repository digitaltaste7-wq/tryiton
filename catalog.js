// Pull a store's products from just its website URL, and sort them into pet / jewellery / clothing.
import { safeFetch } from './net.js';

const UA = 'Mozilla/5.0 (compatible; TryOnBot/1.0; +https://tryon.app)';

export function normalizeUrl(input) {
  let s = String(input || '').trim();
  if (!s) throw new Error('Please paste your website address.');
  if (!/^https?:\/\//i.test(s)) s = 'https://' + s;
  const u = new URL(s);
  if (!u.hostname.includes('.')) throw new Error('That does not look like a website address.');
  return { origin: u.origin, domain: u.hostname.replace(/^www\./, '') };
}

// ---------- classification ----------
const PET = /\b(dog|dogs|puppy|puppies|pup|cat|cats|kitten|pet|pets|canine|feline|k9|paw|paws|hound|doggy|doggie)\b/i;
const PET_GEAR = /\b(harness|leash|collar|lead)\b/i;
const JEWEL = {
  necklace: /\b(necklace|necklaces|pendant|chain|choker|lariat|locket|tennis necklace)\b/i,
  earrings: /\b(earring|earrings|stud|studs|hoop|hoops|huggie|huggies|drop earrings|ear cuff|climber)\b/i,
  ring: /\b(ring|rings|band|signet|solitaire|eternity)\b/i,
  bracelet: /\b(bracelet|bracelets|bangle|bangles|cuff|anklet)\b/i,
  watch: /\b(watch|watches)\b/i,
};
const JEWEL_ANY = /\b(jewel|jewelry|jewellery|gold|silver|diamond|gemstone|sterling|karat|14k|18k|carat|pearl|sapphire|emerald|ruby)\b/i;
const CLOTH = {
  dress: /\b(dress|dresses|gown|jumpsuit|romper|saree|sari|lehenga|abaya|kaftan|kurta set)\b/i,
  outerwear: /\b(jacket|coat|blazer|parka|puffer|vest|gilet|trench|cardigan)\b/i,
  bottom: /\b(pant|pants|trouser|trousers|jeans|shorts|skirt|leggings|joggers|chinos)\b/i,
  top: /\b(shirt|t-shirt|tee|top|blouse|hoodie|sweater|sweatshirt|jumper|polo|tank|kurta|crop)\b/i,
};
const SKIP = /\b(gift card|giftcard|e-gift|shipping|insurance|warranty|sample|cleaner|polish cloth|box only|treat|treats|food|kibble|shampoo|bowl|toy|toys|bed|crate|candle|mug)\b/i;

export function classify(p) {
  const text = [p.title, p.type, (p.tags || []).join(' ')].join(' ');
  if (SKIP.test(text)) return { category: null, sub: null };
  const isCloth = Object.values(CLOTH).some((r) => r.test(text));
  if (PET.test(text) || (PET_GEAR.test(text) && !isCloth)) {
    const sub = /\bharness\b/i.test(text) ? 'harness' : /\bcollar\b/i.test(text) ? 'collar' : /\b(leash|lead)\b/i.test(text) ? 'leash' : 'apparel';
    return { category: 'pet', sub };
  }
  if (!isCloth || JEWEL_ANY.test(text)) {
    for (const [sub, re] of Object.entries(JEWEL)) if (re.test(text)) return { category: 'jewellery', sub };
  }
  if (JEWEL_ANY.test(text) && !Object.values(CLOTH).some((r) => r.test(text))) return { category: 'jewellery', sub: 'necklace' };
  for (const [sub, re] of Object.entries(CLOTH)) if (re.test(text)) return { category: 'clothing', sub };
  return { category: null, sub: null };
}

export function guessNiche(products) {
  const n = { pet: 0, jewellery: 0, clothing: 0 };
  for (const p of products) if (p.category) n[p.category]++;
  const best = Object.entries(n).sort((a, b) => b[1] - a[1])[0];
  return best[1] ? best[0] : 'clothing';
}

// ---------- importers ----------
async function getJson(url) {
  const r = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'application/json' } }, 6_000_000);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return JSON.parse(r.text);
}

async function fromShopify(origin) {
  const out = [];
  let currency = null;
  for (let page = 1; page <= 4; page++) {
    const data = await getJson(`${origin}/products.json?limit=250&page=${page}`);
    if (!Array.isArray(data.products)) throw new Error('not shopify');
    for (const p of data.products) {
      const img = p.images?.[0]?.src;
      if (!img) continue;
      const v = p.variants?.find((x) => x.available !== false) || p.variants?.[0];
      out.push({
        ext_id: String(p.id), title: p.title, url: `${origin}/products/${p.handle}`, image: img,
        price: v?.price ?? null, variant_id: v ? String(v.id) : null, type: p.product_type,
        tags: Array.isArray(p.tags) ? p.tags : String(p.tags || '').split(','),
      });
    }
    if (data.products.length < 250) break;
  }
  if (!out.length) throw new Error('no products');
  try {
    const meta = await getJson(`${origin}/meta.json`);
    currency = meta.currency || null;
    return { platform: 'shopify', products: out, currency, name: meta.name };
  } catch { return { platform: 'shopify', products: out, currency }; }
}

async function fromWoo(origin) {
  const out = [];
  let currency = null;
  for (let page = 1; page <= 4; page++) {
    const data = await getJson(`${origin}/wp-json/wc/store/v1/products?per_page=100&page=${page}`);
    if (!Array.isArray(data)) throw new Error('not woo');
    for (const p of data) {
      const img = p.images?.[0]?.src;
      if (!img) continue;
      const minor = Number(p.prices?.currency_minor_unit ?? 2);
      currency = p.prices?.currency_code || currency;
      out.push({
        ext_id: String(p.id), title: decode(p.name), url: p.permalink, image: img,
        price: p.prices?.price ? (Number(p.prices.price) / 10 ** minor).toFixed(minor) : null,
        variant_id: String(p.id), type: (p.categories || []).map((c) => c.name).join(' '),
        tags: (p.tags || []).map((t) => t.name),
      });
    }
    if (data.length < 100) break;
  }
  if (!out.length) throw new Error('no products');
  return { platform: 'woocommerce', products: out, currency };
}

// Any other site: read product info that most shops publish for Google (JSON-LD), from the home page
// and up to 40 product links found on it.
async function fromHtml(origin) {
  const home = await safeFetch(origin, { headers: { 'User-Agent': UA } }, 4_000_000);
  if (!home.ok) throw new Error('Could not open the website (HTTP ' + home.status + ').');
  const name = (home.text.match(/<meta[^>]+property=["']og:site_name["'][^>]+content=["']([^"']+)/i) || home.text.match(/<title>([^<]+)/i) || [])[1];
  const links = new Set();
  for (const m of home.text.matchAll(/href=["']([^"'#]+)["']/gi)) {
    try {
      const u = new URL(m[1], origin);
      if (u.origin === origin && /\/(product|products|p|shop|item)s?\//i.test(u.pathname)) links.add(u.origin + u.pathname);
    } catch {}
    if (links.size >= 40) break;
  }
  const out = [];
  const pages = [home.text];
  await Promise.all([...links].map(async (l) => {
    try { const r = await safeFetch(l, { headers: { 'User-Agent': UA } }, 3_000_000); if (r.ok) pages.push(r.text + `<!--url:${l}-->`); } catch {}
  }));
  const seen = new Set();
  for (const html of pages) {
    const pageUrl = (html.match(/<!--url:(.+?)-->$/) || [])[1];
    for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
      let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
      const items = [].concat(j['@graph'] || j).flat();
      for (const it of items) {
        if (!it || !/Product/.test([].concat(it['@type']).join())) continue;
        const img = [].concat(it.image || [])[0];
        const imgUrl = typeof img === 'string' ? img : img?.url;
        if (!imgUrl || seen.has(it.name)) continue;
        seen.add(it.name);
        const offer = [].concat(it.offers || [])[0] || {};
        out.push({
          ext_id: it.sku || it.productID || null, title: decode(it.name), url: it.url || pageUrl || origin,
          image: new URL(imgUrl, origin).href, price: offer.price ?? offer.lowPrice ?? null, variant_id: null,
          type: it.category || '', tags: [],
        });
      }
    }
  }
  if (!out.length) throw new Error('We could not read products from this website automatically.');
  return { platform: 'other', products: out, name };
}

function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/<[^>]+>/g, '').trim();
}

export async function importCatalog(origin) {
  const errors = [];
  for (const fn of [fromShopify, fromWoo, fromHtml]) {
    try {
      const res = await fn(origin);
      res.products = res.products.slice(0, 500).map((p, i) => ({ ...p, ...classify(p), position: i }));
      res.niche = guessNiche(res.products);
      return res;
    } catch (e) { errors.push(e.message); }
  }
  throw new Error(errors[errors.length - 1] || 'Could not read products from this website.');
}
