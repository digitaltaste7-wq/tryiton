// Fetch that only reaches public internet addresses (never the server's own network),
// follows at most 4 redirects, times out, and caps the download size.
import dns from 'node:dns/promises';
import net from 'node:net';

function isPrivate(ip) {
  if (net.isIPv4(ip)) {
    const [a, b] = ip.split('.').map(Number);
    return a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224;
  }
  const v = ip.toLowerCase();
  if (v.startsWith('::ffff:')) return isPrivate(v.slice(7));
  return v === '::1' || v === '::' || v.startsWith('fc') || v.startsWith('fd') || v.startsWith('fe80');
}

async function assertPublic(url) {
  const u = new URL(url);
  if (!/^https?:$/.test(u.protocol)) throw new Error('Only web addresses are allowed.');
  if (process.env.ALLOW_LOCAL_FETCH === '1') return; // local testing only
  const host = u.hostname.replace(/^\[|\]$/g, '');
  const addrs = net.isIP(host) ? [{ address: host }] : await dns.lookup(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivate(a.address))) throw new Error('That address is not allowed.');
}

export async function safeFetch(url, opts = {}, maxBytes = 5_000_000, binary = false) {
  let current = url;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublic(current);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), opts.timeout || 15000);
    let r;
    try {
      r = await fetch(current, { ...opts, redirect: 'manual', signal: ctrl.signal });
    } finally { clearTimeout(timer); }
    if (r.status >= 300 && r.status < 400 && r.headers.get('location')) {
      current = new URL(r.headers.get('location'), current).href;
      continue;
    }
    const len = Number(r.headers.get('content-length') || 0);
    if (len > maxBytes) throw new Error('File too large.');
    const chunks = []; let size = 0;
    for await (const c of r.body || []) {
      size += c.length;
      if (size > maxBytes) throw new Error('File too large.');
      chunks.push(c);
    }
    const buf = Buffer.concat(chunks);
    return {
      ok: r.ok, status: r.status, url: current, contentType: r.headers.get('content-type') || '',
      buffer: buf, text: binary ? '' : buf.toString('utf8'),
    };
  }
  throw new Error('Too many redirects.');
}
