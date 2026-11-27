/**
 * The master page of a saved library (Vid2Study.html). One self-contained file: it opens by double-click from any drive, needs no
 * server and loads nothing from the internet. The saved lectures are linked with relative paths, so the folder can be moved or copied.
 *
 *   - the shelf: one book per subject, a ribbon on each, colour taken from the name so a subject always looks the same
 *   - a contents page per subject: module, category, lecture, with dotted leaders like a printed book
 *   - a sidebar tree with search, and a reader that shows a lecture beside it (or full page)
 *   - recently opened and bookmarks are remembered by this browser (the lectures themselves never depend on it)
 * Without JavaScript the sidebar is still a complete list of links (it is written into the page, then enhanced).
 */
const esc = (value) => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const href = (row) => './' + row.path.map(encodeURIComponent).join('/');
const natural = (a, b) => a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' });

/** subject -> module -> category -> lectures, in reading order. */
export function shelve(entries) {
  const subjects = new Map();
  for (const row of entries) {
    const modules = subjects.get(row.subject) || subjects.set(row.subject, new Map()).get(row.subject);
    const categories = modules.get(row.module) || modules.set(row.module, new Map()).get(row.module);
    (categories.get(row.category) || categories.set(row.category, []).get(row.category)).push(row);
  }
  const sortMap = (map) => new Map([...map.entries()].sort(([a], [b]) => natural(a, b)));
  return new Map([...subjects.entries()].sort(([a], [b]) => natural(a, b)).map(([name, modules]) => [name,
    new Map([...sortMap(modules)].map(([m, cats]) => [m, new Map([...sortMap(cats)].map(([c, rows]) => [c, rows.sort((x, y) => natural(x.title, y.title))]))]))]));
}

const PLAIN = new Set(['General', 'Lectures']);

function staticTree(shelf) {
  let out = '';
  for (const [subject, modules] of shelf) {
    const count = [...modules.values()].flatMap(c => [...c.values()]).reduce((n, rows) => n + rows.length, 0);
    out += '<details class="t-subject"><summary><span>' + esc(subject) + '</span><small>' + count + '</small></summary>';
    for (const [module, cats] of modules) {
      const showModule = !(PLAIN.has(module) && modules.size === 1);
      out += (showModule ? '<div class="t-module"><div class="t-label">' + esc(module) + '</div>' : '<div>');
      for (const [category, rows] of cats) {
        if (!(PLAIN.has(category) && cats.size === 1)) out += '<div class="t-category">' + esc(category) + '</div>';
        out += '<ul>' + rows.map(row => '<li><a href="' + esc(href(row)) + '" data-id="' + esc(row.id) + '">' + esc(row.title) + '</a></li>').join('') + '</ul>';
      }
      out += '</div>';
    }
    out += '</details>';
  }
  return out;
}

