// A shopper's "lookbook" = one job that generates every piece in parallel.
// Photos and results live only in memory and are wiped after JOB_TTL (privacy: "deleted within 24 hours").
import crypto from 'node:crypto';
import { tryOn, loadProductImage, buildPrompt, nearestRatio } from './ai.js';
import { db, bumpUsage } from './db.js';

const JOB_TTL = 6 * 3600e3;
const PER_JOB = Number(process.env.PER_JOB || 3); // generations running at once for one shopper
const GLOBAL = Number(process.env.MAX_PARALLEL || 24); // across all shoppers
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

export function createJob({ site, person, ratioWH, products, name, species }) {
  const id = crypto.randomBytes(12).toString('base64url');
  const job = {
    id, siteId: site.id, created: Date.now(), person, items: new Map(),
    order: products.map((p) => String(p.id)),
  };
  for (const p of products) job.items.set(String(p.id), { status: 'queued' });
  jobs.set(id, job);
  bumpUsage(site.id, 'sessions');
  const ratio = nearestRatio(ratioWH?.[0], ratioWH?.[1]);

  const queue = [...products];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const item = job.items.get(String(p.id));
      await slot();
      item.status = 'working'; item.started = Date.now();
      try {
        const product = await loadProductImage(p.image);
        const prompt = buildPrompt({ category: p.category, sub: p.sub, title: p.title, name, species });
        item.image = await tryOn({ person, product, prompt, ratio });
        item.status = 'done'; item.ms = Date.now() - item.started;
        bumpUsage(site.id, 'images');
      } catch (e) {
        item.status = 'failed'; item.error = String(e.message || e).slice(0, 200);
        bumpUsage(site.id, 'failed');
        console.error('[tryon] failed', site.domain, p.title, item.error);
      } finally { release(); }
    }
  };
  Promise.all(Array.from({ length: Math.min(PER_JOB, products.length) }, worker)).then(() => {
    job.person = null; // shopper photo no longer needed: drop it right away
    job.finished = Date.now();
  });
  return job;
}

export function getJob(id) { return jobs.get(id); }

setInterval(() => {
  const cut = Date.now() - JOB_TTL;
  for (const [id, j] of jobs) if (j.created < cut) jobs.delete(id);
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
