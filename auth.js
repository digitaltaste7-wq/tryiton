import crypto from 'node:crypto';
import { db, now } from './db.js';

const ADMINS = (process.env.ADMIN_EMAILS || '').toLowerCase().split(',').map((s) => s.trim()).filter(Boolean);
export const isAdmin = (u) => !!u && ADMINS.includes(u.email);

export function hashPass(p) {
  const salt = crypto.randomBytes(16);
  const h = crypto.scryptSync(p, salt, 32);
  return salt.toString('hex') + ':' + h.toString('hex');
}
export function checkPass(p, stored) {
  const [s, h] = String(stored).split(':');
  if (!s || !h) return false;
  const calc = crypto.scryptSync(p, Buffer.from(s, 'hex'), 32);
  return crypto.timingSafeEqual(calc, Buffer.from(h, 'hex'));
}

export function cookies(req) {
  const out = {};
  for (const part of (req.headers.cookie || '').split(';')) {
    const i = part.indexOf('=');
    if (i > 0) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
  }
  return out;
}

export function startSession(res, userId, secure) {
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = now() + 30 * 864e5;
  db.prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run(token, userId, exp);
  res.setHeader('Set-Cookie', `tid=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 86400}${secure ? '; Secure' : ''}`);
}
export function endSession(req, res) {
  const t = cookies(req).tid;
  if (t) db.prepare('DELETE FROM sessions WHERE token = ?').run(t);
  res.setHeader('Set-Cookie', 'tid=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0');
}
export function currentUser(req) {
  const t = cookies(req).tid;
  if (!t) return null;
  const row = db.prepare(`SELECT u.* FROM sessions s JOIN users u ON u.id = s.user_id WHERE s.token = ? AND s.expires > ?`).get(t, now());
  return row || null;
}
