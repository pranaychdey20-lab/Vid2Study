/**
 * What is on this frame? code / table / diagram (incl. charts) / formula / plain text.
 * No AI: it combines OCR layout (where each word sits) with simple pixel measurements, and it is
 * deliberately OPTIMISTIC: when in doubt a frame is flagged, because a false alarm costs one small
 * vision call and one extra figure, while a miss loses the code, table or diagram from the notes.
 *
 * Signals
 *   code     lines that look like code (keywords, braces, `=>`), dense punctuation, several indentation
 *            levels, even character widths (monospace), a dark background
 *   table    ruled grid (long horizontal + vertical lines) and/or words forming aligned columns
 *   diagram  edges that are NOT under OCR text (boxes, arrows, curves, plots), more colour
 *   formula  many lines with =, sums, integrals, powers, LaTeX-like commands
 * The pure functions work on plain arrays so they can be tested without a browser; `analyzeFrame` is
 * the browser wrapper (canvas) used by the pipeline.
 */
import { CODE_LINE } from './codedetect.js';

const clamp = (v) => Math.max(0, Math.min(1, v));

/** Flag thresholds (lower = more frames flagged). */
export const THRESHOLDS = { code: 0.45, table: 0.45, diagram: 0.5, formula: 0.5 };
/** When several kinds apply, the most specific one names the figure. */
const PRIORITY = ['code', 'table', 'formula', 'diagram'];

// ---------------------------------------------------------------------------------------------
// OCR layout
// ---------------------------------------------------------------------------------------------

/** Tesseract TSV -> { W, H, words: [{x,y,w,h,conf,text,line}] } (word rows only). */
export function parseTsv(tsv) {
  const words = [];
  let W = 0, H = 0;
  for (const row of String(tsv || '').split('\n')) {
    const c = row.split('\t');
    if (c.length < 12) continue;
    const level = Number(c[0]);
    if (level === 1) { W = Number(c[8]); H = Number(c[9]); continue; }
    if (level !== 5) continue;
    const text = c.slice(11).join('\t').trim();
    const conf = Number(c[10]);
    if (!text || conf < 0) continue;
    words.push({ x: Number(c[6]), y: Number(c[7]), w: Number(c[8]), h: Number(c[9]), conf, text, line: `${c[2]}.${c[3]}.${c[4]}` });
  }
  return { W, H, words };
}

/** Group words into lines (as Tesseract numbered them), left to right, top to bottom. */
export function groupLines(words) {
  const by = new Map();
  for (const w of words) {
    if (!by.has(w.line)) by.set(w.line, []);
    by.get(w.line).push(w);
  }
  return [...by.values()]
    .map((ws) => {
      ws.sort((a, b) => a.x - b.x);
      return { words: ws, x0: ws[0].x, y0: Math.min(...ws.map((w) => w.y)), y1: Math.max(...ws.map((w) => w.y + w.h)), text: ws.map((w) => w.text).join(' ') };
    })
    .sort((a, b) => a.y0 - b.y0);
}

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[s.length >> 1] : 0; };

