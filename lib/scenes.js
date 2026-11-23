/**
 * Scene-change detector (pure, no DOM). Fed small grayscale thumbnails one after another, it says
 * when the picture changed enough to count as a new slide / code window / board.
 *
 * score = the fraction of pixels whose brightness moved by more than `pixelDelta` (of 255).
 * (ffmpeg's `scene` score is a different measure; a text slide changing to another text slide moves
 * only a few percent of the pixels, so the default threshold here is lower than ffmpeg's 0.3.)
 *
 * A new scene is compared with the LAST KEPT keyframe (so a slow build-up still triggers), and the
 * keyframe is taken one sample later, once the picture has settled (so fades and animations do not
 * produce a half-drawn slide).
 */

export const THUMB_W = 160;
export const THUMB_H = 90;

/**
 * Fraction of pixels that changed by more than `delta` between two equal-length gray arrays.
 * `mask` (optional, 1 = ignore) leaves out the presenter's camera box (see MotionMask).
 */
export function changedFraction(a, b, delta = 24, mask = null) {
  let n = 0, m = 0;
  for (let i = 0; i < a.length; i++) {
    if (mask && mask[i]) continue;
    m++;
    if (Math.abs(a[i] - b[i]) > delta) n++;
  }
  return m ? n / m : 0;
}

/**
 * Learns which pixels move ALL the time (the teacher's face / webcam box, a looping clip) so they stop
 * counting as "the slide changed". Each pixel keeps a decaying rate of how often it changes between
 * samples; a slide change bumps every pixel once, a talking face keeps its pixels busy. Pixels busy in
 * more than `on` of the samples are masked (grown by one pixel). No mask while it is still learning,
 * when almost nothing is busy, or when most of the frame is busy (a camera video: there is no slide). Pure.
 */
export class MotionMask {
  constructor(w, h, { rate = 0.06, on = 0.3, warmup = 12, maxShare = 0.4, delta = 24 } = {}) {
    Object.assign(this, { w, h, rate, on, warmup, maxShare, delta });
    this.freq = new Float32Array(w * h);
    this.prev = null;
    this.count = 0;
    this.mask = null;
  }
  push(gray) {
    const { freq, rate, delta } = this;
    if (this.prev) {
      const p = this.prev;
      for (let i = 0; i < freq.length; i++) freq[i] = freq[i] * (1 - rate) + (Math.abs(gray[i] - p[i]) > delta ? rate : 0);
      this.count++;
    }
    this.prev = gray;
    if (this.count >= this.warmup) this.mask = this.build();
    return this.mask;
  }
  build() {
    const { w, h, freq, on } = this;
    const raw = new Uint8Array(w * h);
    for (let i = 0; i < raw.length; i++) if (freq[i] > on) raw[i] = 1;
    const m = new Uint8Array(w * h);
    let n = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      let hit = 0;
      for (let dy = -1; dy <= 1 && !hit; dy++) for (let dx = -1; dx <= 1 && !hit; dx++) {
        const yy = y + dy, xx = x + dx;
        if (yy >= 0 && yy < h && xx >= 0 && xx < w && raw[yy * w + xx]) hit = 1;
      }
      if (hit) { m[y * w + x] = 1; n++; }
    }
    const share = n / m.length;
    return share < 0.004 || share > this.maxShare ? null : m;
  }
}

/**
 * 64-bit difference hash ('0'/'1' string) of a gray frame with the masked pixels painted over by the
 * frame's average, so the same slide with the teacher looking another way hashes the same. Pure.
 */
export function maskedHash(gray, w, h, mask = null) {
  let sum = 0, n = 0;
  for (let i = 0; i < gray.length; i++) if (!mask || !mask[i]) { sum += gray[i]; n++; }
  const fill = n ? sum / n : 0;
  const cell = new Float64Array(9 * 8), cnt = new Uint32Array(9 * 8);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = y * w + x, c = Math.min(7, Math.floor((y * 8) / h)) * 9 + Math.min(8, Math.floor((x * 9) / w));
    cell[c] += mask && mask[i] ? fill : gray[i];
    cnt[c]++;
  }
  let out = '';
  for (let r = 0; r < 8; r++) for (let c = 0; c < 8; c++) {
    const a = cell[r * 9 + c] / (cnt[r * 9 + c] || 1), b = cell[r * 9 + c + 1] / (cnt[r * 9 + c + 1] || 1);
    out += a < b ? '1' : '0';
  }
  return out;
}

export const INK_GRID_W = 32, INK_GRID_H = 18;
/**
 * Where on the screen there is writing: a 32x18 grid ('0'/'1' string), a cell is '1' when enough of its
 * pixels sit on a strong edge (text, lines, handwriting). Masked cells are always '0'. A board written
 * step by step only ever ADDS cells, which is how `inkContainment` spots a build-up without OCR. Pure.
 */