const CSS = String.raw`
:root { color-scheme: light dark; --ink:#14232b; --muted:#5b6d75; --paper:#eef2f0; --card:#fbfcfb; --line:#d2dbd8; --wash:#e3ebe8; --teal:#0e6a64; --teal-deep:#0a4f4b; --tint:#d8ebe8; --amber:#e3a21a; --shadow:rgba(20,35,43,.14);
  --serif:"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif; --sans:"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif; }
:root[data-theme=dark] { --ink:#e5eeea; --muted:#9db0a9; --paper:#0f1a1e; --card:#16252a; --line:#27393f; --wash:#1b2c32; --teal:#4cc2b6; --teal-deep:#7fd8ce; --tint:#183a3a; --shadow:rgba(0,0,0,.5); }
@media (prefers-color-scheme: dark) { :root:not([data-theme=light]) { --ink:#e5eeea; --muted:#9db0a9; --paper:#0f1a1e; --card:#16252a; --line:#27393f; --wash:#1b2c32; --teal:#4cc2b6; --teal-deep:#7fd8ce; --tint:#183a3a; --shadow:rgba(0,0,0,.5); } }
* { box-sizing: border-box; }
html, body { height: 100%; }
body { margin: 0; background: var(--paper); color: var(--ink); font: 15px/1.55 var(--sans); }
a { color: inherit; }
:focus-visible { outline: 2px solid var(--teal); outline-offset: 2px; border-radius: 4px; }
button { font: inherit; color: inherit; }
.app { display: grid; grid-template-columns: 19.5rem minmax(0, 1fr); height: 100vh; }

/* sidebar */
.side { display: flex; flex-direction: column; min-height: 0; background: var(--card); border-right: 1px solid var(--line); }
.brand { display: flex; align-items: center; gap: .7rem; padding: 1.1rem 1.1rem .5rem; text-decoration: none; }
.brand svg { width: 30px; height: 36px; flex: none; }
.brand b { display: block; font: 600 1.12rem/1.15 var(--serif); letter-spacing: .005em; }
.brand span { display: block; color: var(--muted); font-size: 12.5px; }
.find { position: relative; margin: .55rem 1.1rem .7rem; }
.find input { width: 100%; padding: .5rem .7rem .5rem 2rem; border: 1px solid var(--line); border-radius: 9px; background: var(--paper); color: var(--ink); font: inherit; font-size: 14px; }
.find svg { position: absolute; left: .65rem; top: 50%; width: 15px; height: 15px; margin-top: -7.5px; stroke: var(--muted); fill: none; stroke-width: 2; stroke-linecap: round; }
.find kbd { position: absolute; right: .55rem; top: 50%; transform: translateY(-50%); padding: 0 .35rem; border: 1px solid var(--line); border-radius: 4px; color: var(--muted); font: 11px var(--sans); }
.tree { flex: 1; overflow-y: auto; padding: 0 .6rem 1.2rem; }
.tree details { margin: 0; }
.t-subject > summary { display: flex; align-items: center; gap: .5rem; padding: .45rem .55rem; border-radius: 8px; cursor: pointer; list-style: none; font: 600 1rem/1.3 var(--serif); }
.t-subject > summary::-webkit-details-marker { display: none; }
.t-subject > summary::before { content: ""; width: .45rem; height: .45rem; border-right: 2px solid var(--muted); border-bottom: 2px solid var(--muted); transform: rotate(-45deg); transition: transform .15s; flex: none; margin: 0 .15rem 0 .05rem; }
.t-subject[open] > summary::before { transform: rotate(45deg); }
.t-subject > summary:hover { background: var(--wash); }
.t-subject > summary span { flex: 1; min-width: 0; }
.t-subject > summary small { color: var(--muted); font: 12px var(--sans); }
.t-module { margin: .15rem 0 .35rem .85rem; padding-left: .55rem; border-left: 1px solid var(--line); }
.t-subject > div { margin: .15rem 0 .35rem .85rem; padding-left: .55rem; border-left: 1px solid var(--line); }
.t-label { margin: .35rem 0 .1rem; color: var(--muted); font-size: 12.5px; font-weight: 600; }
.t-category { margin: .3rem 0 .05rem; color: var(--muted); font-size: 12.5px; }
.tree ul { list-style: none; margin: 0; padding: 0; }
.tree li a { display: block; padding: .28rem .6rem; border-radius: 7px; color: var(--ink); text-decoration: none; font-size: 14px; line-height: 1.35; }
.tree li a:hover { background: var(--wash); }
.tree li a[aria-current=page] { background: var(--teal); color: #fff; }
.tree li[hidden], .tree details[hidden], .t-module[hidden] { display: none; }
.side-foot { display: flex; align-items: center; gap: .4rem; padding: .6rem 1.1rem; border-top: 1px solid var(--line); color: var(--muted); font-size: 12.5px; }
.side-foot span { flex: 1; }
.chip { display: inline-grid; place-items: center; min-width: 2rem; height: 2rem; padding: 0 .55rem; border: 1px solid var(--line); border-radius: 8px; background: var(--card); cursor: pointer; }
.chip:hover { background: var(--wash); }
.chip svg { width: 16px; height: 16px; stroke: currentColor; fill: none; stroke-width: 1.9; stroke-linecap: round; stroke-linejoin: round; }

/* main */
.main { display: flex; flex-direction: column; min-width: 0; min-height: 0; }
.bar { display: flex; align-items: center; gap: .6rem; padding: .6rem 1.2rem; border-bottom: 1px solid var(--line); background: var(--card); min-height: 3.3rem; }
.bar .crumbs { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; color: var(--muted); font-size: 13.5px; }
.bar .crumbs a { text-decoration: none; } .bar .crumbs a:hover { text-decoration: underline; } .bar .crumbs b { color: var(--ink); font-weight: 600; }
.bar .menu { display: none; }
.stage { flex: 1; min-height: 0; overflow-y: auto; }
.reader { display: block; width: 100%; height: 100%; border: 0; background: #fff; }
.page { max-width: 62rem; margin: 0 auto; padding: 2.6rem clamp(1.1rem, 4vw, 3rem) 4rem; }
.hero h1 { margin: 0; font: 600 clamp(2rem, 4vw, 2.9rem)/1.1 var(--serif); letter-spacing: -.01em; }
.hero p { margin: .6rem 0 0; color: var(--muted); max-width: 38rem; }
.go { display: inline-flex; align-items: center; gap: .6rem; margin-top: 1.3rem; padding: .65rem 1.1rem; border-radius: 10px; background: var(--teal); color: #fff; text-decoration: none; font-weight: 600; }
.go:hover { background: var(--teal-deep); }
.go small { display: block; font-weight: 400; opacity: .85; }
h2.sec { margin: 2.6rem 0 1rem; font: 600 1.3rem/1.2 var(--serif); }
.shelf { display: grid; grid-template-columns: repeat(auto-fill, minmax(10.5rem, 1fr)); gap: 1.8rem 1.4rem; }
.book { --c: #0e6a64; position: relative; display: flex; flex-direction: column; justify-content: space-between; aspect-ratio: 3 / 4; padding: 1.2rem 1rem 1rem 1.6rem; border-radius: 3px 9px 9px 3px; color: #fff; text-decoration: none;
  background: linear-gradient(90deg, rgba(0,0,0,.26) 0 .55rem, rgba(255,255,255,.08) .55rem .62rem, transparent .62rem), var(--c);
  box-shadow: 0 1px 0 rgba(255,255,255,.18) inset, 0 8px 16px -8px var(--shadow), 5px 0 0 -1px rgba(255,255,255,.55), 6px 0 0 -1px rgba(0,0,0,.14); transition: transform .18s ease, box-shadow .18s ease; }
.book::before { content: ""; position: absolute; inset: .55rem .55rem .55rem 1.15rem; border: 1px solid rgba(255,255,255,.3); border-radius: 2px 6px 6px 2px; pointer-events: none; }
.book::after { content: ""; position: absolute; top: -5px; right: 1.2rem; width: .95rem; height: 3.1rem; background: var(--amber); clip-path: polygon(0 0, 100% 0, 100% 100%, 50% 80%, 0 100%); filter: drop-shadow(0 2px 1px rgba(0,0,0,.3)); }
.book:hover { transform: translateY(-4px); box-shadow: 0 1px 0 rgba(255,255,255,.18) inset, 0 14px 20px -10px var(--shadow), 5px 0 0 -1px rgba(255,255,255,.55), 6px 0 0 -1px rgba(0,0,0,.14); }
.book h3 { position: relative; margin: .9rem 0 0; font: 600 1.18rem/1.18 var(--serif); overflow-wrap: anywhere; }
.book span { position: relative; font-size: 12.5px; opacity: .9; }
.rows { margin: 0; padding: 0; list-style: none; border-top: 1px solid var(--line); }
.rows li { border-bottom: 1px solid var(--line); }
.rows a { display: flex; gap: 1rem; align-items: baseline; padding: .7rem .3rem; text-decoration: none; }
.rows a:hover b { color: var(--teal); }
.rows b { font-weight: 600; } .rows small { margin-left: auto; color: var(--muted); white-space: nowrap; }
.rows .where { color: var(--muted); font-size: 13px; }
.empty { padding: 3rem 0; color: var(--muted); }
.toc h2 { margin: 2rem 0 .3rem; font: 600 1.4rem/1.2 var(--serif); }
.toc h3 { margin: 1.4rem 0 .2rem; font: 600 1.02rem/1.3 var(--sans); color: var(--muted); }
.toc ol { list-style: none; margin: 0; padding: 0; }
.toc li a { display: flex; align-items: baseline; gap: .5rem; padding: .32rem 0; text-decoration: none; font: 1.05rem/1.4 var(--serif); }
.toc li a::after { content: ""; order: 1; flex: 1; min-width: 1rem; border-bottom: 2px dotted var(--line); transform: translateY(-.25rem); }
.toc li a small { order: 2; color: var(--muted); font: 12.5px var(--sans); }
.toc li a:hover span { color: var(--teal); text-decoration: underline; }
.star { font-size: 1.1rem; line-height: 1; border: 0; background: none; cursor: pointer; color: var(--muted); }
.star[aria-pressed=true] { color: var(--amber); }
.mark { background: var(--amber); color: #14232b; border-radius: 2px; }

@media (max-width: 880px) {
  .app { grid-template-columns: minmax(0, 1fr); }
  .side { position: fixed; inset: 0 auto 0 0; width: min(21rem, 88vw); z-index: 20; transform: translateX(-102%); transition: transform .2s ease; box-shadow: 8px 0 30px var(--shadow); }
  .side.open { transform: none; }
  .bar .menu { display: inline-grid; }
  .scrim { position: fixed; inset: 0; z-index: 10; background: rgba(0,0,0,.35); } .scrim[hidden] { display: none; }
}
@media (prefers-reduced-motion: reduce) { * { transition: none !important; } }
@media print { .side, .bar { display: none; } .app { display: block; height: auto; } }
`;

