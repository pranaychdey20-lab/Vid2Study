/**
 * Results page (shown inside the side panel iframe). Reads the cached result + images from
 * IndexedDB, renders them (KaTeX math, callouts, step diagrams), and handles
 * copy / zip bundle / printable view.
 */
import { getResult, getFrame, putResult } from './lib/db.js';
import { loadSettings } from './lib/settings.js';
import { lectureHtml, writerLabel } from './lib/lecture-layout.js';
import { paginate } from './lib/paginate.js';
import { makeZip } from './lib/zip.js';
import { nativeBridge } from './lib/llm.js';
import { fmtTime, sanitizeName, toCopyText, stripTimestamps, lectureLockName, PROCESSING_LOCK } from './lib/common.js';
import { bindVisuals, VISUAL_CSS, visualRuntime } from './lib/textbook-visuals.js';
import { renderMarkdown } from './lib/md.js';
import { createNotesStore } from './lib/notes-store.js';
import { loadLook, applyLook } from './lib/ui-theme.js';
applyLook(loadLook()); // the look the assistant saved (colours, type, motion), before the notes are drawn
import { mountEditor } from './lib/notes-editor.js';

const params = new URLSearchParams(location.search);
const key = params.get('key');
const previewView = (params.get('preview') === '1' || params.get('print') === '1') && window === window.top;
const offerPractice = params.get('practice') === '1';
const $ = (id) => document.getElementById(id);
const objectUrls = [];
let result = null;
let paperJob = null;
let repairJob = null;
const openPractice = () => {
  $('paperStatus').textContent = '';
  $('paperDialog').showModal();
};
/** filename -> Blob */
const images = new Map();

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

function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

/** LaTeX -> HTML with KaTeX. Returns null (plain-text fallback) when a formula cannot be rendered. */
function renderMath(tex, display) {
  const katex = window.katex;
  if (!katex) return null;
  const html = katex.renderToString(tex, { displayMode: display, throwOnError: false, trust: false });
  return html.includes('katex-error') ? null : html;
}

let katexCss = null;
/** KaTeX stylesheet with the fonts inlined as base64, so exported pages work offline. */
async function inlineKatexCss() {
  if (katexCss) return katexCss;
  let css = await (await fetch('lib/katex/katex.min.css')).text();
  const urls = [...new Set([...css.matchAll(/url\((fonts\/[^)]+)\)/g)].map((m) => m[1]))];
  for (const u of urls) {
    const data = await blobToDataUrl(await (await fetch(`lib/katex/${u}`)).blob());
    css = css.split(`url(${u})`).join(`url(${data})`);
  }
  return (katexCss = css);
}

/** Self-contained, print-friendly HTML: images and math fonts embedded. */
/**
 * A figure for export: JPEG, at most 1280 px wide. Screenshots are stored as lossless PNG (exact for OCR),
 * which makes a PDF 5-10x bigger than needed; JPEG at 0.82 keeps slide text sharp at print size.
 */
async function compactDataUrl(blob) {
  try {
    const bmp = await createImageBitmap(blob);
    const k = Math.min(1, 1280 / bmp.width);
    const c = document.createElement('canvas');
    c.width = Math.round(bmp.width * k);
    c.height = Math.round(bmp.height * k);
    const g = c.getContext('2d');
    g.fillStyle = '#fff';
    g.fillRect(0, 0, c.width, c.height);
    g.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close?.();
    const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', 0.82));
    return blobToDataUrl(jpg && jpg.size < blob.size ? jpg : blob);
  } catch { return blobToDataUrl(blob); }
}

