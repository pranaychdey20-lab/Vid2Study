/**
 * Notes are ONE Markdown document written in as many parts as the model's output limit needs. When a reply stops at the limit
 * the next request carries only "continue" (the transcript and the rules are already in the conversation: a session id, or the
 * same attachment replayed from the provider's prompt cache) and the parts are stitched here. Pure: no network, no DOM.
 */
import { completeWriterPrefix, takeWriterCoverage } from './coverage.js';

const MIN_OVERLAP = 12;

/**
 * Join a continuation to the text so far. A model told to "continue" sometimes repeats the last words or lines; the longest
 * overlap (at least 12 characters, at most 800) is dropped. A fenced wrapper around the whole continuation is removed.
 */
export function stitch(before, after) {
  let next = String(after ?? '').replace(/^\s*\x60{3}(?:markdown|md)?[ \t]*\n/i, '').replace(/\n\x60{3}[ \t]*$/, '');
  const text = String(before ?? '');
  const lead = next.length - next.trimStart().length;
  const body = next.slice(lead);
  const tail = text.slice(-800);
  for (let k = Math.min(tail.length, body.length, 800); k >= MIN_OVERLAP; k--) {
    if (tail.endsWith(body.slice(0, k))) { next = body.slice(k); return text + next; }
  }
  // a repeated whole line (the model restarted at the last line it wrote)
  const lastLine = text.slice(text.lastIndexOf('\n') + 1);
  if (lastLine.trim().length >= MIN_OVERLAP && body.startsWith(lastLine.trim())) return text.slice(0, text.length - lastLine.length) + body;
  return text + next;
}

/** A reply that stopped at the limit, or ends inside a fenced block, a visual or display maths: more is coming. */
export function isCut(reply, text) {
  return !!reply?.truncated || completeWriterPrefix(takeWriterCoverage(String(text ?? '')).md).incomplete;
}

/**
 * Keep asking for the rest until the document is whole (or `maxParts` is reached, or a reply adds nothing).
 * `more(textSoFar, lastReply, partNumber)` performs ONE continuation call and returns its reply.
 * @returns the last reply with the combined `text`, summed `usage`, `parts` and `truncated` (still cut after all parts).
 */
export async function completeParts({ first, more, cut = isCut, maxParts = 4, onPart }) {
  let text = String(first.text ?? ''), last = first, parts = 1;
  const usage = { in: first.usage?.in || 0, out: first.usage?.out || 0 };
  while (cut(last, text) && parts < maxParts) {
    onPart?.(parts + 1);
    const next = await more(text, last, parts);
    usage.in += next.usage?.in || 0;
    usage.out += next.usage?.out || 0;
    if (!String(next.text ?? '').trim()) break;
    const merged = stitch(text, next.text);
    if (merged === text) break;
    text = merged;
    last = { ...next, session: next.session ?? last.session };
    parts++;
  }
  return { ...last, text, usage, parts, truncated: cut(last, text) };
}
