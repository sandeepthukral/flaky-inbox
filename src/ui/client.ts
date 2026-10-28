// Inline browser script; extended by the inbox and message pages.
// No template placeholders inside: plain string concatenation only.
export const clientScript = `
'use strict';
(function () {
  var tabs = document.getElementById('tabs');
  if (tabs) {
    tabs.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('button[data-tab]') : null;
      if (!btn) return;
      Array.prototype.forEach.call(tabs.querySelectorAll('button[data-tab]'), function (b) {
        var on = b === btn;
        b.classList.toggle('active', on);
        var panel = document.getElementById('tab-' + b.getAttribute('data-tab'));
        if (panel) panel.hidden = !on;
      });
    });
  }
  // Dropdowns marked data-autosubmit reload the page as soon as they change.
  Array.prototype.forEach.call(document.querySelectorAll('select[data-autosubmit]'), function (sel) {
    sel.addEventListener('change', function () {
      var f = sel.form;
      if (f.id === 'filter-form') {
        var filter = document.getElementById('inbox-filter');
        if (filter) filter.value = '';
      }
      f.submit();
    });
  });
  var filter = document.getElementById('inbox-filter');
  if (filter) {
    var timer = null;
    var last = filter.value;
    filter.addEventListener('input', function () {
      clearTimeout(timer);
      timer = setTimeout(function () {
        if (filter.value.trim() === last.trim()) return;
        filter.form.submit();
      }, 600);
    });
  }
  var delOne = document.getElementById('delete-message-form');
  if (delOne) {
    delOne.addEventListener('submit', function (e) {
      if (!window.confirm('Delete 1 mail and its attachments?')) e.preventDefault();
    });
  }
  var tbody = document.getElementById('rows');
  var form = document.getElementById('delete-form');
  if (!tbody || !form) return;
  var button = document.getElementById('delete-btn');
  var all = document.getElementById('select-all');
  var bar = document.getElementById('selbar');
  var count = document.getElementById('selcount');
  var clear = document.getElementById('clear-btn');
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
    var n = 0;
    list.forEach(function (b) {
      b.closest('tr').classList.toggle('selected', b.checked);
      if (b.checked) n++;
    });
    button.disabled = n === 0;
    bar.hidden = n === 0;
    count.textContent = n + ' selected';
    all.checked = list.length > 0 && n === list.length;
  }

  // A click anywhere on a row opens the mail; the checkbox cell and real links keep their own behaviour.
  tbody.addEventListener('click', function (e) {
    var t = e.target;
    if (t.closest('a') || t.closest('td.check')) return;
    var tr = t.closest('tr[data-href]');
    if (tr) window.location.href = tr.getAttribute('data-href');
  });
  clear.addEventListener('click', function () {
    boxes().forEach(function (b) { b.checked = false; });
    sync();
  });

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
