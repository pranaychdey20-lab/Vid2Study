/**
 * The shelf of a saved library: subjects, contents pages, the sidebar tree with search, bookmarks and recently opened.
 * ONE copy for both places that show a library: the standalone Vid2Study.html (loaded as .vid2study/library.js, no server, works from
 * file://) and the extension page library-open.html. A classic script with no imports: it reads #lib-data, and an optional
 * window.__v2sHost = { open(entry, stage), close() } shows a lecture in place instead of in the sandboxed reader frame.
 */(function () {
  var data = JSON.parse(document.getElementById('lib-data').textContent);
  // optional hooks from the page that hosts the shelf: open(entry, stage) shows a lecture in place, close() lets it go
  var host = window.__v2sHost || {};
  var entries = data.entries, byId = {}, KEY = 'vid2study:library';
  entries.forEach(function (e) { byId[e.id] = e; });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var natural = function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); };
  function h(tag, attrs) {
    var n = document.createElement(tag);
    for (var k in (attrs || {})) { if (k === 'text') n.textContent = attrs[k]; else if (k === 'class') n.className = attrs[k]; else n.setAttribute(k, attrs[k]); }
    for (var i = 2; i < arguments.length; i++) { var c = arguments[i]; if (c != null) n.append(c.nodeType ? c : document.createTextNode(c)); }
    return n;
  }
  var link = function (e) { return './' + e.path.map(encodeURIComponent).join('/'); };
  var store = (function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (x) { return {}; } })();
  store.recent = store.recent || []; store.marks = store.marks || [];
  var save = function () { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (x) { /* private mode: fine */ } };
  var theme = store.theme; if (theme) document.documentElement.setAttribute('data-theme', theme);

  // subjects in order, each with its lectures in reading order
  var subjects = [], index = {};
  entries.slice().sort(function (a, b) { return natural(a.subject, b.subject) || natural(a.module, b.module) || natural(a.category, b.category) || natural(a.title, b.title); })
    .forEach(function (e) { var s = index[e.subject] || (index[e.subject] = { name: e.subject, rows: [] }, subjects.push(index[e.subject]), index[e.subject]); s.rows.push(e); });
  var hue = function (name) { var n = 0; for (var i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0; return ['#0e6a64', '#2f3e8f', '#8c2f39', '#8a5a12', '#2f6b3a', '#6b3a7d', '#3b5566', '#9a4a1f'][n % 8]; };
  var when = function (t) { return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  var plain = function (v) { return v === 'General' || v === 'Lectures'; };

  var stage = $('#stage'), crumbs = $('#crumbs'), side = $('#side'), scrim = $('#scrim'), tree = $('#tree'), find = $('#find');
  var current = null;

  function leave() { if (host.close) host.close(); }

  function row(e, where) {
    return h('li', {}, h('a', { href: '#/l/' + e.id }, h('b', { text: e.title }), where ? h('span', { class: 'where', text: where }) : null, h('small', { text: when(e.savedAt) })));
  }
  function trail(e) { return [e.subject].concat(plain(e.module) ? [] : [e.module], plain(e.category) ? [] : [e.category]).join(' › '); }

  function home() {
    leave(); current = null; document.title = 'Vid2Study library'; crumbs.replaceChildren(h('b', { text: 'Library' }));
    var last = store.recent.map(function (id) { return byId[id]; }).filter(Boolean)[0];
    var page = h('div', { class: 'page' });
    var hero = h('div', { class: 'hero' }, h('h1', { text: 'Your lectures' }),
      h('p', { text: entries.length ? subjects.length + (subjects.length === 1 ? ' subject' : ' subjects') + ', ' + entries.length + (entries.length === 1 ? ' lecture' : ' lectures') + ', all stored in this folder. Everything here opens without internet.' : 'No lectures saved yet. Save a lecture from Vid2Study with Save as HTML and choose this folder.' }));
    if (last) hero.append(h('a', { class: 'go', href: '#/l/' + last.id }, h('span', {}, h('small', { text: 'Pick up where you left off' }), last.title)));
    page.append(hero);
    if (subjects.length) {
      page.append(h('h2', { class: 'sec', text: 'Subjects' }));
      var shelf = h('div', { class: 'shelf' });
      subjects.forEach(function (s, i) { shelf.append(h('a', { class: 'book', href: '#/s/' + i, style: '--c:' + hue(s.name) }, h('h3', { text: s.name }), h('span', { text: s.rows.length + (s.rows.length === 1 ? ' lecture' : ' lectures') }))); });
      page.append(shelf);
      var fresh = entries.slice().sort(function (a, b) { return (b.savedAt || 0) - (a.savedAt || 0); }).slice(0, 6);
      page.append(h('h2', { class: 'sec', text: 'Recently saved' }), h('ul', { class: 'rows' }, fresh.map(function (e) { return row(e, trail(e)); })));
      var marked = store.marks.map(function (id) { return byId[id]; }).filter(Boolean);
      if (marked.length) page.append(h('h2', { class: 'sec', text: 'Bookmarks' }), h('ul', { class: 'rows' }, marked.map(function (e) { return row(e, trail(e)); })));
      var seen = store.recent.map(function (id) { return byId[id]; }).filter(Boolean).slice(0, 6);
      if (seen.length) page.append(h('h2', { class: 'sec', text: 'Recently opened' }), h('ul', { class: 'rows' }, seen.map(function (e) { return row(e, trail(e)); })));
    }
    stage.replaceChildren(page); stage.scrollTop = 0; mark();
  }

  function subject(i) {
    var s = subjects[i]; if (!s) return home();
    leave(); current = null; document.title = s.name + ' – Vid2Study library';
    crumbs.replaceChildren(h('a', { href: '#/', text: 'Library' }), ' › ', h('b', { text: s.name }));
    var page = h('div', { class: 'page toc' }, h('div', { class: 'hero' }, h('h1', { text: s.name }), h('p', { text: s.rows.length + (s.rows.length === 1 ? ' lecture' : ' lectures') })));
    var lastM = null, lastC = null, list = null;
    s.rows.forEach(function (e) {
      if (e.module !== lastM) { lastM = e.module; lastC = null; if (!(plain(e.module))) page.append(h('h2', { text: e.module })); }
      if (e.category !== lastC || !list) { lastC = e.category; if (!plain(e.category)) page.append(h('h3', { text: e.category })); list = h('ol'); page.append(list); }
      list.append(h('li', {}, h('a', { href: '#/l/' + e.id }, h('span', { text: e.title }), h('small', { text: when(e.savedAt) }))));
    });
    stage.replaceChildren(page); stage.scrollTop = 0; mark();
  }

  function lecture(id) {
    var e = byId[id]; if (!e) return home();
    current = e; document.title = e.title;
    store.recent = [id].concat(store.recent.filter(function (x) { return x !== id; })).slice(0, 12); save();
    var s = index[e.subject], at = s.rows.indexOf(e), prev = s.rows[at - 1], next = s.rows[at + 1];
    crumbs.replaceChildren(h('a', { href: '#/', text: 'Library' }), ' › ', h('a', { href: '#/s/' + subjects.indexOf(s), text: e.subject }), ' › ', h('b', { text: e.title }));
    var bar = $('#actions'); bar.replaceChildren();
    var star = h('button', { class: 'chip star', type: 'button', 'aria-pressed': String(store.marks.indexOf(id) >= 0), title: 'Bookmark this lecture', 'aria-label': 'Bookmark this lecture', text: '★' });
    star.addEventListener('click', function () { var on = store.marks.indexOf(id) < 0; store.marks = on ? store.marks.concat(id) : store.marks.filter(function (x) { return x !== id; }); save(); star.setAttribute('aria-pressed', String(on)); });
    bar.append(prev ? h('a', { class: 'chip', href: '#/l/' + prev.id, title: 'Previous: ' + prev.title, 'aria-label': 'Previous lecture', text: '‹' }) : null, next ? h('a', { class: 'chip', href: '#/l/' + next.id, title: 'Next: ' + next.title, 'aria-label': 'Next lecture', text: '›' }) : null, star,
      host.open ? null : h('a', { class: 'chip', href: link(e), title: 'Open this lecture on its own page', text: 'Full page' }));
    leave();
    if (host.open) { stage.replaceChildren(); host.open(e, stage); }
    else stage.replaceChildren(h('iframe', { class: 'reader', title: e.title, src: link(e), sandbox: 'allow-scripts allow-popups allow-downloads allow-modals' }));
    mark();
  }

  function mark() {
    tree.querySelectorAll('a[data-id]').forEach(function (a) { if (current && a.dataset.id === current.id) { a.setAttribute('aria-current', 'page'); var d = a.closest('details'); if (d) d.open = true; } else a.removeAttribute('aria-current'); });
    if (side.classList.contains('open')) closeSide();
    if (!current) $('#actions').replaceChildren();
  }

  function route() {
    var m = /^#\/(l|s)\/(.+)$/.exec(location.hash);
    if (find.value.trim()) { find.value = ''; filter(''); }
    if (!m) return home();
    if (m[1] === 'l') return lecture(decodeURIComponent(m[2]));
    subject(Number(m[2]));
  }

  // search: narrows the tree, and lists matches on the stage
  function filter(q) {
    q = q.trim().toLowerCase();
    tree.querySelectorAll('li').forEach(function (li) { li.hidden = !!q && li.textContent.toLowerCase().indexOf(q) < 0; });
    tree.querySelectorAll('.t-subject').forEach(function (d) { var any = d.querySelector('li:not([hidden])'); d.hidden = !any; if (q && any) d.open = true; });
    if (!q) return;
    var hits = entries.filter(function (e) { return (e.title + ' ' + e.subject + ' ' + e.module + ' ' + e.category).toLowerCase().indexOf(q) >= 0; });
    var page = h('div', { class: 'page' }, h('div', { class: 'hero' }, h('h1', { text: hits.length ? hits.length + (hits.length === 1 ? ' match' : ' matches') : 'No matches' })));
    page.append(hits.length ? h('ul', { class: 'rows' }, hits.map(function (e) { return row(e, trail(e)); })) : h('p', { class: 'empty', text: 'Nothing in this library matches “' + q + '”. Try a word from the lecture title or the subject.' }));
    leave(); crumbs.replaceChildren(h('b', { text: 'Search' })); stage.replaceChildren(page);
  }
  find.addEventListener('input', function () { filter(find.value); });
  find.addEventListener('keydown', function (e) { if (e.key === 'Escape') { find.value = ''; filter(''); route(); } });
  document.addEventListener('keydown', function (e) { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); find.focus(); } });

  function openSide() { side.classList.add('open'); scrim.hidden = false; }
  function closeSide() { side.classList.remove('open'); scrim.hidden = true; }
  $('#menu').addEventListener('click', openSide); scrim.addEventListener('click', closeSide);
  $('#theme').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!store.theme && matchMedia('(prefers-color-scheme: dark)').matches);
    store.theme = dark ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', store.theme); save();
  });
  tree.addEventListener('click', function (e) { var a = e.target.closest('a[data-id]'); if (a) { e.preventDefault(); location.hash = '#/l/' + a.dataset.id; } });
  addEventListener('hashchange', route);
  route();
})();
