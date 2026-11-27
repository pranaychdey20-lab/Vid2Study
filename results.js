/**
 * Results page (shown inside the side panel iframe). Reads the cached result + images from
 * IndexedDB, renders them (KaTeX math, callouts, step diagrams), and handles
 * copy / zip bundle / printable view.
 */
import { writerLabel } from './lib/lecture-layout.js';
import { makeZip } from './lib/zip.js';
import { nativeBridge } from './lib/llm.js';
import { fmtTime, sanitizeName, toCopyText } from './lib/common.js';
import { VISUAL_CSS, visualRuntime } from './lib/textbook-visuals.js';
import { createNotesView, NOTES_CSS } from './lib/notes-view.js';
import { mountNotesTools } from './lib/notes-tools.js';
import { buildStandaloneHtml as buildHtml } from './lib/standalone-html.js';
import { loadLook, applyLook } from './lib/ui-theme.js';
applyLook(loadLook()); // the look the assistant saved (colours, type, motion), before the notes are drawn

const params = new URLSearchParams(location.search);
const key = params.get('key');
const previewView = (params.get('preview') === '1' || params.get('print') === '1') && window === window.top;
const offerPractice = params.get('practice') === '1';
const $ = (id) => document.getElementById(id);
let result = null;
let tools = null;
const tokens = () => (result?.usage ? ` · ${result.usage.in + result.usage.out} tokens` : '');
const view = createNotesView({
  out: $('out'), toast: msg => toast(msg),
  onDraw: next => { result = next; $('meta').textContent = `${next.frames.length} figures · ${new Date(next.createdAt).toLocaleString()} · ${writerLabel(next)}${tokens()}`; }
});
/** filename -> Blob of the open lecture (owned by the view, which frees it) */
const images = view.images;


function toast(msg) {
  const t = $('toast');
  t.textContent = msg;
  t.classList.add('show');
  setTimeout(() => t.classList.remove('show'), 1800);
}

const buildStandaloneHtml = (markdown = result.summary_markdown, interactive = false, options = {}) => buildHtml({ result, images, markdown, interactive, ...options });

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
  result = await view.open(key); // loads the lecture and its figures, draws it, attaches the editor and the assistant
  if (!result) { $('status').textContent = 'No saved summary for this lecture yet.'; return; }
  $('debug').hidden = !result.debug; // TEMP DEBUG
  if (previewView) document.body.classList.add('wide-preview');
  tools = mountNotesTools({ view, repair: $('repair'), practice: $('practice'), toast });
  await tools.refreshPractice();
  document.title = result.title;
  $('status').remove();
  view.wireEditBar({ edit: $('editNotes'), undo: $('undoEdit'), redo: $('redoEdit') });
  if (previewView && params.get('save') === 'html') openHtmlDialog();

  $('out').addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') return;
    $('lbimg').src = e.target.src;
    $('lbopen').href = e.target.src;
    $('lb').hidden = false;
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id !== 'lbopen') $('lb').hidden = true; });
  if (offerPractice && !$('practice').hidden && !/^##[ \t]+Practice questions(?: — Paper \d+)?[ \t]*$/im.test(result.summary_markdown)) tools.openPractice();
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
$('openLibrary').addEventListener('click', () => window.open(chrome.runtime.getURL('library-open.html'), '_blank'));
$('saveLibrary').addEventListener('click', async () => {
  if (!result || !window.showDirectoryPicker) return;
  const button = $('saveLibrary');
  button.disabled = true;
  try {
    const root = await window.showDirectoryPicker({ id: 'vid2study-library', mode: 'readwrite' });
    $('htmlStatus').textContent = 'Saving the lecture and updating the library…';
    const { saveLibraryLecture, libraryScript, LECTURE_LINKS } = await import('./lib/textbook-library.js');
    const html = await buildStandaloneHtml(result.summary_markdown, true, LECTURE_LINKS);
    const runtime = await visualRuntime();
    const shelf = await libraryScript();
    const saved = await navigator.locks.request('vid2study:library', () => saveLibraryLecture(root, result, html, runtime, { shelf, extensionId: chrome.runtime?.id || '' }));
    import('./lib/library-handle.js').then(({ rememberLibrary }) => rememberLibrary(root)).catch(() => {}); // so the library page opens this folder next time
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
addEventListener('pagehide', () => { tools?.abort(); view.release(); });

init().catch((e) => { $('status').textContent = `Could not load summary: ${e.message}`; });
