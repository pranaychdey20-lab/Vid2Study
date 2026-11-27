/**
 * The library inside the extension: the same shelf as the standalone Vid2Study.html (lib/library-ui.js), but a lecture opens right
 * here through the shared notes view (lib/notes-view.js), so the notes assistant, with the providers and models from Options (API, CLI
 * bridge, Gemini web), works on it, and edits are written back to the lecture's file in the library folder. The reader carries the same
 * Edit notes / Fix formatting / Generate practice paper tools as the saved-notes page (lib/notes-tools.js).
 *
 * "Saved notes" (the notes kept in this browser) is its own section and stays separate from the library: the shelf is drawn from the
 * library folder's manifest only, so a lecture is listed on it only after it was added with Save as HTML.
 */
import { libraryShell } from './lib/library-page.js';
import { readLibraryManifest, readLibraryLecture, lectureId, saveLibraryLecture, LECTURE_LINKS } from './lib/textbook-library.js';
import { recallLibrary, rememberLibrary, ensureAccess } from './lib/library-handle.js';
import { listResultKeys, listSavedNotes } from './lib/db.js';
import { createNotesView, NOTES_CSS } from './lib/notes-view.js';
import { mountNotesTools } from './lib/notes-tools.js';
import { buildStandaloneHtml } from './lib/standalone-html.js';
import { VISUAL_CSS } from './lib/textbook-visuals.js';
import { loadLook, applyLook } from './lib/ui-theme.js';

applyLook(loadLook());
const $ = id => document.getElementById(id);
const say = text => { $('msg').textContent = text; };
const SYNC_DELAY = 3000; // wait this long after the last edit before rewriting the lecture's file

function el(tag, attrs = {}, ...kids) {
  const node = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) { if (k === 'text') node.textContent = v; else if (k === 'class') node.className = v; else node.setAttribute(k, v); }
  node.append(...kids.filter(Boolean));
  return node;
}

let root = null;

async function begin(handle) {
  try {
    root = handle;
    const entries = handle ? await readLibraryManifest(handle) : []; // no folder: the saved notes only
    const ids = new Map(await Promise.all((await listResultKeys()).map(async key => [await lectureId(key), key]))); // keys only: no lecture text is loaded
    await mount(entries, ids);
  } catch (error) { say(error.message || String(error)); }
}

/** CSS limited to the reader (the shelf and the notes use different rules for the same tags); print-only @page rules stay out. */
const scoped = css => {
  const page = css.indexOf('@page');
  const clean = page < 0 ? css : css.slice(0, page) + css.slice(css.indexOf('}', page) + 1);
  return '@scope (#reader) {\n' + clean + '\n}';
};