async function buildStandaloneHtml(markdown = result.summary_markdown, interactive = false, { back = '', shared = '' } = {}) {
  const dataUrls = new Map();
  for (const [name, blob] of images) dataUrls.set(name, await compactDataUrl(blob));
  // printed / exported pages carry no video times (they stay in the stored notes, for the AI and "copy")
  if (result.source !== 'combined') markdown = stripTimestamps(markdown);
  const body = lectureHtml(result, markdown, {
    imageSrc: (src) => dataUrls.get(src.replace(/^images\//, '')) || src,
    math: renderMath,
    pageNumbers: !interactive,
    localImagesOnly: true,
    interactive
  }, true);
  const html = `<!doctype html>
<html><head><meta charset="utf-8"><title>${escHtml(result.title)}</title>
<style>${body.includes("class=\"katex") ? await inlineKatexCss() : ""}</style>
<style>
  body { font: 11pt/1.5 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #000; background: #fff; margin: 0; }
  @media screen { body { max-width: 1100px; margin: 24px auto; padding: 0 clamp(12px, 2vw, 24px); } }
  h1 { font-size: 24pt; font-weight: 800; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 14pt; font-weight: 800; text-transform: uppercase; border-top: 3px solid #000; padding-top: 6px; margin-top: 26px; }
  h3 { font-size: 12pt; font-weight: 800; } .meta { font: 9pt ui-monospace, Consolas, "Courier New", monospace; color: #444; margin-bottom: 16px; }
  img { max-width: 100%; border: 2px solid #000; display: block; margin: 12px 0 0; }
  img + br { display: none; }
  img + br + em { display: block; font: normal 8.5pt ui-monospace, Consolas, "Courier New", monospace; border: 2px solid #000; border-top: 0; padding: 3px 8px; margin-bottom: 12px; background: #f2f2f2; }
  code, .math { font-family: ui-monospace, Consolas, "Courier New", monospace; }
  code { font-size: 9.5pt; }
  .katex-block .katex, .math .katex { font-family: KaTeX_Main, "Times New Roman", serif; }
  pre { background: #f2f2f2; border: 1px solid #000; padding: 8px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; table-layout: auto; font-size: 10pt; line-height: 1.4; }
  thead { display: table-header-group; }
  th, td { border: 1px solid #000; padding: 5px 7px; text-align: left; vertical-align: top; overflow-wrap: anywhere; }
  th { background: #f2f2f2; }
  th:first-child, td:first-child { min-width: 8ch; }
  #references + table td:first-child { width: 21%; }
  blockquote { border-left: 4px solid #000; margin: 8px 0; padding: 2px 12px; }
  ${NOTES_CSS}
  ${VISUAL_CSS}
  @page { size: A4; margin: 9mm 8mm; }
  .contents .snapshot > :last-child > :last-child { margin-bottom: 0; }
  ${result.source === 'combined' ? '.snapshot { display: block; } .snapshot li { break-inside: avoid; } .snapshot ol, .snapshot ul { padding-left: 1.5em; }' : ''}
  @media print { html, body { margin: 0; padding: 0; max-width: none; } img, pre, figure { break-inside: avoid; } h2, h3 { break-after: avoid; } }
  .lib-back { margin: 0 0 10px; font: 12.5px/1.3 system-ui, sans-serif; } .lib-back a { color: #0e6a64; text-decoration: none; } @media print { .lib-back { display: none; } }
</style></head><body>
${back ? `<p class="lib-back"><a href="${escHtml(back)}" target="_top">← Back to the library</a></p>` : ''}
${body}
${interactive ? '<footer><p>Questions and edits are available in the Vid2Study extension.</p></footer>' : ''}
${interactive && body.includes('data-study-visual=') ? (shared ? '<script src="' + shared + '"></script>' : '<script>' + await visualRuntime() + '</script>') : ''}
</body></html>`;
  return !interactive && body.includes('class="page-ref"') ? paginate(html) : html;
}

async function download(blob, filename, saveAs = false) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  try {
    await chrome.downloads.download({ url, filename: `Lectures/${filename}`, conflictAction: 'uniquify', saveAs });
    return;
  } catch { /* fall back to a plain link */ }
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
}

async function copyText() {
  const text = toCopyText(result); // raw LaTeX on purpose: best for pasting into another AI
  try {
    await navigator.clipboard.writeText(text);
  } catch {
    const ta = document.createElement('textarea');
    ta.value = text;
    document.body.appendChild(ta);
    ta.select();
    document.execCommand('copy');
    ta.remove();
  }
  toast('Copied');
}

async function downloadZip() {
  toast('Building zip');
  const folder = sanitizeName(result.title, 'lecture');
  const files = [
    { name: `${folder}/summary.md`, data: result.summary_markdown },
    ...(result.sourceRecord ? [{ name: `${folder}/lecture-sources.txt`, data: result.sourceRecord }] : []),
    ...(result.writerReplies?.length ? [{ name: `${folder}/writer-replies.txt`, data: result.writerReplies.map((reply, i) =>
      `=== Reply ${i + 1}${reply.batch ? ` · Batch ${reply.batch}` : ''} · ${reply.task} · ${reply.model}${reply.truncated ? ' · Truncated' : ''} ===\n${reply.text}`).join('\n\n') }] : []),
    ...(result.coverage?.length ? [{ name: `${folder}/coverage.json`, data: JSON.stringify(result.coverage, null, 2) }] : []),
    { name: `${folder}/summary.html`, data: await buildStandaloneHtml(result.summary_markdown, true) },
    {
      name: `${folder}/frames.json`,
      data: JSON.stringify(result.frames.map((f) => ({
        figure: f.figure,
        index: f.index,
        timestamp_seconds: f.timestamp_seconds,
        time: fmtTime(f.timestamp_seconds),
        type: f.type,
        title: f.title,
        description: f.description,
        filename: f.filename ? `images/${f.filename}` : null
      })), null, 2)
    },
    ...[...images].map(([name, blob]) => ({ name: `${folder}/images/${name}`, data: blob }))
  ];
  await download(await makeZip(files), `${folder}.zip`);
}

/** Dialogs that need a folder picker cannot open inside the side panel: the same notes open in a full tab for that. */
async function openInTab(saveHtml = false) {
  const url = new URL(chrome.runtime.getURL('results.html'));
  url.searchParams.set('key', key);
  url.searchParams.set('preview', '1'); // wide layout; the tab is the same page
  if (saveHtml) url.searchParams.set('save', 'html');
  await chrome.tabs.create({ url: url.href });
}

async function savePdf() {
  const button = $('print');
  button.disabled = true;
  button.textContent = 'Saving PDF…';
  try {
    const html = await buildStandaloneHtml();
    const bridge = await chrome.runtime.sendMessage({ type: 'BRIDGE_INFO', start: true });
    if (!bridge?.ok) throw new Error('Start the local bridge to save a PDF. You can also print this page from the browser.');
    const requestPdf = (url, token) => {
      const base = new URL(url);
      if (base.protocol !== 'http:' || !['127.0.0.1', 'localhost', '[::1]'].includes(base.hostname)) {
        throw new Error('PDF saving requires a local bridge address.');
      }
      return fetch(new URL('/pdf', base), {
        method: 'POST', headers: { 'Content-Type': 'application/json', 'x-bridge-token': token },
        body: JSON.stringify({ html }), signal: AbortSignal.timeout(150000)
      });
    };
    let response;
    try { response = await requestPdf(bridge.url, bridge.token); }
    catch (error) {
      if (!(error instanceof TypeError)) throw error;
      const started = await nativeBridge('start');
      if (!started.ok) throw new Error('The bridge is not running. Start it and try again.');
      response = await requestPdf(`http://127.0.0.1:${started.port || 8787}`, started.token);
    }
    if (!response.ok || !response.headers.get('Content-Type')?.startsWith('application/pdf')) {
      if (response.status === 404) throw new Error('Restart the bridge to enable PDF saving.');
      const detail = await response.json().catch(() => null);
      throw new Error(detail?.error?.message || 'The bridge could not create the PDF.');
    }
    await download(await response.blob(), `${sanitizeName(result.title, 'lecture')}.pdf`, true);
    toast('PDF saved');
  } finally {
    button.disabled = false;
    button.textContent = 'Save as PDF';
  }
}

async function init() {
  const st = document.createElement('style');
  st.textContent = NOTES_CSS + VISUAL_CSS;
  document.head.appendChild(st);
  if (!key) { $('status').textContent = 'No lecture selected.'; return; }
  result = await getResult(key);
  if (!result) { $('status').textContent = 'No saved summary for this lecture yet.'; return; }
  $('debug').hidden = !result.debug; // TEMP DEBUG

  for (const f of result.frames) {
    if (!f.filename) continue;
    const blob = await getFrame(`${key}/${f.filename}`);
    if (blob) images.set(f.filename, blob);
  }
  if (previewView) document.body.classList.add('wide-preview');
  $('practice').hidden = !(await loadSettings()).practiceQuestions;
  const blobUrls = new Map(), nameOfUrl = new Map();
  for (const [name, blob] of images) {
    const u = URL.createObjectURL(blob);
    objectUrls.push(u);
    blobUrls.set(name, u);
    nameOfUrl.set(u, name);
  }

  document.title = result.title;
  const tokens = result.usage ? ` · ${result.usage.in + result.usage.out} tokens` : '';
  let editor = null;
  const draw = () => {
    $('meta').textContent = `${result.frames.length} figures · ${new Date(result.createdAt).toLocaleString()} · ${writerLabel(result)}${tokens}`;
    $('out').innerHTML = lectureHtml(result, result.summary_markdown, {
      imageSrc: (src) => blobUrls.get(src.replace(/^images\//, '')) || src,
      math: renderMath
    });
    bindVisuals($('out'));
    editor?.refresh();
  };
  draw();
  $('status').remove();
  // editing (by hand or through the assistant) goes through one store: one undo / redo history, both copies of the notes kept in step
  const store = createNotesStore({ key, read: () => result, redraw: next => { result = next; draw(); } });
  editor = mountEditor({ root: $('out'), read: () => result, store, fileOf: img => nameOfUrl.get(img.currentSrc || img.src), toast });
  const syncEdit = () => { $('undoEdit').disabled = !store.canUndo(); $('redoEdit').disabled = !store.canRedo(); };
  store.subscribe(syncEdit);
  const guard = (work) => async () => { try { await work(); } catch (error) { toast(error.message || String(error)); } };
  $('undoEdit').addEventListener('click', guard(() => store.undo()));
  $('redoEdit').addEventListener('click', guard(() => store.redo()));
  $('editNotes').addEventListener('click', () => {
    const on = editor.toggle();
    $('editNotes').setAttribute('aria-pressed', String(on));
    $('editNotes').classList.toggle('on', on);
    $('editNotes').textContent = on ? 'Done editing' : 'Edit notes';
    $('undoEdit').hidden = $('redoEdit').hidden = !on;
    syncEdit();
  });
  import('./lib/textbook-assistant.js')
    .then(({ mountAssistant }) => mountAssistant({ root: $('out'), read: () => result, store, preview: md => renderMarkdown(md, { math: renderMath }) }))
    .catch(error => toast('The notes assistant could not start: ' + error.message));
  if (previewView && params.get('save') === 'html') openHtmlDialog();

  $('repair').addEventListener('click', async () => {
    if (repairJob) return;
    repairJob = new AbortController();
    const { signal } = repairJob;
    const button = $('repair');
    button.disabled = true;
    button.textContent = 'Checking formatting…';
    const withNotesLock = work => navigator.locks.request(PROCESSING_LOCK, { mode: 'shared', signal }, () =>
      navigator.locks.request(lectureLockName(key), { signal }, work));
    try {
      if (!window.katex) throw new Error('The math renderer did not load.');
      const { repairFormatting, repairWithCheapAi, applyRawRepairs, AI_REPAIR_LIMIT } = await import('./lib/repair-formatting.js');
      const validMath = (tex, display) => !!renderMath(tex, display);
      let review, raw;
      result = await withNotesLock(async () => {
        const saved = await getResult(key);
        if (!saved) throw new Error('These notes are no longer saved.');
        review = repairFormatting(saved.summary_markdown, validMath);
        raw = repairFormatting(saved.summary_raw ?? saved.summary_markdown, validMath);
        if (!review.repairs && !raw.repairs) return saved;
        const fixed = { ...saved, summary_markdown: review.markdown, summary_raw: raw.markdown };
        await putResult(fixed);
        return fixed;
      });
      draw();
      if (!review.issues.length) {
        toast(review.repairs || raw.repairs ? 'Formatting fixes saved' : 'No formatting problems found');
        return;
      }
      const dialog = $('repairDialog');
      const count = review.issues.length;
      const sent = Math.min(count, AI_REPAIR_LIMIT);
      $('repairDetails').textContent = count + (count === 1 ? ' passage needs' : ' passages need') +
        ' review. Send ' + sent + (sent === 1 ? ' passage' : ' passages') + ' and nearby lines to your Cheap AI?';
      dialog.returnValue = 'no';
      const approved = await new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
        dialog.showModal();
      });
      if (!approved) { toast('Local scan complete. Unresolved passages were kept.'); return; }
      button.textContent = 'Checking with Cheap AI…';
      result = await withNotesLock(async () => {
        const saved = await getResult(key);
        if (saved?.summary_markdown !== review.markdown || saved?.summary_raw !== result.summary_raw) {
          throw new Error('The notes changed. Run Fix formatting again.');
        }
        const { markdown: fixed, accepted } = await repairWithCheapAi(review, await loadSettings(), validMath, signal);
        signal.throwIfAborted();
        const changes = fixed !== review.markdown;
        const remaining = repairFormatting(fixed, validMath).issues.length;
        if (!changes) { toast('No safe AI formatting fixes were found.'); return saved; }
        const summary_raw = saved.summary_raw === saved.summary_markdown ? fixed : applyRawRepairs(saved.summary_raw, accepted);
        const updated = { ...saved, summary_markdown: fixed, summary_raw };
        if (!await getResult(key)) throw new Error('These notes are no longer saved.');
        await putResult(updated);
        toast(remaining ? remaining + ' passages still need review' : 'Formatting fixes saved');
        return updated;
      });
      draw();
    } catch (error) {
      if (!signal.aborted) toast(error.message || String(error));
    } finally {
      repairJob = null;
      button.disabled = false;
      button.textContent = 'Fix formatting';
    }
  });

  $('out').addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') return;
    $('lbimg').src = e.target.src;
    $('lbopen').href = e.target.src;
    $('lb').hidden = false;
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id !== 'lbopen') $('lb').hidden = true; });
  $('paperForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (paperJob) return;
    const withAssignments = $('useAssignments').value === 'yes';
    const text = withAssignments ? $('assignmentText').value : '';
    const files = withAssignments ? [...$('assignmentFiles').files] : [];
    const status = $('paperStatus');
    if (withAssignments && !text.trim() && !files.length) {
      status.textContent = 'Paste questions or attach at least one screenshot.';
      return;
    }
    paperJob = new AbortController();
    const { signal } = paperJob;
    $('paperSubmit').disabled = true;
    $('paperCancel').textContent = 'Cancel generation';
    status.textContent = 'Preparing the practice paper';
    try {
      const { writePracticePaper, appendPracticePaper } = await import('./lib/practice-paper.js');
      result = await navigator.locks.request(PROCESSING_LOCK, { mode: 'shared', signal }, () =>
        navigator.locks.request(lectureLockName(key), { signal }, async () => {
        const saved = await getResult(key);
        if (!saved) throw new Error('These notes are no longer saved.');
        const paper = await writePracticePaper(saved, await loadSettings(), {
          text, files, signal, onWait: value => { status.textContent = value; },
          prepareNotesPdf: markdown => {
            status.textContent = 'Preparing the combined notes for PDF attachment';
            return buildStandaloneHtml(markdown);
          }
        });
        signal.throwIfAborted();
        const addPaper = markdown => appendPracticePaper(markdown, paper);
        const updated = { ...saved, summary_markdown: addPaper(saved.summary_markdown), summary_raw: addPaper(saved.summary_raw) };
        // Full deletion can happen from a second Saved notes tab during generation.
        if (!await getResult(key)) throw new Error('These notes are no longer saved.');
        await putResult(updated);
        return updated;
      }));
      draw();
      $('paperDialog').close();
      $('paperForm').reset();
      $('assignmentInputs').hidden = true;
      toast('Practice paper saved');
    } catch (error) {
      status.textContent = signal.aborted ? 'Practice paper cancelled.' : error.message || String(error);
    } finally {
      paperJob = null;
      $('paperSubmit').disabled = false;
      $('paperCancel').textContent = 'Not now';
    }
  });
  if (offerPractice && !$('practice').hidden && !/^##[ \t]+Practice questions(?: — Paper \d+)?[ \t]*$/im.test(result.summary_markdown)) openPractice();
}

