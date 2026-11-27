/**
 * The notes view shared by the finished-notes page (results.html) and the library page (library-open.html): load a saved lecture and
 * its figures, draw it, keep the editor and the assistant attached, and let everything go when another lecture is opened.
 * Neither page carries its own copy of this. Figures are object URLs that live only while a lecture is open.
 */
import { getResult, getFrame } from './db.js';
import { lectureHtml } from './lecture-layout.js';
import { createNotesStore } from './notes-store.js';
import { mountEditor } from './notes-editor.js';
import { bindVisuals } from './textbook-visuals.js';
import { renderMarkdown } from './md.js';

/** Look and feel of callouts, figures and math: shared by the panel and the standalone export. */
export const NOTES_CSS = `
.contents {break-after:page} .snapshot,.math-note-row {display:grid;grid-template-columns:55% 42%;gap:3%} .math-note-row>p {border-left:1px solid #aab7bd;padding-left:12px}.page-ref {display:inline;font-size:.9em}.page-ref::after {content:"";} .figure-pair {display:grid;grid-template-columns:1fr 1fr;gap:12px;break-inside:avoid} figure {margin:10px 0} figure img {max-height:145mm;object-fit:contain} figcaption,.topic-ref {font-size:.85em;color:#475963}.banner-meta {color:#465762}.slide-ocr,.watch-out,.quick-check,.extra-context {display:block;border-left:3px solid #486876;padding:6px 12px;margin:8px 0;background:#f5f7f7}.extra-context {border-color:#a17439}.slide-ocr strong {display:block;font-size:.7em;letter-spacing:.06em}.math-note-row,figure,.slide-ocr,.watch-out,tr {break-inside:avoid} h2,h3 {break-after:avoid} @page {size:A4;margin:16mm}
blockquote.callout { margin: 12px 0; padding: 6px 12px; border: 0; border-left: 6px solid #000; background: #f2f2f2; }
.inline-explanation { margin: 8px 0 14px; padding: 6px 12px; border: 1px solid #829aa3; border-left: 3px solid #466c7a; background: #f2f7f8; break-inside: avoid; }
.inline-explanation p { margin: 4px 0; }
@media print { p:has(+ .inline-explanation), ul:has(+ .inline-explanation), ol:has(+ .inline-explanation), .slide-ocr:has(+ .inline-explanation) { break-after: avoid; } }
blockquote.callout > p:first-child > strong:first-child { display: inline-block; background: #000; color: #fff; padding: 1px 7px; margin-right: 6px; font: 800 10px/1.7 ui-monospace, Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
blockquote.callout p { margin: 4px 0; }
blockquote.c-extra { border-left-style: dashed; }
blockquote.c-check { border-left-style: dotted; }
.katex-block { overflow-x: auto; overflow-y: hidden; margin: 10px 0; padding: 6px 4px; border-top: 1px solid #000; border-bottom: 1px solid #000; text-align: center; }
.math .katex { font-size: 1.14em; }
.katex-block .katex { font-size: 1.22em; }
.math-note-row { display: block; }
.math-unavailable { overflow-wrap: anywhere; white-space: pre-wrap; }
.katex .katex-mathml { user-select: none; }
p.practice-answer { border-top: 1px solid #87939b; padding-top: 6px; margin-top: 12px; break-after: avoid; }
p.practice-answer > strong:first-child { font-size: 1.05em; }
p.practice-part { color: #314752; margin-top: 14px; break-after: avoid; }
`;

/** LaTeX -> HTML with KaTeX. Returns null (plain-text fallback) when a formula cannot be rendered. */
export function renderMath(tex, display) {
  const katex = window.katex;
  if (!katex) return null;
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false });
  return html.includes('katex-error') ? null : html;
}


/**
 * @param {{ out: HTMLElement, toast?: (msg: string) => void, onDraw?: (result: object) => void }} options
 * onDraw runs after every draw (opening, an edit, undo, redo) with the current result.
 */
export function createNotesView({ out, toast = () => {}, onDraw = () => {} }) {
  /** filename -> Blob of the open lecture (exports read this same map) */
  const images = new Map();
  const listeners = new Set();
  let result = null, key = null, store = null, editor = null, assistant = false;
  let urls = [], blobUrls = new Map(), nameOfUrl = new Map();

  const draw = () => {
    out.innerHTML = lectureHtml(result, result.summary_markdown, { imageSrc: src => blobUrls.get(src.replace(/^images\//, '')) || src, math: renderMath });
    bindVisuals(out);
    editor?.refresh();
    onDraw(result);
  };
  // one stable store for the editor and the assistant; it points at the open lecture's store
  const proxy = {
    commit: change => store.commit(change),
    undo: () => store.undo(),
    redo: () => store.redo(),
    canUndo: () => !!store?.canUndo(),
    canRedo: () => !!store?.canRedo(),
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };

  function release() {
    for (const u of urls) URL.revokeObjectURL(u);
    urls = []; blobUrls = new Map(); nameOfUrl = new Map();
    images.clear();
    editor?.toggle(false);
    result = null; key = null; store = null;
    out.replaceChildren();
  }

  /** Open the saved lecture `lectureKey`. Resolves to its result, or null when it is not saved in this browser. */
  async function open(lectureKey) {
    release();
    const found = await getResult(lectureKey);
    if (!found) return null;
    key = lectureKey; result = found;
    for (const f of result.frames) {
      if (!f.filename) continue;
      const blob = await getFrame(key + '/' + f.filename);
      if (blob) images.set(f.filename, blob);
    }
    for (const [name, blob] of images) {
      const u = URL.createObjectURL(blob);
      urls.push(u); blobUrls.set(name, u); nameOfUrl.set(u, name);
    }
    draw();
    // editing (by hand or through the assistant) goes through one store: one undo / redo history, both copies of the notes kept in step
    store = createNotesStore({ key, read: () => result, redraw: next => { result = next; draw(); } });
    store.subscribe(() => { for (const fn of listeners) fn(); });
    editor ||= mountEditor({ root: out, read: () => result, store: proxy, fileOf: img => nameOfUrl.get(img.currentSrc || img.src), toast });
    if (!assistant) {
      assistant = true;
      import('./textbook-assistant.js')
        .then(({ mountAssistant }) => mountAssistant({ root: out, read: () => result, store: proxy, preview: md => renderMarkdown(md, { math: renderMath }) }))
        .catch(error => { assistant = false; toast('The notes assistant could not start: ' + error.message); });
    }
    for (const fn of listeners) fn();
    return result;
  }

  /** Show a result that a tool (Fix formatting, practice paper) has just saved for the open lecture. */
  function update(next) { if (next && next.key === key) { result = next; draw(); } }

  /** Wire the Edit / Undo / Redo buttons of a toolbar to this view. */
  function wireEditBar({ edit, undo, redo }) {
    const sync = () => { undo.disabled = !proxy.canUndo(); redo.disabled = !proxy.canRedo(); };
    proxy.subscribe(sync);
    const guard = work => async () => { try { await work(); } catch (error) { toast(error.message || String(error)); } };
    undo.addEventListener('click', guard(() => proxy.undo()));
    redo.addEventListener('click', guard(() => proxy.redo()));
    edit.addEventListener('click', () => {
      if (!editor) return;
      const on = editor.toggle();
      edit.setAttribute('aria-pressed', String(on));
      edit.classList.toggle('on', on);
      edit.textContent = on ? 'Done editing' : 'Edit notes';
      undo.hidden = redo.hidden = !on;
      sync();
    });
    return sync;
  }

  return { open, release, update, wireEditBar, images, store: proxy, get result() { return result; }, get key() { return key; } };
}
