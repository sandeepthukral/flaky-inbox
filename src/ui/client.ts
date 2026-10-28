// Inline browser script; extended by the inbox and message pages.
// No template placeholders inside: plain string concatenation only.
export const clientScript = `
'use strict';
(function () {
  var tbody = document.getElementById('rows');
  var form = document.getElementById('delete-form');
  if (!tbody || !form) return;
  var button = document.getElementById('delete-btn');
  var all = document.getElementById('select-all');
  var confirming = false;
  var loading = false;

  function boxes() {
    return Array.prototype.slice.call(tbody.querySelectorAll('input[name=ids]'));
  }
  function checkedIds() {
    return boxes().filter(function (b) { return b.checked; }).map(function (b) { return b.value; });
  }
  function sync() {
    var list = boxes();
    var n = checkedIds().length;
    button.disabled = n === 0;
    all.checked = list.length > 0 && n === list.length;
  }

  tbody.addEventListener('change', sync);
  all.addEventListener('change', function () {
    boxes().forEach(function (b) { b.checked = all.checked; });
    sync();
  });
  form.addEventListener('submit', function (e) {
    var n = checkedIds().length;
    if (n === 0) { e.preventDefault(); return; }
    confirming = true;
    var ok = window.confirm('Delete ' + n + (n === 1 ? ' mail' : ' mails') + ' and their attachments?');
    confirming = false;
    if (!ok) e.preventDefault();
  });

  function refresh() {
    if (document.visibilityState !== 'visible' || confirming || loading) return;
    loading = true;
    fetch('/rows' + window.location.search, { credentials: 'same-origin' })
      .then(function (res) { return res.ok ? res.text() : null; })
      .then(function (text) {
        if (text === null || confirming) return;
        var remembered = {};
        checkedIds().forEach(function (id) { remembered[id] = true; });
        var tpl = document.createElement('template');
        tpl.innerHTML = text;
        var fresh = tpl.content.querySelector('tbody');
        if (!fresh) return;
        tbody.innerHTML = fresh.innerHTML;
        boxes().forEach(function (b) { if (remembered[b.value]) b.checked = true; });
        sync();
      })
      .catch(function () {})
      .then(function () { loading = false; });
  }
  setInterval(refresh, 10000);
  sync();
})();
`;