/** Code-likeness 0..1 from OCR lines. */
export function codeScore(lines, W, dark) {
  // OCR reads stripes, flags and shapes as rows of "= — _ |": those lines are noise, not code. A line counts
  // when it is mostly letters/digits, or is a lone bracket line ("}", "};").
  lines = lines.filter((l) => {
    const t = l.text.replace(/\s/g, '');
    const an = (t.match(/[A-Za-z0-9]/g) || []).length;
    return /^[{}()[\];]+$/.test(t) || (an >= 2 && an / t.length >= 0.4);
  });
  if (lines.length < 3) return 0;
  const hits = lines.filter((l) => CODE_LINE.test(l.text)).length;
  if (hits < 2) return 0; // real code always has a few lines that look like code
  const ratio = hits / lines.length;
  const all = lines.map((l) => l.text).join('').replace(/\s/g, '');
  const sym = all ? (all.match(/[{}()[\];=<>+\-*/%&|^~_#"'`\\:]/g) || []).length / all.length : 0;
  // indentation levels: distinct left edges shared by 2+ lines
  const bins = new Map();
  for (const l of lines) { const b = Math.round(l.x0 / Math.max(1, W * 0.015)); bins.set(b, (bins.get(b) || 0) + 1); }
  const levels = [...bins.values()].filter((n) => n >= 2).length;
  // monospace: every character is about the same width
  const per = lines.flatMap((l) => l.words).filter((w) => w.text.length >= 4).map((w) => w.w / w.text.length);
  let mono = 0;
  if (per.length >= 8) {
    const mean = per.reduce((a, b) => a + b, 0) / per.length;
    const sd = Math.sqrt(per.reduce((a, b) => a + (b - mean) ** 2, 0) / per.length);
    mono = sd / mean < 0.12 ? 1 : 0;
  }
  return clamp(0.4 * clamp(ratio / 0.35) + 0.2 * clamp(sym / 0.1) + 0.15 * mono + 0.1 * clamp(levels / 3) + (dark ? 0.15 : 0));
}

/** Table-likeness 0..1 from words that line up in columns across rows. */
export function tableColsScore(lines, W) {
  const rows = [];
  for (const l of lines) {
    const ws = l.words.filter((w) => !/^\W$/.test(w.text)); // bullets are not cells
    if (ws.length < 2) continue;
    const gap = Math.max(W * 0.03, 2.5 * median(ws.map((w) => w.h)));
    const starts = [ws[0].x];
    for (let i = 1; i < ws.length; i++) if (ws[i].x - (ws[i - 1].x + ws[i - 1].w) > gap) starts.push(ws[i].x);
    if (starts.length >= 2) rows.push(starts);
  }
  if (rows.length < 3) return 0;
  const count = new Map();
  for (const starts of rows) for (const b of new Set(starts.map((x) => Math.round(x / Math.max(1, W * 0.02))))) count.set(b, (count.get(b) || 0) + 1);
  const columns = [...count.values()].filter((n) => n >= 3).length;
  return columns >= 2 ? clamp(columns / 3) * clamp(rows.length / 5) : 0;
}

/** Equation-likeness 0..1: lines holding =, sums, integrals, powers, LaTeX commands. */
export function formulaScore(lines) {
  if (lines.length < 2) return 0;
  const math = /[=∑∫√±≤≥≈≠∂∇×÷∞]|[A-Za-z0-9)]\s*\^\s*[\w({]|\\[a-z]{2,}|\b[a-zA-Z]\s*=\s*[-\w(]/;
  const n = lines.filter((l) => math.test(l.text)).length;
  return clamp(n / lines.length / 0.5) * (n >= 2 ? 1 : 0.5);
}

// ---------------------------------------------------------------------------------------------
// pixels
// ---------------------------------------------------------------------------------------------

/**
 * Edge statistics on a w x h gray image. `boxes` are OCR word boxes in the same pixel coordinates.
 * @returns {{meanLum:number, hLines:number, vLines:number, graphicsFrac:number, edgeFrac:number}}
 */
export function pixelFeatures(g, w, h, boxes = []) {
  const T = 40;
  const mask = new Uint8Array(w * h);
  for (const b of boxes) {
    const x0 = Math.max(0, Math.floor(b.x - 3)), x1 = Math.min(w, Math.ceil(b.x + b.w + 3));
    const y0 = Math.max(0, Math.floor(b.y - 3)), y1 = Math.min(h, Math.ceil(b.y + b.h + 3));
    for (let y = y0; y < y1; y++) mask.fill(1, y * w + x0, y * w + x1);
  }
  let sum = 0;
  for (let i = 0; i < g.length; i++) sum += g[i];
  const mx = Math.floor(w * 0.06), my = Math.floor(h * 0.06); // ignore logos / borders at the edges
  let edges = 0, other = 0;
  const hRows = [];
  const colRun = new Uint16Array(w), colBest = new Uint16Array(w), colGap = new Uint8Array(w);
  const GAP = 4; // a ruled line may be interrupted by a crossing line for a few pixels
  for (let y = 1; y < h - 1; y++) {
    let run = 0, best = 0, gap = 0;
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const gx = Math.abs(g[i + 1] - g[i - 1]);
      const gy = Math.abs(g[i + w] - g[i - w]);
      // line detection ignores pixels under OCR text, so rows of letters never count as ruled lines
      if (gy > T && !mask[i]) { run++; gap = 0; if (run > best) best = run; } else if (++gap > GAP) run = 0;
      if (gx > T && !mask[i]) { colRun[x]++; colGap[x] = 0; if (colRun[x] > colBest[x]) colBest[x] = colRun[x]; } else if (++colGap[x] > GAP) colRun[x] = 0;
      if (gx + gy > T) {
        edges++;
        if (!mask[i] && x > mx && x < w - mx && y > my && y < h - my) other++;
      }
    }
    if (best >= w * 0.35) hRows.push(y);
  }
  const groups = (xs) => xs.reduce((n, v, i) => n + (i === 0 || v - xs[i - 1] > 3 ? 1 : 0), 0);
  const vCols = [];
  for (let x = 1; x < w - 1; x++) if (colBest[x] >= h * 0.25) vCols.push(x);
  const inner = Math.max(1, (w - 2 * mx) * (h - 2 * my));
  return { meanLum: sum / g.length, hLines: groups(hRows), vLines: groups(vCols), graphicsFrac: other / inner, edgeFrac: edges / (w * h) };
}

// ---------------------------------------------------------------------------------------------
// decision
// ---------------------------------------------------------------------------------------------

/**
 * @param {{lines:object[], W:number, px:object, sat?:number}} f
 * @returns {{kinds:string[], primary:string, score:number, scores:object, blank:boolean}}
 */
export function classify({ lines, W, px, sat = 0 }) {
  const dark = px.meanLum < 110;
  const code = codeScore(lines, W, dark);
  const grid = px.hLines >= 2 && px.vLines >= 2 ? clamp(Math.min(px.hLines, 5) / 4) * clamp(Math.min(px.vLines, 4) / 3) : 0;
  const table = clamp(grid * 0.8 + tableColsScore(lines, W) * 0.7 + (px.hLines >= 3 ? 0.15 : 0));
  let diagram = clamp((px.graphicsFrac - 0.015) / 0.04);
  if (px.graphicsFrac > 0.22) diagram *= 0.5; // photo / talking head, not a drawing
  if (sat > 0.08 && px.graphicsFrac > 0.02) diagram = clamp(diagram + 0.15); // coloured chart
  // code is full of "=" and brackets: do not also call it a formula unless the maths is clearly separate
  const scores = { code, table, diagram, formula: code >= 0.6 ? 0 : formulaScore(lines) };
  const kinds = PRIORITY.filter((k) => scores[k] >= THRESHOLDS[k]);
  const round = (o) => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, Math.round(v * 100) / 100]));
  return {
    kinds,
    primary: kinds[0] || 'text',
    score: kinds.length ? Math.max(...kinds.map((k) => scores[k])) : 0,
    scores: round(scores),
    blank: px.edgeFrac < 0.003 // black / empty frame: nothing to describe
  };
}

// ---------------------------------------------------------------------------------------------
// browser wrapper
// ---------------------------------------------------------------------------------------------

/**
 * Classify one captured frame.
 * @param {Blob} blob the frame image
 * @param {{text:string, words:number, boxes?:object[], W?:number}} ocr from ocrImage()
 */
export async function analyzeFrame(blob, ocr) {
  const bmp = await createImageBitmap(blob);
  const w = 480;
  const h = Math.max(8, Math.round((bmp.height * w) / bmp.width));
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  const ctx = c.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0, w, h);
  const srcW = ocr.W || bmp.width;
  bmp.close?.();
  const d = ctx.getImageData(0, 0, w, h).data;
  const g = new Uint8Array(w * h);
  let colourful = 0;
  for (let i = 0; i < g.length; i++) {
    const r = d[i * 4], gr = d[i * 4 + 1], b = d[i * 4 + 2];
    g[i] = (r * 77 + gr * 150 + b * 29) >> 8;
    const mxc = Math.max(r, gr, b), mnc = Math.min(r, gr, b);
    if (mxc > 60 && (mxc - mnc) / mxc > 0.35) colourful++;
  }
  const k = w / srcW;
  const boxes = (ocr.boxes || []).map((b) => ({ x: b.x * k, y: b.y * k, w: b.w * k, h: b.h * k }));
  return classify({ lines: groupLines(ocr.boxes || []), W: srcW, px: pixelFeatures(g, w, h, boxes), sat: colourful / g.length });
}
