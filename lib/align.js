/**
 * Match on-screen content to the transcript by timestamp (pure algorithm, no AI).
 * Each chunk gets the frames whose time falls inside it (binary search over chunk starts), and
 * `interleave` produces one text block where speech and screen text are in time order.
 */
import { fmtTime } from './common.js';
import { formatSegments, mergeSegments } from './transcript.js';

/** Index of the last element whose `start` is <= t (0 when t is before the first). */
export function chunkIndexFor(chunks, t) {
  let lo = 0, hi = chunks.length - 1;
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1;
    if (chunks[mid].start <= t) lo = mid; else hi = mid - 1;
  }
  return lo;
}

/**
 * Put every frame into the chunk that contains its time. Mutates and returns `chunks`, each with
 * `screen: frames[]` sorted by time. Frames before the first chunk go to the first, after the last to the last.
 * @param {{start:number}[]} chunks ordered
 * @param {{t:number}[]} frames
 */
export function assignFrames(chunks, frames) {
  for (const c of chunks) c.screen = [];
  if (!chunks.length) return chunks;
  for (const f of [...frames].sort((a, b) => a.t - b.t)) chunks[chunkIndexFor(chunks, f.t)].screen.push(f);
  return chunks;
}

const oneLine = (s, max) => String(s || '').replace(/\s+/g, ' ').trim().slice(0, max);

/**
 * Text for one frame: "[mm:ss] ON SCREEN F3 (slide text): ..." or "(diagram): <vision description>".
 * `f.text` is OCR text; `f.vision` is a vision-model description (only for low-text frames).
 */
export function screenLine(f, maxChars) {
  // code, tables and worked equations must keep their lines (a derivation squashed into one line loses its steps)
  const heavy = (f.kinds || []).some((k) => k === 'code' || k === 'table' || k === 'formula');
  const max = maxChars || (heavy ? 1800 : 900);
  const parts = [];
  if (f.text) parts.push(`text: ${oneLine(f.text, max)}`);
  if (f.vision) parts.push(`picture: ${heavy ? String(f.vision).trim().slice(0, max) : oneLine(f.vision, max)}`);
  const kinds = [...new Set([f.tag, ...(f.kinds || [])].filter(Boolean))]; // tag: what the frame selector saw (map, patent, ...)
  const tag = kinds.length ? ` [${kinds.join(', ')}]` : '';
  return `[${fmtTime(f.t)}] ON SCREEN F${f.index}${tag}${parts.length ? ` (${parts.join('; ')})` : ' (not described: never say what it shows)'}`;
}

/** Speech lines and screen lines in one block, ordered by time. */
export function interleave(chunk, { mergeSec = 15 } = {}) {
  const speech = mergeSegments(chunk.segments, mergeSec).map((s) => ({ t: s.start, line: formatSegments([s]) }));
  const screen = (chunk.screen || []).map((f) => ({ t: f.t, line: screenLine(f) }));
  // text-only screen lines: what the vision model read off frames it dropped as figures (chunk.extra)
  const extra = (chunk.extra || []).map((x) => ({ t: x.t, line: x.line }));
  return [...speech, ...screen, ...extra].sort((a, b) => a.t - b.t).map((x) => x.line).join('\n');
}

/** Keep the Writer's source types separate and send identical frame text only once. */
export function writerEvidence(chunks, ocr, bullets) {
  const speech = bullets === undefined
    ? chunks.map(chunk => formatSegments(mergeSegments(chunk.segments, 15))).filter(Boolean).join('\n')
    : '';
  const slideText = [], descriptions = [];
  for (const chunk of chunks) {
    for (const frame of chunk.screen || []) {
      const source = ocr[frame.index];
      const raw = (source?.conf ?? 100) >= 50 ? String(source?.text || '').trim() : '';
      const heavy = (frame.kinds || []).some(kind => ['code', 'table', 'formula'].includes(kind));
      const text = bullets === undefined ? oneLine(frame.text, heavy ? 1800 : 900) : '';
      const vision = String(frame.vision || '').trim();
      const label = `[${fmtTime(frame.t)}] ON SCREEN F${frame.index}`;
      // OCR stays verbatim. In ordinary prose, differences in line wrapping alone carry no new text.
      const sameText = raw && (heavy ? raw === text : raw.replace(/\s+/g, ' ') === text);
      if (raw || text) slideText.push([
        raw && `${label} OCR:\n${raw}`,
        text && !sameText && `${label} selected text: ${text}`
      ].filter(Boolean).join('\n'));
      if (vision) descriptions.push(`${label}${frame.presentation ? ' [' + frame.presentation + ']' : ''}: ${vision}`);
    }
  }
  const textOnly = bullets === undefined
    ? chunks.flatMap(chunk => chunk.extra || []).sort((a, b) => a.t - b.t).map(item => item.line).join('\n')
    : '';
  return [
    ['LECTURE TRANSCRIPT', speech],
    ['CHEAP AI CHUNK NOTES', bullets],
    ['FRAME OCR AND SELECTED SLIDE TEXT', slideText.join('\n')],
    ['VISION DESCRIPTIONS', descriptions.join('\n')],
    ['TEXT-ONLY SCREEN EVIDENCE', textOnly]
  ].filter(([, content]) => content).map(([heading, content]) => `${heading}\n${content}`).join('\n\n');
}
