/**
 * Slide OCR (ES module, needs DOM). Tesseract (WASM) runs in a worker started from the vendored files in
 * lib/vendor/tesseract/, including the English language data, so it works offline.
 * Most slides are text, so OCR turns them into plain text for free; frames with little text are
 * probably diagrams, charts or boards and are the only ones worth sending to a vision model.
 */
import { parseTsv } from './framekind.js';

const VENDOR = (p) => new URL(`./vendor/tesseract/${p}`, import.meta.url).href;

// A small pool of Tesseract workers (each is its own thread): slides are read 2-3 at a time instead of one by one.
export const OCR_WORKERS = Math.max(1, Math.min(3, Math.floor((globalThis.navigator?.hardwareConcurrency || 4) / 2)));
let scriptP = null;
let made = []; // worker promises
let idle = []; // ready workers
let waiters = []; // callers waiting for a free worker

function loadScript(src) {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = src;
    s.onload = resolve;
    s.onerror = () => reject(new Error('Could not load the OCR engine.'));
    document.head.appendChild(s);
  });
}

async function newWorker() {
  scriptP ||= (globalThis.Tesseract ? Promise.resolve() : loadScript(VENDOR('tesseract.min.js'))).catch((e) => { scriptP = null; throw e; });
  await scriptP;
  return globalThis.Tesseract.createWorker('eng', 1, {
    workerPath: VENDOR('worker.min.js'),
    corePath: VENDOR('tesseract-core-simd-lstm.wasm.js'),
    langPath: VENDOR('').replace(/\/$/, ''),
    gzip: true,
    workerBlobURL: false,
    cacheMethod: 'none'
  });
}

async function acquire() {
  if (idle.length) return idle.pop();
  if (made.length < OCR_WORKERS) {
    const p = newWorker();
    made.push(p);
    try { return await p; } catch (e) { made = made.filter((x) => x !== p); throw e; }
  }
  return new Promise((resolve) => waiters.push(resolve));
}

function release(w) {
  const next = waiters.shift();
  if (next) next(w); else idle.push(w);
}

/** Number of real words: alphanumeric tokens of 3+ characters (diagram junk makes short noise tokens). */
export function countWords(text, confidence = 100) {
  const n = String(text || '').split(/\s+/).filter((w) => /[A-Za-z0-9]{3,}/.test(w)).length;
  return confidence < 50 ? Math.floor(n * 0.5) : n;
}

/** Tidy OCR output: trim lines, drop empty ones and lone symbols. */
export function cleanOcr(text) {
  return String(text || '')
    .split('\n')
    .map((l) => l.replace(/\s+/g, ' ').trim())
    .filter((l) => l.length > 1 && /[A-Za-z0-9]/.test(l))
    .join('\n');
}

/**
 * @param {Blob} image
 * @returns {Promise<{text:string, words:number, boxes:object[], W:number}>} boxes = every word with its
 *   position, used by lib/framekind.js to tell code, tables and diagrams from plain text slides
 */
export async function ocrImage(image) {
  const w = await acquire();
  let data;
  try { ({ data } = await w.recognize(image, {}, { text: true, tsv: true })); } finally { release(w); }
  const text = cleanOcr(data.text);
  const { W, words: boxes } = parseTsv(data.tsv);
  return { text, words: countWords(text, data.confidence), conf: Number(data.confidence) || 0, boxes, W };
}

export async function closeOcr() {
  const all = made;
  made = []; idle = []; waiters = [];
  for (const p of all) { try { await (await p).terminate(); } catch { /* already gone */ } }
}
