/**
 * Local speech-to-text (ES module, needs DOM). Whisper runs in the browser through the vendored
 * transformers.js + onnxruntime-web (lib/vendor/). Only the model weights are downloaded, once, from
 * Hugging Face; the browser caches them. No audio ever leaves the computer.
 *
 * The audio is decoded to 16 kHz mono, silent stretches are skipped with a simple energy check, and the
 * rest is transcribed in 5-minute windows. After each window `onWindow` lets the caller save progress.
 */
import { fmtTime } from './common.js';

const VENDOR = (p) => new URL(`./vendor/${p}`, import.meta.url).href;
const SR = 16000;
const WINDOW_SEC = 300;
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);

/**
 * The spoken-language setting as Whisper understands it: 'en', 'auto' (detect), or a language code.
 * 'hinglish' (Hindi and English mixed, as many Indian lectures are) is recognised as Hindi: Whisper then
 * writes the Hindi parts and keeps the English words, and the notes writer translates it all to English.
 */
export const asrLang = (language) => {
  const l = String(language || 'en').toLowerCase().trim();
  return l === 'hinglish' || l === 'hindi' ? 'hi' : l || 'en';
};

/**
 * Options for one Whisper call. The English-only models reject `task` and `language` outright
 * ("Cannot specify `task` or `language` for an English-only model"), so they are only set for the
 * multilingual models.
 */
export function whisperOptions(language) {
  const lang = asrLang(language);
  const opts = { chunk_length_s: 30, stride_length_s: 5, return_timestamps: true };
  if (lang !== 'en') {
    opts.task = 'transcribe';
    if (lang !== 'auto') opts.language = lang;
  }
  return opts;
}

/** English-only models are smaller and more accurate; other languages need the multilingual ones. */
export const asrRepo = (size, language) => `onnx-community/whisper-${size}${asrLang(language) === 'en' ? '.en' : ''}`; // 'auto' and other languages: multilingual model

let tf = null;
const pipes = new Map();

async function loadTf() {
  if (!tf) {
    tf = await import('./vendor/transformers.min.js');
    tf.env.allowLocalModels = false;
    tf.env.useBrowserCache = true;
    tf.env.useWasmCache = false; // load the runtime straight from the extension files (no blob: URLs, which the page CSP blocks)
    const wasm = tf.env.backends.onnx?.wasm;
    if (!wasm) throw new Error('The speech engine did not start (no ONNX runtime in the bundle).');
    wasm.wasmPaths = VENDOR('ort/'); // a prefix: the runtime picks the matching .mjs / .wasm from lib/vendor/ort/
    // Several CPU threads need SharedArrayBuffer, i.e. a cross-origin isolated page (manifest.json sets
    // cross_origin_embedder_policy / cross_origin_opener_policy for the extension's pages). Without it: one thread.
    const cores = Number(globalThis.navigator?.hardwareConcurrency) || 2;
    wasm.numThreads = globalThis.crossOriginIsolated ? Math.max(1, Math.min(4, cores - 1)) : 1;
  }
  return tf;
}

async function getPipe(size, language, progress) {
  const repo = asrRepo(size, language);
  if (pipes.has(repo)) return pipes.get(repo);
  const { pipeline } = await loadTf();
  let last = 0;
  const progress_callback = (e) => {
    if (e?.status === 'progress' && e.total && Date.now() - last > 500) {
      last = Date.now();
      progress('transcribe', pct(e.loaded, e.total), `Downloading speech model ${pct(e.loaded, e.total)}% (once)`);
    }
  };
  let p;
  if (typeof navigator !== 'undefined' && navigator.gpu) {
    try {
      p = await pipeline('automatic-speech-recognition', repo, { device: 'webgpu', dtype: { encoder_model: 'fp32', decoder_model_merged: 'q4' }, progress_callback });
    } catch (e) { console.warn('[Vid2Study] WebGPU speech model failed, using CPU:', e?.message); }
  }
  p ||= await pipeline('automatic-speech-recognition', repo, { dtype: 'q8', progress_callback });
  pipes.set(repo, p);
  return p;
}

