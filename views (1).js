// Server-rendered pages for the TryOn dashboard.
export const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

const NICHE = { pet: 'Pet', jewellery: 'Jewellery', clothing: 'Clothing' };
export const SUBS = {
  pet: ['apparel', 'harness', 'collar', 'leash'],
  jewellery: ['necklace', 'earrings', 'ring', 'bracelet', 'watch'],
  clothing: ['top', 'bottom', 'dress', 'outerwear'],
};
const cap = (s) => String(s || '').charAt(0).toUpperCase() + String(s || '').slice(1);

export function layout({ title, user, body, wide }) {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)} · TryOn</title>
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:ital,wght@0,500;0,600;1,500&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/app.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 32 32'><rect width='32' height='32' rx='8' fill='%231e1b18'/><circle cx='22' cy='21' r='3' fill='%23d4af6a'/></svg>">
</head><body>
<header class="top"><div class="wrap ${wide ? 'wide' : ''}">
  <a class="logo" href="${user ? '/app' : '/'}">TryOn<i></i></a>
  <nav>${user ? `<span class="muted hide-sm">${esc(user.email)}</span><form method="post" action="/logout"><button class="link">Log out</button></form>`
    : `<a href="/login">Log in</a><a class="btn sm" href="/signup">Start free</a>`}</nav>
</div></header>
<main class="wrap ${wide ? 'wide' : ''}">${body}</main>
<script src="/app.js"></script>
</body></html>`;
}

export function landing() {
  return `
<section class="hero">
  <p class="eyebrow">AI virtual try-on for online stores</p>
  <h1>Let every shopper see it <em>on them</em> — before they buy.</h1>
  <p class="lead">Jewellery on her. Clothes on him. A coat on their dog. Paste your website, see TryOn on your own products in a minute, then add one line to go live.</p>
  <form class="paste" method="get" action="/signup">
    <input name="url" placeholder="yourstore.com" aria-label="Your website" required>
    <button class="btn">Try it on my store</button>
  </form>
  <div class="niches"><span>💍 Jewellery</span><span>👗 Clothing</span><span>🐕 Pets</span></div>
</section>
<section class="steps3">
  <div><b>1</b><h3>Paste your website</h3><p>We bring in your products automatically — Shopify, WooCommerce, Wix and more.</p></div>
  <div><b>2</b><h3>Preview it live</h3><p>See your own collection with TryOn, exactly as shoppers will.</p></div>
  <div><b>3</b><h3>Add one line</h3><p>Copy one line into your site. Two minutes, no developer.</p></div>
</section>`;
}

export function authPage({ mode, error, email = '', url = '' }) {
  const s = mode === 'signup';
  return `
<section class="card narrow">
  <h1 class="h2">${s ? 'Create your TryOn account' : 'Welcome back'}</h1>
  ${error ? `<p class="err">${esc(error)}</p>` : ''}
  <form method="post" action="/${mode}" class="form">
    ${s ? `<label>Your name<input name="name" autocomplete="name" required></label>` : ''}
    <label>Email<input type="email" name="email" value="${esc(email)}" autocomplete="email" required></label>
    <label>Password<input type="password" name="password" minlength="8" autocomplete="${s ? 'new-password' : 'current-password'}" required></label>
    ${s ? `<label>Your website <span class="muted">(optional)</span><input name="url" value="${esc(url)}" placeholder="yourstore.com"></label>` : ''}
    <button class="btn full">${s ? 'Create account' : 'Log in'}</button>
  </form>
  <p class="muted center">${s ? 'Already have an account? <a href="/login">Log in</a>' : 'New here? <a href="/signup">Create an account</a>'}</p>
</section>`;
}

export function sitesPage({ sites, error, admin }) {
  return `
<div class="row between"><h1 class="h2">Your websites</h1></div>
<form class="paste card" method="post" action="/app/sites" data-busy="Reading your products…">
  <div class="grow"><b>Add a website</b><p class="muted">Paste the store's address — we'll bring in the products automatically.</p></div>
  <input name="url" placeholder="yourstore.com" required aria-label="Website address">
  <button class="btn">Add website</button>
