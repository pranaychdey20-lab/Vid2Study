/**
 * LOSSLESS transcript trimming (pure, no DOM, no AI). Removes only what carries no meaning, so the writer
 * reads fewer tokens without losing a fact:
 *   - sound tags: [Music], (applause), [inaudible], ♪
 *   - filler noises: um, uh, umm, uhh, erm, hmm, ah (English) and their Devanagari spellings
 *   - stutters: the same 1-4 words said twice or more in a row ("the the", "so this is so this is")
 *     (never for numbers: "1 0 0" read out from a matrix stays)
 *   - a line repeated word for word right after itself (speech-recognition loops)
 *   - extra spaces
 * Timestamps are kept, so alignment with the frames does not change.
 * The cheap-model fallback for very long lectures lives in local-pipeline.js ([TASK:TRIM]).
 */

const TAGS = /\[(?:music|applause|laughter|laughs|inaudible|silence|noise|background noise|blank_audio|no speech)[^\]]*\]|\((?:music|applause|laughter|laughs|inaudible|silence|noise)[^)]*\)|[♪♫]+/gi;
const FILLERS = /(^|[\s,.;!?])(?:u+m+|u+h+|e+r+m+|h+m+|a+h+|उम्?|अं+|हम्म+)(?=$|[\s,.;!?])[,]?/gi;
// 1-4 words (letters, Latin or Devanagari, apostrophes) repeated right after themselves
const STUTTER = /(^|\s)((?:[A-Za-zऀ-ॿ'’]+)(?:\s+[A-Za-zऀ-ॿ'’]+){0,3})(?:[\s,]+\2)+(?=$|[\s,.;!?])/gi;

/** Clean one piece of text. Pure. */
export function trimText(text) {
  let s = String(text || '').replace(TAGS, ' ');
  s = s.replace(FILLERS, '$1');
  // run twice: removing one stutter can reveal another ("I I I think think")
  for (let i = 0; i < 2; i++) s = s.replace(STUTTER, '$1$2');
  return s.replace(/\s+([,.;!?])/g, '$1').replace(/([,])\1+/g, '$1').replace(/\s{2,}/g, ' ').replace(/^[\s,]+/, '').trim();
}

/** Rough token count (about 4 characters per token for English, fewer for Devanagari). Pure. */
export const estimateTokens = (text) => {
  const s = String(text || '');
  const dev = (s.match(/[ऀ-ॿ]/g) || []).length;
  return Math.ceil((s.length - dev) / 4 + dev / 2);
};

/**
 * Trim a transcript. Segments that end up empty are dropped; a segment identical to the one before it is
 * merged into it (its end time extends). Pure.
 * @param {{start:number,end:number,text:string}[]} segs
 * @returns {{segs: {start:number,end:number,text:string}[], before:number, after:number}} before/after = token estimates
 */
export function trimSegments(segs) {
  const out = [];
  let before = 0, after = 0;
  for (const s of segs || []) {
    before += estimateTokens(s.text);
    const text = trimText(s.text);
    if (!text || !/[\p{L}\p{N}]/u.test(text)) continue;
    const prev = out[out.length - 1];
    if (prev && prev.text.toLowerCase() === text.toLowerCase()) { prev.end = Math.max(prev.end, s.end); continue; }
    out.push({ ...s, text });
    after += estimateTokens(text);
  }
  return { segs: out, before, after };
}
