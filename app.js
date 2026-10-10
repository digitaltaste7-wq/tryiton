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
