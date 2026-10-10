/*! TryOn widget — one line on any store: <script src=".../w.js" data-site="ty_..." async></script> */
(function () {
  'use strict';
  if (window.__tryon) return;
  window.__tryon = true;

  var script = document.currentScript || document.querySelector('script[data-site][src*="w.js"]');
  if (!script) return;
  var SITE = script.getAttribute('data-site');
  var PREVIEW = script.getAttribute('data-preview') === '1';
  var API = new URL(script.src).origin + '/api/w/' + encodeURIComponent(SITE);
  var cfg = null, state = null, shadow = null, root = null, els = {};
  var pollTimer = null;

  // ---------------- small helpers ----------------
  function h(tag, attrs, kids) {
    var e = document.createElement(tag);
    if (attrs) for (var k in attrs) {
      if (k === 'class') e.className = attrs[k];
      else if (k === 'text') e.textContent = attrs[k];
      else if (k.slice(0, 2) === 'on') e.addEventListener(k.slice(2), attrs[k]);
      else if (attrs[k] !== false && attrs[k] != null) e.setAttribute(k, attrs[k] === true ? '' : attrs[k]);
    }
    (kids || []).forEach(function (c) { if (c) e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c); });
    return e;
  }
  function money(p) {
    if (p == null || p === '') return '';
    var n = Number(p);
    if (isNaN(n)) return String(p);
    try { return new Intl.NumberFormat(undefined, { style: 'currency', currency: cfg.currency || 'USD', maximumFractionDigits: n % 1 ? 2 : 0 }).format(n); }
    catch (e) { return n.toLocaleString(); }
  }
  function stem(url) {
    try {
      var u = new URL(url, location.href), f = decodeURIComponent(u.pathname.split('/').pop() || '').toLowerCase();
      f = f.replace(/\.(jpe?g|png|webp|gif|avif)$/, '').replace(/@\dx$/, '')
        .replace(/_(\d+x\d*|x\d+|\d+x)(_crop_\w+)?$/, '').replace(/_(pico|icon|thumb|small|compact|medium|large|grande|original|master)$/, '')
        .replace(/-\d+x\d+$/, '').replace(/-scaled$/, '');
      return f.length >= 2 ? f : null;
    } catch (e) { return null; }
  }
  function api(path, opts) {
    return fetch(API + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) { if (!r.ok) throw new Error(j.error || 'Something went wrong'); return j; });
    });
  }
  var who = function () { return (state && state.name) || (cfg.niche === 'pet' ? 'your pet' : 'you'); };

  // ---------------- saved lookbook (this browser only, 24h) ----------------
  var IDB = 'tryon', STORE = 'looks';
  function idb() {
    return new Promise(function (res, rej) {
      try {
        var r = indexedDB.open(IDB, 1);
        r.onupgradeneeded = function () { r.result.createObjectStore(STORE); };
        r.onsuccess = function () { res(r.result); };
        r.onerror = function () { rej(r.error); };
      } catch (e) { rej(e); }
    });
  }
  function save() {
    if (!state) return;
    var copy = { name: state.name, kind: state.kind, species: state.species, job: state.job, ids: state.ids, looks: state.looks, failed: state.failed, at: state.at, finished: state.finished };
    idb().then(function (d) { d.transaction(STORE, 'readwrite').objectStore(STORE).put(copy, SITE); }).catch(function () {});
  }
  function load() {
    return idb().then(function (d) {
      return new Promise(function (res) {
        var q = d.transaction(STORE).objectStore(STORE).get(SITE);
        q.onsuccess = function () { res(q.result || null); };
        q.onerror = function () { res(null); };
      });
    }).catch(function () { return null; });
  }
  function forget() {
    idb().then(function (d) { d.transaction(STORE, 'readwrite').objectStore(STORE).delete(SITE); }).catch(function () {});
  }

  // ---------------- niche wording ----------------
  function copy() {
    var n = cfg.niche;
    if (n === 'pet') return {
      step1: 'Tell us about your pet', nameLabel: "Your pet's name", namePh: 'e.g. Scooby',
      q: 'Your pet is a…', kinds: [['dog', 'Dog'], ['cat', 'Cat']],
      tips: ['Full body, side-on', 'Standing up', 'Clear and well-lit', 'Plain background'],
      consent: 'I agree to upload a photo of my pet to see these pieces on them. The photo is used only to create these images and is deleted within 24 hours.',
      add: function (nm) { return 'Add a photo of ' + nm; }, ready: function (nm) { return nm + "'s lookbook" }
    };
    if (n === 'jewellery') return {
      step1: 'Tell us about you', nameLabel: 'Your first name', namePh: 'e.g. Sarah',
      q: 'What does your photo show?', kinds: [['face', 'Face'], ['ears', 'Ears'], ['neck', 'Neck'], ['hand', 'Hand']],
      tips: ['Clear and well-lit', 'Facing the camera', 'No sunglasses', 'Plain background'],
      consent: 'I agree to upload my photo to see these pieces on me. My photo is used only to create these images and is deleted within 24 hours.',
      add: function (nm) { return 'Add your photo, ' + nm; }, ready: function (nm) { return nm + "'s lookbook" }
    };
    return {
      step1: 'Tell us about you', nameLabel: 'Your first name', namePh: 'e.g. Alex',
      q: 'What does your photo show?', kinds: [['full', 'Full body'], ['upper', 'Upper body']],
      tips: ['Standing, facing the camera', 'Fitted clothes', 'Clear and well-lit', 'Plain background'],
      consent: 'I agree to upload my photo to see these pieces on me. My photo is used only to create these images and is deleted within 24 hours.',
      add: function (nm) { return 'Add your photo, ' + nm; }, ready: function (nm) { return nm + "'s lookbook" }
    };
  }
  var FITS = { face: null, ears: ['earrings'], neck: ['necklace'], hand: ['ring', 'bracelet', 'watch'], upper: ['top', 'outerwear'], full: null };

  function pickProducts(kind) {
    var allow = FITS[kind] || null;
    var list = cfg.products.filter(function (p) { return !allow || allow.indexOf(p.sub) >= 0; });
    if (!list.length) list = cfg.products.slice();
    var here = location.pathname.replace(/\/$/, '');
    list.sort(function (a, b) {
      var ah = a.url && here && new URL(a.url, location.href).pathname.replace(/\/$/, '') === here ? -1 : 0;
      var bh = b.url && here && new URL(b.url, location.href).pathname.replace(/\/$/, '') === here ? -1 : 0;
      return ah - bh;
    });
    return list.slice(0, cfg.perShopper || 12);
  }
  function product(id) { for (var i = 0; i < cfg.products.length; i++) if (String(cfg.products[i].id) === String(id)) return cfg.products[i]; return null; }

  // ---------------- UI shell ----------------
  function mount() {
    var host = h('div', { id: 'tryon-root' });
    host.style.cssText = 'all:initial;position:fixed;z-index:2147483000;left:0;top:0;width:0;height:0;';
    document.body.appendChild(host);
    shadow = host.attachShadow ? host.attachShadow({ mode: 'open' }) : host;
    var css = h('style', { text: CSS.replace(/__ACCENT__/g, cfg.accent || '#1e1b18') });
    shadow.appendChild(css);
    root = h('div', { class: 'ty' });
    shadow.appendChild(root);

    els.launch = h('button', { class: 'launch ' + (cfg.position === 'left' ? 'left' : ''), type: 'button', onclick: function () { open(); } },
      [h('span', { class: 'spark', text: '✦' }), h('span', { text: cfg.buttonText })]);
    els.chip = h('button', { class: 'chip ' + (cfg.position === 'left' ? 'left' : ''), type: 'button', hidden: true, onclick: function () { open('book'); } });
    root.appendChild(els.launch); root.appendChild(els.chip);

    els.overlay = h('div', { class: 'overlay', hidden: true, onclick: function (e) { if (e.target === els.overlay) close(); } });
    els.modal = h('div', { class: 'modal', role: 'dialog', 'aria-modal': 'true', 'aria-label': 'TryOn' });
    els.overlay.appendChild(els.modal);
    root.appendChild(els.overlay);
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && !els.overlay.hidden) close(); });
    document.addEventListener('click', function (e) {
      var t = e.target.closest && e.target.closest('[data-tryon-open]');
      if (t) { e.preventDefault(); open(); }
      // A product on the page that already has a look: open the big TryOn view instead of leaving the page
      var pr = e.target.closest && e.target.closest('[data-tryon-product]');
      if (pr && state && state.looks[pr.getAttribute('data-tryon-product')]) {
        e.preventDefault();
        els.overlay.hidden = false; document.documentElement.style.overflow = 'hidden';
        showDetail(pr.getAttribute('data-tryon-product'));
      }
    });
  }

  function open(view) {
    els.overlay.hidden = false;
    document.documentElement.style.overflow = 'hidden';
    if (view === 'book' || (state && state.job && !view)) return showBook();
    showStep1();
  }
  function close() {
    els.overlay.hidden = true;
    document.documentElement.style.overflow = '';
    updateChip();
  }
  function frame(kids, opts) {
    opts = opts || {};
    els.modal.className = 'modal' + (opts.wide ? ' wide' : '');
    els.modal.innerHTML = '';
    var x = h('button', { class: 'x', type: 'button', 'aria-label': 'Close', onclick: close, text: '×' });
    els.modal.appendChild(x);
    kids.forEach(function (k) { if (k) els.modal.appendChild(k); });
  }

  // ---------------- step 1: name + photo type ----------------
  var draft = { name: '', kind: null, consent: false, file: null };
  function showStep1() {
    var c = copy();
    if (!draft.kind) draft.kind = c.kinds[0][0];
    var name = h('input', { class: 'in', type: 'text', maxlength: '40', placeholder: c.namePh, value: draft.name, autocomplete: 'given-name' });
    var chips = h('div', { class: 'seg' }, c.kinds.map(function (k) {
      return h('button', { type: 'button', class: draft.kind === k[0] ? 'on' : '', text: k[1], onclick: function (e) {
        draft.kind = k[0]; [].forEach.call(chips.children, function (b) { b.className = ''; }); e.currentTarget.className = 'on';
      } });
    }));
    var box = h('input', { type: 'checkbox', checked: draft.consent || null });
    var err = h('p', { class: 'err', hidden: true });
    var go = h('button', { class: 'primary', type: 'button', text: 'Continue', onclick: function () {
      draft.name = name.value.trim().replace(/[<>]/g, '');
      draft.consent = box.checked;
      if (!draft.name) { err.textContent = 'Please add a name.'; err.hidden = false; name.focus(); return; }
      if (!draft.consent) { err.textContent = 'Please tick the box to continue.'; err.hidden = false; return; }
      showStep2();
    } });
    name.addEventListener('keydown', function (e) { if (e.key === 'Enter') go.click(); });
    frame([
      h('p', { class: 'eyebrow', text: 'Step 1 of 2' }),
      h('h2', { text: c.step1 }),
      h('label', { class: 'lbl', text: c.nameLabel }), name,
      h('label', { class: 'lbl', text: c.q }), chips,
      h('label', { class: 'consent' }, [box, h('span', { text: c.consent })]),
      err, go,
      h('p', { class: 'pw' }, ['Powered by ', h('b', { text: 'TryOn' })]),
    ]);
    setTimeout(function () { name.focus(); }, 30);
  }

  // ---------------- step 2: photo ----------------
  function showStep2() {
    var c = copy();
    var input = h('input', { type: 'file', accept: 'image/*', hidden: true });
    var drop = h('button', { class: 'drop', type: 'button', onclick: function () { input.click(); } }, [
      h('span', { class: 'plus', text: '+' }), h('span', { text: 'Tap to choose a photo' })]);
    var err = h('p', { class: 'err', hidden: true });
    var go = h('button', { class: 'primary', type: 'button', text: 'Create my lookbook', disabled: true });
    function showFile(f) {
      draft.file = f;
      var url = URL.createObjectURL(f);
      drop.innerHTML = ''; drop.classList.add('has');
      drop.appendChild(h('img', { src: url, alt: 'Your photo' }));
      drop.appendChild(h('span', { class: 'change', text: 'Change photo' }));
      go.disabled = false;
    }
    input.addEventListener('change', function () { if (input.files[0]) showFile(input.files[0]); });
    drop.addEventListener('dragover', function (e) { e.preventDefault(); });
    drop.addEventListener('drop', function (e) { e.preventDefault(); if (e.dataTransfer.files[0]) showFile(e.dataTransfer.files[0]); });
    if (draft.file) showFile(draft.file);
    go.addEventListener('click', function () {
      go.disabled = true; go.textContent = 'Uploading…'; err.hidden = true;
      start().catch(function (e) { err.textContent = e.message; err.hidden = false; go.disabled = false; go.textContent = 'Create my lookbook'; });
    });
    frame([
      h('p', { class: 'eyebrow', text: 'Step 2 of 2' }),
      h('h2', { text: c.add(draft.name) }),
      h('div', { class: 'tips' }, c.tips.map(function (t) { return h('span', { text: t }); })),
      drop, input, err, go,
      h('button', { class: 'link', type: 'button', text: 'Back', onclick: showStep1 }),
    ]);
  }

  function prepPhoto(file) {
    var MAX = 1280;
    var draw = function (src, w, hh) {
      var s = Math.min(1, MAX / Math.max(w, hh)), cw = Math.round(w * s), ch = Math.round(hh * s);
      var cv = document.createElement('canvas'); cv.width = cw; cv.height = ch;
      cv.getContext('2d').drawImage(src, 0, 0, cw, ch);
      return { data: cv.toDataURL('image/jpeg', 0.88), w: cw, h: ch };
    };
    if (window.createImageBitmap) {
      return createImageBitmap(file, { imageOrientation: 'from-image' }).then(function (b) { return draw(b, b.width, b.height); })
        .catch(function () { return viaImg(); });
    }
    return viaImg();
    function viaImg() {
      return new Promise(function (res, rej) {
        var img = new Image();
        img.onload = function () { res(draw(img, img.naturalWidth, img.naturalHeight)); };
        img.onerror = function () { rej(new Error('That photo could not be opened — please try a JPG or PNG.')); };
        img.src = URL.createObjectURL(file);
      });
    }
  }

  function start() {
    if (!draft.file) return Promise.reject(new Error('Please choose a photo.'));
    var picks = pickProducts(draft.kind);
    return prepPhoto(draft.file).then(function (ph) {
      return api('/start', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ photo: ph.data, w: ph.w, h: ph.h, name: draft.name, species: cfg.niche === 'pet' ? draft.kind : null, products: picks.map(function (p) { return p.id; }) }),
      });
    }).then(function (r) {
      state = { name: draft.name, kind: draft.kind, job: r.job, ids: r.products.map(String), looks: {}, failed: {}, at: Date.now(), finished: false };
      save();
      showProgress();
      poll();
    });
  }

  function poll() {
    clearTimeout(pollTimer);
    if (!state || state.finished) return;
    var have = Object.keys(state.looks).join(',');
    api('/job/' + state.job + '?have=' + encodeURIComponent(have)).then(function (r) {
      Object.keys(r.items).forEach(function (id) {
        var it = r.items[id];
        if (it.image) state.looks[id] = it.image;
        if (it.status === 'failed') state.failed[id] = true;
      });
      state.finished = r.finished;
      save(); render(); swapPage();
      if (!r.finished) pollTimer = setTimeout(poll, 1200);
    }).catch(function () {
      // job expired or network blip: keep what we have
      pollTimer = setTimeout(function () { if (state && !state.finished) poll(); }, 4000);
    });
  }

  function counts() {
    var done = Object.keys(state.looks).length, fail = Object.keys(state.failed).length;
    return { done: done, fail: fail, total: state.ids.length };
  }
  var view = null;
  function render() { if (view === 'progress') updateProgress(); else if (view === 'book') showBook(true); updateChip(); }

  // ---------------- progress ----------------
  function showProgress() {
    view = 'progress';
    els.pimg = h('div', { class: 'pimg' });
    els.ptext = h('p', { class: 'ptext' });
    els.pbar = h('div', { class: 'pbar' }, [h('i')]);
    els.pbtn = h('button', { class: 'primary', type: 'button', text: 'Browse the lookbook', disabled: true, onclick: function () { showBook(); } });
    frame([els.pimg, els.ptext, els.pbar, els.pbtn]);
    updateProgress();
  }
  function updateProgress() {
    if (!els.pimg || !state) return;
    var c = counts();
    var lastDone = state.ids.filter(function (id) { return state.looks[id]; }).pop();
    var next = state.ids.filter(function (id) { return !state.looks[id] && !state.failed[id]; })[0];
    var show = lastDone || next || state.ids[0];
    var p = product(show);
    var src = state.looks[show] || (p && p.image);
    var cur = els.pimg.querySelector('img');
    if (!cur || cur.getAttribute('data-id') !== String(show) + (state.looks[show] ? 'L' : 'P')) {
      var img = h('img', { src: src, alt: p ? p.title : '', 'data-id': String(show) + (state.looks[show] ? 'L' : 'P') });
      img.style.opacity = '0';
      els.pimg.appendChild(img);
      requestAnimationFrame(function () { img.style.opacity = '1'; });
      setTimeout(function () { while (els.pimg.children.length > 1) els.pimg.removeChild(els.pimg.firstChild); }, 600);
    }
    els.ptext.textContent = c.done + c.fail >= c.total
      ? (c.done ? copy().ready(state.name) + ' is ready' : 'Sorry — we could not create the looks this time.')
      : 'Getting ' + state.name + ' ready… ' + c.done + ' of ' + c.total + ' looks done';
    els.pbar.firstChild.style.width = Math.max(6, ((c.done + c.fail) / c.total) * 100) + '%';
    els.pbtn.disabled = !c.done;
  }

  // ---------------- lookbook ----------------
  function showBook(refresh) {
    view = 'book';
    if (refresh && els.grid && els.modal.contains(els.grid)) return fillGrid();
    var c = counts();
    els.bhead = h('p', { class: 'muted' });
    els.grid = h('div', { class: 'grid' });
    frame([
      h('p', { class: 'eyebrow', text: 'Your lookbook' }),
      h('h2', { text: copy().ready(state.name) }),
      els.bhead, els.grid,
      h('div', { class: 'foot' }, [
        h('button', { class: 'link', type: 'button', text: 'Start over with a new photo', onclick: function () { reset(); showStep1(); } }),
        h('span', { class: 'pw' }, ['Powered by ', h('b', { text: 'TryOn' })]),
      ]),
    ], { wide: true });
    fillGrid();
  }
  function fillGrid() {
    var c = counts();
    els.bhead.textContent = c.done + c.fail >= c.total ? c.done + (c.done === 1 ? ' look' : ' looks') + ' — tap one to see it up close.' : c.done + ' of ' + c.total + ' looks ready — the rest are on their way.';
    els.grid.innerHTML = '';
    state.ids.forEach(function (id) {
      var p = product(id); if (!p) return;
      var look = state.looks[id], fail = state.failed[id];
      var card = h('button', { type: 'button', class: 'card' + (look ? '' : ' wait'), disabled: !look || null, onclick: function () { showDetail(id); } }, [
        h('div', { class: 'ph' }, [h('img', { src: look || p.image, alt: p.title, loading: 'lazy' }), !look ? h('span', { class: 'st', text: fail ? 'Not available' : 'Creating…' }) : null]),
        h('span', { class: 't', text: p.title }), h('span', { class: 'pr', text: money(p.price) }),
      ]);
      els.grid.appendChild(card);
    });
  }
  function showDetail(id) {
    view = 'detail';
    var p = product(id), look = state.looks[id], on = true;
    var img = h('img', { src: look, alt: p.title });
    var tog = h('button', { class: 'tog', type: 'button', onclick: function () {
      on = !on; img.src = on ? look : p.image; tog.textContent = on ? '⇄ Original' : '⇄ On ' + state.name;
    }, text: '⇄ Original' });
    var buy = null;
    if (cfg.platform === 'shopify' && p.variant_id && !PREVIEW) {
      buy = h('button', { class: 'primary', type: 'button', text: 'Add to bag', onclick: function () {
        buy.disabled = true; buy.textContent = 'Adding…';
        fetch('/cart/add.js', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ items: [{ id: Number(p.variant_id), quantity: 1 }] }) })
          .then(function (r) { if (!r.ok) throw 0; buy.textContent = 'Added ✓ View bag'; buy.disabled = false; buy.onclick = function () { location.href = '/cart'; }; })
          .catch(function () { location.href = p.url; });
      } });
    }
    var view_ = p.url ? h('a', { class: buy ? 'secondary' : 'primary', href: p.url, target: PREVIEW ? '_blank' : null, rel: 'noopener', text: 'View product' }) : null;
    frame([
      h('div', { class: 'detail' }, [
        h('div', { class: 'big' }, [img, tog]),
        h('div', { class: 'info' }, [
          h('button', { class: 'link back', type: 'button', text: '← Lookbook', onclick: function () { showBook(); } }),
          h('h2', { text: p.title }), h('p', { class: 'price', text: money(p.price) }),
          buy, view_,
          h('p', { class: 'muted small', text: 'AI preview — colours and size may differ slightly from the real piece.' }),
        ]),
      ]),
    ], { wide: true });
  }
  function reset() {
    clearTimeout(pollTimer); restorePage(); state = null; forget(); draft.file = null; updateChip();
  }

  function updateChip() {
    if (!els.chip) return;
    if (!state || !state.job) { els.chip.hidden = true; els.launch.hidden = false; return; }
    var c = counts();
    els.launch.hidden = true;
    els.chip.hidden = !els.overlay.hidden ? true : false;
    els.chip.innerHTML = '';
    var thumb = state.looks[state.ids.filter(function (id) { return state.looks[id]; })[0]];
    if (thumb) els.chip.appendChild(h('img', { src: thumb, alt: '' }));
    els.chip.appendChild(h('span', { text: copy().ready(state.name) + ': ' + c.done + ' of ' + c.total + ' ready' }));
  }

  // ---------------- show looks right on the store's own product images ----------------
  var swapped = [];
  function swapPage() {
    if (!state) return;
    var map = {};
    state.ids.forEach(function (id) { var p = product(id); var k = p && stem(p.image); if (k && state.looks[id]) map[k] = id; });
    if (!Object.keys(map).length) return;
    var imgs = document.querySelectorAll('img');
    for (var i = 0; i < imgs.length; i++) {
      var im = imgs[i];
      if (im.__ty || im.closest('#tryon-root')) continue;
      var src = im.currentSrc || im.src || (im.getAttribute('srcset') || '').split(' ')[0] || im.getAttribute('data-src');
      var id = map[stem(src)];
      if (!id) continue;
      var r = im.getBoundingClientRect();
      if (r.width && r.width < 120) continue; // skip thumbnails
      swapOne(im, id);
    }
  }
  function swapOne(im, id) {
    var look = state.looks[id], p = product(id);
    im.__ty = { src: im.getAttribute('src'), srcset: im.getAttribute('srcset'), sizes: im.getAttribute('sizes') };
    var pic = im.parentElement && im.parentElement.tagName === 'PICTURE' ? im.parentElement : null;
    if (pic) [].forEach.call(pic.querySelectorAll('source'), function (s) { s.__tySrcset = s.getAttribute('srcset'); s.removeAttribute('srcset'); });
    im.removeAttribute('srcset'); im.src = look;
    var holder = (pic || im).parentElement;
    if (holder && getComputedStyle(holder).position === 'static') holder.style.position = 'relative';
    var on = true;
    var b = document.createElement('button');
    b.type = 'button'; b.className = 'tryon-tog'; b.textContent = '⇄ Original';
    b.addEventListener('click', function (e) {
      e.preventDefault(); e.stopPropagation();
      on = !on; im.src = on ? look : (im.__ty.src || p.image);
      b.textContent = on ? '⇄ Original' : '⇄ On ' + state.name;
    });
    if (holder) holder.appendChild(b);
    swapped.push({ im: im, b: b, pic: pic });
  }
  function restorePage() {
    swapped.forEach(function (s) {
      var o = s.im.__ty; if (!o) return;
      if (o.srcset) s.im.setAttribute('srcset', o.srcset);
      if (o.src) s.im.setAttribute('src', o.src);
      if (s.pic) [].forEach.call(s.pic.querySelectorAll('source'), function (x) { if (x.__tySrcset) x.setAttribute('srcset', x.__tySrcset); });
      s.b.remove(); delete s.im.__ty;
    });
    swapped = [];
  }

  // ---------------- boot ----------------
  function boot() {
    api('/config?page=' + encodeURIComponent(location.href.slice(0, 300))).then(function (c) {
      cfg = c;
      if (!c.enabled || !c.products || !c.products.length) return;
      var page = document.createElement('style');
      page.textContent = '.tryon-tog{position:absolute;left:10px;bottom:10px;z-index:5;font:600 12px/1 system-ui,-apple-system,Segoe UI,sans-serif;background:rgba(255,255,255,.94);color:#1e1b18;border:0;border-radius:999px;padding:7px 11px;box-shadow:0 2px 8px rgba(0,0,0,.15);cursor:pointer}';
      document.head.appendChild(page);
      mount();
      return load().then(function (saved) {
        if (saved && saved.job && Date.now() - saved.at < 24 * 3600e3) {
          state = saved;
          state.ids = state.ids.filter(function (id) { return product(id); });
          if (state.ids.length) { updateChip(); swapPage(); if (!state.finished) poll(); }
          else state = null;
        }
        // product grids that load later (infinite scroll, lazy images)
        var t = null;
        new MutationObserver(function () { clearTimeout(t); t = setTimeout(swapPage, 400); }).observe(document.body, { childList: true, subtree: true });
      });
    }).catch(function (e) { if (window.console) console.warn('[TryOn]', e.message); });
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', boot); else boot();

  // ---------------- styles (kept inside the widget so the store's theme is untouched) ----------------
  var CSS = [
    ':host{all:initial}',
    '.ty{--ink:#1e1b18;--muted:#7a7069;--line:#ebe5dc;--cream:#f7f3ec;--gold:#b8914f;--acc:__ACCENT__;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif;color:var(--ink);-webkit-font-smoothing:antialiased}',
    '.ty *{box-sizing:border-box}',
    '.ty button{font:inherit;cursor:pointer}',
    '[hidden]{display:none!important}',
    '.launch,.chip{position:fixed;right:20px;bottom:20px;display:flex;align-items:center;gap:10px;border:0;border-radius:999px;box-shadow:0 10px 30px rgba(20,15,10,.25);z-index:2}',
    '.launch.left,.chip.left{right:auto;left:20px}',
    '.launch{background:var(--acc);color:#fff;padding:14px 22px 14px 18px;font-weight:600;font-size:15px;letter-spacing:.01em;transition:transform .2s}',
    '.launch:hover{transform:translateY(-2px)}',
    '.spark{color:#e2c48a;font-size:16px}',
    '.chip{background:#b8914f;color:#fff;padding:6px 16px 6px 6px;font-weight:600;font-size:13px}',
    '.chip img{width:34px;height:34px;border-radius:50%;object-fit:cover;border:2px solid rgba(255,255,255,.8)}',
    '.chip:not(:has(img)){padding:10px 16px}',
    '.overlay{position:fixed;inset:0;width:100vw;height:100vh;background:rgba(30,27,24,.45);backdrop-filter:blur(3px);display:flex;align-items:center;justify-content:center;padding:16px;z-index:3}',
    '.modal{position:relative;background:#fff;border-radius:18px;width:100%;max-width:400px;max-height:calc(100vh - 32px);overflow:auto;padding:30px 26px 22px;box-shadow:0 30px 80px rgba(0,0,0,.3);animation:up .35s cubic-bezier(.2,.8,.2,1)}',
    '.modal.wide{max-width:920px}',
    '@keyframes up{from{opacity:0;transform:translateY(16px)}to{opacity:1;transform:none}}',
    '.x{position:absolute;right:12px;top:10px;border:0;background:none;font-size:26px;color:var(--muted);width:36px;height:36px;border-radius:50%;line-height:1}',
    '.x:hover{background:var(--cream)}',
    '.eyebrow{margin:0 0 6px;font-size:11px;letter-spacing:.16em;text-transform:uppercase;color:var(--gold);font-weight:600}',
    'h2{font-family:"Cormorant Garamond","Iowan Old Style",Palatino,Georgia,serif;font-weight:600;font-size:28px;line-height:1.15;margin:0 0 16px}',
    '.lbl{display:block;font-size:13px;font-weight:600;margin:14px 0 6px}',
    '.in{width:100%;border:1px solid #d9d2c7;border-radius:10px;padding:12px 14px;font:inherit;outline:none}',
    '.in:focus{border-color:var(--ink)}',
    '.seg{display:grid;grid-auto-flow:column;grid-auto-columns:1fr;gap:8px}',
    '.seg button{border:1px solid #d9d2c7;background:#fff;border-radius:10px;padding:10px 6px;font-size:14px}',
    '.seg button.on{background:var(--ink);color:#fff;border-color:var(--ink)}',
    '.consent{display:flex;gap:10px;align-items:flex-start;font-size:12.5px;color:var(--muted);margin:16px 0 4px}',
    '.consent input{margin-top:3px;accent-color:var(--ink)}',
    '.primary,.secondary{display:block;width:100%;text-align:center;border-radius:12px;padding:14px;font-weight:600;margin-top:14px;text-decoration:none;font-size:15px}',
    '.primary{background:var(--ink);color:#fff;border:0}',
    '.primary:disabled{background:#cfc9c1;cursor:default}',
    '.secondary{background:#fff;color:var(--ink);border:1px solid var(--ink)}',
    '.link{border:0;background:none;color:var(--muted);text-decoration:underline;font-size:13px;display:block;margin:12px auto 0;padding:4px}',
    '.err{color:#b3261e;font-size:13px;margin:10px 0 0}',
    '.pw{text-align:center;font-size:10.5px;letter-spacing:.14em;text-transform:uppercase;color:var(--muted);margin:14px 0 0}',
    '.pw b{color:var(--ink)}',
    '.tips{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-bottom:14px}',
    '.tips span{background:var(--cream);border-radius:8px;padding:8px 10px;font-size:12.5px}',
    '.tips span:before{content:"✓ ";color:var(--gold);font-weight:700}',
    '.drop{width:100%;min-height:190px;border:1.5px dashed #d0c8bc;background:#fcfaf7;border-radius:14px;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:6px;color:var(--muted);position:relative;overflow:hidden;padding:0}',
    '.drop .plus{font-size:30px;line-height:1;color:var(--gold)}',
    '.drop.has{border-style:solid;min-height:0}',
    '.drop img{width:100%;max-height:300px;object-fit:cover;display:block}',
    '.drop .change{position:absolute;bottom:10px;right:10px;background:rgba(255,255,255,.92);color:var(--ink);font-size:12px;font-weight:600;border-radius:999px;padding:6px 10px}',
    '.pimg{position:relative;aspect-ratio:4/5;border-radius:12px;overflow:hidden;background:var(--cream);margin-top:6px}',
    '.pimg img{position:absolute;inset:0;width:100%;height:100%;object-fit:cover;transition:opacity .6s}',
    '.ptext{font-family:"Cormorant Garamond",Georgia,serif;font-size:19px;text-align:center;margin:16px 0 10px}',
    '.pbar{height:4px;background:var(--line);border-radius:4px;overflow:hidden}',
    '.pbar i{display:block;height:100%;background:var(--gold);transition:width .6s;width:6%}',
    '.muted{color:var(--muted);margin:-8px 0 16px;font-size:14px}',
    '.small{font-size:12px}',
    '.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(200px,1fr));gap:16px}',
    '.card{border:0;background:none;padding:0;text-align:left;display:flex;flex-direction:column;gap:4px;color:inherit}',
    '.card .ph{position:relative;aspect-ratio:4/5;border-radius:12px;overflow:hidden;background:var(--cream)}',
    '.card img{width:100%;height:100%;object-fit:cover;display:block;transition:transform .4s}',
    '.card:not(.wait):hover img{transform:scale(1.03)}',
    '.card.wait img{opacity:.45;filter:grayscale(.3)}',
    '.card .st{position:absolute;left:50%;top:50%;transform:translate(-50%,-50%);background:rgba(255,255,255,.95);border-radius:999px;padding:6px 12px;font-size:12px;font-weight:600;white-space:nowrap}',
    '.card.wait .ph:after{content:"";position:absolute;inset:0;background:linear-gradient(100deg,transparent 30%,rgba(255,255,255,.5) 50%,transparent 70%);background-size:200% 100%;animation:sh 1.4s infinite}',
    '@keyframes sh{from{background-position:150% 0}to{background-position:-50% 0}}',
    '.card .t{font-size:13.5px;font-weight:500;margin-top:6px}',
    '.card .pr{font-size:13px;color:var(--muted)}',
    '.foot{display:flex;justify-content:space-between;align-items:center;margin-top:18px;gap:12px;flex-wrap:wrap}',
    '.foot .link{margin:0}.foot .pw{margin:0}',
    '.detail{display:grid;grid-template-columns:1.1fr 1fr;gap:28px;align-items:start}',
    '.big{position:relative;border-radius:14px;overflow:hidden;background:var(--cream)}',
    '.big img{width:100%;display:block;max-height:72vh;object-fit:cover}',
    '.tog{position:absolute;left:12px;bottom:12px;border:0;background:rgba(255,255,255,.95);border-radius:999px;padding:8px 13px;font-weight:600;font-size:13px;box-shadow:0 2px 10px rgba(0,0,0,.15)}',
    '.info{padding-top:8px}.info h2{margin-top:8px}',
    '.back{margin:0;padding:0}',
    '.price{font-size:18px;margin:0 0 6px}',
    '.info .muted{margin:14px 0 0}',
    '@media (max-width:640px){.overlay{align-items:flex-end;padding:0}.modal{max-width:none!important;border-radius:18px 18px 0 0;max-height:92vh;padding:26px 18px 20px}.detail{grid-template-columns:1fr;gap:12px}.grid{grid-template-columns:1fr 1fr;gap:12px}.launch,.chip{right:14px;bottom:14px}.launch.left,.chip.left{left:14px}}',
  ].join('\n');
})();
