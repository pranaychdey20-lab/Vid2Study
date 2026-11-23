/**
 * Transcript helpers (pure ES module, no DOM). A transcript is an ordered list of segments
 * { start, end, text } in seconds. It comes from captions ("[mm:ss] text" lines made by the content
 * script) or from local speech recognition (lib/asr.js).
 */
import { fmtTime } from './common.js';

/** "[mm:ss] text" or "[h:mm:ss] text" lines -> segments. A line without a time continues the previous one. */
export function parseTimestamped(text) {
  const segs = [];
  for (const raw of String(text || '').replace(/\r/g, '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    const m = /^\[(?:(\d+):)?(\d+):(\d+)\]\s*(.*)$/.exec(line);
    if (m) {
      const start = (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
      // "[125:03]" (minutes past 99) has no hour group, so m[1] is undefined and m[2] is 125: that works too.
      if (m[4]) segs.push({ start, end: start, text: m[4] });
    } else if (segs.length) {
      segs[segs.length - 1].text += ` ${line}`;
    }
  }
  segs.sort((a, b) => a.start - b.start);
  for (let i = 0; i < segs.length; i++) {
    const next = segs[i + 1]?.start;
    segs[i].end = next != null && next > segs[i].start ? next : segs[i].start + 20;
  }
  return segs;
}

/** Merge tiny segments into pieces of at least `minSec` (fewer, fuller lines = fewer tokens). */
export function mergeSegments(segs, minSec = 15) {
  const out = [];
  let cur = null;
  for (const s of segs) {
    if (!cur) { cur = { ...s }; continue; }
    if (cur.end - cur.start >= minSec) { out.push(cur); cur = { ...s }; } else { cur.text += ` ${s.text}`; cur.end = s.end; }
  }
  if (cur) out.push(cur);
  return out;
}

/** Segments -> "[mm:ss] text" lines for a prompt. */
export function formatSegments(segs) {
  return segs.map((s) => `[${fmtTime(s.start)}] ${s.text}`).join('\n');
}

/** Total spoken length in seconds (end of the last segment). */
export const transcriptDuration = (segs) => (segs.length ? segs[segs.length - 1].end : 0);