async function mount(entries, ids) {
  const shell = libraryShell(entries);
  const notesCss = await (await fetch('notes.css')).text();
  const style = el('style');
  style.textContent = shell.css +
    '\n#reader{--k:#000;--w:#fff;--g1:#f2f2f2;--g2:#d9d9d9;--g3:#8a8a8a;--y:#FFE500;--red:#E00000;--mono:ui-monospace,"SF Mono",Menlo,Consolas,monospace;' +
    'min-height:100%;background:#fff;color:#000;font:15px/1.65 "Helvetica Neue",Helvetica,Arial,sans-serif}' +
    '\n.paper-wrap{padding:.8rem clamp(.3rem,1vw,.9rem) 1.6rem;animation:page-in .55s var(--ease) both}' +
    // tables use the full width and keep whole words (the notes page breaks words anywhere, which cuts narrow columns into "techniqu / es")
    '\n#reader table{display:table;width:100%;table-layout:auto}#reader th,#reader td{overflow-wrap:normal;word-break:normal}#reader th:first-child,#reader td:first-child{min-width:11ch}' +
    '\n#reader{max-width:60rem;margin:0 auto;border-radius:14px;box-shadow:0 24px 50px -30px var(--shadow);min-height:60vh}' +
    '\n#reader.wide,.shell.full #reader{max-width:none}' +
    '\n.zoom{display:inline-flex;align-items:center;gap:.25rem}.zoom span{min-width:3.2rem;text-align:center;color:var(--soft);font-size:12.5px;font-variant-numeric:tabular-nums;cursor:pointer}' +
    '\n#reader>article{max-width:none;margin:0;padding:1.4rem clamp(1rem,2.4vw,2.4rem) 3rem}#reader:not(.wide)>article{max-width:56rem;margin:0 auto}' +
    '\nbody.lib-shelf .ask-orb,body.lib-shelf .ask-panel,body.lib-shelf .ask-quote-fab{display:none!important}' +
    '\n.lib-note{padding:1rem 1.3rem;color:var(--muted)}' +
    '\n' + scoped(notesCss) + '\n' + scoped(NOTES_CSS) + '\n' + VISUAL_CSS;
  document.head.append(style);
  document.body.innerHTML = shell.body;
  document.body.classList.add('lib-shelf');
  document.body.append(Object.assign(el('script'), { type: 'application/json', id: 'lib-data', textContent: shell.json }));
  const toastUi = text => { sync.textContent = text; window.__v2sLibrary?.toast(text); };

  // the reader and its toolbar are built once and reused for every lecture, so opening another one allocates nothing new
  const out = el('article', { id: 'out' });
  const reader = el('div', { id: 'reader' }, out);
  const wrap = el('div', { class: 'paper-wrap' }, reader);
  const btn = (text, title) => el('button', { type: 'button', class: 'chip', text, title });
  const edit = btn('Edit notes', 'Edit the text and move or remove the figures');
  const undo = btn('Undo'); undo.hidden = true;
  const redo = btn('Redo'); redo.hidden = true;
  const repair = btn('Fix formatting', 'Repair common Markdown and LaTeX problems');
  const practice = btn('Generate practice paper'); practice.hidden = true;
  const sync = el('span', { class: 'note', role: 'status' });
  // zoom and width: read small print comfortably, or let the notes use the whole window (also ctrl + scroll over the notes)
  const ZOOM = 'vid2study:zoom';
  let zoom = Number(localStorage.getItem(ZOOM)) || 1, wide = localStorage.getItem(ZOOM + ':wide') !== '0'; // the notes cover the whole page by default
  const zoomOut = btn('−', 'Zoom out'), zoomIn = btn('+', 'Zoom in'), zoomLabel = el('span', { title: 'Reset the zoom' }), wideBtn = btn('Wide', 'Use the whole width of the window');
  const applyZoom = () => {
    zoom = Math.min(2.5, Math.max(0.6, Math.round(zoom * 100) / 100));
    reader.style.zoom = String(zoom);
    zoomLabel.textContent = Math.round(zoom * 100) + '%';
    reader.classList.toggle('wide', wide); wideBtn.classList.toggle('on', wide);
    try { localStorage.setItem(ZOOM, String(zoom)); localStorage.setItem(ZOOM + ':wide', wide ? '1' : '0'); } catch { /* storage off: the zoom lasts until you leave */ }
  };
  zoomOut.addEventListener('click', () => { zoom -= 0.1; applyZoom(); });
  zoomIn.addEventListener('click', () => { zoom += 0.1; applyZoom(); });
  zoomLabel.addEventListener('click', () => { zoom = 1; applyZoom(); });
  wideBtn.addEventListener('click', () => { wide = !wide; applyZoom(); });
  reader.addEventListener('wheel', e => { if (!e.ctrlKey) return; e.preventDefault(); zoom += e.deltaY < 0 ? 0.1 : -0.1; applyZoom(); }, { passive: false });
  applyZoom();
  const tools = el('div', { class: 'toolbar' }, edit, undo, redo, repair, practice, sync, el('span', { class: 'zoom' }, zoomOut, zoomLabel, zoomIn, wideBtn));
  const view = createNotesView({ out, toast: toastUi });
  view.wireEditBar({ edit, undo, redo });
  mountNotesTools({ view, repair, practice, toast: toastUi });

  // keep a LIBRARY lecture's file in step with edits: one rebuild, a few seconds after the last change, never on open
  let opening = false, inLibrary = false, timer = 0, writing = Promise.resolve();
  const writeBack = async () => {
    const result = view.result;
    if (!result || !root || !inLibrary) return;
    sync.textContent = 'Updating the library file…';
    try {
      const html = await buildStandaloneHtml({ result, images: view.images, interactive: true, ...LECTURE_LINKS });
      if (view.key !== result.key) return; // another lecture was opened meanwhile: its own edits will write it
      await navigator.locks.request('vid2study:library', () => saveLibraryLecture(root, result, html));
      sync.textContent = 'Library file updated.';
    } catch (error) { sync.textContent = 'Could not update the library file: ' + (error.message || error); }
  };
  view.store.subscribe(() => {
    if (opening || !view.result || !inLibrary) return;
    sync.textContent = 'Edited. The library file updates in a moment.';
    clearTimeout(timer);
    timer = setTimeout(() => { writing = writing.then(writeBack); }, SYNC_DELAY);
  });

  let token = 0, fallback = null;
  /** Show the notes view for `key` in `stage`. Resolves to the opened result, or null when this browser has no such saved notes. */
  async function show(key, stage, library) {
    const mine = ++token;
    document.body.classList.remove('lib-shelf');
    stage.replaceChildren(el('p', { class: 'lib-note', text: 'Opening…' }));
    await writing; // never switch lecture in the middle of a write-back
    opening = true; inLibrary = library;
    let result = null;
    try { result = key ? await view.open(key) : null; } finally { opening = false; }
    if (mine !== token) return undefined; // the reader moved on while this was loading
    if (result) {
      sync.textContent = library ? '' : 'Saved notes: edits are saved in this browser only.';
      edit.textContent = 'Edit notes'; edit.classList.remove('on'); edit.setAttribute('aria-pressed', 'false'); undo.hidden = redo.hidden = true;
      stage.replaceChildren(tools, wrap);
      dispatchEvent(new Event('resize')); // the assistant re-docks beside the notes
    }
    return result;
  }

  window.__v2sHost = {
    async open(entry, stage) {
      const result = await show(ids.get(entry.id), stage, true);
      if (result !== null) return;
      // not in this browser's saved notes (a library copied from elsewhere): show the file, read-only
      document.body.classList.add('lib-shelf');
      try {
        const frame = el('iframe', { class: 'reader', title: entry.title, sandbox: '' });
        frame.srcdoc = await readLibraryLecture(root, entry);
        fallback = frame;
        stage.replaceChildren(el('p', { class: 'lib-note', text: 'This lecture is not in this browser’s saved notes, so it is read-only here and the assistant is off. Save it again from Vid2Study to edit it.' }), frame);
      } catch (error) { stage.replaceChildren(el('p', { class: 'lib-note', text: 'This lecture could not be opened: ' + (error.message || error) })); }
    },
    close() {
      token++;
      view.release(); // figures, notes and editor state go
      fallback?.remove(); fallback = null;
      document.body.classList.add('lib-shelf');
      document.body.classList.remove('ask-docked');
    },
    notes: {
      list: () => listSavedNotes().then(items => items.map(item => ({ ...item, sub: item.sub }))),
      async open(item, stage, setTitle) {
        const result = await show(item.key, stage, false);
        if (result) setTitle?.(result.title);
        else if (result === null) stage.replaceChildren(el('p', { class: 'lib-note', text: 'These notes are no longer saved in this browser.' }));
      }
    }
  };
  document.body.append(Object.assign(el('script'), { src: 'lib/library-ui.js' }));
}

// ---- the screen before a folder is open ----------------------------------------------------------------------------------
const remembered = await recallLibrary().catch(() => null);
if (remembered) { $('reopen').hidden = false; $('reopen').textContent = 'Open “' + remembered.name + '”'; }
$('reopen').addEventListener('click', async () => {
  if (!(await ensureAccess(remembered))) { say('Access to the folder was not allowed. Choose it again.'); return; }
  await begin(remembered);
});
$('notesOnly').addEventListener('click', () => begin(null));
$('choose').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'vid2study-library', mode: 'readwrite' });
    await rememberLibrary(handle).catch(() => {});
    await begin(handle);
  } catch (error) { if (error.name !== 'AbortError') say(error.message); }
});