/** Decode a media Blob's audio to 16 kHz mono Float32Array. */
export async function decodeMono16k(blob) {
  let ab;
  try {
    const ctx = new AudioContext({ sampleRate: SR });
    ab = await ctx.decodeAudioData(await blob.arrayBuffer());
    ctx.close();
  } catch (e) {
    throw new Error(`Could not read the audio track (${e?.message || e}). The file may be too large to decode (about 1 GB or more), have no sound, or use an unsupported codec. Use captions instead.`);
  }
  if (ab.numberOfChannels === 1) return ab.getChannelData(0);
  const out = new Float32Array(ab.length);
  for (let c = 0; c < ab.numberOfChannels; c++) {
    const d = ab.getChannelData(c);
    for (let i = 0; i < out.length; i++) out[i] += d[i] / ab.numberOfChannels;
  }
  return out;
}

/** True when a stretch of audio is (nearly) silent: RMS below a small floor. */
export function isSilent(samples, floor = 0.004) {
  let sum = 0;
  const step = Math.max(1, Math.floor(samples.length / 20000));
  let n = 0;
  for (let i = 0; i < samples.length; i += step) { sum += samples[i] * samples[i]; n++; }
  return Math.sqrt(sum / Math.max(1, n)) < floor;
}

/** Whisper invents text on silence / music: drop bracketed tags and runs of the same line. */
export function cleanSegments(segs) {
  const out = [];
  let run = 0;
  for (const s of segs) {
    const t = s.text.trim();
    if (!t || /^[[(♪].*[\])♪]$/.test(t)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === t.toLowerCase()) { if (++run >= 2) continue; } else run = 0;
    out.push({ ...s, text: t });
  }
  return out;
}

/**
 * Whisper fed music, or a language it was not told about (a Hindi song through the English model), does not
 * fail: it invents short stock phrases ("I'm sorry.", "Thank you.", "No! No! No!") again and again.
 * True when a transcript is mostly that: stock phrases, or very few distinct lines for its length.
 * Pure. @param {{text:string}[]} segs
 */
