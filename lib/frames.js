/**
 * Key-frame capture (ES module). A "grabber" supplies pixels at a time:
 *   { open(): {duration,width,height}, times(t,duration): number[], draw(t, canvas), close(), keepMissing? }
 * `blobGrabber` plays a local Blob/File in a hidden <video>; the YouTube grabber (offscreen.js) asks the
 * page's own player for frames. Picking the sharpest candidate and dropping near-duplicates is shared.
 */
import { putFrame } from './db.js';
import { fmtTime } from './common.js';

const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);

export function once(target, event, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { target.removeEventListener(event, ok); reject(new Error(`${event} timeout`)); }, ms);
    const ok = () => { clearTimeout(t); resolve(); };
    target.addEventListener(event, ok, { once: true });
  });
}

/**
 * Seek and wait until the new frame is actually decoded. The frame callback is the exact signal, but a
 * hidden page (offscreen document, background tab) often never paints, so it never fires and every seek
 * used to wait the full 350 ms fallback. After two misses on one video we stop waiting for it and draw
 * as soon as `readyState` says the current frame is there (a few ms after `seeked`).
 */
function seek(video, t) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { video.removeEventListener('seeked', onSeeked); reject(new Error('seek timeout')); }, 10000);
    const onSeeked = () => {
      clearTimeout(timer);
      let done = false;
      const finish = () => { if (!done) { done = true; resolve(); } };
      const rvfc = 'requestVideoFrameCallback' in video && (video._lhMiss || 0) < 2;
      if (rvfc) {
        video.requestVideoFrameCallback(() => { video._lhMiss = 0; finish(); });
        setTimeout(() => { if (!done) video._lhMiss = (video._lhMiss || 0) + 1; finish(); }, 350);
        return;
      }
      // poll: HAVE_CURRENT_DATA (2) = the frame at the new time is decoded; one extra tick to be safe
      const started = Date.now();
      const poll = () => {
        if (video.readyState >= 2) return setTimeout(finish, 8);
        if (Date.now() - started > 350) return finish();
        setTimeout(poll, 10);
      };
      poll();
    };
    video.addEventListener('seeked', onSeeked, { once: true });
    video.currentTime = t;
  });
}

const small = document.createElement('canvas');
const smallCtx = small.getContext('2d', { willReadFrequently: true });

/** Variance of the Laplacian on a 320px-wide grayscale copy: higher = sharper. */
export function sharpness(canvas) {
  const w = 320;
  const h = Math.max(3, Math.round((canvas.height * w) / canvas.width));
  small.width = w;
  small.height = h;
  smallCtx.drawImage(canvas, 0, 0, w, h);
  const d = smallCtx.getImageData(0, 0, w, h).data;
  const g = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  let sum = 0, sum2 = 0, n = 0;
  for (let y = 1; y < h - 1; y++) {
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      const l = g[i - w] + g[i + w] + g[i - 1] + g[i + 1] - 4 * g[i];
      sum += l; sum2 += l * l; n++;
    }
  }
  const mean = sum / n;
  return sum2 / n - mean * mean;
}

/** 8x8 average hash as a 64-element bit array. */
export function aHash(canvas) {
  small.width = 8;
  small.height = 8;
  smallCtx.drawImage(canvas, 0, 0, 8, 8);
  const d = smallCtx.getImageData(0, 0, 8, 8).data;
  const g = [];
  for (let i = 0; i < 64; i++) g.push(0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2]);
  const avg = g.reduce((a, b) => a + b, 0) / 64;
  return g.map((v) => (v >= avg ? 1 : 0));
}
const hamming = (a, b) => a.reduce((s, v, i) => s + (v !== b[i] ? 1 : 0), 0);

/** 256x144 grayscale thumbnail, used to confirm a hash match really is the same image. */
const TW = 256, TH = 144;
export function thumb(canvas) {
  small.width = TW;
  small.height = TH;
  smallCtx.drawImage(canvas, 0, 0, TW, TH);
  const d = smallCtx.getImageData(0, 0, TW, TH).data;
  const g = new Uint8Array(TW * TH);
  for (let i = 0; i < g.length; i++) g[i] = 0.299 * d[i * 4] + 0.587 * d[i * 4 + 1] + 0.114 * d[i * 4 + 2];
  return g;
}
/** Fraction of thumbnail pixels whose brightness changed noticeably (> 30/255). */
function changedFraction(a, b) {
  let n = 0;
  for (let i = 0; i < a.length; i++) if (Math.abs(a[i] - b[i]) > 30) n++;
  return n / a.length;
}

