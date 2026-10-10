// TryOn — AI virtual try-on for any online store (pet, jewellery, clothing).
import express from 'express';
import path from 'node:path';
import crypto from 'node:crypto';
import { db, now, getUsage, imageAllowance } from './src/db.js';
import { hashPass, checkPass, startSession, endSession, currentUser, isAdmin } from './src/auth.js';
import { normalizeUrl, importCatalog } from './src/catalog.js';
import { createJob, getJob, allowIp } from './src/jobs.js';
import { MOCK } from './src/ai.js';
import { layout, landing, authPage, sitesPage, sitePage, previewPage, SUBS } from './src/views.js';

const PORT = Number(process.env.PORT || 3000);
const APP_URL = (process.env.APP_URL || `http://localhost:${PORT}`).replace(/\/$/, '');
const SECURE = APP_URL.startsWith('https://');
const app = express();
app.set('trust proxy', true);
app.disable('x-powered-by');

app.use(express.static(path.resolve('public'), { maxAge: '5m', index: false }));
app.get('/w.js', (req, res) => {
  res.setHeader('Cache-Control', 'public, max-age=300');
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.sendFile(path.resolve('public/widget.js'));
});
app.get('/health', (req, res) => res.json({ ok: true, mock: MOCK }));

// =================== Widget API (called from shops' websites) ===================
const widget = express.Router();
widget.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', req.headers.origin || '*');
  res.setHeader('Vary', 'Origin');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});
widget.use(express.json({ limit: '9mb' }));

function siteByKey(key) { return db.prepare('SELECT * FROM sites WHERE key = ?').get(key); }
function originAllowed(site, req) {
  // Browsers omit Origin on same-origin GETs (our preview page), so fall back to Referer
  let origin = req.headers.origin;
  if (!origin && req.headers.referer) { try { origin = new URL(req.headers.referer).origin; } catch {} }
  if (!origin) return false;
  let host;
  try { host = new URL(origin).hostname.replace(/^www\./, ''); } catch { return false; }
  if (origin === APP_URL) return 'preview';
  if (host === site.domain || host.endsWith('.' + site.domain)) return 'site';
  if (site.platform === 'shopify' && /\.(myshopify|shopifypreview)\.com$/.test(host)) return 'site';
  if (!SECURE && (host === 'localhost' || host === '127.0.0.1')) return 'site';
  return false;
}
function widgetProducts(siteId) {
  return db.prepare(`SELECT id, title, url, image, price, variant_id, category, sub FROM products
    WHERE site_id = ? AND include = 1 AND category IS NOT NULL ORDER BY position LIMIT 200`).all(siteId);
}

widget.get('/:key/config', (req, res) => {
  const site = siteByKey(req.params.key);
  if (!site) return res.status(404).json({ error: 'unknown site' });
  const where = originAllowed(site, req);
  if (!where) return res.status(403).json({ error: 'This website is not connected to this TryOn account.' });
  if (where === 'site') {
    db.prepare('UPDATE sites SET last_seen_at = ?, last_seen_url = ? WHERE id = ?').run(now(), String(req.query.page || '').slice(0, 300), site.id);
  }
  const used = getUsage(site.id).images;
  res.json({
    enabled: !!site.enabled, name: site.name || site.domain, niche: site.niche, currency: site.currency,
    platform: site.platform, accent: site.accent, position: site.position,
    buttonText: site.button_text || (site.niche === 'pet' ? 'See it on your pet' : 'See it on you'),
    perShopper: site.per_shopper, available: Math.max(0, imageAllowance(site) - used),
    products: widgetProducts(site.id),
  });
});