export function inkBlocks(gray, w, h, mask = null, minShare = 0.08) {
  const GW = INK_GRID_W, GH = INK_GRID_H;
  const edge = new Uint32Array(GW * GH), all = new Uint32Array(GW * GH), masked = new Uint32Array(GW * GH);
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x, c = Math.min(GH - 1, Math.floor((y * GH) / h)) * GW + Math.min(GW - 1, Math.floor((x * GW) / w));
    all[c]++;
    if (mask && mask[i]) { masked[c]++; continue; }
    const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    if (Math.abs(lap) > 40) edge[c]++;
  }
  let out = '';
  for (let c = 0; c < GW * GH; c++) out += all[c] && masked[c] < all[c] / 2 && edge[c] / all[c] >= minShare ? '1' : '0';
  return out;
}

/** Share of a's inked cells that are also inked in b (1 = everything written on a is still on b). Pure. */
export function inkContainment(a, b) {
  let na = 0, both = 0;
  for (let i = 0; i < a.length; i++) if (a[i] === '1') { na++; if (b[i] === '1') both++; }
  return na ? both / na : 1;
}
export const inkCount = (a) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] === '1') n++; return n; };

/** RGBA ImageData bytes -> gray array. */
export function toGray(rgba) {
  const g = new Uint8Array(rgba.length / 4);
  for (let i = 0; i < g.length; i++) g[i] = (rgba[i * 4] * 77 + rgba[i * 4 + 1] * 150 + rgba[i * 4 + 2] * 29) >> 8;
  return g;
}

/** Halve a gray image (2x2 average): the metrics run at 320x180, the detector at 160x90. */
export function halve(gray, w, h) {
  const W = w >> 1, H = h >> 1, out = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const i = 2 * y * w + 2 * x;
    out[y * W + x] = (gray[i] + gray[i + 1] + gray[i + w] + gray[i + w + 1]) >> 2;
  }
  return out;
}

/**
 * How sharp and how "drawn" a frame is. sharp = variance of the Laplacian (motion blur, whip pans and
 * cross-fades make it drop); ink = fraction of pixels on a strong edge (grows while a chart, text or
 * diagram is still being drawn in, so the most complete moment of an animation has the most ink). Pure.
 */
export function frameMetrics(gray, w, h) {
  let sum = 0, sq = 0, n = 0, edges = 0;
  for (let y = 1; y < h - 1; y++) for (let x = 1; x < w - 1; x++) {
    const i = y * w + x;
    const lap = 4 * gray[i] - gray[i - 1] - gray[i + 1] - gray[i - w] - gray[i + w];
    sum += lap; sq += lap * lap; n++;
    if (Math.abs(lap) > 40) edges++;
  }
  const mean = sum / n;
  return { sharp: sq / n - mean * mean, ink: edges / n };
}

/**
 * The best moment of one scene ("peak information density"): among its samples, the still ones (little
 * change from the previous sample: no transition, no camera move) that are sharp, with the most drawn
 * in. Falls back to the sharpest sample when nothing in the scene stands still. Pure.
 * @param {{t:number, motion:number, sharp:number, ink:number}[]} cands  @param {number} still  motion below this = still
 * @returns {number} the time to capture
 */
export function pickSettled(cands, still = 0.025) {
  if (!cands.length) return null;
  const maxSharp = Math.max(...cands.map((c) => c.sharp)) || 1;
  const maxInk = Math.max(...cands.map((c) => c.ink)) || 1;
  const calm = cands.filter((c) => c.motion < still && c.sharp >= maxSharp * 0.5);
  const pool = calm.length ? calm : cands;
  let best = pool[0], bestScore = -1;
  for (const c of pool) {
    const score = 0.6 * (c.ink / maxInk) + 0.4 * (c.sharp / maxSharp);
    if (score > bestScore + 1e-9) { best = c; bestScore = score; }
  }
  return best.t;
}

export class SceneDetector {
  /** @param {{threshold?:number, pixelDelta?:number, maxUnsettled?:number}} o */
  constructor({ threshold = 0.05, pixelDelta = 24, maxUnsettled = 3 } = {}) {
    this.threshold = threshold;
    this.delta = pixelDelta;
    this.maxUnsettled = maxUnsettled;
    this.ref = null; // gray of the last kept keyframe
    this.pending = null; // { t, gray, n } a change that is not settled yet
    this.mask = null; // MotionMask.mask: pixels ignored when comparing (the presenter's camera)
  }

  /**
   * Feed the next sample. Returns the time to capture as a keyframe, or null.
   * (The first sample is always a keyframe.)
   */
  push(t, gray) {
    if (!this.ref) { this.ref = gray; return t; }
    if (this.pending) {
      const settled = changedFraction(this.pending.gray, gray, this.delta, this.mask) < this.threshold / 2;
      if (settled || this.pending.n >= this.maxUnsettled) {
        this.ref = gray;
        this.pending = null;
        return t;
      }
      this.pending = { gray, n: this.pending.n + 1 };
      return null;
    }
    if (changedFraction(this.ref, gray, this.delta, this.mask) >= this.threshold) this.pending = { gray, n: 1 };
    return null;
  }

  /** Call after the last sample: a change that never settled still counts. Returns a time or null. */
  finish(lastT) {
    if (!this.pending) return null;
    this.ref = this.pending.gray;
    this.pending = null;
    return lastT;
  }
}
