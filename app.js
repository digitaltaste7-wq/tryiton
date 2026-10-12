// Dashboard helpers: copy buttons, platform tabs, busy forms, install check.
document.addEventListener('click', function (e) {
  var c = e.target.closest('[data-copy]');
  if (c) {
    var t = c.getAttribute('data-copy'), old = c.textContent;
    (navigator.clipboard ? navigator.clipboard.writeText(t) : Promise.reject()).catch(function () {
      var a = document.createElement('textarea'); a.value = t; document.body.appendChild(a); a.select(); document.execCommand('copy'); a.remove();
    }).finally(function () { c.textContent = 'Copied ✓'; setTimeout(function () { c.textContent = old; }, 1600); });
  }
  var tab = e.target.closest('[data-tab]');
  if (tab) showTab(tab.getAttribute('data-tab'));
});
function showTab(name) {
  document.querySelectorAll('[data-tab]').forEach(function (b) { b.classList.toggle('on', b.getAttribute('data-tab') === name); });
  document.querySelectorAll('[data-pane]').forEach(function (p) { p.hidden = p.getAttribute('data-pane') !== name; });
}
var first = document.querySelector('[data-tab].on') || document.querySelector('[data-tab]');
if (first) showTab(first.getAttribute('data-tab'));
document.querySelectorAll('form[data-busy]').forEach(function (f) {
  f.addEventListener('submit', function () { var b = f.querySelector('button'); if (b) { b.disabled = true; b.textContent = f.getAttribute('data-busy'); } });
});
document.querySelectorAll('form[data-confirm]').forEach(function (f) {
  f.addEventListener('submit', function (e) { if (!confirm(f.getAttribute('data-confirm'))) e.preventDefault(); });
});
var box = document.getElementById('install');
if (box && !box.querySelector('.status.on')) {
  var iv = setInterval(function () {
    fetch('/app/sites/' + box.getAttribute('data-site') + '/status').then(function (r) { return r.json(); }).then(function (j) {
      if (!j.live) return;
      clearInterval(iv);
      box.querySelector('.status').classList.add('on');
      box.querySelector('.status span').textContent = 'Live on your website';
      box.querySelector('[data-seen]').textContent = 'Last seen on ' + (j.url || '');
    }).catch(function () {});
  }, 5000);
}

// Upload a product photo (resized in the browser first so uploads stay small)
document.querySelectorAll('form[data-photo-form]').forEach(function (f) {
  f.addEventListener('submit', function (e) {
    e.preventDefault();
    var status = f.querySelector('[data-photo-status]'), btn = f.querySelector('button');
    var el = f.elements, file = el.photo.files[0];
    if (!file) return;
    btn.disabled = true; btn.textContent = 'Uploading…'; status.textContent = '';
    var img = new Image();
    img.onload = function () {
      var s = Math.min(1, 1600 / Math.max(img.naturalWidth, img.naturalHeight));
      var c = document.createElement('canvas');
      c.width = Math.round(img.naturalWidth * s); c.height = Math.round(img.naturalHeight * s);
      var ctx = c.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, c.width, c.height);
      ctx.drawImage(img, 0, 0, c.width, c.height);
      fetch('/app/sites/' + f.getAttribute('data-photo-form') + '/add-photo', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ image: c.toDataURL('image/jpeg', 0.9), title: el.title.value, price: el.price.value, url: el.url.value, kind: el.kind.value, gender: el.gender ? el.gender.value : '' }),
      }).then(function (r) { return r.json().then(function (j) { if (!r.ok) throw new Error(j.error || 'Upload failed'); }); })
        .then(function () { location.href = location.pathname + '?added=1#products'; })
        .catch(function (err) { status.textContent = err.message; btn.disabled = false; btn.textContent = 'Upload product'; });
    };
    img.onerror = function () { status.textContent = 'That file could not be opened — please use a JPG or PNG.'; btn.disabled = false; btn.textContent = 'Upload product'; };
    img.src = URL.createObjectURL(file);
  });
});