widget.post('/:key/start', (req, res) => {
  const site = siteByKey(req.params.key);
  if (!site || !site.enabled) return res.status(404).json({ error: 'TryOn is switched off for this store.' });
  if (!originAllowed(site, req)) return res.status(403).json({ error: 'Not allowed from this website.' });
  if (!allowIp(req.ip)) return res.status(429).json({ error: 'You have made several lookbooks just now — please try again in a few minutes.' });
  const { photo, w, h, name, species } = req.body || {};
  const m = /^data:(image\/(?:jpeg|png|webp));base64,([A-Za-z0-9+/=]+)$/.exec(String(photo || ''));
  if (!m) return res.status(400).json({ error: 'Please upload a JPG or PNG photo.' });
  if (m[2].length > 8_000_000) return res.status(413).json({ error: 'That photo is too large.' });
  const all = widgetProducts(site.id);
  const byId = new Map(all.map((p) => [String(p.id), p]));
  const ids = [...new Set((req.body.products || []).map(String))].filter((id) => byId.has(id));
  let chosen = (ids.length ? ids.map((id) => byId.get(id)) : all).slice(0, Math.max(1, site.per_shopper));
  const left = imageAllowance(site) - getUsage(site.id).images;
  if (left <= 0) return res.status(402).json({ error: 'TryOn is resting for now — please check back soon.' });
  chosen = chosen.slice(0, left);
  const job = createJob({
    site, person: { mime: m[1], data: m[2] }, ratioWH: [Number(w) || 0, Number(h) || 0], products: chosen,
    name: String(name || '').slice(0, 40).replace(/[^\p{L}\p{N} '\-]/gu, ''),
    species: species === 'cat' ? 'cat' : species === 'dog' ? 'dog' : null,
  });
  res.json({ job: job.id, products: chosen.map((p) => p.id) });
});

widget.get('/:key/job/:id', (req, res) => {
  const site = siteByKey(req.params.key);
  const job = getJob(req.params.id);
  if (!site || !job || job.siteId !== site.id) return res.status(404).json({ error: 'Lookbook expired — please start again.' });
  const have = new Set(String(req.query.have || '').split(',').filter(Boolean));
  const items = {};
  let done = 0, failed = 0;
  for (const [pid, it] of job.items) {
    if (it.status === 'done') done++;
    if (it.status === 'failed') failed++;
    items[pid] = { status: it.status };
    if (it.status === 'done' && !have.has(pid)) items[pid].image = it.image;
  }
  res.json({ total: job.items.size, done, failed, finished: !!job.finished, items });
});
app.use('/api/w', widget);

// =================== Dashboard ===================
app.use(express.urlencoded({ extended: false, limit: '1mb' }));
// Basic CSRF protection for forms: only accept POSTs that come from our own pages
app.use((req, res, next) => {
  if (req.method !== 'POST' || req.path.startsWith('/api/w/')) return next();
  const o = req.headers.origin || req.headers.referer || '';
  if (o && !o.startsWith(APP_URL)) return res.status(403).send('Blocked');
  next();
});
const page = (res, opts, code = 200) => res.status(code).type('html').send(layout(opts));
function needUser(req, res, next) {
  const u = currentUser(req);
  if (!u) return res.redirect('/login');
  req.user = u; next();
}
function ownSite(req, res) {
  const s = db.prepare('SELECT * FROM sites WHERE id = ?').get(Number(req.params.id));
  if (!s || (s.user_id !== req.user.id && !isAdmin(req.user))) { res.redirect('/app'); return null; }
  return s;
}

app.get('/', (req, res) => {
  const u = currentUser(req);
  page(res, { title: 'AI virtual try-on for your store', user: u, body: landing() });
});
app.get('/signup', (req, res) => page(res, { title: 'Sign up', body: authPage({ mode: 'signup', url: req.query.url || '' }) }));
app.get('/login', (req, res) => page(res, { title: 'Log in', body: authPage({ mode: 'login' }) }));

app.post('/signup', async (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const pass = String(req.body.password || '');
  const fail = (error) => page(res, { title: 'Sign up', body: authPage({ mode: 'signup', error, email, url: req.body.url }) }, 400);
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) return fail('Please enter a valid email.');
  if (pass.length < 8) return fail('Password needs at least 8 characters.');
  if (db.prepare('SELECT 1 FROM users WHERE email = ?').get(email)) return fail('That email already has an account — please log in.');
  const r = db.prepare('INSERT INTO users (email, name, pass, created_at) VALUES (?, ?, ?, ?)').run(email, String(req.body.name || '').slice(0, 80), hashPass(pass), now());
  startSession(res, Number(r.lastInsertRowid), SECURE);
  if (req.body.url) {
    try { const id = await addSite(Number(r.lastInsertRowid), req.body.url); return res.redirect(`/app/sites/${id}?new=1`); }
    catch (e) { return res.redirect('/app?error=' + encodeURIComponent(e.message)); }
  }
  res.redirect('/app');
});
app.post('/login', (req, res) => {
  const email = String(req.body.email || '').trim().toLowerCase();
  const u = db.prepare('SELECT * FROM users WHERE email = ?').get(email);
  if (!u || !checkPass(String(req.body.password || ''), u.pass)) {
    return page(res, { title: 'Log in', body: authPage({ mode: 'login', error: 'Email or password is not right.', email }) }, 401);
  }
  startSession(res, u.id, SECURE);
  res.redirect('/app');
});
app.post('/logout', (req, res) => { endSession(req, res); res.redirect('/'); });

async function addSite(userId, rawUrl) {
  const { origin, domain } = normalizeUrl(rawUrl);
  const existing = db.prepare('SELECT id FROM sites WHERE user_id = ? AND domain = ?').get(userId, domain);
  if (existing) return existing.id;
  const cat = await importCatalog(origin);
  const key = 'ty_' + crypto.randomBytes(9).toString('base64url');
  const r = db.prepare(`INSERT INTO sites (user_id, key, url, domain, name, platform, niche, currency, imported_at, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(userId, key, origin, domain, cat.name || prettyName(domain), cat.platform, cat.niche, cat.currency || null, now(), now());
  const siteId = Number(r.lastInsertRowid);
  saveProducts(siteId, cat.products, cat.niche);
  return siteId;
}
function prettyName(domain) {
  return domain.split('.')[0].replace(/[-_]+/g, ' ').replace(/\b\w/g, (c) => c.toUpperCase());
}
function saveProducts(siteId, products, niche) {
  const ins = db.prepare(`INSERT INTO products (site_id, ext_id, title, url, image, price, variant_id, category, sub, include, position)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  db.exec('BEGIN');
  try {
    products.forEach((p, i) => {
      // Within a store of one niche, pieces we could not classify get switched off (merchant can turn on)
      const on = p.category && (p.category === niche || niche === 'clothing' || p.category !== 'clothing') ? 1 : 0;
      ins.run(siteId, p.ext_id, p.title, p.url, p.image, p.price == null ? null : String(p.price), p.variant_id, p.category, p.sub, on, i);
    });
    db.exec('COMMIT');
  } catch (e) { db.exec('ROLLBACK'); throw e; }
}

app.get('/app', needUser, (req, res) => {
  const admin = isAdmin(req.user);
  const sites = db.prepare(`SELECT s.*, u.email AS owner, (SELECT COUNT(*) FROM products p WHERE p.site_id = s.id AND p.include = 1 AND p.category IS NOT NULL) AS count
    FROM sites s JOIN users u ON u.id = s.user_id ${admin ? '' : 'WHERE s.user_id = ?'} ORDER BY s.created_at DESC`).all(...(admin ? [] : [req.user.id]));
  page(res, { title: 'Your websites', user: req.user, body: sitesPage({ sites, error: req.query.error, admin }) });
});
app.post('/app/sites', needUser, async (req, res) => {
  try { const id = await addSite(req.user.id, req.body.url); res.redirect(`/app/sites/${id}?new=1`); }
  catch (e) { res.redirect('/app?error=' + encodeURIComponent(e.message === 'fetch failed' ? 'We could not reach that website. Check the address and try again.' : e.message)); }
});
app.get('/app/sites/:id', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  const products = db.prepare('SELECT * FROM products WHERE site_id = ? ORDER BY include DESC, position').all(site.id);
  const flash = req.query.new ? `We found ${products.length} products on ${site.domain}. Open the preview to see TryOn on them.` : req.query.saved ? 'Saved.' : req.query.error || '';
  page(res, { title: site.name || site.domain, user: req.user, wide: true,
    body: sitePage({ site, products, usage: getUsage(site.id), allowance: imageAllowance(site), appUrl: APP_URL, admin: isAdmin(req.user), flash }) });
});
app.get('/app/sites/:id/status', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  res.json({ live: !!site.last_seen_at, url: site.last_seen_url, at: site.last_seen_at });
});
app.post('/app/sites/:id/settings', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  const b = req.body;
  const niche = ['pet', 'jewellery', 'clothing'].includes(b.niche) ? b.niche : site.niche;
  const accent = /^#[0-9a-f]{6}$/i.test(b.accent || '') ? b.accent : site.accent;
  db.prepare(`UPDATE sites SET name = ?, button_text = ?, niche = ?, accent = ?, position = ?, per_shopper = ?, enabled = ? WHERE id = ?`)
    .run(String(b.name || '').slice(0, 80) || site.name, String(b.button_text || '').slice(0, 40) || null, niche, accent,
      b.position === 'left' ? 'left' : 'right', Math.min(24, Math.max(1, Number(b.per_shopper) || 12)), b.enabled ? 1 : 0, site.id);
  res.redirect(`/app/sites/${site.id}?saved=1`);
});
app.post('/app/sites/:id/products', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  const upd = db.prepare('UPDATE products SET include = ?, category = COALESCE(?, category), sub = COALESCE(?, sub) WHERE id = ? AND site_id = ?');
  db.exec('BEGIN');
  for (const [k, v] of Object.entries(req.body)) {
    if (!k.startsWith('p_')) continue;
    const id = Number(k.slice(2));
    if (v === 'off') { upd.run(0, null, null, id, site.id); continue; }
    const [c, s] = String(v).split(':');
    if (SUBS[c]?.includes(s)) upd.run(1, c, s, id, site.id);
  }
  db.exec('COMMIT');
  res.redirect(`/app/sites/${site.id}?saved=1`);
});
app.post('/app/sites/:id/reimport', needUser, async (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  try {
    const cat = await importCatalog(site.url);
    // keep the merchant's choices for products we already knew
    const old = new Map(db.prepare('SELECT ext_id, title, include, category, sub FROM products WHERE site_id = ?').all(site.id).map((p) => [p.ext_id || p.title, p]));
    db.prepare('DELETE FROM products WHERE site_id = ?').run(site.id);
    saveProducts(site.id, cat.products.map((p) => { const o = old.get(p.ext_id || p.title); return o ? { ...p, category: o.category, sub: o.sub } : p; }), site.niche);
    for (const [k, o] of old) if (!o.include) db.prepare('UPDATE products SET include = 0 WHERE site_id = ? AND (ext_id = ? OR title = ?)').run(site.id, k, k);
    db.prepare('UPDATE sites SET imported_at = ? WHERE id = ?').run(now(), site.id);
    res.redirect(`/app/sites/${site.id}?saved=1`);
  } catch (e) { res.redirect(`/app/sites/${site.id}?error=` + encodeURIComponent(e.message)); }
});
app.post('/app/sites/:id/plan', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  if (!isAdmin(req.user)) return res.redirect(`/app/sites/${site.id}`);
  db.prepare('UPDATE sites SET plan = ?, monthly_limit = ? WHERE id = ?')
    .run(req.body.plan === 'active' ? 'active' : 'trial', Math.max(0, Number(req.body.monthly_limit) || 0), site.id);
  res.redirect(`/app/sites/${site.id}?saved=1`);
});
app.post('/app/sites/:id/delete', needUser, (req, res) => {
  const site = ownSite(req, res); if (!site) return;
  db.prepare('DELETE FROM sites WHERE id = ?').run(site.id);
  res.redirect('/app');
});

// Live preview: the store's real products on a demo page with TryOn switched on (great for sales demos)
app.get('/preview/:key', (req, res) => {
  const site = siteByKey(req.params.key);
  if (!site) return res.status(404).send('Preview not found');
  const products = widgetProducts(site.id).slice(0, 24);
  res.type('html').send(previewPage({ site, products, appUrl: APP_URL }));
});

app.use((req, res) => page(res, { title: 'Not found', user: currentUser(req), body: '<section class="card narrow"><h1 class="h2">Page not found</h1><p><a href="/">Go home</a></p></section>' }, 404));
app.use((err, req, res, next) => {
  console.error(err);
  if (req.path.startsWith('/api/')) return res.status(err.status || 500).json({ error: err.type === 'entity.too.large' ? 'That photo is too large.' : 'Something went wrong.' });
  res.status(500).send('Something went wrong.');
});

app.listen(PORT, () => console.log(`TryOn running on ${APP_URL}${MOCK ? '  (TEST MODE: no GEMINI_API_KEY, try-ons return the shopper photo)' : ''}`));
