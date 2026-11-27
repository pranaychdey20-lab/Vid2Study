/**
 * Pure helpers for working on a whole lecture: a compact outline, token-lean retrieval of the sections a request needs, a small
 * edit-script format the assistant writes, validation of what it wrote (nothing unsafe or malformed is ever applied), the
 * application of approved edits to the Markdown, and figure moves. No DOM, no network.
 *
 * Edit script (cheaper and safer than JSON: complete blocks survive a cut-off reply, no escaping of Markdown):
 *   @@ append S3                       add at the end of section S3
 *   @@ after S3 | first words          add after the paragraph / list / block that starts with those words
 *   @@ replace S3 | first words        replace that paragraph / visual block
 *   @@ section S3 | New title          add a new section after S3
 *   <Markdown, may hold ```visual blocks>
 *   @@ end                             present only when the reply is complete
 */
import { readVisual } from './textbook-visuals.js';

const TOPIC = /^###[ \t]+(.+?)[ \t]*$/;
const FENCE = /^\s*(`{3,}|~{3,})\s*([\w+-]*)/;
export const sectionTitle = (heading) => String(heading || '').replace(/\s+\(\d+(?::\d{2}){1,2}\)\s*$/, '').trim();
const timeOf = (heading) => /\((\d+(?::\d{2}){1,2})\)\s*$/.exec(heading)?.[1] || '';
const norm = (text) => String(text || '').toLowerCase().replace(/[`*_>#|\\$[\]()]/g, ' ').replace(/\s+/g, ' ').trim();

/** Topic sections (### headings outside code fences). A section ends at the next heading of level 1-3. */
export function parseSections(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const found = [];
  let fence = '', active = null;
  lines.forEach((line, i) => {
    const tick = FENCE.exec(line)?.[1];
    if (tick && (!fence || tick.startsWith(fence[0]))) fence = fence ? '' : tick;
    if (fence || !/^#{1,3}[ \t]/.test(line)) return;
    if (active) active.end = i;
    const heading = TOPIC.exec(line)?.[1];
    active = heading ? { heading, start: i, end: lines.length } : null;
    if (active) found.push(active);
  });
  const sections = found.map((section, i) => {
    const body = lines.slice(section.start + 1, section.end).join('\n').trim();
    return { ...section, id: 'S' + (i + 1), n: i + 1, title: sectionTitle(section.heading), time: timeOf(section.heading), body,
      visuals: (body.match(/^\s*>?\s*`{3}visual\b/gm) || []).length, math: /\$[^$\n]+\$|\$\$/.test(body), figures: (body.match(/\[\[FRAME:\d+\]\]|!\[[^\]]*\]\(images\//g) || []).length };
  });
  return { lines, sections };
}

const firstSentence = (body, max = 110) => {
  const plain = body.replace(/^\s*[>#-]+\s*/gm, '').replace(/`{3}[\s\S]*?(`{3}|$)/g, ' ').replace(/\[\[FRAME:\d+\]\]|!\[[^\]]*\]\([^)]*\)/g, ' ').replace(/\*\*|\$/g, '').replace(/\s+/g, ' ').trim();
  const cut = plain.slice(0, max);
  return plain.length > max ? cut.replace(/\s+\S*$/, '') + '…' : cut;
};

/** One line per section: ~25 tokens each. The whole lecture's shape for the price of a paragraph. */
export function outline(sections) {
  return sections.map(s => `${s.id} ${s.title}${s.time ? ' (' + s.time + ')' : ''} · ${s.body.length} chars${s.visuals ? ' · ' + s.visuals + ' visual' + (s.visuals > 1 ? 's' : '') : ''}${s.figures ? ' · ' + s.figures + ' figure' + (s.figures > 1 ? 's' : '') : ''}${s.math ? ' · maths' : ''} — ${firstSentence(s.body)}`).join('\n');
}

const STOP = new Set('the and for with that this from are was were but not you your can how why what when which where does did have has had into than then them they their about would could should there here some any all each every more most also only just like make made use used using onto over under between within without per via our out one two its it\'s is in on of to a an as at be by or if so we me my do no yes please give show tell explain add put new notes note lecture section sections topic topics'.split(' '));
const words = (text) => (String(text || '').toLowerCase().match(/[a-z0-9][a-z0-9'-]{2,}/g) || []).filter(w => !STOP.has(w));
const BROAD = /\b(whole|entire|all|every|each|throughout|complete|finish|unfinished|incomplete|rest of|everything|overall|across|lecture)\b/i;
const ORDINAL = { first: 1, second: 2, third: 3, fourth: 4, fifth: 5, sixth: 6, seventh: 7, eighth: 8, ninth: 9, tenth: 10 };

/** Which sections does this request point at by number or position? ("section 3", "S4", "the last section", "second topic") */
export function mentioned(request, count) {
  const out = new Set();
  const text = String(request || '');
  for (const m of text.matchAll(/\b(?:section|topic|part|sec)\s*#?\s*(\d{1,3})\b|\bS(\d{1,3})\b/gi)) { const n = Number(m[1] || m[2]); if (n >= 1 && n <= count) out.add(n); }
  for (const m of text.matchAll(/\b(first|second|third|fourth|fifth|sixth|seventh|eighth|ninth|tenth)\s+(?:section|topic|part)\b/gi)) if (ORDINAL[m[1].toLowerCase()] <= count) out.add(ORDINAL[m[1].toLowerCase()]);
  if (/\b(last|final|ending|end of)\s+(?:section|topic|part|lecture)\b/i.test(text)) out.add(count);
  if (/\b(first|opening|intro(?:duction)?)\s+(?:section|topic|part)\b/i.test(text)) out.add(1);
  return [...out];
}

/** Cut at a paragraph boundary when possible. */
export function clip(text, max) {
  if (text.length <= max) return text;
  const cut = text.slice(0, max), at = Math.max(cut.lastIndexOf('\n\n'), cut.lastIndexOf('\n'));
  return (at > max * 0.5 ? cut.slice(0, at) : cut).trimEnd() + '\n[…]';
}

/**
 * Choose the sections to send with a request, in document order, within `budget` characters.
 *  scope 'section' = only the focused section; 'lecture' (or a broad request) = every section, each clipped to its share;
 *  'auto' = the sections the request names, the focused one, and the best keyword matches (BM25).
 * @returns {{ picked: {section, text, clipped:boolean}[], mode: string }}
 */
export function pickSections(sections, request, { focus = null, budget = 9000, perSection = 3200, scope = 'auto' } = {}) {
  const N = sections.length;
  if (!N) return { picked: [], mode: 'empty' };
  const take = (list, each) => list.map(s => ({ section: s, text: clip(s.body, each), clipped: s.body.length > each }));
  if (scope === 'section' && focus) return { picked: take([focus], perSection * 2), mode: 'section' };
  if (scope === 'lecture' || (scope === 'auto' && BROAD.test(request) && /\b(notes|lecture|sections|topics|everything|whole|entire|all|every|each|throughout|complete|unfinished|incomplete|rest of)\b/i.test(request) && N > 1)) {
    const named = new Set(mentioned(request, N));
    const share = Math.max(400, Math.min(perSection, Math.floor(budget / N)));
    return { picked: sections.map(s => ({ section: s, text: clip(s.body, named.has(s.n) ? perSection : share), clipped: s.body.length > (named.has(s.n) ? perSection : share) })), mode: 'lecture' };
  }
  const query = [...new Set(words(request))];
  const df = new Map();
  const docs = sections.map(s => { const w = words(s.title + ' ' + s.title + ' ' + s.title + ' ' + s.body); const tf = new Map(); for (const t of w) tf.set(t, (tf.get(t) || 0) + 1); for (const t of tf.keys()) df.set(t, (df.get(t) || 0) + 1); return { tf, len: w.length }; });
  const avg = docs.reduce((a, d) => a + d.len, 0) / N || 1;
  const named = new Set(mentioned(request, N));
  const scored = sections.map((s, i) => {
    let score = 0;
    for (const t of query) { const f = docs[i].tf.get(t) || 0; if (!f) continue; const idf = Math.log(1 + (N - df.get(t) + 0.5) / (df.get(t) + 0.5)); score += idf * (f * 2.2) / (f + 1.2 * (0.25 + 0.75 * docs[i].len / avg)); }
    if (named.has(s.n)) score += 50;
    if (focus && s.id === focus.id) score += 4;
    return { s, score };
  }).sort((a, b) => b.score - a.score || a.s.n - b.s.n);
  const chosen = [];
  let used = 0;
  for (const { s, score } of scored) {
    if (score <= 0 && chosen.length >= 2) break;
    const size = Math.min(s.body.length, perSection);
    if (chosen.length && used + size > budget) continue;
    chosen.push(s); used += size;
    if (chosen.length >= 8) break;
  }
  if (!chosen.length) chosen.push(focus || sections[0]);
  chosen.sort((a, b) => a.n - b.n);
  return { picked: take(chosen, perSection), mode: 'auto' };
}

/** The text sent as the notes file: the outline, then each picked section under its tag. */
export function notesFile(sections, picked, title) {
  return `NOTES: ${title}\n\nOUTLINE (all ${sections.length} sections)\n${outline(sections)}\n\nSECTIONS SENT IN FULL\n` +
    (picked.map(p => `=== ${p.section.id} ${p.section.heading}${p.clipped ? ' [clipped]' : ''} ===\n${p.text}`).join('\n\n') || '(none)');
}

// ---------------------------------------------------------------------------------------------------------------------
// The edit script
// ---------------------------------------------------------------------------------------------------------------------
const HEADER = /^@@[ \t]*(append|after|replace|section)[ \t]+S?(\d{1,3})[ \t]*(?:\|[ \t]*(.*?))?[ \t]*$/i;
const END = /^@@[ \t]*end[ \t]*$/i;

/** @returns {{ ops: {op, n, arg, content}[], complete: boolean, stray: string }} */
export function parseEditScript(reply) {
  let text = String(reply || '').replace(/\r\n?/g, '\n').trim();
  const wrapped = /^`{3,}[\w-]*\n([\s\S]*?)\n`{3,}$/.exec(text);
  if (wrapped && /(^|\n)@@/.test(wrapped[1])) text = wrapped[1];
  const ops = [];
  let current = null, complete = false, stray = [];
  for (const line of text.split('\n')) {
    if (END.test(line)) { complete = true; break; }
    const head = HEADER.exec(line);
    if (head && !(current && insideFence(current.lines))) {
      current = { op: head[1].toLowerCase(), n: Number(head[2]), arg: (head[3] || '').trim(), lines: [] };
      ops.push(current);
    } else if (current) current.lines.push(line);
    else if (line.trim()) stray.push(line);
  }
  return { ops: ops.map(({ lines, ...op }) => ({ ...op, content: lines.join('\n').trim() })), complete, stray: stray.join('\n') };
}
function insideFence(lines) {
  let open = '';
  for (const line of lines) { const t = FENCE.exec(line)?.[1]; if (t && (!open || t.startsWith(open[0]))) open = open ? '' : t; }
  return !!open;
}

/** Why this content may not go into the notes, or null. Visual blocks are fully validated against the registry. */
export function contentProblem(content, { heading = false } = {}) {
  const text = String(content || '');
  if (!text.trim()) return 'it is empty';
  if (text.length > 7000) return 'it is longer than 7000 characters';
  let open = null, visuals = 0;
  const prose = [];
  for (const line of text.split('\n')) {
    const m = FENCE.exec(line);
    if (open) {
      if (m && m[1][0] === open.mark[0] && m[1].length >= open.mark.length && !m[2]) {
        if (open.kind === 'visual') {
          visuals++;
          if (!readVisual(open.lines.join('\n'))) return `visual block ${visuals} is not a valid visual (unknown type or a value out of range)`;
        }
        open = null;
      } else open.lines.push(line);
      continue;
    }
    if (m) { open = { mark: m[1], kind: m[2].toLowerCase(), lines: [] }; continue; }
    prose.push(line);
  }
  if (open) return 'a code or visual block is not closed';
  if (visuals > 6) return 'more than 6 visual blocks';
  const flat = prose.join('\n').replace(/`[^`\n]*`/g, ' ').replace(/\$\$[\s\S]*?\$\$|\$[^$\n]+\$/g, ' ');
  if (!heading && /^#{1,6}[ \t]/m.test(flat)) return 'it contains a heading';
  if (/<\s*\/?[a-zA-Z][^>\n]*>|<!--/.test(flat)) return 'it contains HTML';
  if (/!\[[^\]\n]*\]\(/.test(flat)) return 'it contains an image';
  if (/\[\[(?:FRAME|VISUAL)\b|MISSING_DETAILS\s*:/i.test(flat)) return 'it contains an app marker';
  if (/\]\(\s*(?!https?:\/\/)[a-z][a-z0-9+.-]*:/i.test(flat)) return 'it contains a non-web link';
  return null;
}

/** Supplementary prose is labelled as such; visuals stand alone. */
export function wrapExtra(content) {
  const out = [];
  let prose = [], fence = '';
  const flush = () => {
    const body = prose.join('\n').trim();
    prose = [];
    if (!body) return;
    out.push(/^>/.test(body) ? body : '> **Extra Context:** ' + body.split('\n').map((l, i) => (i ? (l.trim() ? '> ' + l : '>') : l)).join('\n'));
  };
  const lines = String(content).split('\n');
  for (let i = 0; i < lines.length; i++) {
    const m = FENCE.exec(lines[i]);
    if (!fence && m && m[2].toLowerCase() === 'visual') {
      flush();
      const block = [lines[i]];
      fence = m[1];
      while (++i < lines.length) { block.push(lines[i]); if (FENCE.exec(lines[i])?.[1]?.startsWith(fence[0]) && !FENCE.exec(lines[i])[2]) break; }
      fence = '';
      out.push(block.join('\n'));
    } else prose.push(lines[i]);
  }
  flush();
  return out.join('\n\n');
}

/** Check one parsed op against the notes. @returns {{ ok:boolean, error?:string, op?:object }} */
export function checkOp(op, sections) {
  const section = sections[op.n - 1];
  if (!section) return { ok: false, error: `S${op.n} does not exist (the notes have ${sections.length} sections)` };
  if (op.op === 'section') {
    const title = op.arg.replace(/^#+\s*/, '').trim();
    if (!title || title.length > 120 || /[<>\n]/.test(title)) return { ok: false, error: 'the new section needs a plain title' };
    const problem = contentProblem(op.content);
    return problem ? { ok: false, error: `new section "${title}": ${problem}` } : { ok: true, op: { ...op, arg: title, heading: section.heading } };
  }
  const problem = contentProblem(op.content);
  if (problem) return { ok: false, error: `${op.op} ${section.id}: ${problem}` };
  if (op.op === 'replace' && !op.arg) return { ok: false, error: `replace ${section.id} needs the first words of what it replaces` };
  if (['after', 'replace'].includes(op.op) && op.arg && norm(op.arg).length < 3) return { ok: false, error: `${op.op} ${section.id}: the anchor is too short` };
  return { ok: true, op: { ...op, heading: section.heading } };
}

// ---- block geometry --------------------------------------------------------------------------------------------------
/** Blocks of a line range: paragraphs / lists / tables / blockquotes (until a blank line) and whole fenced blocks. */
function blocksIn(lines, from, to) {
  const blocks = [];
  let i = from;
  while (i < to) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i, f = FENCE.exec(lines[i]);
    if (f) {
      i++;
      while (i < to && !(FENCE.exec(lines[i])?.[1]?.startsWith(f[1][0]) && !FENCE.exec(lines[i])[2])) i++;
      i = Math.min(to, i + 1);
    } else if (/^\s*\$\$/.test(lines[i]) && !/\$\$\s*$/.test(lines[i].trim().slice(2))) {
      i++;
      while (i < to && !/\$\$\s*$/.test(lines[i])) i++;
      i = Math.min(to, i + 1);
    } else while (i < to && lines[i].trim()) { if (i > start && FENCE.test(lines[i])) break; i++; }
    blocks.push({ start, end: i, text: lines.slice(start, i).join('\n') });
  }
  return blocks;
}
const findBlock = (blocks, anchor) => {
  const a = norm(anchor);
  return blocks.find(b => norm(b.text).startsWith(a)) || blocks.find(b => norm(b.text).includes(a));
};

function locate(lines, heading) {
  const { sections } = parseSections(lines.join('\n'));
  const exact = sections.filter(s => s.heading === heading);
  const hit = exact.length === 1 ? exact : sections.filter(s => sectionTitle(s.heading) === sectionTitle(heading));
  if (hit.length !== 1) throw new Error(`The section "${sectionTitle(heading)}" ${hit.length ? 'appears more than once' : 'could not be found'}.`);
  return hit[0];
}

/** Apply approved ops to one document. Each op carries `heading` (from checkOp). Throws with a plain message when a target is gone. */
export function applyOps(markdown, ops) {
  let lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const notes = [];
  for (const op of ops) {
    const section = locate(lines, op.heading);
    let at, remove = 0, block = op.op === 'section' ? `### ${op.arg}\n\n${wrapExtra(op.content)}` : ['append', 'after'].includes(op.op) ? wrapExtra(op.content) : op.content;
    if (op.op === 'append' || op.op === 'section') {
      at = section.end;
      while (at > section.start + 1 && !lines[at - 1].trim()) at--;
    } else {
      const hit = findBlock(blocksIn(lines, section.start + 1, section.end), op.arg);
      if (!hit) {
        if (op.op === 'replace') throw new Error(`Could not find "${op.arg}" in ${sectionTitle(op.heading)}.`);
        notes.push(`The anchor "${op.arg}" was not found in ${sectionTitle(op.heading)}; the addition went to the end of the section.`);
        at = section.end; while (at > section.start + 1 && !lines[at - 1].trim()) at--;
      } else if (op.op === 'after') at = hit.end;
      else { if (hit.text.length > 3000) throw new Error('That passage is too long to replace safely.'); at = hit.start; remove = hit.end - hit.start; }
    }
    const lead = op.op === 'replace' ? [] : [''];
    const trail = lines[at + remove] !== undefined && lines[at + remove].trim() ? [''] : [];
    lines = [...lines.slice(0, at), ...lead, ...block.split('\n'), ...trail, ...lines.slice(at + remove)];
    // keep one blank line before the next heading
    const next = lines.findIndex((l, i) => i > at && /^#{1,3}[ \t]/.test(l) && !FENCE.test(lines[i - 1] || ''));
    if (next > 0 && lines[next - 1].trim()) lines.splice(next, 0, '');
  }
  return { markdown: lines.join('\n').replace(/\n{3,}/g, '\n\n'), notes };
}

/** A short label for a proposed op, for the review list. */
export const describeOp = (op, sections) => {
  const s = sections[op.n - 1];
  const where = s ? `${s.id} · ${s.title}` : `S${op.n}`;
  return op.op === 'append' ? `Add to the end of ${where}` : op.op === 'after' ? `Add in ${where}, after “${op.arg.slice(0, 40)}${op.arg.length > 40 ? '…' : ''}”`
    : op.op === 'replace' ? `Replace in ${where}: “${op.arg.slice(0, 40)}${op.arg.length > 40 ? '…' : ''}”` : `New section “${op.arg}” after ${where}`;
};

// ---------------------------------------------------------------------------------------------------------------------
// Figures: move one block up or down, in either form of the notes.
//   saved Markdown (summary_markdown): ![Figure 3: …](images/x.png) + *FIG 3 · mm:ss — …* (+ a "Watch at" line)
//   raw notes (summary_raw): [[FRAME:12]] on its own line
// A heading is a block too: stepping over it moves the figure into the neighbouring topic.
// ---------------------------------------------------------------------------------------------------------------------
function docBlocks(lines) {
  const blocks = [];
  let i = 0;
  while (i < lines.length) {
    if (!lines[i].trim()) { i++; continue; }
    const start = i;
    const f = FENCE.exec(lines[i]);
    if (f) { i++; while (i < lines.length && !(FENCE.exec(lines[i])?.[1]?.startsWith(f[1][0]) && !FENCE.exec(lines[i])[2])) i++; i = Math.min(lines.length, i + 1); }
    else if (/^#{1,6}[ \t]/.test(lines[i])) i++;
    else { while (i < lines.length && lines[i].trim() && !/^#{1,6}[ \t]/.test(lines[i]) && !(i > start && FENCE.test(lines[i]))) i++; }
    blocks.push({ start, end: i, text: lines.slice(start, i).join('\n') });
  }
  // a figure's caption lines and its "Watch at" link belong to it
  const merged = [];
  for (const b of blocks) {
    const prev = merged.at(-1);
    if (prev && /^\[Watch at [^\]]*\]\([^)]*\)\s*$/.test(b.text) && /^!\[Figure/.test(prev.text)) { prev.end = b.end; prev.text += '\n\n' + b.text; } else merged.push({ ...b });
  }
  return merged;
}
const figureKey = (block) => /^\[\[FRAME:(\d+)\]\]\s*$/.exec(block.text)?.[1] ? 'F' + /\[\[FRAME:(\d+)\]\]/.exec(block.text)[1]
  : /^!\[[^\]]*\]\((images\/[^)\s]+)\)/.exec(block.text)?.[1] || null;

/** Figures of a document in order: [{ key, line }]. Key = 'F<index>' (raw) or 'images/<file>' (saved). */
export function listFigures(markdown) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  return docBlocks(lines).map(b => ({ key: figureKey(b), line: b.start })).filter(f => f.key);
}

/** Move the figure `key` one block up (-1) or down (+1). Returns the new Markdown, or null when it cannot move. */
export function moveFigure(markdown, key, direction) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const blocks = docBlocks(lines);
  const i = blocks.findIndex(b => figureKey(b) === key);
  const j = i + direction;
  if (i < 0 || j < 0 || j >= blocks.length) return null;
  const a = blocks[i], b = blocks[j];
  if (/^##[ \t]/.test(b.text) || (/^#{1,2}[ \t]/.test(b.text))) return null; // never out of the topics region
  const [first, second] = direction < 0 ? [b, a] : [a, b];
  const moved = [...lines.slice(0, first.start), ...lines.slice(second.start, second.end), '', ...lines.slice(first.start, first.end), ...lines.slice(second.end)];
  return moved.join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Remove a figure from a document. */
export function removeFigure(markdown, key) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const b = docBlocks(lines).find(x => figureKey(x) === key);
  if (!b) return null;
  return [...lines.slice(0, b.start), ...lines.slice(b.end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** Renumber "Figure N" / "FIG N" in saved Markdown after figures moved, so the numbers follow reading order. */
export function renumberFigures(markdown) {
  let n = 0;
  const lines = String(markdown || '').split('\n');
  return lines.map((line, i) => {
    if (/^!\[Figure \d+:/.test(line)) { n++; return line.replace(/^!\[Figure \d+:/, `![Figure ${n}:`); }
    if (n && /^\*FIG \d+ ·/.test(line) && /^!\[Figure/.test(lines[i - 1] || '')) return line.replace(/^\*FIG \d+ ·/, `*FIG ${n} ·`);
    return line;
  }).join('\n');
}

/** Editor text for one section: the body of the raw notes (figures are [[FRAME:n]] lines the author can move or delete). */
export function sectionText(markdown, heading) {
  const { lines } = parseSections(markdown);
  const s = locate(lines, heading);
  return lines.slice(s.start + 1, s.end).join('\n').trim();
}

/** Replace one section's body. `figures` of the new text must be a subset of the old ones (an author cannot invent a frame). */
export function setSectionText(markdown, heading, body, { allowedFrames = null } = {}) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const s = locate(lines, heading);
  const text = String(body || '').replace(/\r\n?/g, '\n').trim();
  if (/^#{1,3}[ \t]/m.test(text.replace(/`{3}[\s\S]*?`{3}/g, ''))) throw new Error('A section cannot contain headings of its own: use “Add section” for that.');
  if (allowedFrames) for (const m of text.matchAll(/\[\[FRAME:(\d+)\]\]/g)) if (!allowedFrames.has(Number(m[1]))) throw new Error(`[[FRAME:${m[1]}]] is not a figure of this lecture.`);
  const fix = text.replace(/<\s*script\b[\s\S]*?<\s*\/\s*script\s*>/gi, '');
  return [...lines.slice(0, s.start + 1), '', ...fix.split('\n'), '', ...lines.slice(s.end)].join('\n').replace(/\n{3,}/g, '\n\n');
}

/** The first invalid ```visual block in an author's own text, as a message, or null. (Their prose, callouts and figures are theirs.) */
export function visualProblem(text) {
  let open = null, n = 0;
  for (const line of String(text || '').split('\n')) {
    const m = FENCE.exec(line);
    if (open) {
      if (m && m[1][0] === open.mark[0] && m[1].length >= open.mark.length && !m[2]) {
        if (open.kind === 'visual' && !readVisual(open.lines.join('\n'))) return `Visual block ${n} is not valid: it has an unknown type or a value out of range.`;
        open = null;
      } else open.lines.push(line);
    } else if (m) { open = { mark: m[1], kind: m[2].toLowerCase(), lines: [] }; if (open.kind === 'visual') n++; }
  }
  return open ? 'A code or visual block is not closed (a line with three backticks is missing).' : null;
}

/** The saved-Markdown block (picture, caption, watch link) of the figure `key` ('images/<file>'), or null. */
export function figureBlock(markdown, key) {
  const lines = String(markdown || '').replace(/\r\n?/g, '\n').split('\n');
  const hit = docBlocks(lines).find(b => figureKey(b) === key);
  return hit ? hit.text : null;
}