/**
 * Near-duplicate check. An 8x8 aHash alone is far too coarse for lecture slides: two different
 * text slides on a white background hash identically. So a hash match only counts as a
 * duplicate if almost no pixels changed (< 0.3% of a 256x144 thumbnail). When unsure we keep
 * the frame: an extra image is better than a lost slide.
 */
export const isDuplicate = (sig, kept) =>
  kept.some((k) => hamming(k.hash, sig.hash) <= 5 && changedFraction(k.thumb, sig.thumb) < 0.003);
export const toPng =(canvas) => new Promise((r) => canvas.toBlob(r, 'image/png'));

/** Grabber for a local video file / blob: seek a hidden <video> and draw it. */
export function blobGrabber(blob, maxWidth = 1600) {
  const objectUrl = URL.createObjectURL(blob);
  const video = document.createElement('video');
  video.muted = true;
  video.preload = 'auto';
  video.playsInline = true;
  video.src = objectUrl;
  return {
    async open() {
      await once(video, 'loadeddata', 30000);
      const scale = Math.min(1, maxWidth / video.videoWidth);
      return { duration: video.duration, width: Math.round(video.videoWidth * scale), height: Math.round(video.videoHeight * scale) };
    },
    times: (t, dur) => [t, Math.min(t + 2, Math.max(0, dur - 0.5))],
    async draw(t, canvas) {
      await seek(video, t);
      canvas.getContext('2d').drawImage(video, 0, 0, canvas.width, canvas.height);
    },
    close() {
      video.removeAttribute('src');
      video.load();
      URL.revokeObjectURL(objectUrl);
    }
  };
}

/**
 * Capture one sharp, de-duplicated PNG per key frame and store it in IndexedDB.
 * @param {object} grabber see top of file
 * @param {Array} keyFrames [{index, timestamp_seconds, title, description, type}]
 * @param {{key:string, signal:AbortSignal, progress:Function}} o
 * @returns {Promise<Array>} kept frame metadata (figure number, time, filename or null when no image)
 */
export async function captureFrames(grabber, keyFrames, { key, signal, progress }) {
  if (!keyFrames.length) return [];
  const kept = [];
  try {
    const info = await grabber.open();
    const dur = info.duration;
    const canvases = [0, 1].map(() => {
      const c = document.createElement('canvas');
      c.width = info.width;
      c.height = info.height;
      return c;
    });
    const sigs = [];
    for (let i = 0; i < keyFrames.length; i++) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      const f = keyFrames[i];
      progress('frames', pct(i, keyFrames.length), `Capturing frames ${i + 1}/${keyFrames.length}`);
      const t = Math.min(Math.max(0, f.timestamp_seconds), Math.max(0, dur - 0.5));
      const times = grabber.times(t, dur);

      let best = null;
      for (let k = 0; k < times.length; k++) {
        try {
          await grabber.draw(times[k], canvases[k]);
          const score = sharpness(canvases[k]);
          if (!best || score > best.score) best = { score, time: times[k], canvas: canvases[k] };
        } catch (e) {
          if (signal.aborted) throw e;
          console.warn(`[Vid2Study] frame ${f.index} @ ${times[k]}s skipped:`, e.message);
        }
      }
      if (!best) {
        // No pixels (blocked or failed). Keep a text-only figure when the caller wants timestamp links.
        if (grabber.keepMissing) kept.push({ ...f, figure: kept.length + 1, time: fmtTime(t), filename: null });
        continue;
      }
      const sig = { hash: aHash(best.canvas), thumb: thumb(best.canvas) };
      if (isDuplicate(sig, sigs)) continue; // near-duplicate of a kept frame
      sigs.push(sig);

      const figure = kept.length + 1;
      const filename = `frame_${String(figure).padStart(2, '0')}_${fmtTime(best.time, '-')}.png`;
      const png = await toPng(best.canvas);
      if (!png) continue;
      await putFrame(`${key}/${filename}`, png);
      kept.push({ ...f, figure, timestamp_seconds: best.time, time: fmtTime(best.time), filename });
    }
    progress('frames', 100, `Captured ${kept.filter((k) => k.filename).length} frames`);
    return kept;
  } finally {
    grabber.close();
  }
}