$('copy').addEventListener('click', () => result && copyText());
$('zip').addEventListener('click', () => result && downloadZip().catch((e) => toast(`Zip failed: ${e.message}`)));
const openHtmlDialog = () => {
  $('saveLibrary').hidden = !window.showDirectoryPicker;
  $('htmlDialog').showModal();
};
$('saveHtml').addEventListener('click', () => {
  if (!result) return;
  if (window === window.top) openHtmlDialog();
  else openInTab(true).catch(error => toast(error.message));
});
$('saveStandalone').addEventListener('click', async () => {
  if (!result) return;
  const name = sanitizeName(result.title, 'lecture') + '.html';
  try {
    const file = window.showSaveFilePicker ? await window.showSaveFilePicker({
      suggestedName: name, types: [{ description: 'HTML textbook', accept: { 'text/html': ['.html'] } }]
    }) : null;
    $('htmlStatus').textContent = 'Preparing offline HTML…';
    const blob = new Blob([await buildStandaloneHtml(result.summary_markdown, true)], { type: 'text/html' });
    if (!file) {
      await download(blob, name, true);
      $('htmlStatus').textContent = 'HTML sent to your browser’s downloads.';
    } else {
      const stream = await file.createWritable();
      try { await stream.write(blob); await stream.close(); }
      catch (error) { await stream.abort().catch(() => {}); throw error; }
      $('htmlStatus').textContent = 'Saved ' + file.name;
    }
  } catch (error) {
    if (error.name !== 'AbortError') $('htmlStatus').textContent = 'HTML save failed: ' + error.message;
  }
});
$('saveLibrary').addEventListener('click', async () => {
  if (!result || !window.showDirectoryPicker) return;
  const button = $('saveLibrary');
  button.disabled = true;
  try {
    const root = await window.showDirectoryPicker({ id: 'vid2study-library', mode: 'readwrite' });
    $('htmlStatus').textContent = 'Saving the lecture and updating the library…';
    const { saveLibraryLecture } = await import('./lib/textbook-library.js');
    const html = await buildStandaloneHtml(result.summary_markdown, true, { back: '../../../../Vid2Study.html', shared: '../../../../.vid2study/visuals.js' });
    const runtime = await visualRuntime();
    const saved = await navigator.locks.request('vid2study:library', () => saveLibraryLecture(root, result, html, runtime));
    $('htmlStatus').textContent = 'Saved ' + saved.location + '. Open ' + saved.index + ' in the chosen folder to browse the library.';
  } catch (error) {
    if (error.name !== 'AbortError') $('htmlStatus').textContent = 'Library save failed: ' + error.message;
  } finally {
    button.disabled = false;
  }
});
// TEMP DEBUG: open the run's plain-text dump in a new tab (Ctrl+S saves it)
$('debug').addEventListener('click', () => {
  if (!result?.debug) return;
  window.open(URL.createObjectURL(new Blob([result.debug], { type: 'text/plain;charset=utf-8' })), '_blank');
});
$('print').addEventListener('click', () => result && savePdf().catch(e => toast(e.message)));
$('practice').addEventListener('click', openPractice);
$('useAssignments').addEventListener('change', () => { $('assignmentInputs').hidden = $('useAssignments').value !== 'yes'; });
$('paperCancel').addEventListener('click', () => {
  if (paperJob) paperJob.abort();
  else $('paperDialog').close();
});
$('paperDialog').addEventListener('cancel', event => { if (paperJob) { event.preventDefault(); paperJob.abort(); } });
addEventListener('pagehide', () => { paperJob?.abort(); repairJob?.abort(); objectUrls.forEach((u) => URL.revokeObjectURL(u)); });

init().catch((e) => { $('status').textContent = `Could not load summary: ${e.message}`; });
