/**
 * The library inside the extension: the same shelf as the standalone Vid2Study.html (lib/library-ui.js), but a lecture opens right
 * here through the shared notes view (lib/notes-view.js), so the notes assistant, with the providers and models from Options (API, CLI
 * bridge, Gemini web), works on it, and edits are written back to the lecture's file in the library folder.
 *
 * Kept apart from "Saved notes" on purpose: the shelf is drawn from the library folder's manifest only, so a lecture is listed here
 * only after it was added to the library with Save as HTML.
 */
import { libraryShell } from './lib/library-page.js';
import { readLibraryManifest, readLibraryLecture, lectureId, saveLibraryLecture, LECTURE_LINKS } from './lib/textbook-library.js';
import { recallLibrary, rememberLibrary, ensureAccess } from './lib/library-handle.js';
import { listResultKeys } from './lib/db.js';
import { createNotesView, NOTES_CSS } from './lib/notes-view.js';
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
    const entries = await readLibraryManifest(handle);
    if (!entries.length) { say('This folder has no lectures yet. Open a saved lecture, choose Save as HTML, then Choose library folder.'); return; }
    const ids = new Map(await Promise.all((await listResultKeys()).map(async key => [await lectureId(key), key]))); // keys only: no lecture text is loaded
    await mount(entries, ids);
  } catch (error) { say(error.message || String(error)); }
}

/** CSS wrapped so it applies only inside the reader (the shelf and the notes use different rules for the same tags). */
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
    '\n.lib-tools{position:sticky;top:0;z-index:3;display:flex;flex-wrap:wrap;gap:.4rem;align-items:center;padding:.5rem 1rem;border-bottom:1px solid var(--line);background:var(--card)}' +
    '\n.lib-tools [hidden]{display:none}.lib-tools .on{background:var(--teal);color:#fff}.lib-sync{margin-left:auto;color:var(--muted);font-size:12.5px}.lib-note{padding:1rem 1.2rem;color:var(--muted)}' +
    '\nbody.lib-shelf .ask-orb,body.lib-shelf .ask-panel,body.lib-shelf .ask-quote-fab{display:none!important}' +
    '\n' + scoped(notesCss) + '\n' + scoped(NOTES_CSS) + '\n' + VISUAL_CSS;
  document.head.append(style);
  document.body.innerHTML = shell.body;
  document.body.classList.add('lib-shelf');
  document.body.append(Object.assign(el('script'), { type: 'application/json', id: 'lib-data', textContent: shell.json }));

  // the reader and its toolbar are built once and reused for every lecture, so opening another one allocates nothing new
  const out = el('article', { id: 'out' });
  const reader = el('div', { id: 'reader' }, out);
  const edit = el('button', { type: 'button', class: 'chip', title: 'Edit the text and move or remove the figures', text: 'Edit notes' });
  const undo = el('button', { type: 'button', class: 'chip', text: 'Undo', hidden: '' });
  const redo = el('button', { type: 'button', class: 'chip', text: 'Redo', hidden: '' });
  const sync = el('span', { class: 'lib-sync', role: 'status' });
  const tools = el('div', { class: 'lib-tools' }, edit, undo, redo, sync);
  const toast = text => { sync.textContent = text; };
  const view = createNotesView({ out, toast });
  view.wireEditBar({ edit, undo, redo });

  // keep the lecture's file in step with edits: one rebuild, a few seconds after the last change, never on open
  let opening = false, timer = 0, writing = Promise.resolve();
  const writeBack = async () => {
    const result = view.result;
    if (!result || !root) return;
    sync.textContent = 'Updating the library file…';
    try {
      const html = await buildStandaloneHtml({ result, images: view.images, interactive: true, ...LECTURE_LINKS });
      if (view.key !== result.key) return; // another lecture was opened meanwhile: its own edits will write it
      await navigator.locks.request('vid2study:library', () => saveLibraryLecture(root, result, html));
      sync.textContent = 'Library file updated.';
    } catch (error) { sync.textContent = 'Could not update the library file: ' + (error.message || error); }
  };
  view.store.subscribe(() => {
    if (opening || !view.result) return;
    sync.textContent = 'Edited. The library file updates in a moment.';
    clearTimeout(timer);
    timer = setTimeout(() => { writing = writing.then(writeBack); }, SYNC_DELAY);
  });

  let token = 0, fallback = null;
  window.__v2sHost = {
    async open(entry, stage) {
      const mine = ++token;
      document.body.classList.remove('lib-shelf');
      stage.replaceChildren(el('p', { class: 'lib-note', text: 'Opening…' }));
      await writing; // never switch lecture in the middle of a write-back
      const key = ids.get(entry.id);
      opening = true;
      let result = null;
      try { result = key ? await view.open(key) : null; } finally { opening = false; }
      if (mine !== token) return; // the reader moved on while this was loading
      if (result) {
        sync.textContent = '';
        edit.textContent = 'Edit notes'; edit.classList.remove('on'); edit.setAttribute('aria-pressed', 'false'); undo.hidden = redo.hidden = true;
        stage.replaceChildren(tools, reader);
        dispatchEvent(new Event('resize')); // the assistant re-docks beside the notes
        return;
      }
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
$('choose').addEventListener('click', async () => {
  try {
    const handle = await window.showDirectoryPicker({ id: 'vid2study-library', mode: 'readwrite' });
    await rememberLibrary(handle).catch(() => {});
    await begin(handle);
  } catch (error) { if (error.name !== 'AbortError') say(error.message); }
});