const JS = String.raw`
(function () {
  var data = JSON.parse(document.getElementById('lib-data').textContent);
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

  function row(e, where) {
    return h('li', {}, h('a', { href: '#/l/' + e.id }, h('b', { text: e.title }), where ? h('span', { class: 'where', text: where }) : null, h('small', { text: when(e.savedAt) })));
  }
  function trail(e) { return [e.subject].concat(plain(e.module) ? [] : [e.module], plain(e.category) ? [] : [e.category]).join(' › '); }

  function home() {
    current = null; document.title = 'Vid2Study library'; crumbs.replaceChildren(h('b', { text: 'Library' }));
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
    current = null; document.title = s.name + ' – Vid2Study library';
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
      h('a', { class: 'chip', href: link(e), title: 'Open this lecture on its own page', text: 'Full page' }));
    var frame = h('iframe', { class: 'reader', title: e.title, src: link(e), sandbox: 'allow-scripts allow-popups allow-downloads allow-modals' });
    stage.replaceChildren(frame); mark();
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
    crumbs.replaceChildren(h('b', { text: 'Search' })); stage.replaceChildren(page);
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
`;

const MARK = '<svg viewBox="0 0 30 36" aria-hidden="true"><path d="M3 4a3 3 0 013-3h20a1 1 0 011 1v29a1 1 0 01-1 1H6a3 3 0 01-3-3z" fill="#0e6a64"/><path d="M3 4a3 3 0 013-3h2v33H6a3 3 0 01-3-3z" fill="#0a4f4b"/><path d="M19 1h6v15l-3-2.6L19 16z" fill="#e3a21a"/><path d="M12 22h10M12 26h7" stroke="#fff" stroke-opacity=".7" stroke-width="1.6" stroke-linecap="round"/></svg>';
const FAVICON = 'data:image/svg+xml,' + encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 30 36"><path d="M3 4a3 3 0 013-3h20a1 1 0 011 1v29a1 1 0 01-1 1H6a3 3 0 01-3-3z" fill="#0e6a64"/><path d="M3 4a3 3 0 013-3h2v33H6a3 3 0 01-3-3z" fill="#0a4f4b"/><path d="M19 1h6v15l-3-2.6L19 16z" fill="#e3a21a"/></svg>');

