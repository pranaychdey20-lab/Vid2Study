/**
 * Keyframe scan (ES module, needs DOM). Walks through a video with a "grabber" (see frames.js), draws a
 * tiny grayscale thumbnail at each sample time, feeds it to the SceneDetector and saves ONE full-size
 * PNG per scene change, with its timestamp. If the lecturer talks over the same slide for 10 minutes,
 * nothing is saved for those 10 minutes. Near-duplicates (animated slide builds) are dropped with the
 * perceptual hash from frames.js.
 */
import { putFrame } from './db.js';
import { fmtTime } from './common.js';
import { aHash, thumb, isDuplicate, toPng } from './frames.js';
import { SceneDetector, MotionMask, THUMB_W, THUMB_H, toGray, halve, frameMetrics, pickSettled, changedFraction, maskedHash, inkBlocks } from './scenes.js';

const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);

/**
 * @param {object} grabber { open(), draw(t, canvas), close() } from frames.js / offscreen.js
 * @param {{key:string, signal:AbortSignal, progress:Function, threshold:number, sampleSeconds:number,
 *          maxSamples:number, maxScenes:number, onFrame?:Function}} o
 *   onFrame(frame) is called as soon as each frame is saved (the caller can start reading it while the scan goes on)
 * @returns {Promise<{frames: {index:number,t:number,filename:string}[], duration:number, samples:number, capped:boolean}>}
 */
