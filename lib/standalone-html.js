/**
 * One lecture as a self-contained HTML page: figures and math fonts embedded, print-friendly, with the visual code inline (a standalone
 * file) or shared (a library). Used by the saved-notes page (Save as HTML / PDF / library) and by the library page (keeping a lecture's
 * file in step after an edit), so there is one builder.
 */
import { lectureHtml } from './lecture-layout.js';
import { paginate } from './paginate.js';
import { stripTimestamps } from './common.js';
import { VISUAL_CSS, visualRuntime } from './textbook-visuals.js';
import { NOTES_CSS, renderMath } from './notes-view.js';

const blobToDataUrl = (blob) =>
  new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = () => reject(r.error);
    r.readAsDataURL(blob);
  });

const escHtml = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');

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

/** `images` is filename -> Blob of the lecture (what the notes view holds); nothing is kept after the page is built. */
export async function buildStandaloneHtml({ result, images, markdown = result.summary_markdown, interactive = false, back = '', shared = '' }) {
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

