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
  outerwear: /\b(jacket|jackets|coat|coats|blazer|parka|puffer|vest|gilet|trench|cardigan|shacket|anorak|bomber|fleece)\b/i,
  bottom: /\b(pant|pants|trouser|trousers|jeans|denim|shorts|skirt|leggings|joggers|chinos|chino|sweatpants)\b/i,
  top: /\b(shirt|shirts|t-shirt|tee|tees|top|tops|blouse|hoodie|sweater|sweatshirt|jumper|polo|tank|kurta|crop|crew|crewneck|henley|knit|pullover|overshirt|button[- ]down|oxford|turtleneck|cami|bodysuit|sleeve)\b/i,
};
const SKIP = /\b(gift card|giftcard|e-gift|shipping|insurance|warranty|sample|cleaner|polish cloth|box only|treat|treats|food|kibble|shampoo|bowl|toy|toys|bed|crate|candle|mug|sock|socks|hat|cap|beanie|bag|tote|backpack|belt|wallet|sunglasses|towel|blanket|boxer|boxers|brief|briefs|underwear|bra|swatch|repair|kit)\b/i;

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

// ---------- any other website ----------
const PRODUCT_PATH = /\/(product|products|p|shop|item|items|store|catalog|collections\/[^/]+\/products|dp|buy)\/[^/?#]+/i;
const NOT_PRODUCT = /\/(cart|bag|checkout|account|login|blog|journal|news|pages?|policies|search|help|faq|about|contact|wishlist)(\/|$)/i;

function meta(html, key) {
  const re1 = new RegExp(`<meta[^>]+(?:property|name|itemprop)=["']${key}["'][^>]*content=["']([^"']*)["']`, 'i');
  const re2 = new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]*(?:property|name|itemprop)=["']${key}["']`, 'i');
  return decode((html.match(re1) || html.match(re2) || [])[1] || '') || null;
}

// Read one product page: structured product data first, then the social-sharing preview tags
export function parseProductPage(html, pageUrl) {
  for (const m of html.matchAll(/<script[^>]+application\/ld\+json[^>]*>([\s\S]*?)<\/script>/gi)) {
    let j; try { j = JSON.parse(m[1].trim()); } catch { continue; }
    const stack = [].concat(j); const found = [];
    while (stack.length) {
      const it = stack.shift();
      if (!it || typeof it !== 'object') continue;
      if (Array.isArray(it)) { stack.push(...it); continue; }
      if (it['@graph']) stack.push(...[].concat(it['@graph']));
      if (/Product|ProductGroup/.test([].concat(it['@type'] || '').join())) found.push(it);
    }
    for (const it of found) {
      const img = [].concat(it.image || it.hasVariant?.[0]?.image || [])[0];
      const imgUrl = typeof img === 'string' ? img : img?.url || img?.contentUrl;
      if (!it.name || !imgUrl) continue;
      const offer = [].concat(it.offers || it.hasVariant?.[0]?.offers || [])[0] || {};
      const offer2 = [].concat(offer.offers || [])[0] || {};
      return {
        ext_id: String(it.sku || it.productID || it.productGroupID || pageUrl), title: decode(it.name),
        url: it.url ? new URL(it.url, pageUrl).href : pageUrl, image: new URL(imgUrl, pageUrl).href,
        price: offer.price ?? offer.lowPrice ?? offer2.price ?? null, variant_id: null,
        type: [].concat(it.category || '').join(' '), tags: [], currency: offer.priceCurrency || null,
      };
    }
  }
  const title = meta(html, 'og:title') || meta(html, 'twitter:title') || (html.match(/<h1[^>]*>([\s\S]*?)<\/h1>/i) || [])[1];
  const image = meta(html, 'og:image:secure_url') || meta(html, 'og:image') || meta(html, 'twitter:image') || meta(html, 'image');
  const ogType = meta(html, 'og:type') || '';
  const price = meta(html, 'product:price:amount') || meta(html, 'og:price:amount') || meta(html, 'price');
  // Only trust a plain page as a product if it says so, has a price, or lives at a product-like address
  if (title && image && (/product/i.test(ogType) || price || PRODUCT_PATH.test(new URL(pageUrl).pathname))) {
    return {
      ext_id: pageUrl, title: decode(title).replace(/\s*[|–—-]\s*[^|–—-]{2,40}$/, ''), url: pageUrl,
      image: new URL(image, pageUrl).href, price: price || null, variant_id: null, type: '', tags: [],
      currency: meta(html, 'product:price:currency') || meta(html, 'og:price:currency'),
    };
  }
  return null;
}

async function fetchText(url, max = 3_000_000) {
  const r = await safeFetch(url, { headers: { 'User-Agent': UA, Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8' } }, max);
  if (!r.ok) throw new Error('HTTP ' + r.status);
  return r;
}

async function mapLimit(items, n, fn) {
  const out = []; let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (i < items.length) { const k = i++; try { out[k] = await fn(items[k]); } catch { out[k] = null; } }
  }));
  return out;
}

// Product pages listed in the site's sitemap (the page list most sites publish for Google)
async function sitemapProductUrls(origin) {
  const roots = new Set([`${origin}/sitemap.xml`, `${origin}/sitemap_index.xml`, `${origin}/product-sitemap.xml`]);
  try {
    const robots = await fetchText(`${origin}/robots.txt`, 300_000);
    for (const m of robots.text.matchAll(/^\s*sitemap:\s*(\S+)/gim)) roots.add(m[1].trim());
  } catch {}
  const urls = new Set(); const seen = new Set();
  const queue = [...roots];
  while (queue.length && seen.size < 12 && urls.size < 200) {
    const sm = queue.shift();
    if (seen.has(sm)) continue; seen.add(sm);
    let xml; try { xml = (await fetchText(sm, 8_000_000)).text; } catch { continue; }
    if (/<sitemapindex/i.test(xml)) {
      const kids = [...xml.matchAll(/<loc>\s*([^<\s]+)\s*<\/loc>/gi)].map((m) => decode(m[1]));
      // product sitemaps first
      kids.sort((a, b) => (/product/i.test(b) ? 1 : 0) - (/product/i.test(a) ? 1 : 0));
      queue.unshift(...kids.filter((k) => !/(blog|post|article|page|tag|author|categor|image|video|news)/i.test(k)).slice(0, 6));
      continue;
    }
    const isProductMap = /product/i.test(sm);
    for (const m of xml.matchAll(/<url>([\s\S]*?)<\/url>/gi)) {
      const loc = decode((m[1].match(/<loc>\s*([^<\s]+)\s*<\/loc>/i) || [])[1] || '');
      if (!loc) continue;
      try {
        const path = new URL(loc).pathname;
        if (NOT_PRODUCT.test(path) || /\[|\]/.test(path)) continue;
        if (isProductMap || PRODUCT_PATH.test(path)) urls.add(loc);
      } catch {}
      if (urls.size >= 200) break;
    }
  }
  return [...urls];
}

// Product links found on the home page and a few collection pages
async function linkedProductUrls(origin, homeHtml) {
  const urls = new Set(); const lists = new Set();
  const scan = (html) => {
    for (const m of html.matchAll(/href=["']([^"'#]+)["']/gi)) {
      try {
        const u = new URL(decode(m[1]), origin);
        if (u.origin !== origin || NOT_PRODUCT.test(u.pathname)) continue;
        if (PRODUCT_PATH.test(u.pathname)) urls.add(u.origin + u.pathname);
        else if (/\/(collections?|category|categories|shop|women|men|new|sale|all)(\/|$)/i.test(u.pathname) || u.pathname.split('/').filter(Boolean).length === 1) lists.add(u.origin + u.pathname);
      } catch {}
    }
  };
  scan(homeHtml);
  if (urls.size < 12) {
    const pages = await mapLimit([...lists].slice(0, 8), 4, async (l) => (await fetchText(l)).text);
    for (const html of pages) if (html) scan(html);
  }
  return [...urls];
}

async function fromAnySite(origin) {
  const home = await fetchText(origin, 4_000_000);
  const name = meta(home.text, 'og:site_name') || decode((home.text.match(/<title>([^<]+)/i) || [])[1] || '').split(/[|–—-]/)[0].trim() || null;
  let candidates = await sitemapProductUrls(origin);
  if (candidates.length < 6) candidates = [...new Set([...candidates, ...(await linkedProductUrls(origin, home.text))])];
  const pages = await mapLimit(candidates.slice(0, 60), 8, async (u) => parseProductPage((await fetchText(u)).text, u));
  const seen = new Set(); const products = [];
  for (const p of pages) {
    if (!p || seen.has(p.title.toLowerCase())) continue;
    seen.add(p.title.toLowerCase()); products.push(p);
  }
  // the home page itself may list products in its structured data
  if (!products.length) { const p = parseProductPage(home.text, origin); if (p) products.push(p); }
  return { platform: 'other', products, name, currency: products.find((p) => p.currency)?.currency || null };
}

function decode(s) {
  return String(s || '').replace(/&amp;/g, '&').replace(/&#0?39;|&apos;/g, "'").replace(/&quot;/g, '"').replace(/&#8211;/g, '–').replace(/&#8217;/g, '’').replace(/&#x27;/g, "'").replace(/<[^>]+>/g, '').trim();
}

function finish(res) {
  res.products = res.products.slice(0, 500).map((p, i) => ({ ...p, ...classify(p), position: i }));
  res.niche = guessNiche(res.products);
  // In a clothing store, a piece we could not name (e.g. "The Organic Cotton Crew") is most likely a top
  if (res.niche === 'clothing') {
    for (const p of res.products) {
      if (!p.category && !SKIP.test([p.title, p.type, (p.tags || []).join(' ')].join(' '))) { p.category = 'clothing'; p.sub = 'top'; }
    }
  }
  return res;
}

// Never fails just because products could not be read: the store is still created and
// products can be added by link or photo from the dashboard.
export async function importCatalog(origin) {
  for (const fn of [fromShopify, fromWoo]) {
    try { return finish(await fn(origin)); } catch {}
  }
  try {
    const res = await fromAnySite(origin);
    if (res.products.length) return finish(res);
    return { platform: 'other', products: [], niche: null, name: res.name, empty: true };
  } catch (e) {
    const err = new Error(/HTTP|fetch failed|ENOTFOUND|allowed/i.test(e.message) ? 'We could not open that website. Check the address and try again.' : e.message);
    throw err;
  }
}

// Products the store owner pasted links to (any website)
export async function importFromUrls(urls, siteNiche) {
  const list = [...new Set(urls.map((u) => String(u).trim()).filter((u) => /^https?:\/\//i.test(u)))].slice(0, 50);
  const pages = await mapLimit(list, 6, async (u) => {
    const r = await fetchText(u);
    // a Shopify product link: its .json gives exact data
    const m = /\/products\/([^/?#]+)/.exec(new URL(r.url).pathname);
    if (m) {
      try {
        const j = JSON.parse((await safeFetch(new URL(r.url).origin + '/products/' + m[1] + '.json', { headers: { 'User-Agent': UA } }, 2_000_000)).text).product;
        const v = j.variants?.[0];
        if (j?.images?.[0]?.src) return { ext_id: String(j.id), title: j.title, url: r.url, image: j.images[0].src, price: v?.price ?? null, variant_id: v ? String(v.id) : null, type: j.product_type, tags: String(j.tags || '').split(',') };
      } catch {}
    }
    return parseProductPage(r.text, r.url);
  });
  const ok = pages.filter(Boolean).map((p) => ({ ...p, ...classify(p) }));
  for (const p of ok) if (!p.category && siteNiche) { p.category = siteNiche; p.sub = siteNiche === 'pet' ? 'apparel' : siteNiche === 'jewellery' ? 'necklace' : 'top'; }
  return { products: ok, failed: list.length - ok.length };
}
