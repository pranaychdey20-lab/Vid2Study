/**
 * Split a transcript into chunks of about `targetSec` (default 12.5 min), cutting at the best
 * boundary near the target instead of mid-sentence: prefer a long pause, and a boundary close to a
 * scene change (a new slide usually means a new idea). Pure algorithm, no AI.
 */

/**
 * @param {{start:number,end:number,text:string}[]} segs ordered segments
 * @param {{targetSec?:number, sceneTimes?:number[]}} o
 * @returns {{index:number,start:number,end:number,segments:object[]}[]}
 */
export function chunkSegments(segs, { targetSec = 750, sceneTimes = [] } = {}) {
  if (!segs.length) return [];
  const make = (a, b) => ({ index: 0, start: segs[a].start, end: segs[b - 1].end, segments: segs.slice(a, b) });
  const scenes = [...sceneTimes].sort((x, y) => x - y);
  const nearScene = (t) => {
    let lo = 0, hi = scenes.length;
    while (lo < hi) { const mid = (lo + hi) >> 1; if (scenes[mid] < t) lo = mid + 1; else hi = mid; }
    return (scenes[lo] != null && scenes[lo] - t <= 20) || (scenes[lo - 1] != null && t - scenes[lo - 1] <= 20);
  };
  const out = [];
  let from = 0;
  while (from < segs.length) {
    const t0 = segs[from].start;
    if (segs[segs.length - 1].end - t0 <= targetSec * 1.25) { out.push(make(from, segs.length)); break; }
    let best = -1, bestScore = -Infinity, i = from;
    for (; i < segs.length - 1; i++) {
      const len = segs[i].end - t0;
      if (len > targetSec * 1.25) break;
      if (len < targetSec * 0.75) continue;
      const gap = Math.max(0, segs[i + 1].start - segs[i].end);
      const score = Math.min(gap, 5) + (nearScene(segs[i].end) ? 3 : 0) - (Math.abs(len - targetSec) / targetSec) * 2;
      if (score > bestScore) { bestScore = score; best = i; }
    }
    const cut = best >= 0 ? best : Math.max(from, i - 1);
    out.push(make(from, cut + 1));
    from = cut + 1;
  }
  out.forEach((c, k) => { c.index = k; });
  return out;
}
