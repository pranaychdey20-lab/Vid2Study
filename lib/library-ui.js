/**
 * The shelf of a saved library: a hero with a rotating stack of subject covers, the lecture table with subject tabs, subject pages,
 * bookmarks, recently opened, search, a sliding sidebar, light / dark, full screen.
 * ONE copy for both places that show a library: the standalone Vid2Study.html (loaded as .vid2study/library.js, no server, works from
 * file://) and the extension page library-open.html. A classic script with no imports: it reads #lib-data, and an optional
 * window.__v2sHost = { open(entry, stage), close(), notes: { list(), open(item, stage) } } shows a lecture in place (with the notes
 * assistant) instead of in the sandboxed reader frame, and adds a "Saved notes" section.
 */
(function () {
  'use strict';
  var data = JSON.parse(document.getElementById('lib-data').textContent);
  var host = window.__v2sHost || {};
  var entries = data.entries, byId = {}, KEY = 'vid2study:library';
  entries.forEach(function (e) { byId[e.id] = e; });
  var $ = function (s, r) { return (r || document).querySelector(s); };
  var natural = function (a, b) { return a.localeCompare(b, undefined, { numeric: true, sensitivity: 'base' }); };
  var reduce = matchMedia('(prefers-reduced-motion: reduce)').matches;

  function add(n, c) {
    if (c == null || c === false) return;
    if (Array.isArray(c)) { c.forEach(function (x) { add(n, x); }); return; }
    n.append(c.nodeType ? c : document.createTextNode(String(c)));
  }
  function h(tag, attrs) {
    var n = document.createElement(tag);
    for (var k in (attrs || {})) {
      var v = attrs[k];
      if (v == null || v === false) continue;
      if (k === 'text') n.textContent = v; else if (k === 'html') n.innerHTML = v; else if (k === 'class') n.className = v; else n.setAttribute(k, v === true ? '' : v);
    }
    for (var i = 2; i < arguments.length; i++) add(n, arguments[i]);
    return n;
  }
  var link = function (e) { return './' + e.path.map(encodeURIComponent).join('/'); };
  var store = (function () { try { return JSON.parse(localStorage.getItem(KEY)) || {}; } catch (x) { return {}; } })();
  store.recent = store.recent || []; store.marks = store.marks || [];
  var save = function () { try { localStorage.setItem(KEY, JSON.stringify(store)); } catch (x) { /* private mode: fine */ } };
  if (store.theme) document.documentElement.setAttribute('data-theme', store.theme);

  var ICONS = {
    home: '<svg viewBox="0 0 24 24"><path d="M4 11l8-6.5L20 11v8a1 1 0 01-1 1h-4.5v-5.5h-5V20H5a1 1 0 01-1-1z"/></svg>',
    star: '<svg viewBox="0 0 24 24"><path d="M12 3.6l2.5 5.2 5.6.8-4.1 4 1 5.6-5-2.7-5 2.7 1-5.6-4.1-4 5.6-.8z"/></svg>',
    clock: '<svg viewBox="0 0 24 24"><circle cx="12" cy="12" r="8.5"/><path d="M12 7.5V12l3 2"/></svg>',
    notes: '<svg viewBox="0 0 24 24"><path d="M6 3.5h9l4 4V20a1 1 0 01-1 1H6a1 1 0 01-1-1V4.5a1 1 0 011-1z"/><path d="M14.5 3.5V8H19M8.5 12.5h7M8.5 16h5"/></svg>',
    bot: '<svg viewBox="0 0 24 24"><rect x="4.5" y="8" width="15" height="11" rx="3"/><path d="M12 4.5V8M9 13v1.5M15 13v1.5"/></svg>',
    back: '<svg viewBox="0 0 24 24"><path d="M15 5l-7 7 7 7"/></svg>',
    prev: '<svg viewBox="0 0 24 24"><path d="M14 6l-6 6 6 6"/></svg>',
    next: '<svg viewBox="0 0 24 24"><path d="M10 6l6 6-6 6"/></svg>',
    full: '<svg viewBox="0 0 24 24"><path d="M4 9V4h5M20 9V4h-5M4 15v5h5M20 15v5h-5"/></svg>',
    exit: '<svg viewBox="0 0 24 24"><path d="M9 4v5H4M15 4v5h5M9 20v-5H4M15 20v-5h5"/></svg>',
    out: '<svg viewBox="0 0 24 24"><path d="M14 4h6v6M20 4l-9 9M18 14v5a1 1 0 01-1 1H5a1 1 0 01-1-1V7a1 1 0 011-1h5"/></svg>'
  };
  var icon = function (name) { return h('span', { html: ICONS[name], style: 'display:contents' }); };

  // subjects in order, each with its lectures in reading order
  var subjects = [], index = {};
  entries.slice().sort(function (a, b) { return natural(a.subject, b.subject) || natural(a.module, b.module) || natural(a.category, b.category) || natural(a.title, b.title); })
    .forEach(function (e) { var s = index[e.subject] || (index[e.subject] = { name: e.subject, rows: [] }, subjects.push(index[e.subject]), index[e.subject]); s.rows.push(e); });
  var PAIRS = [['#ffa24a', '#b8420a'], ['#8b6cff', '#2f1a96'], ['#2dd4bf', '#0b5f58'], ['#f472b6', '#8a1747'], ['#60a5fa', '#1a3fa6'], ['#a3e635', '#3a5a10'], ['#fb7185', '#8e1233'], ['#fbbf24', '#82400a']];
  var pair = function (name) { var n = 0; for (var i = 0; i < name.length; i++) n = (n * 31 + name.charCodeAt(i)) >>> 0; return PAIRS[n % PAIRS.length]; };
  var when = function (t) { return t ? new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' }) : ''; };
  var plain = function (v) { return v === 'General' || v === 'Lectures'; };
  var plural = function (n, one, many) { return n + ' ' + (n === 1 ? one : many); };

  var shell = $('#shell'), stage = $('#stage'), crumbs = $('#crumbs'), side = $('#side'), scrim = $('#scrim'), tree = $('#tree'), find = $('#find'), actions = $('#actions'), nav = $('#nav');
  var current = null, deckTimer = 0, tab = 'All';
  var toastTimer = 0;
  function toast(text) { var t = $('#toast'); t.textContent = text; t.classList.add('show'); clearTimeout(toastTimer); toastTimer = setTimeout(function () { t.classList.remove('show'); }, 3600); }
  function countUp(el, to) {
    if (reduce || to < 2) { el.textContent = to; return; }
    var t0 = performance.now();
    (function step(now) { var k = Math.min(1, (now - t0) / 800); el.textContent = Math.round(to * (1 - Math.pow(1 - k, 3))); if (k < 1) requestAnimationFrame(step); })(t0);
  }

  // ---- shared pieces -------------------------------------------------------------------------------------------------
  function trail(e) { return [e.subject].concat(plain(e.module) ? [] : [e.module], plain(e.category) ? [] : [e.category]).join(' › '); }

  /** rows: [{ id, title, sub, where, when, href, badge }] -> the animated table */
  function table(rows, q) {
    if (!rows.length) return h('div', { class: 'empty', text: q ? 'Nothing here matches “' + q + '”. Try a word from the lecture title or the subject.' : 'Nothing here yet.' });
    var body = h('tbody');
    rows.forEach(function (r, i) {
      var tr = h('tr', { class: 'row', style: '--i:' + Math.min(i, 14) },
        h('td', { text: i + 1 }),
        h('td', {}, h('div', { class: 't-title' }, h('a', { href: r.href }, mark(r.title, q)), r.sub ? h('span', { text: r.sub }) : null)),
        h('td', { class: 'hide-s' }, r.badge ? h('span', { class: 'badge', text: r.badge }) : null),
        h('td', { class: 'hide-s', text: r.when || '' }),
        h('td', {}, h('span', { class: 'go', text: '→' })));
      tr.addEventListener('click', function (ev) { if (!ev.target.closest('a')) location.hash = r.href; });
      body.append(tr);
    });
    return h('table', { class: 'table' }, h('thead', {}, h('tr', {}, h('th', { text: '#' }), h('th', { text: 'Lecture' }), h('th', { class: 'hide-s', text: 'Subject' }), h('th', { class: 'hide-s', text: 'Saved' }), h('th'))), body);
  }
  function mark(text, q) {
    if (!q) return text;
    var at = text.toLowerCase().indexOf(q);
    return at < 0 ? text : [text.slice(0, at), h('span', { class: 'mark', text: text.slice(at, at + q.length) }), text.slice(at + q.length)];
  }
  var rowOf = function (e) { return { title: e.title, sub: trail(e), badge: e.subject, when: when(e.savedAt), href: '#/l/' + e.id }; };

  function fullChip() {
    var on = function () { return shell.classList.contains('full'); };
    var chip = h('button', { class: 'chip', type: 'button', title: 'Full screen', 'aria-label': 'Full screen', 'aria-pressed': String(on()) }, icon('full'));
    function sync() { chip.replaceChildren(icon(on() ? 'exit' : 'full')); chip.setAttribute('aria-pressed', String(on())); chip.title = on() ? 'Exit full screen' : 'Full screen'; }
    chip.addEventListener('click', function () {
      var go = !on();
      shell.classList.toggle('full', go);
      try { if (go && document.documentElement.requestFullscreen) document.documentElement.requestFullscreen().catch(function () {}); else if (!go && document.fullscreenElement) document.exitFullscreen(); } catch (x) { /* the window still fills the page */ }
      sync();
    });
    document.addEventListener('fullscreenchange', function () { if (!document.fullscreenElement && on()) { shell.classList.remove('full'); } sync(); });
    addEventListener('keydown', function (ev) { if (ev.key === 'Escape' && on() && !document.fullscreenElement) { shell.classList.remove('full'); sync(); } });
    return chip;
  }
  var full = fullChip();

  function setReading(on) { shell.classList.toggle('reading', on); crumbs.hidden = !on; }
  function setActions() { actions.replaceChildren.apply(actions, Array.prototype.slice.call(arguments).filter(Boolean).concat([full])); }
  function leave() { clearInterval(deckTimer); if (host.close) host.close(); }
  function page(node) { stage.replaceChildren(node); stage.scrollTop = 0; }

  // ---- views ---------------------------------------------------------------------------------------------------------
  function deck() {
    var n = Math.min(subjects.length, 7), at = 0;
    var cards = subjects.slice(0, n).map(function (s, i) {
      var c = pair(s.name), a = h('a', { class: 'card', href: '#/s/' + i, style: '--c1:' + c[0] + ';--c2:' + c[1] }, h('span', { class: 'tag', text: plural(s.rows.length, 'lecture', 'lectures') }), h('div', {}, h('h3', { text: s.name }), h('span', { text: 'Latest: ' + when(Math.max.apply(null, s.rows.map(function (r) { return r.savedAt || 0; }))) })));
      a.addEventListener('click', function (ev) { if (a.dataset.pos !== '0') { ev.preventDefault(); go(i); } });
      a.addEventListener('pointermove', function (ev) {
        if (a.dataset.pos !== '0' || reduce) return;
        var r = a.getBoundingClientRect(), x = (ev.clientX - r.left) / r.width - .5, y = (ev.clientY - r.top) / r.height - .5;
        a.style.transform = 'translateZ(90px) rotateY(' + (x * 18).toFixed(1) + 'deg) rotateX(' + (-y * 14).toFixed(1) + 'deg) scale(1.12)';
      });
      a.addEventListener('pointerleave', function () { a.style.transform = ''; });
      return a;
    });
    var title = h('b'), sub = h('span'), dashes = h('div', { class: 'dashes' }), root = h('div', { class: 'deckwrap' }, h('div', { class: 'deck' }, cards), h('div', { class: 'deck-meta' }, title, sub), dashes);
    for (var i = 0; i < n; i++) (function (k) { var d = h('i'); d.addEventListener('click', function () { go(k); }); dashes.append(d); })(i);
    function paint() {
      cards.forEach(function (c, i) { var d = (i - at + n) % n; c.dataset.pos = d === 0 ? '0' : d === 1 ? '1' : d === n - 1 ? '-1' : 'far'; });
      title.textContent = subjects[at].name; sub.textContent = plural(subjects[at].rows.length, 'lecture', 'lectures');
      Array.prototype.forEach.call(dashes.children, function (d, i) { d.classList.remove('on'); if (i === at) { void d.offsetWidth; d.classList.add('on'); } });
    }
    function go(i) { at = i; paint(); clearInterval(deckTimer); if (n > 1 && !reduce) deckTimer = setInterval(function () { at = (at + 1) % n; paint(); }, 4800); }
    paint(); go(0);
    root.addEventListener('pointerenter', function () { clearInterval(deckTimer); });
    root.addEventListener('pointerleave', function () { go(at); });
    return root;
  }

  function home() {
    leave(); current = null; setReading(false); document.title = 'Vid2Study library';
    var last = store.recent.map(function (id) { return byId[id]; }).filter(Boolean)[0];
    var stats = h('p');
    var a = h('b', { text: '0' }), b = h('b', { text: '0' });
    add(stats, entries.length ? [a, ' ' + (subjects.length === 1 ? 'subject' : 'subjects') + ' and ', b, ' ' + (entries.length === 1 ? 'lecture' : 'lectures') + ', all stored in this folder. ' + (host.open ? 'Open any of them to read, ask or edit with the assistant.' : 'Everything here opens without internet.')] : 'No lectures saved yet. Save a lecture from Vid2Study with Save as HTML and choose this folder.');
    var cta = h('div', { class: 'cta' });
    if (last) cta.append(h('a', { class: 'btn', href: '#/l/' + last.id }, h('span', {}, h('small', { text: 'Pick up where you left off' }), last.title)));
    else if (entries.length) cta.append(h('a', { class: 'btn', href: '#/l/' + entries[0].id }, 'Open a lecture'));
    if (host.notes) cta.append(h('a', { class: 'btn ghost', href: '#/n' }, 'Saved notes'));
    var root = h('div', { class: 'page' }, h('div', { class: 'hero' }, h('div', {}, h('h1', {}, 'Welcome to your ', h('em', { text: 'Library' })), stats, cta), subjects.length ? deck() : null));
    if (subjects.length) {
      var tabs = h('div', { class: 'tabs', role: 'tablist' }), holder = h('div');
      var names = ['All'].concat(subjects.map(function (s) { return s.name; }));
      if (names.indexOf(tab) < 0) tab = 'All';
      var draw = function () {
        Array.prototype.forEach.call(tabs.children, function (t) { t.setAttribute('aria-selected', String(t.textContent === tab)); });
        var rows = (tab === 'All' ? entries.slice().sort(function (x, y) { return (y.savedAt || 0) - (x.savedAt || 0); }) : index[tab].rows).map(rowOf);
        holder.replaceChildren(table(rows));
      };
      names.forEach(function (name) { var t = h('button', { class: 'tab', type: 'button', role: 'tab', text: name }); t.addEventListener('click', function () { tab = name; draw(); }); tabs.append(t); });
      root.append(h('h2', { class: 'sec' }, 'Lectures', h('small', { text: 'newest first' })), tabs, holder);
      var seen = store.recent.map(function (id) { return byId[id]; }).filter(Boolean).slice(0, 5);
      if (seen.length) root.append(h('h2', { class: 'sec' }, 'Recently opened'), table(seen.map(rowOf)));
      draw();
    }
    page(root); countUp(a, subjects.length); countUp(b, entries.length); markNav();
  }

  function subject(i) {
    var s = subjects[i]; if (!s) return home();
    leave(); current = null; setReading(false); document.title = s.name + ' – Vid2Study library';
    var root = h('div', { class: 'page' }, h('div', { class: 'sub-hero' }, h('h1', { text: s.name }), h('p', { text: plural(s.rows.length, 'lecture', 'lectures') + ' · saved ' + when(Math.max.apply(null, s.rows.map(function (r) { return r.savedAt || 0; }))) })));
    var lastM = null, lastC = null, bucket = [];
    var flush = function () { if (bucket.length) { root.append(table(bucket)); bucket = []; } };
    s.rows.forEach(function (e) {
      if (e.module !== lastM) { flush(); lastM = e.module; lastC = null; if (!plain(e.module)) root.append(h('div', { class: 'mod', text: e.module })); }
      if (e.category !== lastC) { flush(); lastC = e.category; if (!plain(e.category)) root.append(h('div', { class: 'cat', text: e.category })); }
      bucket.push(rowOf(e));
    });
    flush();
    page(root); markNav('s' + i);
  }

  function listOf(ids, label, empty) {
    leave(); current = null; setReading(false); document.title = label + ' – Vid2Study library';
    var rows = ids.map(function (id) { return byId[id]; }).filter(Boolean).map(rowOf);
    page(h('div', { class: 'page' }, h('div', { class: 'sub-hero' }, h('h1', { text: label }), h('p', { text: rows.length ? plural(rows.length, 'lecture', 'lectures') : empty })), rows.length ? table(rows) : null));
    markNav(label);
  }

  function notesList() {
    leave(); current = null; setReading(false); document.title = 'Saved notes – Vid2Study library';
    var root = h('div', { class: 'page' }, h('div', { class: 'sub-hero' }, h('h1', { text: 'Saved notes' }), h('p', { text: 'Notes saved in this browser. They join the library only when you add them with Save as HTML.' })), h('p', { class: 'empty', text: 'Loading…' }));
    page(root); markNav('notes');
    host.notes.list().then(function (items) {
      if (location.hash !== '#/n') return;
      var rows = items.map(function (it) { return { title: it.title, sub: it.sub, badge: it.course || '', when: when(it.createdAt), href: '#/n/' + encodeURIComponent(it.key) }; });
      root.lastChild.replaceWith(rows.length ? table(rows) : h('div', { class: 'empty', text: 'No saved notes yet.' }));
    }, function (err) { root.lastChild.textContent = 'Could not read the saved notes: ' + (err && err.message || err); });
  }

  function reading(crumb, nodes) {
    setReading(true); crumbs.replaceChildren.apply(crumbs, crumb);
    return nodes;
  }

  function lecture(id) {
    var e = byId[id]; if (!e) return home();
    leave(); current = e; document.title = e.title;
    store.recent = [id].concat(store.recent.filter(function (x) { return x !== id; })).slice(0, 12); save();
    var s = index[e.subject], at = s.rows.indexOf(e), prev = s.rows[at - 1], next = s.rows[at + 1];
    reading([h('a', { href: '#/' }, 'Library'), ' › ', h('a', { href: '#/s/' + subjects.indexOf(s) }, e.subject), ' › ', h('b', { text: e.title })]);
    var star = h('button', { class: 'chip star', type: 'button', 'aria-pressed': String(store.marks.indexOf(id) >= 0), title: 'Bookmark this lecture', 'aria-label': 'Bookmark this lecture', text: '★' });
    star.addEventListener('click', function () { var on = store.marks.indexOf(id) < 0; store.marks = on ? store.marks.concat(id) : store.marks.filter(function (x) { return x !== id; }); save(); star.setAttribute('aria-pressed', String(on)); });
    setActions(h('a', { class: 'chip', href: '#/', title: 'Back to the library' }, icon('back'), 'Library'),
      prev ? h('a', { class: 'chip', href: '#/l/' + prev.id, title: 'Previous: ' + prev.title, 'aria-label': 'Previous lecture' }, icon('prev')) : null,
      next ? h('a', { class: 'chip', href: '#/l/' + next.id, title: 'Next: ' + next.title, 'aria-label': 'Next lecture' }, icon('next')) : null, star,
      host.open ? null : h('a', { class: 'chip', href: link(e), title: 'Open this lecture on its own page' }, icon('out'), 'Full page'));
    if (host.open) { stage.replaceChildren(); host.open(e, stage); }
    else stage.replaceChildren(h('iframe', { class: 'reader', title: e.title, src: link(e), sandbox: 'allow-scripts allow-popups allow-downloads allow-modals' }));
    markNav();
  }

  function note(key) {
    leave(); current = null;
    reading([h('a', { href: '#/' }, 'Library'), ' › ', h('a', { href: '#/n' }, 'Saved notes'), ' › ', h('b', { text: 'Opening…' })]);
    setActions(h('a', { class: 'chip', href: '#/n', title: 'Back to the saved notes' }, icon('back'), 'Saved notes'));
    stage.replaceChildren();
    host.notes.open({ key: key }, stage, function (title) { document.title = title; crumbs.lastChild.textContent = title; });
    markNav('notes');
  }

  // ---- sidebar ---------------------------------------------------------------------------------------------------------
  function navLink(id, label, ico, count, href) {
    return h('a', { href: href, 'data-nav': id }, icon(ico), h('span', { text: label }), count != null ? h('small', { text: count }) : null);
  }
  function buildNav() {
    nav.replaceChildren(navLink('home', 'Home', 'home', null, '#/'));
    nav.append(navLink('Bookmarks', 'Bookmarks', 'star', store.marks.filter(function (id) { return byId[id]; }).length, '#/b'));
    nav.append(navLink('Recently opened', 'Recently opened', 'clock', store.recent.filter(function (id) { return byId[id]; }).length, '#/r'));
    if (host.notes) nav.append(navLink('notes', 'Saved notes', 'notes', null, '#/n'));
    if (data.assistant && !host.open) {
      var b = h('button', { type: 'button', title: 'Open this library inside Vid2Study to use the notes assistant' }, icon('bot'), h('span', { text: 'Open with the assistant' }));
      b.addEventListener('click', function () {
        var done = function () { toast('Link copied. Paste it in the address bar to open this library with the assistant (Vid2Study must be installed).'); };
        try { navigator.clipboard.writeText(data.assistant).then(done, function () { toast('Open ' + data.assistant + ' in your browser.'); }); } catch (x) { toast('Open ' + data.assistant + ' in your browser.'); }
      });
      nav.append(b);
    }
  }
  function markNav(id) {
    buildNav();
    nav.querySelectorAll('a[data-nav]').forEach(function (a) { var on = (!id && !current && location.hash.replace('#', '') === '/' && a.dataset.nav === 'home') || a.dataset.nav === id; if (on) a.setAttribute('aria-current', 'page'); });
    if (!id && (location.hash === '' || location.hash === '#/')) { var homeLink = nav.querySelector('[data-nav=home]'); if (homeLink) homeLink.setAttribute('aria-current', 'page'); }
    tree.querySelectorAll('a[data-id]').forEach(function (a) { if (current && a.dataset.id === current.id) { a.setAttribute('aria-current', 'page'); var d = a.closest('details'); if (d) d.open = true; } else a.removeAttribute('aria-current'); });
    if (side.classList.contains('open')) closeSide();
  }

  function route() {
    var parts = location.hash.split('/'), kind = parts[1], rest = parts.slice(2).join('/');
    if (find.value.trim()) { find.value = ''; filter(''); }
    setActions();
    if (kind === 'l') return lecture(decodeURIComponent(rest));
    if (kind === 's') return subject(Number(rest));
    if (kind === 'b') return listOf(store.marks, 'Bookmarks', 'Press ★ on a lecture to keep it here.');
    if (kind === 'r') return listOf(store.recent, 'Recently opened', 'Lectures you open appear here.');
    if (kind === 'n' && host.notes) return rest ? note(decodeURIComponent(rest)) : notesList();
    home();
  }

  // search: narrows the tree, and lists matches on the stage
  function filter(q) {
    q = q.trim().toLowerCase();
    tree.querySelectorAll('li').forEach(function (li) { li.hidden = !!q && li.textContent.toLowerCase().indexOf(q) < 0; });
    tree.querySelectorAll('.t-subject').forEach(function (d) { var any = d.querySelector('li:not([hidden])'); d.hidden = !any; if (q && any) d.open = true; });
    if (!q) return;
    leave(); setReading(false);
    var hits = entries.filter(function (e) { return (e.title + ' ' + e.subject + ' ' + e.module + ' ' + e.category).toLowerCase().indexOf(q) >= 0; });
    page(h('div', { class: 'page' }, h('div', { class: 'sub-hero' }, h('h1', { text: hits.length ? plural(hits.length, 'match', 'matches') : 'No matches' }), h('p', { text: 'for “' + q + '”' })), table(hits.map(rowOf), q)));
  }
  find.addEventListener('input', function () { filter(find.value); });
  find.addEventListener('keydown', function (e) { if (e.key === 'Escape') { find.value = ''; filter(''); route(); } });
  document.addEventListener('keydown', function (e) { if (e.key === '/' && !/INPUT|TEXTAREA|SELECT/.test(document.activeElement.tagName)) { e.preventDefault(); find.focus(); } });

  function openSide() { side.classList.add('open'); scrim.hidden = false; }
  function closeSide() { side.classList.remove('open'); scrim.hidden = true; }
  $('#menu').addEventListener('click', function () { side.classList.contains('open') ? closeSide() : openSide(); }); scrim.addEventListener('click', closeSide);
  $('#theme').addEventListener('click', function () {
    var dark = document.documentElement.getAttribute('data-theme') === 'dark' || (!store.theme && matchMedia('(prefers-color-scheme: dark)').matches) || !document.documentElement.getAttribute('data-theme') && !matchMedia('(prefers-color-scheme: light)').matches;
    store.theme = dark ? 'light' : 'dark'; document.documentElement.setAttribute('data-theme', store.theme); save();
  });
  tree.addEventListener('click', function (e) { var a = e.target.closest('a[data-id]'); if (a) { e.preventDefault(); location.hash = '#/l/' + a.dataset.id; } });
  addEventListener('hashchange', route);
  window.__v2sLibrary = { toast: toast, route: route };
  route();
})();