/** The whole master page for `entries` ({ id, subject, module, category, title, path, savedAt? }). */
export function libraryPage(entries) {
  const shelf = shelve(entries);
  const json = JSON.stringify({ version: 1, entries }).replace(/</g, String.fromCharCode(92) + 'u003c').replace(new RegExp(String.fromCharCode(0x2028) + '|' + String.fromCharCode(0x2029), 'g'), '');
  return '<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">' +
    '<title>Vid2Study library</title><link rel="icon" href="' + FAVICON + '"><style>' + CSS + '</style></head><body>' +
    '<div class="app"><aside class="side" id="side" aria-label="Library"><a class="brand" href="#/" aria-label="Library home">' + MARK + '<div><b>Vid2Study</b><span>Your lecture library</span></div></a>' +
    '<label class="find"><svg viewBox="0 0 24 24" aria-hidden="true"><circle cx="11" cy="11" r="6.5"/><path d="M16 16l5 5"/></svg><input id="find" type="search" placeholder="Search lectures" aria-label="Search lectures" autocomplete="off"><kbd>/</kbd></label>' +
    '<nav class="tree" id="tree" aria-label="Subjects and lectures">' + staticTree(shelf) + '</nav>' +
    '<div class="side-foot"><span>' + entries.length + (entries.length === 1 ? ' lecture' : ' lectures') + '</span><button class="chip" id="theme" type="button" title="Switch between light and dark" aria-label="Switch between light and dark"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 14.5A8 8 0 019.5 4 8 8 0 1020 14.5z"/></svg></button></div></aside>' +
    '<div class="scrim" id="scrim" hidden></div>' +
    '<div class="main"><div class="bar"><button class="chip menu" id="menu" type="button" aria-label="Show the library menu"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h16M4 17h16"/></svg></button><div class="crumbs" id="crumbs"><b>Library</b></div><div id="actions" style="display:flex;gap:.4rem"></div></div>' +
    '<main class="stage" id="stage"><div class="page"><div class="hero"><h1>Your lectures</h1><p>This library needs JavaScript for the reader. The list of lectures on the left still opens each one.</p></div></div></main></div></div>' +
    '<script type="application/json" id="lib-data">' + json + '</script><script>' + JS + '</script></body></html>';
}