export async function scanScenes(grabber, { key, signal, progress, threshold = 0.05, sampleSeconds = 2, maxSamples = 4000, maxScenes = 600, refine = 2, onFrame }) {
  const frames = [];
  try {
    const info = await grabber.open();
    const dur = info.duration;
    if (!Number.isFinite(dur) || dur <= 0) throw new Error('This video has no known length (live stream?), so slides cannot be scanned.');
    // the grabber may already hold pictures on its own grid (YouTube: taken while listening): use that grid
    const step = Math.max(Number(info.step) || Number(sampleSeconds) || 2, dur / maxSamples);
    const times = [];
    for (let t = 0; t < dur - 0.5; t += step) times.push(t);
    if (!times.length) times.push(0);

    // samples are read at twice the detector's size: sharpness and "ink" need the detail, the detector does not
    const MW = THUMB_W * 2, MH = THUMB_H * 2;
    const tiny = document.createElement('canvas');
    tiny.width = MW;
    tiny.height = MH;
    const tctx = tiny.getContext('2d', { willReadFrequently: true });
    const big = document.createElement('canvas');
    big.width = info.width;
    big.height = info.height;

    const det = new SceneDetector({ threshold });
    const motionMask = new MotionMask(THUMB_W, THUMB_H);
    const sigs = [];
    let failed = 0;
    let capped = false;

    // `t` = when the scene starts (aligned with the transcript, used for "watch at"); `shot` = its best moment
    const save = async (t, shot = t) => {
      if (frames.length >= maxScenes) { capped = true; return; }
      await grabber.draw(shot, big);
      const sig = { hash: aHash(big), thumb: thumb(big) };
      if (isDuplicate(sig, sigs)) return;
      sigs.push(sig);
      const index = frames.length + 1;
      const filename = `scene_${String(index).padStart(4, '0')}_${fmtTime(t, '-')}.png`;
      const png = await toPng(big);
      if (!png) return;
      await putFrame(`${key}/${filename}`, png);
      // h: 64-bit picture hash; mh / eb: the same with the presenter's camera masked out, and where the
      // writing is (inkBlocks): used by mergeRepeats to drop repeats and step-by-step build-ups without AI
      const b = scene?.best;
      const extra = b?.gray ? { mh: maskedHash(b.gray, THUMB_W, THUMB_H, b.mask), eb: inkBlocks(b.gray, THUMB_W, THUMB_H, b.mask), ink: b.ink } : {};
      frames.push({ index, t, shot, filename, h: sig.hash.join(''), sharp: b?.sharp, ...extra });
      onFrame?.(frames[frames.length - 1]);
    };

    // One scene = the samples from one detector keyframe to the next. Its picture is taken at its best
    // moment (pickSettled): still, sharp, fully drawn in. Samples while a change is still settling are
    // transitions (blur, fades, a half-drawn chart) and are never candidates.
    let scene = null, prev = null, lastT = 0;
    const close = async () => {
      if (!scene) return;
      const shot = pickSettled(scene.cands, threshold / 2);
      scene.best = scene.cands.find((c) => c.t === shot);
      await save(scene.start, shot);
      scene = null;
    };
    // one sample: draw small, gray it. null when the frame could not be read
    let tries = 0, drawn = 0;
    const sample = async (t) => {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
      tries++;
      try {
        await grabber.draw(t, tiny);
        tctx.getImageData(0, 0, 1, 1); // throws on a tainted canvas
        const mid = toGray(tctx.getImageData(0, 0, MW, MH).data);
        drawn++;
        return { mid, gray: halve(mid, MW, MH) };
      } catch (e) {
        if (signal.aborted || e?.name === 'AbortError') throw e;
        if (++failed > 20 && failed > tries * 0.5) throw new Error(`Could not read video frames (${e.message}). The video may be protected or in an unsupported format.`);
        return null;
      }
    };
    // feed one sample (in time order) to the motion mask, the detector and the current scene
    const feed = async (t, { mid, gray }) => {
      const mask = motionMask.push(gray);
      det.mask = mask;
      const keep = det.push(t, gray);
      const motion = prev ? changedFraction(prev, gray, 24, mask) : 0;
      prev = gray;
      lastT = t;
      if (keep != null) { await close(); scene = { start: keep, cands: [] }; }
      if (scene && !det.pending) scene.cands.push({ t, motion, gray, mask, ...frameMetrics(mid, MW, MH) });
    };
    const tick = (t) => progress('scenes', pct(t, dur), `Scanning for slide changes ${fmtTime(t)} / ${fmtTime(dur)} · ${frames.length} found`);

    // COARSE + REFINE: a seekable video is first sampled every `refine` steps (every 2nd sample = 4 s by
    // default); where two coarse samples differ, the fine samples in between are read. So a slide that stays
    // up for minutes costs half the seeks, and nothing is lost: a slide on screen for at least one coarse
    // step always covers a coarse sample, and the interval right AFTER a change is read in full too (slides
    // tend to change in bursts). refine = 1 reads every sample. A grabber with its own grid (YouTube pictures
    // already taken while listening) is walked sample by sample as before.
    const k = info.step ? 1 : Math.max(1, Math.round(refine));
    const coarse = [];
    for (let i = 0; i < times.length; i += k) coarse.push(i);
    if (coarse[coarse.length - 1] !== times.length - 1) coarse.push(times.length - 1);
    let last = null; // { i, gray } the last coarse sample that was read
    let burst = false; // the previous interval changed: read this one in full as well
    for (let n = 0; n < coarse.length; n++) {
      const ci = coarse[n];
      const cur = await sample(times[ci]);
      const changed = !!(cur && last && changedFraction(last.gray, cur.gray, 24, motionMask.mask) >= threshold / 3);
      if (cur && last && ci - last.i > 1 && (changed || burst)) {
        for (let j = last.i + 1; j < ci; j++) {
          const s = await sample(times[j]);
          if (s) await feed(times[j], s);
        }
      }
      if (cur && last) burst = changed;
      if (cur) { await feed(times[ci], cur); last = { i: ci, gray: cur.gray }; }
      if (n % 5 === 0) tick(times[ci]);
    }
    const tail = det.finish(lastT);
    if (tail != null) { await close(); scene = { start: tail, cands: [{ t: tail, motion: 1, sharp: 0, ink: 0 }] }; }
    await close();
    progress('scenes', 100, `Found ${frames.length} slide changes${capped ? ` (stopped at the ${maxScenes} limit)` : ''}`);
    return { frames, duration: dur, samples: times.length, read: drawn, capped };
  } finally {
    grabber.close();
  }
}