</form>
${error ? `<p class="err">${esc(error)}</p>` : ''}
<div class="sites">
${sites.map((s) => `<a class="card site" href="/app/sites/${s.id}">
  <div><b>${esc(s.name || s.domain)}</b><span class="muted">${esc(s.domain)}${admin && s.owner ? ' · ' + esc(s.owner) : ''}</span></div>
  <div class="tags"><span class="tag">${NICHE[s.niche] || '—'}</span><span class="tag">${s.count} products</span>
  ${s.last_seen_at ? '<span class="tag ok">Live</span>' : '<span class="tag">Not installed</span>'}${s.plan === 'active' ? '<span class="tag gold">Active</span>' : '<span class="tag">Trial</span>'}</div>
</a>`).join('') || '<p class="muted">No websites yet.</p>'}
</div>`;
}

export function sitePage({ site, products, usage, allowance, appUrl, admin, flash }) {
  const snippet = `<script src="${appUrl}/w.js" data-site="${site.key}" async></script>`;
  const included = products.filter((p) => p.include && p.category).length;
  const pct = Math.min(100, Math.round((usage.images / Math.max(1, allowance)) * 100));
  const opt = (p) => {
    const cur = p.include && p.category ? `${p.category}:${p.sub}` : 'off';
    let o = `<option value="off"${cur === 'off' ? ' selected' : ''}>Off</option>`;
    for (const [c, subs] of Object.entries(SUBS)) {
      o += `<optgroup label="${NICHE[c]}">` + subs.map((s) => `<option value="${c}:${s}"${cur === `${c}:${s}` ? ' selected' : ''}>${NICHE[c]} · ${cap(s)}</option>`).join('') + '</optgroup>';
    }
    return o;
  };
  return `
<a class="back" href="/app">← All websites</a>
${flash ? `<p class="flash">${esc(flash)}</p>` : ''}
<div class="row between head">
  <div><h1 class="h2">${esc(site.name || site.domain)}</h1>
  <p class="muted"><a href="${esc(site.url)}" target="_blank" rel="noopener">${esc(site.domain)}</a> · ${esc(cap(site.platform || 'website'))} · ${NICHE[site.niche] || ''} store · ${included} products ready</p></div>
  <a class="btn" href="/preview/${site.key}" target="_blank" rel="noopener">Open live preview ↗</a>
</div>

<div class="grid2">
<section class="card">
  <p class="step">Step 1</p><h2>Preview TryOn on your products</h2>
  <p>Opens a demo of your store with TryOn switched on. Upload a photo and see your collection on you${site.niche === 'pet' ? 'r pet' : ''}.</p>
  <div class="row gap"><a class="btn ghost" href="/preview/${site.key}" target="_blank" rel="noopener">Open preview ↗</a>
  <button class="btn ghost" data-copy="${esc(appUrl + '/preview/' + site.key)}">Copy preview link</button></div>
</section>
<section class="card" id="install" data-site="${site.id}">
  <p class="step">Step 3</p><h2>Installation check</h2>
  <div class="status ${site.last_seen_at ? 'on' : ''}"><i></i><span>${site.last_seen_at ? 'Live on your website' : 'Waiting for your website…'}</span></div>
  <p class="muted small" data-seen>${site.last_seen_at ? 'Last seen on ' + esc(site.last_seen_url || site.domain) : 'Once you add the line below, open your store once and this turns green.'}</p>
</section>
</div>

