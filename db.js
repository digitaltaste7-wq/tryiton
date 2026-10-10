// SQLite storage (built into Node 22 — no extra install).
import { DatabaseSync } from 'node:sqlite';
import fs from 'node:fs';
import path from 'node:path';

const DATA_DIR = process.env.DATA_DIR || path.resolve('data');
fs.mkdirSync(DATA_DIR, { recursive: true });
export const db = new DatabaseSync(path.join(DATA_DIR, 'tryon.sqlite'));
db.exec(`PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON;`);

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT UNIQUE NOT NULL,
  name TEXT,
  pass TEXT NOT NULL,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  expires INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS sites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  key TEXT UNIQUE NOT NULL,
  url TEXT NOT NULL,
  domain TEXT NOT NULL,
  name TEXT,
  platform TEXT,
  niche TEXT,
  currency TEXT,
  button_text TEXT,
  accent TEXT DEFAULT '#1e1b18',
  position TEXT DEFAULT 'right',
  enabled INTEGER DEFAULT 1,
  plan TEXT DEFAULT 'trial',
  monthly_limit INTEGER DEFAULT 3000,
  per_shopper INTEGER DEFAULT 12,
  last_seen_at INTEGER,
  last_seen_url TEXT,
  imported_at INTEGER,
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  ext_id TEXT,
  title TEXT NOT NULL,
  url TEXT,
  image TEXT NOT NULL,
  price TEXT,
  variant_id TEXT,
  category TEXT,
  sub TEXT,
  include INTEGER DEFAULT 1,
  position INTEGER DEFAULT 0
);
CREATE INDEX IF NOT EXISTS products_site ON products(site_id);
CREATE TABLE IF NOT EXISTS usage (
  site_id INTEGER NOT NULL REFERENCES sites(id) ON DELETE CASCADE,
  month TEXT NOT NULL,
  images INTEGER DEFAULT 0,
  sessions INTEGER DEFAULT 0,
  failed INTEGER DEFAULT 0,
  PRIMARY KEY (site_id, month)
);
`);

export const month = () => new Date().toISOString().slice(0, 7);
export const now = () => Date.now();

export function bumpUsage(siteId, field, n = 1) {
  db.prepare(`INSERT INTO usage (site_id, month, ${field}) VALUES (?, ?, ?)
    ON CONFLICT(site_id, month) DO UPDATE SET ${field} = ${field} + excluded.${field}`)
    .run(siteId, month(), n);
}
export function getUsage(siteId) {
  return db.prepare('SELECT * FROM usage WHERE site_id = ? AND month = ?').get(siteId, month())
    || { images: 0, sessions: 0, failed: 0 };
}

// Trial sites (prospect demos) get a small allowance so previews can't run up the AI bill.
export const TRIAL_IMAGES = Number(process.env.TRIAL_IMAGES || 60);
export function imageAllowance(site) {
  return site.plan === 'active' ? site.monthly_limit : Math.min(site.monthly_limit, TRIAL_IMAGES);
}