const STOCK = /^(i'?m (so )?sorry|i'?m not sure|thank you( so much)?( for watching)?|thanks( for watching)?|no+|yes|yeah|oh+|okay|ok|you|bye|hmm+|uh+|ah+|wow|what|please|come on|let'?s go|subscribe.*|music|applause|laughter)[.!?,\s]*$/i;
export function looksHallucinated(segs) {
  const lines = segs.map((s) => String(s.text || '').trim()).filter(Boolean);
  if (lines.length < 6) return false;
  const parts = lines.flatMap((l) => l.split(/(?<=[.!?])\s+/)).map((p) => p.trim()).filter(Boolean);
  const stock = parts.filter((p) => STOCK.test(p) || p.split(/\s+/).length <= 1).length / parts.length;
  const distinct = new Set(parts.map((p) => p.toLowerCase().replace(/[^a-z0-9ऀ-ॿ ]/g, ''))).size / parts.length;
  const words = lines.join(' ').split(/\s+/).length;
  return stock > 0.5 || (distinct < 0.3 && words / lines.length < 6);
}

/**
 * Map positions in recorded audio (seconds) to positions in the video, from the anchors the page sent:
 * each anchor says "these n samples starting at sample o were played from video time t0 to t1".
 * Handles playback speed, pauses for ads and stalls exactly, because every block carries its own times.
 * @param {{o:number,n:number,t0:number,t1:number}[]} anchors ordered by o
 * @returns {(sec:number)=>number}
 */
export function makeTimeMap(anchors, sr = SR) {
  // anchors may still be growing (live recording), so the empty check is made on every call
  return (sec) => {
    if (!anchors.length) return sec;
    const s = sec * sr;
    let lo = 0, hi = anchors.length - 1;
    while (lo < hi) { const mid = (lo + hi + 1) >> 1; if (anchors[mid].o <= s) lo = mid; else hi = mid - 1; }
    const a = anchors[lo];
    const f = Math.min(1, Math.max(0, (s - a.o) / Math.max(1, a.n)));
    return a.t0 + f * (a.t1 - a.t0);
  };
}

/**
 * A sample source that is still being filled (YouTube audio heard from the tab). The recorder calls
 * push() with blocks as they arrive; transcribeAudio / transcribeCloud wait on until() for each
 * window, so transcription runs WHILE the video plays. Consumed audio is dropped (release()), so
 * memory stays small however long the video is.
 */
export function createLiveAudio() {
  let parts = []; // { o, a: Int16Array } in order
  const anchors = [];
  const pending = new Map();
  let length = 0, nextSeq = 0, finished = false, error = null, waiters = [];
  const wake = () => {
    waiters = waiters.filter((w) => {
      if (error) { w.rej(error); return false; }
      if (finished || length >= w.n) { w.res(); return false; }
      return true;
    });
  };
  const audio = {
    get length() { return length; },
    until: (n) => (error ? Promise.reject(error) : finished || length >= n ? Promise.resolve() : new Promise((res, rej) => waiters.push({ n, res, rej }))),
    slice(a, b) {
      const end = Math.min(b, length);
      const out = new Float32Array(Math.max(0, end - a));
      for (const p of parts) {
        const lo = Math.max(a, p.o), hi = Math.min(end, p.o + p.a.length);
        for (let i = lo; i < hi; i++) out[i - a] = p.a[i - p.o] / 32768;
      }
      return out;
    },
    release(upTo) { parts = parts.filter((p) => p.o + p.a.length > upTo); }
  };
  return {
    audio,
    mapTime: makeTimeMap(anchors),
    /** @param {{seq:number,n:number,t0:number,t1:number,b64:string}} m a block from the page (any order) */
    push(m) {
      pending.set(m.seq, m);
      while (pending.has(nextSeq)) {
        const q = pending.get(nextSeq);
        pending.delete(nextSeq++);
        const bin = atob(q.b64);
        const u8 = new Uint8Array(bin.length);
        for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
        const a = new Int16Array(u8.buffer);
        parts.push({ o: length, a });
        anchors.push({ o: length, n: a.length, t0: q.t0, t1: q.t1 });
        length += a.length;
      }
      wake();
    },
    finish() { finished = true; wake(); },
    fail(e) { error = e; wake(); },
    get length() { return length; }
  };
}

/**
 * Transcribe 16 kHz mono audio in 5-minute windows.
 * @param {{length:number, slice:(a:number,b:number)=>Float32Array}} audio  sample source
 * @param {{size?:string, language?:string, signal:AbortSignal, progress:Function, mapTime?:(sec:number)=>number,
 *          resume?:{segments:object[], nextSec:number}, onWindow?:(state:{segments:object[],nextSec:number})=>Promise<void>}} o
 *   language: 'en' (English-only model), a language code, or 'auto' (multilingual model detects it)
 * @returns {Promise<{start:number,end:number,text:string}[]>}
 */
export async function transcribeAudio(audio, { size = 'base', language = 'en', signal, progress, mapTime, resume, onWindow }) {
  progress('transcribe', null, 'Loading the speech model');
  const pipe = await getPipe(size, language, progress);
  const map = mapTime || ((s) => s);
  const segments = [...(resume?.segments || [])];
  for (let s = resume?.nextSec || 0; ; s += WINDOW_SEC) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    // a live source (audio still being recorded) makes us wait until a whole window is there, or the end
    await audio.until?.(Math.floor((s + WINDOW_SEC) * SR));
    if (s * SR >= audio.length) break;
    const dur = audio.length / SR; // grows while listening
    const slice = await audio.slice(Math.floor(s * SR), Math.min(audio.length, Math.floor((s + WINDOW_SEC) * SR)));
    if (!isSilent(slice)) {
      const out = await pipe(slice, whisperOptions(language));
      for (const c of out?.chunks || []) {
        const [a, b] = c.timestamp || [0, null];
        const start = s + (a || 0);
        segments.push({ start: map(start), end: map(s + (b ?? (a || 0) + 5)), text: String(c.text || '') });
      }
    }
    const next = s + WINDOW_SEC;
    await onWindow?.({ segments: cleanSegments(segments), nextSec: next });
    audio.release?.(Math.floor(next * SR)); // a live source can drop what is done
    progress('transcribe', pct(Math.min(next, dur), dur), `Transcribing ${fmtTime(map(Math.min(next, dur)))} / ${fmtTime(map(dur))}`);
  }
  return cleanSegments(segments);
}
