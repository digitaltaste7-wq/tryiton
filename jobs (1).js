// A shopper's "lookbook" = one job that generates every piece, a few at a time.
// Photos and results live only in memory: the shopper photo is dropped 1 hour after the lookbook
// finishes (so a failed piece can be retried), and everything is wiped after JOB_TTL.
import crypto from 'node:crypto';
import { tryOn, loadProductImage } from './ai.js';
import { db, bumpUsage } from './db.js';

const JOB_TTL = 6 * 3600e3;
const KEEP_PHOTO = 3600e3;
const PER_JOB = Number(process.env.PER_JOB || 3);       // generations running at once for one shopper
const GLOBAL = Number(process.env.MAX_PARALLEL || 12);  // across all shoppers
const jobs = new Map();
let running = 0;
const waiting = [];

function slot() {
  if (running < GLOBAL) { running++; return Promise.resolve(); }
  return new Promise((r) => waiting.push(r));
}
function release() {
  const next = waiting.shift();
  if (next) next(); else running--;
}

const PET_SUBS = ['apparel', 'harness', 'collar', 'leash'];
// A pet store's products are always worn by the pet, whatever words the store used
function effective(site, p) {
  if (site.niche === 'pet') return { category: 'pet', sub: PET_SUBS.includes(p.sub) ? p.sub : 'apparel' };
  return { category: p.category || site.niche, sub: p.sub };
}

async function runOne(job, site, p) {
  const item = job.items.get(String(p.id));
  await slot();
  item.status = 'working'; item.started = Date.now(); item.error = null;
  try {
    if (!job.person) throw new Error('Photo expired — please start a new lookbook.');
    const product = await loadProductImage(p.image);
    const { category, sub } = effective(site, p);
    item.image = await tryOn({
      person: job.person, personSize: job.personSize, product, category, sub, title: p.title,
      name: job.name, species: job.species, quality: site.quality,
    });
    item.status = 'done'; item.ms = Date.now() - item.started;
    bumpUsage(site.id, 'images');
  } catch (e) {
    item.status = 'failed'; item.error = String(e.message || e).slice(0, 200);
    bumpUsage(site.id, 'failed');
    console.error('[tryon] failed', site.domain, p.title, item.error);
  } finally { release(); }
}

function finish(job) {
  if ([...job.items.values()].some((i) => i.status === 'queued' || i.status === 'working')) return;
  job.finished = Date.now();
  clearTimeout(job.dropTimer);
  job.dropTimer = setTimeout(() => { job.person = null; }, KEEP_PHOTO);
  job.dropTimer.unref?.();
}

export function createJob({ site, person, personSize, products, name, species }) {
  const id = crypto.randomBytes(12).toString('base64url');
  const job = {
    id, siteId: site.id, created: Date.now(), person, personSize, name, species,
    items: new Map(), products: new Map(products.map((p) => [String(p.id), p])),
  };
  for (const p of products) job.items.set(String(p.id), { status: 'queued' });
  jobs.set(id, job);
  bumpUsage(site.id, 'sessions');
  const queue = [...products];
  const worker = async () => { while (queue.length) await runOne(job, site, queue.shift()); };
  Promise.all(Array.from({ length: Math.min(PER_JOB, products.length) }, worker)).then(() => finish(job));
  return job;
}

// Try one failed piece again (shopper pressed "Try again")
export function retryItem(job, site, pid) {
  const item = job.items.get(String(pid));
  const p = job.products.get(String(pid));
  if (!item || !p || item.status !== 'failed') return false;
  if (!job.person) return 'expired';
  item.status = 'queued'; job.finished = null;
  runOne(job, site, p).then(() => finish(job));
  return true;
}

export function getJob(id) { return jobs.get(id); }

setInterval(() => {
  const cut = Date.now() - JOB_TTL;
  for (const [id, j] of jobs) if (j.created < cut) { clearTimeout(j.dropTimer); jobs.delete(id); }
}, 10 * 60e3).unref();

// Simple per-visitor limiter: max N lookbooks per 10 minutes per IP
const hits = new Map();
export function allowIp(ip, max = 4) {
  const t = Date.now(), arr = (hits.get(ip) || []).filter((x) => x > t - 600e3);
  if (arr.length >= max) { hits.set(ip, arr); return false; }
  arr.push(t); hits.set(ip, arr);
  if (hits.size > 50000) hits.clear();
  return true;
}
export { db };