<section class="card">
  <p class="step">Step 2</p><h2>Add one line to your website</h2>
  <div class="code"><code>${esc(snippet)}</code><button class="btn sm" data-copy="${esc(snippet)}">Copy</button></div>
  <div class="tabs" role="tablist">
    ${['Shopify', 'Wix', 'WooCommerce', 'Squarespace', 'Other'].map((t, i) => `<button role="tab" data-tab="${t}" class="${(site.platform === 'shopify' ? i === 0 : site.platform === 'woocommerce' ? t === 'WooCommerce' : i === 0) ? 'on' : ''}">${t}</button>`).join('')}
  </div>
  <div class="tabpanes">
    <ol data-pane="Shopify"><li>In Shopify admin go to <b>Online Store → Themes</b>.</li><li>Next to your live theme click <b>⋯ → Edit code</b>.</li><li>Open <b>layout/theme.liquid</b>, scroll to the bottom and paste the line just above <code>&lt;/body&gt;</code>.</li><li>Click <b>Save</b>, then open your store once.</li></ol>
    <ol data-pane="Wix"><li>In your Wix dashboard go to <b>Settings → Custom code</b> (under Advanced).</li><li>Click <b>+ Add Custom Code</b> and paste the line.</li><li>Choose <b>All pages</b>, place code in <b>Body – end</b>, then <b>Apply</b>.</li><li>Publish and open your store once.</li></ol>
    <ol data-pane="WooCommerce"><li>In WordPress go to <b>Plugins → Add New</b>, install and activate the free <b>WPCode</b> plugin.</li><li>Go to <b>Code Snippets → + Add Snippet → Add Your Custom Code</b>, type <b>HTML Snippet</b>.</li><li>Paste the line, set Location to <b>Site Wide Footer</b>, switch it <b>Active</b> and save.</li><li>Open your store once.</li></ol>
    <ol data-pane="Squarespace"><li>Go to <b>Settings → Advanced → Code Injection</b> (Business plan or higher).</li><li>Paste the line into the <b>Footer</b> box and <b>Save</b>.</li><li>Open your store once.</li></ol>
    <ol data-pane="Other"><li>Paste the line just before <code>&lt;/body&gt;</code> on every page (most builders have a “footer code” or “custom code” setting).</li><li>Open your store once.</li><li>Stuck? Send this line to whoever manages your website.</li></ol>
  </div>
</section>

<div class="grid2">
<section class="card">
  <h2>Look &amp; feel</h2>
  <form method="post" action="/app/sites/${site.id}/settings" class="form">
    <label>Store name<input name="name" value="${esc(site.name || '')}"></label>
    <label>Button text<input name="button_text" value="${esc(site.button_text || '')}" placeholder="${site.niche === 'pet' ? 'See it on your pet' : 'See it on you'}"></label>
    <div class="row gap">
      <label class="grow">Store type<select name="niche">${Object.entries(NICHE).map(([k, v]) => `<option value="${k}"${site.niche === k ? ' selected' : ''}>${v}</option>`).join('')}</select></label>
      <label>Button colour<input type="color" name="accent" value="${esc(site.accent || '#1e1b18')}"></label>
      <label>Position<select name="position"><option value="right"${site.position !== 'left' ? ' selected' : ''}>Bottom right</option><option value="left"${site.position === 'left' ? ' selected' : ''}>Bottom left</option></select></label>
    </div>
    <label>Pieces per shopper<input type="number" name="per_shopper" min="1" max="24" value="${site.per_shopper}"></label>
    <label class="check"><input type="checkbox" name="enabled" ${site.enabled ? 'checked' : ''}> TryOn is switched on</label>
    <button class="btn">Save</button>
  </form>
