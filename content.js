/**
 * Content script (runs only on sites the user enabled; see background.js).
 * - Floating pill that expands to a card on any page with a video: Download / Summarize / Captions.
 * - Lectures drawer when the site adapter can list a course (a university LMS).
 * - Results panel (an iframe of results.html, which reads the cache directly).
 * - YouTube frame capture on request (the page's own player).
 * Site specifics live in adapters/*.js. UI lives in a Shadow DOM so site styles and ours never collide.
 */
(() => {
  if (window.__lectureNotesHelper) return;
  window.__lectureNotesHelper = true;
  // Activity log: forward this page's warnings and errors to the service worker (see lib/log.js)
  {
    const text = (args) => args.map((a) => (a instanceof Error ? a.message : typeof a === 'string' ? a : (() => { try { return JSON.stringify(a); } catch { return String(a); } })())).join(' ');
    const send = (level, args) => { try { chrome.runtime.sendMessage({ type: 'LOG', entry: { t: Date.now(), level, scope: 'content', msg: text(args).slice(0, 600) } })?.catch?.(() => {}); } catch { /* extension reloaded */ } };
    const warn = console.warn.bind(console), error = console.error.bind(console);
    console.warn = (...a) => { warn(...a); send('alert', a); };
    console.error = (...a) => { error(...a); send('error', a); };
    window.addEventListener('error', (e) => send('error', [`Uncaught: ${e.message}`]));
  }
  const U = window.__lhUtil;
  const adapters = window.__lhAdapters || [];
  const site = adapters.find((a) => a.id !== 'generic' && a.match(location)) || null;
  const generic = adapters.find((a) => a.id === 'generic');
  const active = site || generic;
  const scanners = site?.id === 'youtube' ? [site] : [site, generic].filter(Boolean);

  // ---------- state ----------
  /** @type {Map<string, object>} id -> video record (see adapters/util.js) */
  const sources = new Map();
  let selectedId = null;
  let expanded = false;
  let runningKey = null;
  /** cache key -> { id, info } of a summary that is paused because an AI model failed (see SUMMARY_PAUSED) */
  const pausedBy = new Map();
  let capturing = false;
  const cached = new Map(); // cache key -> {cached, title}
  const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: e.message }));
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);

  const current = () => sources.get(selectedId) || null;
  /** Cache key for a video: the clean file URL, `yt:<id>`, or `text:<page>` for unreadable streams. */
  const keyOf = (s) => (s.kind === 'youtube' ? `yt:${s.youtubeId}` : s.kind === 'stream' ? s.pageKey : s.url);
  const titleOf = (s) => (site?.getTitle(s) || generic.getTitle(s)).slice(0, 140);
  const courseName = () => active.getContext().course;

  // ---------- UI ----------
  const host = document.createElement('div');
  host.id = 'lecture-notes-helper-root';
  const root = host.attachShadow({ mode: 'open' });
  root.innerHTML = `
    <link rel="stylesheet" href="${chrome.runtime.getURL('content.css')}">
    <div class="wrap">
      <button class="tab" data-a="dopen" hidden>LECTURES</button>
      <button class="pill btn primary" data-a="expand" hidden>Notes</button>
      <div class="card" hidden>
        <div class="head"><b>Lecture Notes</b><button class="x" data-a="close" title="Minimize" aria-label="Minimize">×</button></div>
        <select class="pick" hidden></select>
        <div class="name"></div>
        <div class="note err" hidden></div>
        <div class="btns">
          <button class="btn" data-a="download">Download</button>
          <button class="btn primary" data-a="ai">Summarize</button>
        </div>
        <div class="btns sub">
          <button class="btn" data-a="captions" title="Uses the captions only. Much cheaper, no screenshots." hidden>Captions</button>
          <button class="btn" data-a="fromfile" hidden>From file</button>
        </div>
        <button class="link regen" data-a="regen" hidden>Regenerate</button>
        <div class="prog" hidden>
          <div class="ptext"></div>
          <div class="bar"><i></i></div>
          <button class="link cancel" data-a="cancel">Cancel</button>
        </div>
        <div class="err msg" hidden></div>
      </div>
      <div class="drawer" hidden>
        <div class="dhead"><b>Lectures</b><button class="x" data-a="dclose" title="Close" aria-label="Close">×</button></div>
        <div class="dsub"><span class="dname"></span><span class="lbl dcount"></span></div>
        <div class="tools">
          <button class="btn" data-a="all">All</button>
          <button class="btn" data-a="none">None</button>
          <button class="btn" data-a="newonly" title="Select every video that has no notes yet">Without notes</button>
          <button class="btn primary" data-a="dlsel">Download selected</button>
          <button class="btn primary" data-a="sumsel">Summarize selected</button>
          <button class="btn" data-a="qcancel">Cancel queue</button>
          <button class="btn" data-a="refresh">Refresh list</button>
          <button class="btn" data-a="fromfile">From file</button>
        </div>
        <div class="list"></div>
      </div>
      <div class="panel" hidden>
        <div class="phead"><span class="ptitle"></span><button class="x" data-a="pclose" title="Close" aria-label="Close">×</button></div>
        <iframe allow="clipboard-write" title="Lecture summary"></iframe>
      </div>
      <div class="banner" hidden>The video is being heard / scanned through this player. Please do not touch it (it plays muted) until it finishes.</div>
    </div>`;
  const $ = (s) => root.querySelector(s);
  const card = $('.card'), pill = $('.pill'), pick = $('.pick'), nameEl = $('.name'), noteEl = $('.note');
  const aiBtn = $('[data-a="ai"]'), dlBtn = $('[data-a="download"]'), capBtn = $('[data-a="captions"]'), fileBtn = $('.card [data-a="fromfile"]');
  const regen = $('.regen'), prog = $('.prog'), ptext = $('.ptext'), bar = $('.bar'), errEl = $('.card .msg');
  const panel = $('.panel'), ptitle = $('.ptitle'), frame = $('iframe');
  const tab = $('.tab'), drawer = $('.drawer'), list = $('.list'), banner = $('.banner');
  (document.body || document.documentElement).appendChild(host);

  const onListRoute = () => !!site?.hasList?.(location);

  function render() {
    const s = current();
    tab.hidden = !onListRoute() || !drawer.hidden || !panel.hidden;
    pill.hidden = !s || expanded;
    card.hidden = !s || !expanded;
    banner.hidden = !capturing;
    if (!s) return;
    pick.hidden = sources.size < 2;
    pick.innerHTML = [...sources.values()].map((v) => `<option value="${esc(v.id)}">${esc(titleOf(v)).slice(0, 60)}</option>`).join('');
    pick.value = selectedId;
    nameEl.textContent = `${titleOf(s)} · ${s.kind === 'youtube' ? 'YouTube' : s.kind === 'stream' ? 'stream' : `${U.fileBase(s.url)}.${U.ext(s.url)}`}`;
    const key = keyOf(s);
    const c = cached.get(key);
    const busy = !!runningKey;
    const stream = s.kind === 'stream';
    noteEl.hidden = !stream;
    noteEl.textContent = stream ? "This player can't be read directly." : '';
    dlBtn.hidden = s.kind !== 'file';
    aiBtn.hidden = stream;
    capBtn.hidden = !s.tracks?.length;
    fileBtn.hidden = !stream;
    const paused = pausedBy.get(key);
    aiBtn.textContent = paused ? 'Fix model & resume' : c?.cached ? 'View' : 'Summarize';
    if (paused) { // an AI model failed in one step: the job waits for the user (a window to change the model is open)
      errEl.hidden = false;
      errEl.textContent = `Paused: ${paused.info.label}. The ${paused.info.slotLabel} (${paused.info.model || 'none'}) did not work: ${paused.info.reason}`;
    }
    aiBtn.disabled = busy && runningKey === key;
    capBtn.disabled = busy;
    regen.hidden = !c?.cached || busy;
    prog.hidden = runningKey !== key;
  }

  /** Fill a progress bar element: determinate when percent is a number, stepped stripe otherwise. */
  function paintBar(barEl, percent) {
    const fill = barEl.querySelector('i');
    if (percent == null) { barEl.classList.add('indet'); fill.style.width = ''; }
    else { barEl.classList.remove('indet'); fill.style.width = `${percent}%`; }
  }
  function setProgress({ percent, text: t }) {
    prog.hidden = false;
    ptext.textContent = t || '';
    paintBar(bar, percent);
  }
  const resetDownloadButton = () => { dlBtn.disabled = false; dlBtn.textContent = 'Download'; };
  function showError(msg) { errEl.hidden = !msg; errEl.textContent = msg || ''; }

  async function refreshCache(s) {
    const key = keyOf(s);
    const r = await send({ type: 'HAS_CACHE', url: key });
    if (!r?.error) cached.set(key, r);
    render();
  }

  function addSource(rec) {
    if (!rec?.id || sources.has(rec.id)) {
      // Refresh captions that appeared later.
      const old = sources.get(rec?.id);
      if (old && rec.tracks?.length && !old.tracks?.length) { old.tracks = rec.tracks; render(); }
      return;
    }
    sources.set(rec.id, { tracks: [], ...rec });
    selectedId = rec.id; // newest wins
    render();
    refreshCache(sources.get(rec.id));
  }

  function openPanel(key, title) {
    ptitle.textContent = title || cached.get(key)?.title || 'Notes';
    frame.src = `${chrome.runtime.getURL('results.html')}?key=${encodeURIComponent(key)}`;
    panel.hidden = false;
    render();
  }

  // ---------- captions ----------
  const parseCaptions = U.parseCaptions; // shared with the YouTube caption fetch (adapters/util.js)

  /** Best-effort caption text for a video that is not a plain captions job ('' when none can be read). */
  async function captionsFor(s) {
    try {
      if (s.kind === 'youtube') {
        // 1. the page's own player loads them (YouTube's token included); 2. the old direct fetch (works for
        // videos that still serve captions without a token). '' = none: the offscreen job tries yt-dlp next.
        const r = await send({ type: 'YT_PAGE_CAPTIONS', videoId: s.youtubeId }).catch(() => null);
        if (r?.text && r.text.length >= 40) return r.text;
        return await U.youtubeCaptions(s.youtubeId).catch(() => '');
      }
      if (s.tracks?.length) {
        const res = await fetch(s.tracks[0].src, { credentials: 'include' });
        return res.ok ? parseCaptions(await res.text()) : '';
      }
    } catch { /* no captions: the extension transcribes the audio itself */ }
    return '';
  }

  // ---------- starting jobs ----------
  /** @param {'video'|'youtube'|'text'} mode */
  async function startSummary(mode, regenerate) {
    showError('');
    const s = current();
    const key = keyOf(s);
    const msg = {
      type: 'START_SUMMARY', mode, url: key, videoUrl: s.url, youtubeId: s.youtubeId, title: titleOf(s), course: courseName(),
      referer: active.refererFor(s.url), withCookies: s.kind === 'file' && site?.id !== 'iitg', regenerate
    };
    if (s.kind === 'youtube') {
      // length decides download-first vs listening for very long videos (offscreen checks it against downloadMaxHours)
      const d = document.querySelector('video')?.duration;
      if (Number.isFinite(d) && d > 0) msg.durationSec = Math.round(d);
    }
    if (mode === 'text') {
      try {
        const res = await fetch(s.tracks[0].src, { credentials: 'include' });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        msg.transcript = parseCaptions(await res.text());
        if (msg.transcript.length < 40) throw new Error('the captions are empty');
      } catch (e) { return showError(`Could not read the captions: ${e.message}`); }
    } else {
      // Captions (when the page has them) replace speech recognition; the video itself is still scanned for slides.
      const tx = await captionsFor(s);
      if (tx.length >= 40) msg.transcript = tx;
    }
    const r = await send(msg);
    if (r?.error) return showError(r.error);
    runningKey = key;
    setProgress({ percent: null, text: 'Queued' });
    render();
  }

  // ---------- Lectures drawer ----------
  /** @type {null | {id:string,name:string,lectures:Array}} */ let course = null;
  const checked = new Set();
  /** url -> {saved, summary, item} from the service worker */
  let states = {};
  /** key -> latest PROGRESS message */
  const live = new Map();
  let drawerError = '';
  let refreshTimer = 0;
  const STAGES = { fetch: 'FETCH', source: 'SOURCE', transcribe: 'LISTEN', scenes: 'SLIDES', ocr: 'OCR', vision: 'DIAGRAMS', extract: 'WATCH', upload: 'UPLOAD', processing: 'PROCESSING', frames: 'FRAMES', notes: 'NOTES', final: 'FINISH', done: 'DONE' };

  async function openDrawer(force) {
    drawer.hidden = false;
    panel.hidden = true;
    render();
    list.innerHTML = '<div class="msg lbl">Loading...</div>';
    try { course = await site.listLectures(force); drawerError = ''; } catch (e) { drawerError = e.message; }
    drawRows();
    refreshStates();
  }

  function refreshStates() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      if (drawer.hidden || !course) return;
      const r = await send({ type: 'GET_STATES', urls: course.lectures.map((l) => l.url) });
      if (r?.states) { states = r.states; drawRows(); }
    }, 250);
  }

  /** What a row should say, from queue item + stores + live progress. */
  function rowInfo(l) {
    const st = states[l.url] || {};
    const it = st.item;
    const lv = live.get(l.url);
    const info = { tags: [], active: false, percent: null, line: '', err: '' };
    if (it?.status === 'queued') info.tags.push({ t: 'QUEUED', on: true });
    else if (it?.status === 'running') {
      info.active = true;
      if (it.kind === 'download') {
        info.percent = lv?.stage === 'download' ? lv.percent : null;
        info.tags.push({ t: `DOWNLOADING${info.percent != null ? ` ${info.percent}%` : ''}`, on: true });
      } else {
        info.percent = lv && lv.stage !== 'download' ? lv.percent : null;
        info.tags.push({ t: `SUMMARIZING ${STAGES[lv?.stage] || ''}`.trim(), on: true });
      }
      info.line = lv?.text || '';
    } else if (it?.status === 'paused') {
      info.tags.push({ t: 'PAUSED: MODEL DID NOT WORK', bad: true });
      info.err = it.message || 'A model failed.';
    } else if (it?.status === 'error') {
      info.tags.push({ t: 'ERROR', bad: true });
      info.err = it.message;
    } else if (it?.status === 'cancelled') info.tags.push({ t: 'CANCELLED' });
    if (!info.active) {
      if (st.saved) info.tags.push({ t: 'SAVED' });
      if (st.summary) info.tags.push({ t: 'SUMMARY READY' });
      if (!st.saved && !st.summary && !it) info.tags.push({ t: 'NOT SAVED' });
    }
    return info;
  }

  function drawRows() {
    $('.dname').textContent = course?.name || '';
    $('.dcount').textContent = course ? `${course.lectures.length} videos` : '';
    if (drawerError) { list.innerHTML = `<div class="msg err">${esc(drawerError)}</div>`; return; }
    if (!course) { list.innerHTML = '<div class="msg lbl">Open a course page.</div>'; return; }
    if (!course.lectures.length) { list.innerHTML = '<div class="msg lbl">No videos in this course.</div>'; return; }
    const scroll = list.scrollTop;
    let html = '';
    let lastMod = null, lastChap = null;
    course.lectures.forEach((l, i) => {
      if (l.module !== lastMod) {
        // one click selects the whole week / module for bulk notes
        const all = course.lectures.filter((x) => x.module === l.module);
        const on = all.length && all.every((x) => checked.has(x.url));
        html += `<h3 class="mod"><label style="cursor:pointer;display:flex;gap:6px;align-items:center"><input type="checkbox" data-a="modchk" data-i="${i}" ${on ? 'checked' : ''} aria-label="Select this whole section">${esc(l.module)} <span class="lbl" style="font-weight:normal">(${all.length})</span></label></h3>`;
        lastMod = l.module; lastChap = null;
      }
      if (l.chapter && l.chapter !== lastChap) { html += `<h4 class="chap">${esc(l.chapter)}</h4>`; lastChap = l.chapter; }
      const f = rowInfo(l);
      const st = states[l.url] || {};
      const busy = f.active || st.item?.status === 'queued';
      html += `<div class="row${f.active ? ' active' : ''}" data-i="${i}">
        <input type="checkbox" data-a="chk" ${checked.has(l.url) ? 'checked' : ''} aria-label="Select">
        <div class="rtitle">${esc(l.title)}<span class="rdur">${esc(l.duration)}</span></div>
        <div class="rstat">${f.tags.map((t) => `<span class="tag${t.on ? ' on' : ''}${t.bad ? ' bad' : ''}">${esc(t.t)}</span>`).join('')}</div>
        ${f.active ? `<div class="bar${f.percent == null ? ' indet' : ''}"><i style="width:${f.percent ?? 0}%"></i></div><div class="rline">${esc(f.line)}</div>` : ''}
        ${f.err ? `<div class="rerr err">${esc(f.err)}</div>` : ''}
        <div class="rbtns">
          <button class="btn" data-a="rdl" ${busy ? 'disabled' : ''}>${st.item?.status === 'error' && st.item.kind === 'download' ? 'Retry' : 'Download'}</button>
          <button class="btn" data-a="rsum" ${busy ? 'disabled' : ''}>${st.item?.status === 'paused' ? 'Fix model' : st.item?.status === 'error' && st.item.kind === 'summary' ? 'Retry' : 'Summarize'}</button>
          ${st.summary ? '<button class="btn" data-a="rview">View</button>' : ''}
        </div>
      </div>`;
    });
    list.innerHTML = html;
    list.scrollTop = scroll;
    showCount();
  }

  /** "Summarize selected (N)": how many of the ticked videos still need notes. */
  function showCount() {
    const sel = course ? course.lectures.filter((l) => checked.has(l.url)) : [];
    const todo = sel.filter((l) => !states[l.url]?.summary && !['queued', 'running'].includes(states[l.url]?.item?.status)).length;
    $('[data-a="sumsel"]').textContent = sel.length ? `Summarize selected (${todo}${todo !== sel.length ? ` of ${sel.length}` : ''})` : 'Summarize selected';
    $('[data-a="dlsel"]').textContent = sel.length ? `Download selected (${sel.length})` : 'Download selected';
  }

  /** Queue downloads or summaries for lectures (skips what is already saved / summarized). */
  async function enqueue(kind, lectures) {
    const items = lectures
      .filter((l) => (kind === 'download' ? !states[l.url]?.saved : !states[l.url]?.summary))
      .map((l) => ({ url: l.url, kind, mode: 'video', videoUrl: l.url, title: l.title, course: course.name, filename: l.filename, referer: site.refererFor(l.url) }));
    if (!items.length) return;
    const r = await send({ type: 'ENQUEUE', items });
    drawerError = r?.error || '';
    refreshStates();
    if (drawerError) drawRows();
  }

  // ---------- events ----------
  root.addEventListener('click', async (e) => {
    const el = e.target.closest('[data-a]');
    const a = el?.dataset.a;
    if (!a) return;
    const rowL = () => course?.lectures[Number(el.closest('.row')?.dataset.i)];
    const s = current();
    if (a === 'expand') { expanded = true; render(); }
    else if (a === 'close') { expanded = false; render(); }
    else if (a === 'pclose') { panel.hidden = true; frame.src = 'about:blank'; render(); }
    else if (a === 'dopen') openDrawer(false);
    else if (a === 'dclose') { drawer.hidden = true; render(); }
    else if (a === 'refresh') openDrawer(true);
    else if (a === 'all') { course?.lectures.forEach((l) => checked.add(l.url)); drawRows(); }
    else if (a === 'none') { checked.clear(); drawRows(); }
    else if (a === 'chk') { const l = rowL(); if (l) el.checked ? checked.add(l.url) : checked.delete(l.url); drawRows(); }
    else if (a === 'modchk') {
      const mod = course?.lectures[Number(el.dataset.i)]?.module;
      course?.lectures.filter((l) => l.module === mod).forEach((l) => (el.checked ? checked.add(l.url) : checked.delete(l.url)));
      drawRows();
    }
    else if (a === 'newonly') { checked.clear(); course?.lectures.forEach((l) => { if (!states[l.url]?.summary) checked.add(l.url); }); drawRows(); }
    else if (a === 'dlsel') enqueue('download', course.lectures.filter((l) => checked.has(l.url)));
    else if (a === 'sumsel') enqueue('summary', course.lectures.filter((l) => checked.has(l.url)));
    else if (a === 'qcancel') { await send({ type: 'CANCEL' }); refreshStates(); }
    else if (a === 'fromfile') send({ type: 'OPEN_LOCAL' });
    else if (a === 'rdl') { const l = rowL(); if (l) enqueue('download', [l]); }
    else if (a === 'rsum') {
      const l = rowL();
      const it = l && states[l.url]?.item;
      if (it?.status === 'paused') send({ type: 'OPEN_MODEL_FIX', id: it.id }); // a model failed: change it in the pop-up window
      else if (l) enqueue('summary', [l]);
    }
    else if (a === 'rview') {
      const l = rowL();
      if (l) { cached.set(l.url, { cached: true, title: l.title }); openPanel(l.url, l.title); }
    }
    else if (a === 'download' && s) {
      showError('');
      const filename = site?.filenameFor?.(s) || `Lectures/${U.sanitize(courseName(), 'Videos')}/${U.sanitize(titleOf(s), U.fileBase(s.url))}.${U.ext(s.url)}`;
      dlBtn.disabled = true;
      dlBtn.textContent = 'Queued';
      const r = await send({ type: 'START_DOWNLOAD', url: s.url, filename, title: titleOf(s), referer: active.refererFor(s.url), withCookies: site?.id !== 'iitg' });
      if (r?.error) { showError(`Download failed: ${r.error}`); resetDownloadButton(); }
    }
    else if (a === 'ai' && s) {
      if (pausedBy.has(keyOf(s))) { const r = await send({ type: 'OPEN_MODEL_FIX', id: pausedBy.get(keyOf(s)).id }); if (r?.error) { pausedBy.delete(keyOf(s)); showError(r.error); render(); } }
      else if (cached.get(keyOf(s))?.cached) openPanel(keyOf(s), cached.get(keyOf(s)).title);
      else startSummary(s.kind === 'youtube' ? 'youtube' : 'video', false);
    }
    else if (a === 'captions' && s) startSummary('text', !!cached.get(keyOf(s))?.cached);
    else if (a === 'regen' && s) { e.preventDefault(); startSummary(s.kind === 'youtube' ? 'youtube' : s.tracks?.length && s.kind === 'stream' ? 'text' : 'video', true); }
    else if (a === 'cancel') { ptext.textContent = 'Cancelling...'; send({ type: 'CANCEL' }); }
  });

  pick.addEventListener('change', () => { selectedId = pick.value; showError(''); render(); refreshCache(current()); });

  // Drag the card by its header.
  $('.head').addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = card.getBoundingClientRect();
    const dx = e.clientX - r.left, dy = e.clientY - r.top;
    const move = (ev) => {
      card.style.left = `${Math.max(0, Math.min(innerWidth - r.width, ev.clientX - dx))}px`;
      card.style.top = `${Math.max(0, Math.min(innerHeight - 40, ev.clientY - dy))}px`;
      card.style.right = 'auto';
      card.style.bottom = 'auto';
    };
    const up = () => { removeEventListener('pointermove', move); removeEventListener('pointerup', up); };
    addEventListener('pointermove', move);
    addEventListener('pointerup', up);
  });

  // ---------- messages from the service worker ----------
  chrome.runtime.onMessage.addListener((msg, _sender, reply) => {
    // Frame capture for YouTube: the worker page asks, through the service worker, for frames of this page's player.
    if (msg?.type === 'CAPTURE_PING') { reply({ ok: true }); return false; } // the helper window asks if we are loaded
    if (msg?.type?.startsWith('CAPTURE_')) {
      const cap = site?.capture;
      (async () => {
        if (!cap) throw new Error('This page cannot be captured.');
        // msg.helper: this is the separate helper window, not the tab the viewer watches: no banner needed
        if (msg.type === 'CAPTURE_BEGIN') { const r = await cap.begin(); capturing = !msg.helper; render(); return { ok: true, ...r }; }
        if (msg.type === 'CAPTURE_FRAME') return { ok: true, ...(await cap.frame(msg.t, msg.maxWidth)) };
        if (msg.type === 'CAPTURE_AUDIO_BEGIN') {
          const r = await cap.listen(msg.rate, (m) => chrome.runtime.sendMessage({ target: 'offscreen', ...m, bg: !!msg.helper }).catch(() => {}),
            { sampleEvery: msg.sampleEvery, maxWidth: msg.maxWidth, maxSamples: msg.maxSamples });
          capturing = !msg.helper; render();
          return { ok: true, ...r };
        }
        if (msg.type === 'CAPTURE_AUDIO_STOP') { cap.stopListening(); return { ok: true }; }
        capturing = false; render();
        await cap.end(!!msg.helper);
        return { ok: true };
      })().then(reply, (e) => { capturing = false; render(); reply({ ok: false, error: e.message || String(e) }); });
      return true;
    }
    switch (msg?.type) {
      case 'VIDEO_FOUND': addNetworkVideo(msg.url); break;
      case 'RESCAN': scanAll(); reply?.({ ok: true }); break;
      case 'QUEUE_CHANGED': refreshStates(); break;
      case 'DOWNLOAD_STATUS': {
        const s = current();
        if (msg.url && s && msg.url !== s.url) break;
        if (msg.state === 'saving') dlBtn.textContent = 'Saving';
        else if (msg.state === 'done') { dlBtn.textContent = 'Saved'; setTimeout(resetDownloadButton, 3000); }
        else { showError(`Download failed: ${msg.message || 'unknown error'}`); resetDownloadButton(); }
        break;
      }
      case 'SUMMARY_PAUSED':
        runningKey = null;
        pausedBy.set(msg.url, { id: msg.id, info: msg.info });
        if (current() && msg.url === keyOf(current())) expanded = true; // make sure the card is open where the user can see it
        render();
        break;
      case 'SUMMARY_RESUMED':
        pausedBy.delete(msg.url);
        showError('');
        runningKey = msg.url;
        setProgress({ percent: null, text: 'Resuming with the new settings' });
        render();
        refreshStates();
        break;
      case 'PROGRESS':
        pausedBy.delete(msg.url);
        live.set(msg.url, msg);
        if (!drawer.hidden) drawRowsSoon();
        if (msg.stage === 'download') { if (current() && msg.url === current().url) dlBtn.textContent = msg.percent != null ? `${msg.percent}%` : 'Fetching'; break; }
        runningKey = msg.url;
        if (current() && msg.url === keyOf(current())) { setProgress(msg); render(); }
        break;
      case 'SUMMARY_DONE':
        runningKey = null;
        pausedBy.delete(msg.url);
        cached.set(msg.url, { cached: true, title: msg.title });
        render();
        if (current() && msg.url === keyOf(current())) { if (drawer.hidden) openPanel(msg.url, msg.title); }
        // The page moved on (e.g. YouTube autoplay went to the next video): still show the finished notes.
        else if (panel.hidden) openPanel(msg.url, msg.title);
        break;
      case 'SUMMARY_ERROR':
        runningKey = null;
        pausedBy.delete(msg.url);
        if (current() && msg.url === keyOf(current())) expanded = true; // a failure must be seen, not hidden behind the minimised pill
        render();
        if (current() && msg.url === keyOf(current())) showError(msg.message);
        else showError(`Notes for an earlier video failed: ${msg.message}`);
        break;
    }
    return false;
  });

  let drawTimer = 0;
  /** PROGRESS can arrive several times a second; repaint the rows at most every 400 ms. */
  function drawRowsSoon() {
    if (drawTimer) return;
    drawTimer = setTimeout(() => { drawTimer = 0; drawRows(); }, 400);
  }

  // ---------- detection ----------
  function addNetworkVideo(url) {
    if (site?.id === 'youtube') return;
    if (U.isFile(url)) addSource({ id: U.cleanUrl(url), kind: 'file', url: U.cleanUrl(url), title: '' });
    else if (U.isStream(url)) addSource({ id: `stream:${U.cleanUrl(url)}`, kind: 'stream', url, title: '', pageKey: `text:${U.cleanUrl(location.href)}` });
  }
  function scanAll() {
    for (const a of scanners) {
      try { a.getVideos().forEach(addSource); } catch { /* an adapter must never break the page */ }
    }
  }
  // Media events don't bubble, but they do reach capture listeners.
  document.addEventListener('loadstart', (e) => { if (e.target instanceof HTMLVideoElement) scanAll(); }, true);
  new MutationObserver((muts) => {
    for (const m of muts) {
      if (m.type === 'attributes') { scanAll(); return; }
      for (const n of m.addedNodes) {
        if (n.nodeType === 1 && (n.tagName === 'VIDEO' || n.tagName === 'IFRAME' || n.querySelector?.('video,iframe'))) { scanAll(); return; }
      }
    }
  }).observe(document.documentElement, { childList: true, subtree: true, attributes: true, attributeFilter: ['src'] });
  setInterval(() => { if (!document.hidden) scanAll(); }, 4000);

  // ---------- SPA navigation ----------
  // Content scripts run in an isolated world, so patching history.pushState would not see the
  // page's own calls. Use the Navigation API when present plus a cheap URL poll as fallback.
  let lastHref = location.href;
  function onNavigate() {
    if (location.href === lastHref) return;
    lastHref = location.href;
    sources.clear();
    selectedId = null;
    showError('');
    if (!onListRoute()) { course = null; checked.clear(); drawer.hidden = true; }
    render();
    setTimeout(scanAll, 600);
  }
  window.navigation?.addEventListener('navigatesuccess', onNavigate);
  addEventListener('popstate', onNavigate);
  setInterval(onNavigate, 1000);

  // ---------- init ----------
  (async () => {
    render();
    const st = await send({ type: 'GET_STATE' });
    if (st?.job?.url) runningKey = st.job.url;
    for (const p of st?.paused || []) if (p.info) pausedBy.set(p.url, { id: p.id, info: p.info }); // a page reload must not hide a paused job
    if (st?.paused?.length) render();
    (st?.videos || []).forEach(addNetworkVideo);
    scanAll();
  })();
})();
