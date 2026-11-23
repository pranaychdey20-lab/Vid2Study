/**
 * Results page (shown inside the side panel iframe). Reads the cached result + images from
 * IndexedDB, renders them (KaTeX math, callouts, step diagrams), and handles
 * copy / zip bundle / printable view.
 */
import { getResult, getFrame } from './lib/db.js';
import { renderMarkdown } from './lib/md.js';
import { makeZip } from './lib/zip.js';
import { fmtTime, sanitizeName, toCopyText, stripTimestamps } from './lib/common.js';

const key = new URLSearchParams(location.search).get('key');
const $ = (id) => document.getElementById(id);
const objectUrls = [];
let result = null;
/** filename -> Blob */
const images = new Map();

/** Look and feel of callouts, figures and math: shared by the panel and the standalone export. */
export const NOTES_CSS = `
blockquote.callout { margin: 12px 0; padding: 6px 12px; border: 0; border-left: 6px solid #000; background: #f2f2f2; }
blockquote.callout > p:first-child > strong:first-child { display: inline-block; background: #000; color: #fff; padding: 1px 7px; margin-right: 6px; font: 800 10px/1.7 ui-monospace, Consolas, monospace; letter-spacing: .1em; text-transform: uppercase; }
blockquote.callout p { margin: 4px 0; }
blockquote.c-extra { border-left-style: dashed; }
blockquote.c-check { border-left-style: dotted; }
.katex-block { overflow-x: auto; overflow-y: hidden; margin: 10px 0; padding: 6px 4px; border-top: 1px solid #000; border-bottom: 1px solid #000; text-align: center; }
.katex { font-size: 1.05em; }
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

async function buildStandaloneHtml() {
  const dataUrls = new Map();
  for (const [name, blob] of images) dataUrls.set(name, await compactDataUrl(blob));
  // printed / exported pages carry no video times (they stay in the stored notes, for the AI and "copy")
  const body = renderMarkdown(stripTimestamps(result.summary_markdown), {
    imageSrc: (src) => dataUrls.get(src.replace(/^images\//, '')) || src,
    math: renderMath
  });
  const created = new Date(result.createdAt).toLocaleString();
  const tokens = result.usage ? ` · ${result.usage.in + result.usage.out} tokens` : '';
  return `<!doctype html>
<html><head><meta charset="utf-8"><title>${escHtml(result.title)}</title>
<style>${body.includes("class=\"katex") ? await inlineKatexCss() : ""}</style>
<style>
  body { font: 11pt/1.6 "Helvetica Neue", Helvetica, Arial, sans-serif; color: #000; background: #fff; max-width: 820px; margin: 24px auto; padding: 0 20px; }
  h1 { font-size: 24pt; font-weight: 800; line-height: 1.2; margin: 0 0 6px; }
  h2 { font-size: 14pt; font-weight: 800; text-transform: uppercase; border-top: 3px solid #000; padding-top: 6px; margin-top: 26px; }
  h3 { font-size: 12pt; font-weight: 800; } .meta { font: 9pt ui-monospace, Consolas, "Courier New", monospace; color: #444; margin-bottom: 16px; }
  img { max-width: 100%; border: 2px solid #000; display: block; margin: 12px 0 0; }
  img + br { display: none; }
  img + br + em { display: block; font: normal 8.5pt ui-monospace, Consolas, "Courier New", monospace; border: 2px solid #000; border-top: 0; padding: 3px 8px; margin-bottom: 12px; background: #f2f2f2; }
  code, .math { font-family: ui-monospace, Consolas, "Courier New", monospace; font-size: 9.5pt; }
  .katex-block .katex, .math .katex { font-family: KaTeX_Main, "Times New Roman", serif; }
  pre { background: #f2f2f2; border: 1px solid #000; padding: 8px; white-space: pre-wrap; }
  table { border-collapse: collapse; width: 100%; font-size: 10pt; } th, td { border: 1px solid #000; padding: 4px 8px; text-align: left; vertical-align: top; } th { background: #f2f2f2; }
  blockquote { border-left: 4px solid #000; margin: 8px 0; padding: 2px 12px; }
  ${NOTES_CSS}
  @media print { body { margin: 0; max-width: none; } img, table, pre, figure { page-break-inside: avoid; } h2, h3 { page-break-after: avoid; } }
</style></head><body>
<div class="meta">${escHtml(result.course || '')} · ${escHtml(created)} · ${escHtml(result.model || 'AI')} · ${result.frames.length} figures${tokens}</div>
${body}
</body></html>`;
}

async function download(blob, filename) {
  const url = URL.createObjectURL(blob);
  setTimeout(() => URL.revokeObjectURL(url), 120000);
  try {
    await chrome.downloads.download({ url, filename: `Lectures/${filename}`, conflictAction: 'uniquify' });
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
    { name: `${folder}/summary.html`, data: await buildStandaloneHtml() },
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

async function openPrintable() {
  const html = await buildStandaloneHtml();
  const url = URL.createObjectURL(new Blob([html], { type: 'text/html' }));
  // chrome.tabs.create does not depend on the click's user-activation window.
  await chrome.tabs.create({ url }).catch(() => window.open(url, '_blank'));
  setTimeout(() => URL.revokeObjectURL(url), 5 * 60000);
}

async function init() {
  const st = document.createElement('style');
  st.textContent = NOTES_CSS;
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
  const blobUrls = new Map();
  for (const [name, blob] of images) {
    const u = URL.createObjectURL(blob);
    objectUrls.push(u);
    blobUrls.set(name, u);
  }

  document.title = result.title;
  const tokens = result.usage ? ` · ${result.usage.in + result.usage.out} tokens` : '';
  $('meta').textContent = `${result.frames.length} figures · ${new Date(result.createdAt).toLocaleString()} · ${result.model || ''}${tokens}`;
  $('out').innerHTML = renderMarkdown(result.summary_markdown, {
    imageSrc: (src) => blobUrls.get(src.replace(/^images\//, '')) || src,
    math: renderMath
  });
  $('status').remove();

  $('out').addEventListener('click', (e) => {
    if (e.target.tagName !== 'IMG') return;
    $('lbimg').src = e.target.src;
    $('lbopen').href = e.target.src;
    $('lb').hidden = false;
  });
  $('lb').addEventListener('click', (e) => { if (e.target.id !== 'lbopen') $('lb').hidden = true; });
}

$('copy').addEventListener('click', () => result && copyText());
$('zip').addEventListener('click', () => result && downloadZip().catch((e) => toast(`Zip failed: ${e.message}`)));
// TEMP DEBUG: open the run's plain-text dump in a new tab (Ctrl+S saves it)
$('debug').addEventListener('click', () => {
  if (!result?.debug) return;
  window.open(URL.createObjectURL(new Blob([result.debug], { type: 'text/plain;charset=utf-8' })), '_blank');
});
$('print').addEventListener('click', () => result && openPrintable().catch((e) => toast(`Failed: ${e.message}`)));
addEventListener('pagehide', () => objectUrls.forEach((u) => URL.revokeObjectURL(u)));

init().catch((e) => { $('status').textContent = `Could not load summary: ${e.message}`; });