</section>
<section class="card">
  <h2>This month</h2>
  <div class="stats"><div><b>${usage.images}</b><span>try-on images</span></div><div><b>${usage.sessions}</b><span>shoppers used it</span></div><div><b>${usage.failed}</b><span>not created</span></div></div>
  <div class="bar"><i style="width:${pct}%"></i></div>
  <p class="muted small">${usage.images} of ${allowance} images used${site.plan !== 'active' ? ' (free trial allowance)' : ''}.</p>
  ${admin ? `<form method="post" action="/app/sites/${site.id}/plan" class="form adm"><p class="step">Admin</p>
    <div class="row gap"><label class="grow">Plan<select name="plan"><option value="trial"${site.plan !== 'active' ? ' selected' : ''}>Trial</option><option value="active"${site.plan === 'active' ? ' selected' : ''}>Active (paid)</option></select></label>
    <label class="grow">Monthly images<input type="number" name="monthly_limit" value="${site.monthly_limit}" min="0"></label></div>
    <label>AI quality<select name="quality"><option value="standard"${site.quality !== 'premium' ? ' selected' : ''}>Standard — Nano Banana 2 (about $0.07 per look)</option><option value="premium"${site.quality === 'premium' ? ' selected' : ''}>Premium — Nano Banana Pro (about $0.14 per look)</option></select></label><button class="btn sm">Update plan</button></form>` : ''}
  <form method="post" action="/app/sites/${site.id}/reimport" data-busy="Refreshing products…"><button class="btn ghost sm">Refresh products from website</button></form>
</section>
</div>

<section class="card">
  <div class="row between"><h2>Products (${products.length})</h2><span class="muted small">Choose what each piece is, or switch it off.</span></div>
  <form method="post" action="/app/sites/${site.id}/products">
  <div class="plist">
  ${products.map((p) => `<div class="prow"><img src="${esc(p.image)}" alt="" loading="lazy"><div class="grow"><b>${esc(p.title)}</b><span class="muted small">${p.price ? esc(p.price) + ' ' + esc(site.currency || '') : ''}</span></div>
    <select name="p_${p.id}" aria-label="Type for ${esc(p.title)}">${opt(p)}</select></div>`).join('')}
  </div>
  <div class="savebar"><button class="btn">Save products</button></div>
  </form>
</section>

<form method="post" action="/app/sites/${site.id}/delete" class="danger" data-confirm="Remove this website from TryOn?"><button class="link red">Remove this website</button></form>`;
}

export function previewPage({ site, products, appUrl }) {
  const cur = site.currency || '';
  const fmt = (p) => p ? (cur === 'USD' || !cur ? '$' : cur + ' ') + Number(p).toLocaleString('en-US', { minimumFractionDigits: 0, maximumFractionDigits: 2 }) : '';
  const word = site.niche === 'pet' ? 'them' : 'you';
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(site.name || site.domain)} — TryOn preview</title>
<link href="https://fonts.googleapis.com/css2?family=Cormorant+Garamond:wght@500;600&family=Inter:wght@400;500;600&display=swap" rel="stylesheet">
<link rel="stylesheet" href="/preview.css"></head><body>
<div class="pbar">Live preview of TryOn on <b>${esc(site.domain)}</b> — your real products, shown in a demo page.</div>
<header class="shop"><span class="brand">${esc(site.name || site.domain)}</span><nav><a>New in</a><a>Collection</a><a>About</a></nav></header>
<section class="hero">
  <p class="eye">The ${site.niche === 'pet' ? 'pet' : site.niche === 'jewellery' ? 'fine jewellery' : ''} collection</p>
  <h1>${site.niche === 'pet' ? 'Made to fit them.' : 'Made to be worn.'}<br>Made for ${word}.</h1>
  <button class="cta" data-tryon-open>See these on ${site.niche === 'pet' ? 'YOUR pet' : 'YOU'}</button>
  <p class="pw">Powered by <b>TryOn</b></p>
  <p class="sub">Upload one photo — see every piece in the collection on ${word}.</p>
</section>
<section class="coll"><div class="ch"><h2>The Collection</h2><span>${products.length} pieces</span></div>
<div class="grid">
${products.map((p) => `<a class="item" data-tryon-product="${p.id}" href="${esc(p.url || '#')}" target="_blank" rel="noopener"><div class="ph"><img src="${esc(p.image)}" alt="${esc(p.title)}"></div><div class="meta"><span>${esc(p.title)}</span><span>${fmt(p.price)}</span></div></a>`).join('')}
</div></section>
<footer>Shop products link to ${esc(site.domain)}.</footer>
<script src="${appUrl}/w.js" data-site="${site.key}" data-preview="1" async></script>
</body></html>`;
}
