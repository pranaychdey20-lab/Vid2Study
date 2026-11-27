/**
 * Local-first pipeline (ES module). Everything that can be done with plain algorithms is done in the
 * browser, and AI only writes the notes:
 *
 *   1 TRANSCRIPT  captions if the page has them, else Whisper in the browser (lib/asr.js)
 *   2 SCAN        sample the video, save one frame per slide change (lib/scenes.js, lib/scan.js)
 *   3 OCR         Tesseract reads each frame (lib/ocr.js)
 *   4 VISION      only frames with little text go to the vision model (diagrams, charts, boards)
 *   5 ALIGN       frames are matched to the transcript by timestamp, chunked at ~12 minutes (align.js, chunk.js)
 *   6 WRITE       short video: the strong model writes everything from the aligned text.
 *                 long video: the cheap model turns each chunk into bullets (map),
 *                 then the strong model merges, reviews and writes the notes (reduce).
 *
 * Progress is saved in a draft after every step, so a failed run resumes where it stopped.
 */
import { putResult, deleteResult, getDraft, putDraft, deleteDraft, getFrame, deleteFrames, deleteFrame } from './db.js';
import { fmtTime } from './common.js';
import { log } from './log.js';
import { slotRef, sttRef } from './settings.js';
import { generate, searchTool, parseJsonLoose } from './llm.js';
import { chunkPrompt, writePrompt, writeTokens, groupMinutes, visionPrompt, selectPrompt, FRAME_KINDS, finalPrompt, fixMathPrompt, outputsPrompt, questionsPrompt, transcriptPrompt, writerContinuationPrompt, trimPrompt, fixMathBatchPrompt, readMathBatch, screenPrompt, describePrompt, DETAIL } from './prompts.js';
import { lintSection } from './lint.js';
import { blobGrabber } from './frames.js';
import { pool, unfence, splitFinal, figureMd } from './pipeline.js';
import { parseTimestamped, transcriptDuration, formatSegments } from './transcript.js';
import { transcribeAudio, looksHallucinated } from './asr.js';
import { transcribeCloud } from './stt.js';
import { openAudioSource } from './audiofile.js';
import { scanScenes } from './scan.js';
import { ocrImage, closeOcr, OCR_WORKERS } from './ocr.js';
import { chunkSegments } from './chunk.js';
import { assignFrames, interleave, chunkIndexFor, writerEvidence } from './align.js';
import { completeWriterPrefix, emptyTopics, missingScreenTopics, readCoverageChecklist, takeWriterCoverage, topicBody, unmatchedCoverage } from './coverage.js';
import { trimSegments, estimateTokens } from './trim.js';
import { detectCode } from './codedetect.js';
import { analyzeFrame } from './framekind.js';
import { inkContainment, inkCount } from './scenes.js';
import { lectureTopicContext, practiceContext, practiceReferenceContext } from './websearch.js';

const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const clip = (s, n) => (s.length > n ? `${s.slice(0, n)}…` : s);
const took = (t0) => { const s = Math.round((Date.now() - t0) / 1000); return s >= 60 ? `${Math.floor(s / 60)} min ${s % 60} s` : `${s} s`; };
/** At most `n` calls of `fn` running at once (the rest wait their turn). */
const limiter = (n) => {
  let busy = 0;
  const queue = [];
  const next = () => { if (busy < n && queue.length) { busy++; queue.shift()(); } };
  return (fn) => new Promise((resolve, reject) => {
    queue.push(() => Promise.resolve().then(fn).then(resolve, reject).finally(() => { busy--; next(); }));
    next();
  });
};
/**
 * The stages that call an AI model. When one fails the job PAUSES (it is saved and can be resumed) instead of
 * quietly carrying on without it, so the user can pick another model or choose to skip it.
 *   slot  which model slot the stage uses (the user can change that slot)
 *   skip  what "skip this stage" switches off ('vision' covers both vision stages); absent = cannot be skipped
 */
export const STAGE = {
  stt: { label: 'Speech-to-text', slot: 'stt' },
  select: { label: 'Checking the video frames for figures', slot: 'vision', skip: 'vision', skipNote: 'Figures are picked without the vision model and get no description.' },
  describe: { label: 'Describing code, table and diagram frames', slot: 'vision', skip: 'vision', skipNote: 'Code, tables and diagrams are listed without a description from the picture.' },
  digest: { label: 'Reading the transcript (summary, timeline, video type)', slot: 'digest', skip: 'digest', skipNote: 'The video type is guessed from its words, and the vision calls read the full trimmed transcript.' },
  trim: { label: 'Tightening a very long transcript', slot: 'cheap', skip: 'trim', skipNote: 'The writer reads the transcript with only the code clean-up (fillers, stutters) applied.' },
  map: { label: 'Summarising the parts of a long video', slot: 'cheap' },
  write: { label: 'Writing the notes', slot: 'strong' },
  math: { label: 'Fixing the maths', slot: 'cheap', skip: 'math', skipNote: 'Formulas keep any small errors the writer made.' },
  overview: { label: 'Writing the overview', slot: 'cheap', skip: 'overview', skipNote: 'The overview just lists the topics.' },
  outputs: { label: 'Adding the output of the code examples', slot: 'cheap', skip: 'outputs', skipNote: 'Code examples are left without their output.' },
  questions: { label: 'Writing the practice questions', slot: 'practice', skip: 'questions', skipNote: 'The notes have no practice questions section.' }
};
const SLOT_LABEL = { practice: 'Practice Paper AI', stt: 'Speech-to-text AI', vision: 'Vision AI', cheap: 'Cheap AI', strong: 'Strong AI', digest: 'Transcript AI' };

/**
 * An AI model failed in one stage. `info` is plain data (it travels through messages) for the "model failed"
 * window: which stage and slot, the model, the HTTP status, the reason, and what skipping would do.
 */
export class StageError extends Error {
  constructor(stageId, ref, cause, { fallback = false } = {}) {
    const st = STAGE[stageId];
    super(`${st.label}: ${cause?.message || cause}`);
    this.name = 'StageError';
    this.info = {
      stage: stageId, label: st.label, slot: st.slot, slotLabel: SLOT_LABEL[st.slot],
      provider: ref?.provider?.id || '', providerName: ref?.provider?.name || '', model: ref?.model || '',
      status: Number.isFinite(cause?.status) ? cause.status : null,
      code: cause?.code,
      reason: String(cause?.message || cause).slice(0, 400),
      skip: st.skip || null, skipNote: st.skipNote || '',
      fallback // the slot was empty, so the Strong AI was used for it
    };
  }
}

/** A failed request to an AI service (HTTP error or no connection): the model is not working, as opposed to an unreadable reply. */
const isHttpError = (e) => Number.isFinite(e?.status);

const SELECT_BATCH = 10; // frames per vision call (in time order, so near-duplicates meet). Cheap vision models
// (Gemini Flash / Flash-Lite, Haiku) read 10 images at 1024 px well; more starts to blur their attention.
const MAX_SELECT = 150; // frames judged per video at most (25 calls)

/** Kind names a vision model uses for pictures of people, gods, places and art -> our kind "illustration". */
const QUOTE_SYNONYMS = /^(quotation|epigraph|citation|saying|motto|statement|caption|text)$/;
const KIND_SYNONYMS = /^(artwork|art|painting|drawing|sketch|cartoon|statue|sculpture|idol|deity|god|goddess|person|portrait|people|character|figure|temple|building|architecture|landscape|scene|picture|image|poster|infographic|animation|comic|manuscript|icon)$/;

/** Parse a model's JSON reply (fenced, or with text around it). Pure. @returns {any} */
export function parseReply(text) {
  const t = String(text || '').replace(/^```(?:json)?\s*|\s*```$/g, '');
  try { return JSON.parse(t); } catch { /* fall through */ }
  const m = /\{[\s\S]*\}/.exec(t) || /\[[\s\S]*\]/.exec(t);
  try { return m ? JSON.parse(m[0]) : null; } catch { return null; }
}

/**
 * The vision model's JSON reply -> verdicts by frame index. Unknown ids and missing fields are tolerated.
 * What drops a frame: the model said keep=false, or its kind is a plain reject (title, logo, transition,
 * talking head, blank), or it is a duplicate (`same_as`) of a frame that really is kept in the same batch.
 * An unfamiliar kind ("artwork", "statue", "deity") is a picture, never a reason to drop. `force` (the
 * describe call: every frame was already chosen) only lets keep=false from the model drop a frame. Pure.
 * @param {string} text  @param {{index:number}[]} batch  @param {{force?:boolean}} [o]
 * @returns {Record<number,{keep:boolean,kind:string,info:number,caption:string,text:string,detail:string,reason:string}>}
 */
export function readVerdicts(text, batch, { force = false } = {}) {
  const j = parseReply(text);
  const list = Array.isArray(j) ? j : Array.isArray(j?.frames) ? j.frames : [];
  const ids = new Set(batch.map((f) => f.index));
  const known = [...FRAME_KINDS.good, ...FRAME_KINDS.bad];
  const rejectKinds = FRAME_KINDS.bad.filter((k) => k !== 'other');
  const out = {};
  const claim = {}; // n -> the frame it says it duplicates
  list.forEach((v, i) => {
    if (!v || typeof v !== 'object') return;
    const labeled = /^F?(\d+)$/i.exec(String(v?.id ?? '').trim());
    const n = Number(labeled?.[1] ?? (!force && v?.id == null ? batch[i]?.index : NaN));
    if (!ids.has(n)) return;
    const k = String(v.kind || '').toLowerCase().trim();
    const kind = known.includes(k) ? k : QUOTE_SYNONYMS.test(k) ? 'quote' : KIND_SYNONYMS.test(k) ? 'illustration' : 'other';
    const info = Math.max(0, Math.min(10, Number(v.info) || 0));
    const same = /(\d+)/.exec(String(v.same_as || ''))?.[1];
    if (same && Number(same) !== n && !force) claim[n] = Number(same);
    const no = v.keep === false || v.keep === 'false';
    const keep = !no && !rejectKinds.includes(kind) && (force || info >= 3 || kind !== 'other');
    out[n] = {
      keep, kind, info,
      caption: String(v.caption || v.label || '').replace(/\s+/g, ' ').replace(/^(this (image|frame|picture) shows\s*)/i, '').trim(),
      text: String(v.text || '').trim(),
      presentation: ['visual', 'reproducible'].includes(v.presentation) ? v.presentation : '',
      topic: typeof v.topic === 'string' ? v.topic.trim().replace(/\s+/g, ' ').slice(0, 130) : '',
      detail: String(v.detail || '').trim(), // exact code / table / LaTeX, or a full description of a drawing
      reason: keep ? '' : String(v.reason || kind).slice(0, 80)
    };
  });
  // a duplicate claim counts only when the frame it points at is in this batch and is itself kept
  for (const [n, target] of Object.entries(claim)) {
    const t = out[target];
    if (out[n].keep && t && t.keep && !claim[target]) { out[n].keep = false; out[n].reason = `same as F${target}`; }
  }
  return out;
}

/**
 * The screening call's reply: { "keep": [{ "id": "F3", "kind": "diagram", "info": 8, "label": "..." }],
 * "drop": "F4:dup F5:blur ..." } -> { keep: {index: {kind, info, label}}, drop: {index: why} }. Frames the reply
 * does not mention are dropped by the caller. Unknown ids are ignored. Pure.
 * @param {string} text  @param {Set<number>|number[]} ids
 */
export function readScreen(text, ids) {
  const have = new Set(ids);
  const j = parseReply(text);
  const list = Array.isArray(j) ? j : Array.isArray(j?.keep) ? j.keep : [];
  const known = [...FRAME_KINDS.good, ...FRAME_KINDS.bad];
  const keep = {}, drop = {}, into = {};
  for (const v of list) {
    const n = Number(/(\d+)/.exec(String(typeof v === 'object' ? v?.id : v) ?? '')?.[1]);
    if (!have.has(n)) continue;
    const k = String(v.kind || '').toLowerCase().trim();
    keep[n] = {
      kind: known.includes(k) ? k : QUOTE_SYNONYMS.test(k) ? 'quote' : KIND_SYNONYMS.test(k) ? 'illustration' : 'other',
      info: Math.max(0, Math.min(10, Number(v.info) || 5)),
      label: String(v.label || v.caption || '').replace(/\s+/g, ' ').trim().slice(0, 120)
    };
  }
  const why = typeof j?.drop === 'string' ? j.drop : Array.isArray(j?.drop) ? j.drop.join(' ') : '';
  // "F20:dup>F19 F29:unfinished>F31 F5:blur": id, reason and (for a repeat / an unfinished state) the KEPT frame that replaces it
  for (const m of why.matchAll(/F?(\d+)\s*[:=]\s*([A-Za-z_]+)(?:\s*(?:>|->|=>|of|\(|same as)\s*F?(\d+)\)?)?/gi)) {
    const n = Number(m[1]);
    if (!have.has(n) || keep[n]) continue;
    drop[n] = m[2].trim().toLowerCase();
    if (m[3]) into[n] = Number(m[3]);
  }
  return { keep, drop, into };
}

/**
 * Review the screening AI's drops with what the code knows (a model looking at hundreds of small pictures makes
 * confident mistakes; in the Berlin Wall test it dropped 17 of 46 frames as "unfinished", one of them on screen for 24 s,
 * and kept the EARLY state of two scenes while dropping the settled later one):
 *  - a drop for a soft reason (dup / same / unfinished / superseded) is accepted ONLY when it names a kept replacement
 *    ("F20:dup>F19") that is close in time (30 s for unfinished, 60 s for dup) and not an obviously different picture;
 *    otherwise the frame is RESCUED (kept), because nothing replaces it
 *  - "unfinished" for a frame that stays on screen 10 s or more is rescued: a state in the middle of an animation is gone in
 *    a few seconds. A state is also never "replaced" by an EARLIER frame
 *  - a repeat whose dropped copy comes LATER and stays on screen clearly longer than the kept copy (which is gone in 8 s or
 *    less) is the settled state: they swap, so the longer-lasting one is kept
 * Hard reasons (blur, transition, title, logo, talking head, blank, outro, credits, over the keep limit) are left alone.
 * Pure.
 * @param {{keep:object, drop:Record<number,string>, into?:Record<number,number>}} res
 * @param {Record<number,{t:number, dwell?:number, h?:string}>} info
 * @returns {{keep:object, drop:Record<number,string>, rescued:number[], swapped:[number,number][]}}
 */
export function fixScreen(res, info) {
  const keep = { ...res.keep }, drop = { ...res.drop }, into = { ...(res.into || {}) };
  const SOFT = /^(dup|duplicate|same|repeat|repeated|unfinished|partial|superseded|animation|build|built)/i;
  const UNFINISHED = /^(unfinished|partial|superseded|animation|build|built)/i;
  const moved = {}; // a kept frame that was swapped out -> the frame that took its place
  const rescued = [], swapped = [];
  const order = Object.keys(drop).map(Number).sort((a, b) => (info[a]?.t ?? 0) - (info[b]?.t ?? 0));
  for (const n of order) {
    const why = drop[n];
    if (!SOFT.test(why)) continue;
    const a = info[n];
    const to = moved[into[n]] ?? into[n];
    const b = info[to];
    const unfinished = UNFINISHED.test(why);
    const closeEnough = a && b && Math.abs(a.t - b.t) <= (unfinished ? 30 : 60);
    const sameScene = !a?.h || !b?.h || hamming(a.h, b.h) <= 30;
    const direction = !unfinished || (b && a && b.t > a.t); // a state is replaced by a LATER, more complete one
    const longLived = unfinished && (a?.dwell || 0) >= 10;
    if (!to || !keep[to] || !closeEnough || !sameScene || !direction || longLived) {
      keep[n] = { kind: 'other', info: 5, label: '' }; // nothing real replaces it: keep it
      delete drop[n];
      rescued.push(n);
      continue;
    }
    if (!unfinished && a.t > b.t && (a.dwell || 0) >= 1.5 * (b.dwell || 0) && (b.dwell || 0) <= 8) {
      keep[n] = { ...keep[to] }; // the settled, longer-lasting copy takes over
      delete keep[to];
      delete drop[n];
      drop[to] = `replaced by the longer-lasting F${n}`;
      moved[to] = n;
      swapped.push([to, n]);
    }
  }
  return { keep, drop, rescued, swapped };
}

/**
 * Split items (each with `bytes`) into consecutive batches, each at most `maxCount` items and about
 * `maxBytes` bytes (a request with inline pictures has a size limit: ~20 MB for Gemini). An item bigger than
 * the budget still gets a batch of its own. Pure.
 */
export function packByBudget(items, { maxCount = 2000, maxBytes = 14e6 } = {}) {
  const out = [];
  let cur = [], size = 0;
  for (const it of items) {
    const b = Number(it.bytes) || 0;
    if (cur.length && (cur.length >= maxCount || size + b > maxBytes)) { out.push(cur); cur = []; size = 0; }
    cur.push(it);
    size += b;
  }
  if (cur.length) out.push(cur);
  return out;
}

/** Shorten to at most n characters at a sentence end (else a word end), never mid-word. Pure. */
export function clipSentence(s, n) {
  s = String(s || '').trim();
  if (s.length <= n) return s;
  const cut = s.slice(0, n);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  if (end >= n * 0.4) return cut.slice(0, end + 1);
  return `${cut.slice(0, Math.max(cut.lastIndexOf(' '), n * 0.6)).replace(/[\s,;:(-]+$/, '')}…`;
}

/** Words in common / words in either, for deciding that two OCR texts are the same slide. */
function similarity(a, b) {
  const wa = new Set(a.toLowerCase().split(/\W+/).filter(Boolean));
  const wb = new Set(b.toLowerCase().split(/\W+/).filter(Boolean));
  if (!wa.size || !wb.size) return 0;
  let both = 0;
  for (const w of wa) if (wb.has(w)) both++;
  return both / (wa.size + wb.size - both);
}

const hamming = (a, b) => { let n = 0; for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) n++; return n; };

/**
 * Merge consecutive repeats of one screen (an animated slide build, a diagram drawn step by step):
 * keep the fullest. Two frames are the same screen when their OCR words overlap > 65% (a build adds words
 * to the previous version, it does not replace them), or when both
 * are text-poor diagrams with a near-identical picture hash. Different code/tables are never merged
 * on the hash alone (dark editor backgrounds hash alike).
 * @param {{t:number,words:number,text:string,kinds:string[],h?:string,graphicsFrac?:number}[]} frames ordered by time
 */
export function mergeRepeats(frames, minWords = 12, { boards = true } = {}) {
  const out = [];
  const ink = (f) => f.text.length + (f.scores?.diagram || 0) * 400 + (f.eb ? inkCount(f.eb) * 4 : 0);
  // text agrees, or there is too little text to tell two screens apart (then the picture decides)
  const textAgrees = (a, b) => a.words < minWords || b.words < minWords || Math.max(contained(a.text, b.text), contained(b.text, a.text)) >= 0.5;
  // Similar slide titles and bullets do not prove the plots or pictures are the same.
  const samePicture = (a, b) => {
    const ah = a.mh || a.h, bh = b.mh || b.h;
    if (!ah || !bh) return !ah && !bh && !a.filename && !b.filename;
    const sameInk = !a.eb && !b.eb || a.eb && b.eb && inkContainment(a.eb, b.eb) >= 0.98 && inkContainment(b.eb, a.eb) >= 0.98;
    return ah.length === bh.length && hamming(ah, bh) <= 3 && sameInk;
  };
  for (const f of frames) {
    const prev = out[out.length - 1];
    if (prev) {
      const sameText = prev.words >= 5 && f.words >= 5 && similarity(prev.text, f.text) > 0.65;
      const sameDrawing = boards && prev.words < minWords && f.words < minWords && prev.h && f.h && f.t - prev.t < 120 &&
        prev.kinds.includes('diagram') && f.kinds.includes('diagram') && hamming(prev.h, f.h) <= 6;
      if ((sameText || sameDrawing) && samePicture(prev, f)) { if (ink(f) >= ink(prev) * 0.8) out[out.length - 1] = f; continue; }
      // BUILD-UP (math solved step by step, bullets appearing one by one): almost everything on the earlier
      // screen is still on the later one, which only adds. Keep the finished one.
      const grows = prev.words >= 3 && f.words >= prev.words && contained(prev.text, f.text) >= 0.85;
      const alike = !prev.mh || !f.mh || hamming(prev.mh, f.mh) <= 14;
      const boardGrows = boards && alike && prev.eb && f.eb && f.t - prev.t < 600 && textAgrees(prev, f) && inkCount(prev.eb) >= 4 &&
        inkContainment(prev.eb, f.eb) >= 0.88 && inkCount(f.eb) >= inkCount(prev.eb);
      if ((grows || boardGrows) && samePicture(prev, f)) { out[out.length - 1] = f; continue; }
      // the later screen is a part of the earlier one (half erased, zoomed in): nothing new
      const shrinks = f.words >= 3 && f.words <= prev.words && contained(f.text, prev.text) >= 0.85;
      const boardShrinks = boards && alike && prev.eb && f.eb && f.t - prev.t < 600 && textAgrees(prev, f) && inkCount(f.eb) >= 4 &&
        inkContainment(f.eb, prev.eb) >= 0.9 && inkCount(f.eb) <= inkCount(prev.eb);
      if ((shrinks || boardShrinks) && samePicture(prev, f)) continue;
    }
    // REPEAT of an earlier screen (the teacher flips back to a slide): already kept, drop it. Text slides by
    // their words; text-poor ones by the masked picture hash AND where the ink is (both must agree).
    const seen = out.some((g) => (g.words >= minWords && f.words >= minWords && samePicture(f, g) && similarity(f.text, g.text) >= 0.9) ||
      (boards && f.words < minWords && g.words < minWords && f.mh && g.mh && f.eb && g.eb && !f.kinds.includes('code') &&
        samePicture(f, g)));
    if (seen) continue;
    out.push(f);
  }
  return out;
}

/**
 * What the question writer gets: each topic's heading, big idea, key points, formulas and code (no figures,
 * no callouts), clipped so a 3-hour lecture still fits one call. Pure.
 */
export function practiceOutline(notes, max = 16000) {
  const secs = String(notes || '').split(/^(?=###\s)/m).filter((s) => s.startsWith('###'));
  if (!secs.length) return '';
  const per = Math.max(500, Math.floor(max / secs.length));
  return secs.map((s) => clip(s
    .replace(/\[\[FRAME:\d+\]\]/g, '')
    .replace(/^>.*$/gm, '')
    .replace(/\n{2,}/g, '\n')
    .trim(), per)).join('\n\n');
}

/**
 * The writer's last line "<!--NEEDS practice=yes math=no-->": does this video deserve practice questions, and
 * do the notes hold maths worth the math-fix call? Returns the notes without that line, and the answer
 * (null when the line is missing, e.g. a reply cut off: the caller then falls back to its settings). Pure.
 */
export function takeNeeds(md) {
  const re = /<!--\s*NEEDS\s+([^>]*?)\s*-->\s*$/i;
  const m = re.exec(String(md || '').trimEnd());
  if (!m) return { md: String(md || ''), needs: null };
  const val = (k) => { const v = new RegExp(`${k}\\s*=\\s*(yes|no|true|false)`, 'i').exec(m[1])?.[1]; return v == null ? null : /^(yes|true)$/i.test(v); };
  const style = (/style\s*=\s*([a-z]+)/i.exec(m[1])?.[1] || '').toLowerCase() || null;
  const subject = (/subject\s*=\s*(.+)$/i.exec(m[1])?.[1] || '').replace(/^["'<]+|["'>]+$/g, '').trim().slice(0, 80) || null;
  return { md: String(md).trimEnd().replace(re, '').trimEnd(), needs: { practice: val('practice'), math: val('math'), style, subject } };
}

/** The video-type model's JSON -> { technical, kind, subject } or null when unreadable. Pure. */
export function readClassify(text) {
  let j = null;
  try { j = JSON.parse(String(text).replace(/^```(?:json)?\s*|\s*```$/g, '')); } catch { const m = /\{[\s\S]*\}/.exec(String(text)); try { j = m ? JSON.parse(m[0]) : null; } catch { j = null; } }
  if (!j || (typeof j.technical !== 'boolean' && !/^(true|false)$/i.test(String(j.technical)))) return null;
  return { technical: j.technical === true || /^true$/i.test(String(j.technical)), kind: String(j.kind || '').slice(0, 30), subject: String(j.subject || '').slice(0, 80) };
}

/** Is this a maths / science / code lecture? (code detected, or enough maths and technical words). Pure. */
export function isTechnical(text, code) {
  if (code?.likely) return true;
  const hits = String(text || '').match(/\b(equation|formula|theorem|lemma|proof|matrix|matrices|vector|algorithm|derivative|integral|differential|probability|calculus|algebra|coordinate|kinematics?|velocity|acceleration|torque|frequency|voltage|current|resistance|function|variable|complexity|recursion|array|pixel|filter|regression|gradient|joint|transform|rotation)\b|\d\s*[=+\-*/^×÷]\s*\d/gi) || [];
  return hits.length >= 6;
}

/**
 * FRAME PRIORITY (no AI): how much a frame matters to the notes, so the best ones reach the strong model as
 * pictures and the important rest get a full description from the vision model. The rule:
 *   1. what it is: map / chart 10; diagram / schematic / table / code / formula 9; patent drawing 8; document 6;
 *      text slide 5; photo 4; scene of a non-lecture video 3 (the vision model's kind; else the pixel classifier:
 *      code / table / formula / diagram 8, other 4)
 *   2. how much it teaches: the vision model's info score 0-10 (5 for a flagged frame it did not see, else 3)
 *   3. how long it stays on screen (the lecturer spends time on what matters): up to +3 at 2 min
 *   4. how much readable text it holds: up to +1
 * priority = 2 x kind + info + time + text (about 0-34). Pure.
 */
export const KIND_WEIGHT = { map: 10, chart: 10, diagram: 9, schematic: 9, table: 9, code: 9, formula: 9, patent: 8, document: 6, slide: 5, quote: 7, illustration: 5, photo: 4, scene: 3 };
/** A video that is not maths / science / code (story, history, religion): its pictures of people, deities, places and events ARE the content. */
// (text on screen is CONTENT in a story video: a quote, a date, a statistic. It must not rank below every picture.)
export const STORY_WEIGHT = { ...KIND_WEIGHT, illustration: 9, photo: 8, scene: 7, document: 8, slide: 8, quote: 10 };
export function framePriority(f, { technical = true } = {}) {
  const W = technical ? KIND_WEIGHT : STORY_WEIGHT;
  const kind = f.tag ? (W[f.tag] ?? 2) : f.scene ? W.scene : f.kinds?.some((k) => ['code', 'table', 'formula', 'diagram'].includes(k)) ? 8 : technical ? 4 : 6;
  const info = Number.isFinite(f.score) && f.tag ? f.score * 10 : f.kinds?.length ? 5 : 3;
  const time = Math.min(3, Math.max(0, Number(f.dwell) || 0) / 40);
  const text = Math.min(1, (Number(f.words) || 0) / 40);
  return Math.round((2 * kind + info + time + text) * 10) / 10;
}
/** A frame this important is always described by the vision model when it is not sent to the writer as a picture. */
export const IMPORTANT_PRIORITY = 20;
/** Frame kinds the notes may never leave out (the rest are shown only when the Strong AI lists them). */
export const ALWAYS_SHOWN = ['code', 'table', 'formula', 'chart', 'diagram', 'schematic', 'map', 'patent'];

/**
 * The frames sent to the writer as pictures: the n highest-priority frames of EACH write part (windows = the
 * parts' start times), so every part gets its own best pictures. Pure.
 * @param {{t:number, filename?:string, priority?:number}[]} frames  @param {number[]} starts  @param {number} n
 */
export function pictureSet(frames, starts, n) {
  if (!(n > 0)) return [];
  const win = (t) => { let k = 0; for (let i = 1; i < starts.length; i++) if (t >= starts[i]) k = i; return k; };
  const by = new Map();
  for (const f of frames) if (f.filename) { const k = starts.length ? win(f.t) : 0; if (!by.has(k)) by.set(k, []); by.get(k).push(f); }
  return [...by.values()].flatMap((list) => pickPictures(list, n)).sort((a, b) => a.t - b.t);
}

/** The write parts: the full transcript in 2-3 parts for a long video, else groups of groupMinutes(detail). Pure. */
export function planGroups(chunks, { minutes, fullText, detail }) {
  if (fullText) return splitGroups(chunks, partsFor(minutes));
  const groupMin = groupMinutes(detail);
  const groups = [];
  let cur = [], curMin = 0;
  for (const c of chunks) {
    const d = (c.end - c.start) / 60;
    if (cur.length && curMin + d > groupMin) { groups.push(cur); cur = []; curMin = 0; }
    cur.push(c);
    curMin += d;
  }
  if (cur.length) groups.push(cur);
  return groups;
}

/**
 * Which frames go to the writer as pictures: the most informative first (flagged code / table / diagram /
 * formula, then the vision model's info score), at most n, back in time order. Pure.
 */
export function pickPictures(frames, n) {
  if (!(n > 0)) return [];
  const rank = (f) => (Number.isFinite(f.priority) ? f.priority : framePriority(f));
  return frames.filter((f) => f.filename).sort((a, b) => rank(b) - rank(a) || a.t - b.t).slice(0, n).sort((a, b) => a.t - b.t);
}

/** How many write calls a long video gets when the strong model reads the full transcript: 2 up to 2 h,
 * 3 up to 3 h, then one per hour (each part stays within one call's output budget). Pure. */
export const partsFor = (minutes) => Math.max(2, Math.ceil(minutes / 60));

/** Split chunks (in order) into n contiguous groups of about equal length; never an empty group. Pure. */
export function splitGroups(chunks, n) {
  n = Math.max(1, Math.min(n, chunks.length));
  const total = chunks.reduce((s, c) => s + (c.end - c.start), 0);
  const groups = [];
  let cur = [], acc = 0;
  chunks.forEach((c, i) => {
    cur.push(c);
    acc += c.end - c.start;
    const left = chunks.length - i - 1, need = n - groups.length - 1;
    if (need > 0 && (acc >= (total * (groups.length + 1)) / n || left === need)) { groups.push(cur); cur = []; }
  });
  if (cur.length) groups.push(cur);
  return groups;
}

/** Keep an evenly spread subset of the lines so the transcript fits `maxTokens` (a lecture longer than a model's context). Pure. */
export function fitTranscript(segs, maxTokens) {
  const total = estimateTokens((segs || []).map((x) => x.text).join(' '));
  if (!(total > maxTokens)) return segs;
  const ratio = maxTokens / total;
  return segs.filter((_, i) => Math.floor(i * ratio) !== Math.floor((i - 1) * ratio) || i === 0);
}

/**
 * Base64 characters of pictures one vision request may carry. Pictures travel inline in the request body, so this stays
 * well under the service's limit (Gemini's inline limit is 100 MB since Jan 2026, so ~85 MB here: base64 grows pictures by a third;
 * other services ~17 MB). `maxRequestMB` overrides it (0 = automatic). Pure.
 */
export function requestBudget(settings, provider) {
  const mb = Number(settings?.maxRequestMB) || 0;
  if (mb > 0) return mb * 1e6;
  return provider?.type === 'gemini' ? 85e6 : 17e6;
}

/** How many describe calls for n frames: 1 up to 100 frames, else 2 (never more: no cap on the frames, a cap on the calls). Pure. */
export const describeCalls = (n) => Math.max(1, Math.min(2, Math.ceil(n / 100)));

/** Words each description may use when a describe call holds `perCall` frames, so the whole reply fits the output limit (~60k tokens). Pure. */
export const describeWords = (perCall) => Math.max(25, Math.min(150, Math.floor((60000 / Math.max(1, perCall) - 150) * 0.55)));

/**
 * The Transcript AI's reply for one part -> { brief, lines, type, refs }. Sections: BRIEF, TIMELINE and (first part only) TYPE, a JSON
 * line read by `readClassify` (null when absent or unreadable). A reply without the headings counts as the shortened lines when
 * it is long enough; one that is too short falls back to the part's own lines. Pure.
 */
export function parseDigest(text, fallbackLines) {
  let checklist = [];
  const raw = String(text || '').replace(/^=== COVERAGE CHECKLIST ===[ \t]*\r?\n([\s\S]*?)(?=^=== [^\n=]+ ===|$(?![\s\S]))/im, (_, section) => {
    checklist = readCoverageChecklist(section);
    return '';
  });
  const research = /^=== RESEARCH GAPS ===[ \t]*\r?\n([\s\S]*)$/im.exec(raw);
  const gaps = research ? parseTimestamped(research[1].split(/\r?\n/).filter(line => /^\[(?:\d+:)?\d+:\d{2}\]\s+\S/.test(line)).slice(0, 4).join('\n')) : [];
  const t = research ? raw.slice(0, research.index) : raw;
  const ty = /===\s*TYPE\s*===([\s\S]*)$/i.exec(t);
  const noType = ty ? t.slice(0, ty.index) : t;
  const rf = /===\s*REFERENCES\s*===([\s\S]*)$/i.exec(noType);
  const body = rf ? noType.slice(0, rf.index) : noType;
  const m = /===\s*BRIEF\s*===([\s\S]*?)===\s*TIMELINE\s*===([\s\S]*)$/i.exec(body);
  const brief = (m ? m[1] : '').trim();
  const lines = (m ? m[2] : body).trim();
  return { brief, lines: lines.length > String(fallbackLines || '').length * 0.04 ? lines : fallbackLines, type: ty ? readClassify(ty[1]) : null, refs: rf ? readRefs(rf[1]) : [], gaps, checklist };
}

/** Split a list into k consecutive parts of (nearly) equal size, k >= 1. Pure. */
export function splitEven(list, k) {
  k = Math.max(1, Math.min(k, list.length || 1));
  const out = [];
  for (let i = 0; i < k; i++) out.push(list.slice(Math.floor((i * list.length) / k), Math.floor(((i + 1) * list.length) / k)));
  return out.filter((g) => g.length);
}

/** Share of a's words (2+ letters) that are also in b: 1 = b says everything a says. Pure. */
export function contained(a, b) {
  const wa = new Set(String(a).toLowerCase().split(/\W+/).filter((w) => w.length > 1));
  if (!wa.size) return 0;
  const wb = new Set(String(b).toLowerCase().split(/\W+/).filter((w) => w.length > 1));
  let n = 0;
  for (const w of wa) if (wb.has(w)) n++;
  return n / wa.size;
}

/**
 * LOCAL FILTER before the vision model: does this frame need eyes at all? OCR cannot read charts, diagrams,
 * handwriting, boards, photos, code layout, tables or equations, so all of those go to the vision model:
 * any code / table / diagram / formula flag, little text, or text OCR was unsure of (low confidence =
 * handwriting, a chart's labels, a photo). Only a plain typed text slide that OCR read in full and with
 * confidence skips it (the writer gets its text anyway). Blank frames never go. Pure.
 */
export function needsVision(f, minWords = 12, { technical = true } = {}) {
  if (f.blank) return false;
  if (f.kinds?.length) return true;
  if (!technical) return true; // a story / religion / history video: every picture may be the content, OCR cannot judge it
  if (f.words < Math.max(24, minWords * 2)) return true;
  return Number.isFinite(f.conf) && f.conf < 75;
}

/** " (on screen ~4 s)" for a prompt line; '' when unknown. Pure. */
export const onScreen = (dwell) => (Number.isFinite(dwell) ? ` (on screen ~${Math.max(1, Math.round(dwell))} s)` : '');

/**
 * The Transcript AI's REFERENCES section (a JSON array) -> [{kind, title, author, at, why}]. Entries without a title are
 * dropped; an unknown kind becomes "other". Never throws. Pure.
 */
export function readRefs(text) {
  const t = String(text || '').replace(/^\s*```(?:json)?\s*|\s*```\s*$/g, '').trim();
  let j = null;
  try { j = JSON.parse(t); } catch { const m = /\[[\s\S]*\]/.exec(t); try { j = m ? JSON.parse(m[0]) : null; } catch { j = null; } }
  if (!Array.isArray(j)) return [];
  const KINDS = ['book', 'paper', 'film', 'document', 'person', 'website', 'quote', 'other'];
  const one = (v, n) => String(v ?? '').replace(/\s+/g, ' ').trim().slice(0, n);
  return j.filter((x) => x && typeof x === 'object' && one(x.title, 200).length >= 2).map((x) => ({
    kind: KINDS.includes(String(x.kind).toLowerCase()) ? String(x.kind).toLowerCase() : 'other',
    title: one(x.title, 160), author: one(x.author, 120), why: one(x.why, 220),
    at: /^\d{1,3}:\d{2}(?::\d{2})?$/.test(String(x.at || '')) ? String(x.at) : ''
  }));
}

/**
 * All the sources of a video in one list: those the Transcript AI found (one list per transcript part) plus the quotes shown
 * on screen, without repeats (same title), in time order, at most 14. Pure.
 * @param {object[]} found  @param {{t:number,text:string}[]} quotes
 */
export function collectRefs(found, quotes = []) {
  const key = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '');
  const secs = (at) => String(at || '').split(':').reduce((a, v) => a * 60 + Number(v), 0);
  const seen = new Set(), out = [];
  const add = (r) => { const k = key(r.title); if (k.length < 2 || seen.has(k)) return; seen.add(k); out.push({ ...r, _t: r.at ? secs(r.at) : r._t ?? 1e9 }); };
  for (const q of quotes || []) {
    const { body, who } = splitQuote(q.text);
    if (!body) continue;
    const words = body.split(/\s+/);
    add({ kind: 'quote', title: `“${words.slice(0, 9).join(' ')}${words.length > 9 ? '…' : ''}”`, author: who, why: 'shown on screen as a quote', at: fmtTime(q.t), _t: q.t });
  }
  for (const r of found || []) add(r);
  return out.sort((a, b) => a._t - b._t).slice(0, 14).map(({ _t, ...r }) => r);
}

/** Build the bibliography directly from the extracted lecture sources. */
export function formatReferences(refs) {
  if (!refs.length) return '';
  const labels = {
    book: 'Books and papers', paper: 'Books and papers', film: 'Films and documentaries',
    document: 'Documents and treaties', person: 'People', website: 'Websites and organisations',
    quote: 'Quotes', other: 'Other sources'
  };
  const groups = new Map();
  for (const r of refs) {
    const label = labels[r.kind] || labels.other;
    if (!groups.has(label)) groups.set(label, []);
    groups.get(label).push(`- **${r.title}**${r.author ? ` — ${r.author}` : ''}${r.at ? ` (at ${r.at})` : ''}${r.why ? `: ${r.why}` : ''}`);
  }
  return ['## References', ...[...groups].map(([label, lines]) => `**${label}**\n\n${lines.join('\n')}`)].join('\n\n');
}

/**
 * The writer's FIGURE LIST, kept apart from the notes so it costs few output tokens: one line after the notes,
 * `<!--FIGS 12@2|first words of the bullet;14@3;20@5|November 9-->`. Each entry = frame number @ topic number (1 = the first
 * "### " section of that reply), optionally | and the first words of the bullet the figure goes right after.
 * Returns the notes without the line and the entries (a frame is listed once; unreadable entries are skipped). Pure.
 * @returns {{md:string, figs:{n:number, topic:number, words:string}[]}}
 */
export function takeFigs(md) {
  const text = String(md || '');
  const all = [...text.matchAll(/<!--\s*FIGS\b([\s\S]*?)-->/gi)];
  if (!all.length) return { md: text, figs: [] };
  const figs = [];
  const seen = new Set();
  for (const part of all[all.length - 1][1].split(/[;\n]+/)) {
    const e = /^\s*F?(\d+)\s*@\s*(\d+)\s*(?:\|\s*(.+?))?\s*$/.exec(part);
    if (!e || seen.has(Number(e[1]))) continue;
    seen.add(Number(e[1]));
    figs.push({ n: Number(e[1]), topic: Number(e[2]), words: (e[3] || '').trim() });
  }
  return { md: text.replace(/<!--\s*FIGS\b[\s\S]*?-->\s*/gi, '').trimEnd(), figs };
}

/**
 * Put each listed frame into the notes as a `[[FRAME:n]]` marker (the rest of the pipeline then treats it like any marker):
 * in its topic, right after the whole bullet (sub-bullets included) whose first words match `words` (at least half of them),
 * else at the end of the topic's points, before its first callout. A topic number out of range is moved to the nearest one.
 * Frames listed for the same place keep their order. Pure.
 * @param {string} md  @param {{n:number, topic:number, words?:string}[]} figs
 */
export function applyFigs(md, figs) {
  if (!figs?.length) return md;
  const lines = String(md).split('\n');
  const heads = [];
  lines.forEach((l, i) => { if (/^###\s/.test(l)) heads.push(i); });
  if (!heads.length) return md;
  const indent = (l) => l.match(/^\s*/)[0].length;
  const marks = [];
  figs.forEach((f, order) => {
    const k = Math.min(heads.length, Math.max(1, Math.round(f.topic) || 1)) - 1;
    const from = heads[k], to = k + 1 < heads.length ? heads[k + 1] : lines.length;
    let at = -1;
    const want = [...new Set(quoteKeys(f.words || ''))];
    if (want.length) {
      let best = 0;
      for (let i = from + 1; i < to; i++) {
        if (/^\s*\[\[FRAME/.test(lines[i])) continue;
        const have = new Set(quoteKeys(lines[i]));
        const score = want.filter((w) => have.has(w)).length / want.length;
        if (score > best) { best = score; at = i; }
      }
      if (best < 0.5) at = -1;
      else { while (at + 1 < to && lines[at + 1].trim() && indent(lines[at + 1]) > indent(lines[at])) at++; } // after its sub-bullets too
    }
    if (at < 0) {
      let callout = -1;
      for (let i = from + 1; i < to; i++) if (/^\s*>/.test(lines[i])) { callout = i; break; }
      let end = (callout > 0 ? callout : to) - 1;
      while (end > from && !lines[end].trim()) end--;
      at = end;
    }
    marks.push({ at, n: f.n, order });
  });
  marks.sort((a, b) => b.at - a.at || b.order - a.order);
  for (const m of marks) lines.splice(m.at + 1, 0, `[[FRAME:${m.n}]]`);
  return lines.join('\n');
}

/** The words (3+ letters, lower case) that identify a quote. Pure. */
export const quoteKeys = (s) => String(s || '').toLowerCase().match(/[a-z']{3,}/g) || [];

/** "Forget not ... fall ...\n- Unknown, Graffiti on the Berlin Wall" -> { body, who }. Pure. */
export function splitQuote(text) {
  const lines = String(text || '').split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  let who = '';
  if (lines.length > 1 && /^[-–—~]\s*\S/.test(lines[lines.length - 1])) who = lines.pop().replace(/^[-–—~]\s*/, '');
  let body = lines.join(' ').replace(/\s+/g, ' ').trim();
  const m = !who && /^(.*?[”"])\s+[-–—]\s+(\S.*)$/.exec(body); // one line: “quote” - Author, Source
  if (m) { body = m[1]; who = m[2]; }
  body = body.replace(/^[“”"]+|[“”"]+$/g, '').trim();
  return { body, who: who.trim() };
}

/**
 * Every quote shown on screen is in the notes, as its OWN callout ("> **Quote:** “…” — author"): the Strong AI is asked to
 * write it, and this makes sure. A quote already in a callout stays; one the writer put inside a bullet or a paragraph becomes
 * a callout of its own (its words are kept); one that is missing is added where its time belongs (an epigraph at the start
 * goes right under the first topic's heading, any other at the end of the topic it is shown in). Pure.
 * @param {string} notes  @param {{t:number, text:string}[]} quotes
 */
export function ensureQuotes(notes, quotes) {
  let md = String(notes || '');
  for (const q of quotes || []) {
    const { body, who } = splitQuote(q.text);
    const keys = [...new Set(quoteKeys(body))];
    if (keys.length < 3) continue;
    const lines = md.split('\n');
    const covers = (line) => { const w = new Set(quoteKeys(line)); return keys.filter((k) => w.has(k)).length / keys.length >= 0.8; };
    const at = lines.findIndex(covers);
    if (at >= 0) {
      if (/^\s*>/.test(lines[at])) continue; // already a callout
      const plain = lines[at].replace(/^\s*(?:[-*+]|\d+\.)\s+/, '').trim();
      lines[at] = /^\*\*quote/i.test(plain) ? `> ${plain}` : `> **Quote:** ${plain}`;
      md = lines.join('\n');
      continue;
    }
    const callout = `> **Quote:** “${body}”${who ? ` — ${who}` : ''}`;
    const parts = md.split(/^(?=###\s)/m);
    const first = parts.findIndex((p) => p.startsWith('###'));
    if (first < 0) { md = `${md.trimEnd()}\n\n${callout}\n`; continue; }
    const starts = sectionStarts(parts.slice(first), 0);
    let k = 0;
    for (let i = 0; i < starts.length; i++) if (starts[i] <= q.t + 5) k = i;
    const i = first + k;
    if (q.t <= starts[0] + 20 && k === 0) { // an epigraph at the very start: right under the first heading
      const nl = parts[i].indexOf('\n');
      parts[i] = `${parts[i].slice(0, nl + 1)}${callout}\n${parts[i].slice(nl + 1)}`;
    } else parts[i] = `${parts[i].trimEnd()}\n\n${callout}\n\n`;
    md = parts.join('');
  }
  return md;
}

/** The old candidate rank: a flagged frame (code / table / diagram / formula) first, then low-text frames, then the rest. Pure. */
export const codeRank = (f, minWords = 12) => ((f.kinds?.length ? 2 + (Number(f.score) || 0) : f.words < minWords ? 1 : 0));

/**
 * Cut a candidate list to at most `cap` frames WITHOUT losing the story: the video is split into `cap` equal time slices and
 * the best-ranked frame of each slice stays; free slots (slices with nothing) go to the best-ranked frames left over. So the
 * frames are spread over the whole video, and the flagged ones win inside their slice. The old rule (a plain top-N by rank)
 * kept only the first frames of a video whose frames all rank the same (a story, a documentary). Pure.
 * @param {{t:number}[]} list ordered by time  @param {number} cap  @param {(f:object)=>number} rank
 */
export function capCandidates(list, cap, rank = codeRank) {
  if (!(cap > 0) || list.length <= cap) return list;
  const t0 = list[0].t, span = Math.max(1, list[list.length - 1].t - t0 + 1);
  const best = new Map(); // slice -> frame
  for (const f of list) {
    const b = Math.min(cap - 1, Math.floor(((f.t - t0) / span) * cap));
    const cur = best.get(b);
    if (!cur || rank(f) > rank(cur)) best.set(b, f);
  }
  const chosen = new Set(best.values());
  const rest = list.filter((f) => !chosen.has(f)).sort((a, b) => rank(b) - rank(a) || a.t - b.t);
  for (const f of rest) { if (chosen.size >= cap) break; chosen.add(f); }
  return list.filter((f) => chosen.has(f));
}

/** Start time (seconds) of each `### Title (mm:ss)` section; headings without a time are spread evenly. */
function sectionStarts(sections, duration) {
  const t = sections.map((s) => {
    const m = /^###[^\n]*\((\d{1,3}):(\d{2})(?::(\d{2}))?\)\s*$/m.exec(s);
    return m ? (m[3] != null ? Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) : Number(m[1]) * 60 + Number(m[2])) : null;
  });
  return t.map((v, i) => (v != null ? v : (duration * i) / Math.max(1, sections.length)));
}

/**
 * Writers spell the frame marker in many ways ([[FRAME:F3]], [[ frame: 3 ]], [[F3]]): one form, [[FRAME:3]].
 * Pure. @param {string} md
 */
export function normaliseMarkers(md) {
  return String(md || '')
    .replace(/\[\[\s*FRAME\s*[:#]?\s*F?\s*(\d+)\s*\]\]/gi, '[[FRAME:$1]]')
    .replace(/\[\[\s*F(\d+)\s*\]\]/g, '[[FRAME:$1]]')
    // a marker written as a list item ("    - [[FRAME:3]]") would leave an empty bullet: put it on its own line
    .replace(/^[ \t>]*(?:[-*+]|\d+\.)[ \t]*(\[\[FRAME:\d+\]\])[ \t]*$/gm, '\n$1\n');
}

const STOP = new Set('that this with from they them their there were what when which while would could should about after before into than then also only more most some such very have been being does just over under your will each other these those because where between through during against'.split(' '));
/** Content words of a text (4+ letters, not stopwords) and any number: what links a picture to a sentence. */
const keyWords = (s) => new Set((String(s).toLowerCase().match(/[a-z][a-z'-]{3,}|\d+/g) || []).map((w) => w.replace(/'s$/, '')).filter((w) => !STOP.has(w)));

/**
 * Section times from the transcript, not the writer's guess: each `### Topic (mm:ss)` heading gets the time
 * of the transcript line that best matches the section's first points (times only move forward). Left alone
 * when the transcript is too coarse to say (one piece per minute) or nothing matches clearly. Pure.
 * @param {string} notes  @param {{start:number,end:number,text:string}[]} segs
 */
export function snapSectionTimes(notes, segs) {
  if (!segs || segs.length < 4) return notes;
  const lens = segs.map((s) => s.end - s.start).sort((a, b) => a - b);
  if (lens[lens.length >> 1] > 20) return notes;
  const words = segs.map((s) => keyWords(s.text)); // a line counts fully, the next one (a topic spills over) by half
  let floor = 0;
  return notes.split(/^(?=###\s)/m).map((p) => {
    const head = /^(###[^\n]*\()(\d{1,3}):(\d{2})(?::(\d{2}))?(\)[ \t]*)$/m.exec(p);
    if (!p.startsWith('###') || !head) return p;
    const old = head[4] != null ? Number(head[2]) * 3600 + Number(head[3]) * 60 + Number(head[4]) : Number(head[2]) * 60 + Number(head[3]);
    const points = p.split('\n').slice(1).filter((l) => /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l) && !/\*\*Big idea:\*\*/.test(l) && !/^\s*[-*+]\s*\*\*[^*]+:\*\*\s*$/.test(l)).slice(0, 2);
    const want = keyWords(points.join(' '));
    let best = null;
    segs.forEach((s, i) => {
      if (s.start < floor - 1) return;
      let hits = 0;
      for (const w of want) {
        const v = /^\d+$/.test(w) ? 2 : 1; // a shared year or number is strong evidence
        if (words[i].has(w)) hits += v; else if (words[i + 1]?.has(w)) hits += v / 2;
      }
      if (hits >= 3 && (!best || hits > best.hits)) best = { hits, t: s.start };
    });
    const t = best ? best.t : Math.max(old, floor);
    floor = t;
    if (Math.abs(t - old) < 2) return p;
    return p.replace(head[0], `${head[1]}${fmtTime(t)}${head[5]}`);
  }).join('');
}

/**
 * Insert `[[FRAME:n]]` markers for frames the writer did not place. Each one goes right after the bullet
 * that talks about what was said (and shown) at that moment: the speech around the frame's time and its
 * text / description are matched against every bullet, and the section being spoken at that time breaks
 * ties. With no clear match it goes at the end of that section's key points (before the first callout).
 * @param {string} notes markdown with `### Topic (mm:ss)` sections
 * @param {{index:number,t:number,text?:string,vision?:string}[]} frames
 * @param {number} duration  @param {{start:number,end:number,text:string}[]} [segs] the transcript
 */
export function insertFrames(notes, frames, duration, segs = []) {
  if (!frames.length) return notes;
  const parts = notes.split(/^(?=###\s)/m);
  const sections = parts.filter((p) => p.startsWith('###'));
  if (!sections.length) return `${notes}\n\n${frames.map((f) => `[[FRAME:${f.index}]]`).join('\n\n')}`;
  const starts = sectionStarts(sections, duration);
  // bullets of each section (not callouts, not code), as line numbers inside that section
  const lines = sections.map((p) => p.split('\n'));
  const bullets = lines.map((ls) => {
    const out = [];
    let fence = false;
    ls.forEach((l, i) => {
      if (/^\s*(```|~~~)/.test(l)) fence = !fence;
      else if (!fence && /^\s*(?:[-*+]|\d+\.)\s+\S/.test(l)) out.push({ i, words: keyWords(l.replace(/\*\*[^*]+:\*\*/g, '')) });
    });
    return out;
  });
  const after = sections.map(() => new Map()); // line -> markers to put after it
  const tail = sections.map(() => []);
  for (const f of [...frames].sort((a, b) => a.t - b.t)) {
    let k = 0;
    starts.forEach((s, i) => { if (s <= f.t + 1) k = i; });
    const said = segs.filter((s) => s.end >= f.t - 6 && s.start <= f.t + 12).map((s) => s.text).join(' ');
    const want = keyWords(`${said} ${f.text || ''} ${f.vision || ''}`);
    let best = null;
    bullets.forEach((bs, si) => bs.forEach((b) => {
      let hits = 0;
      for (const w of b.words) if (want.has(w)) hits += /^\d+$/.test(w) ? 2 : 1; // a shared year or number is strong evidence
      const score = hits + (si === k ? 1.5 : 0) - Math.min(2, Math.abs(si - k) * 0.5);
      if (hits >= 2 && (!best || score > best.score)) best = { si, i: b.i, score };
    }));
    if (best) {
      // after the bullet and any deeper bullets / continuation lines that belong to it
      const ls = lines[best.si], ind = /^\s*/.exec(ls[best.i])[0].length;
      let end = best.i;
      while (end + 1 < ls.length && ls[end + 1].trim() && !/^\s*>/.test(ls[end + 1]) &&
        (/^\s*/.exec(ls[end + 1])[0].length > ind)) end++;
      const m = after[best.si];
      m.set(end, [...(m.get(end) || []), `[[FRAME:${f.index}]]`]);
    } else tail[k].push(`[[FRAME:${f.index}]]`);
  }
  let si = 0;
  return parts.map((p) => {
    if (!p.startsWith('###')) return p;
    const k = si++;
    let ls = lines[k];
    if (after[k].size) ls = ls.flatMap((l, i) => (after[k].has(i) ? [l, '', ...after[k].get(i).flatMap((m) => [m, ''])] : [l]));
    let out = ls.join('\n');
    if (!tail[k].length) return out;
    const block = `\n\n${tail[k].join('\n\n')}\n`;
    const c = out.search(/\n>\s/); // first callout
    return c > 0 ? `${out.slice(0, c).replace(/\s+$/, '')}${block}${out.slice(c)}` : `${out.replace(/\s+$/, '')}${block}\n`;
  }).join('');
}

/**
 * Decide which frames the notes (and the PDF) show, at most `budget` (10 per hour of video by default), and
 * only frames that earn it: the writer's own picks (it saw or read them; +5 for that) and IMPORTANT frames it
 * did not place (priority >= IMPORTANT_PRIORITY: maps, charts, diagrams, code... the vision model rated well),
 * ranked together by priority. The budget is a cap, not a target: a long video with two important frames gets
 * two. Markers for dropped frames are removed; important frames the writer skipped are inserted after the
 * bullet that talks about them.
 * @param {string} notes  @param {object[]} screen  @param {Map<number,object>} byIndex  @param {number} budget
 * @param {{start:number,end:number,text:string}[]} [segs] the transcript (to place inserted frames)
 */
export function chooseFigures(notes, screen, byIndex, budget, segs = []) {
  notes = normaliseMarkers(notes);
  const marked = [...new Set([...notes.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => Number(m[1])))].filter((n) => byIndex.has(n));
  const keep = new Set();
  const mine = new Set(marked);
  const prio = (f) => (Number.isFinite(f.priority) ? f.priority : framePriority(f)) + (mine.has(f.index) ? 5 : 0);
  const cands = [...new Map([...screen.filter((x) => x.important), ...marked.map((n) => byIndex.get(n))].map((f) => [f.index, f])).values()];
  for (const f of cands.sort((a, b) => prio(b) - prio(a) || figScore(b) - figScore(a) || a.t - b.t)) if (keep.size < budget) keep.add(f.index);
  const seen = new Set();
  let out = notes.replace(/\[\[FRAME:(\d+)\]\]/g, (m, n) => {
    n = Number(n);
    if (!keep.has(n) || seen.has(n)) return '';
    seen.add(n);
    return m;
  });
  const missing = [...keep].filter((n) => !seen.has(n)).map((n) => byIndex.get(n));
  out = insertFrames(out, missing, Math.max(...screen.map((f) => f.t), 0) + 1, segs);
  return out;
}

/** Frames whose content is the point (code, a chart, a map...): never thinned out for spacing. */
const INFORMATIVE = new Set(['code', 'table', 'formula', 'diagram', 'chart', 'schematic', 'patent', 'map']);
const HARD_KINDS = new Set(['code', 'table', 'formula']);
/**
 * Never thinned out: code, tables, formulas always; a chart / diagram / map when a vision model confirmed it,
 * or (without one) when it carries real text. A text-poor "diagram" is just an illustration (a cartoon scene):
 * several of those from one stretch of a video look the same, so they are thinned like photos.
 */
const informative = (f) => {
  if (!f) return false;
  if (f.presentation === 'visual') return true;
  if (f.tag) return INFORMATIVE.has(f.tag);
  const ks = f.kinds || [];
  if (ks.some((k) => HARD_KINDS.has(k))) return true;
  return ks.some((k) => INFORMATIVE.has(k)) && (f.words || 0) >= 8;
};
const figScore = (f) => (Number.isFinite(f?.score) ? f.score : 0);
/** Two pictures that are the same image (64-bit hash differs in at most 6 bits). Code/tables are never judged this way. */
const LOOKALIKE_BITS = 6;
const lookalike = (a, b) => !!a?.h && !!b?.h && a.h.length === b.h.length && hamming(a.h, b.h) <= LOOKALIKE_BITS &&
  !(a.kinds || []).some((k) => HARD_KINDS.has(k)) && !(b.kinds || []).some((k) => HARD_KINDS.has(k));

const OUTRO = /\b(lesson by|narration by|music by|animation by|directed by|produced by|view full lesson|nominate an educator|recommend an animator|submit a lesson|thanks for watching|thank you for watching|like and subscribe)\b/i;
/** An end card (credits, logo, "view full lesson"): its text says so and it comes late in the video. Pure. */
export const isOutro = (text, t, duration) => !!text && duration > 0 && t >= duration * 0.6 && OUTRO.test(text);

/**
 * Spread the figures over the story. Pure.
 * 1. One figure per scene: two pictures (photos, scenes, slides) in the same section closer than `minGap`
 *    seconds show the same moment; the weaker one goes. Code, charts, maps, diagrams are never thinned.
 * 2. A section with no figure receives the best unused IMPORTANT frame from its own time range (if one exists
 *    and stays `minGap` away from the figures already shown), while the budget lasts. No filler pictures.
 * @param {string} notes  @param {object[]} screen  @param {Map<number,object>} byIndex
 * @param {{budget:number, duration:number, minGap:number, segs?:object[]}} o
 */
export function balanceFigures(notes, screen, byIndex, { budget, duration, minGap, segs = [] }) {
  const parts = notes.split(/^(?=###\s)/m);
  const sections = parts.filter((p) => p.startsWith('###'));
  if (!sections.length) return notes;
  const ids = (p) => [...p.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => Number(m[1])).filter((n) => byIndex.has(n));
  // 1. thin out same-moment pictures inside each section
  const drop = new Set();
  for (const p of sections) {
    const fs = ids(p).map((n) => byIndex.get(n)).filter((f) => !informative(f)).sort((a, b) => a.t - b.t);
    let last = null; // the last figure kept: every next one is compared with it (not with a dropped neighbour)
    for (const b of fs) {
      if (last && b.t - last.t < minGap) {
        if (figScore(b) > figScore(last)) { drop.add(last.index); last = b; } else drop.add(b.index);
      } else last = b;
    }
  }
  // 1b. the same picture twice, anywhere in the notes (a held shot, a repeated flag): the later one goes
  {
    const kept = [];
    for (const n of sections.flatMap(ids)) {
      const f = byIndex.get(n);
      if (!f || drop.has(n)) continue;
      if (kept.some((k) => lookalike(k, f))) drop.add(n); else kept.push(f);
    }
  }
  let used = new Set(sections.flatMap(ids).filter((n) => !drop.has(n)));
  // 2. a figure for every section that has none
  const starts = sectionStarts(sections, duration);
  const ends = starts.map((s, i) => (i + 1 < starts.length ? starts[i + 1] : Infinity));
  const shownT = () => [...used].map((n) => byIndex.get(n).t);
  const add = new Map();
  sections.forEach((p, k) => {
    if (ids(p).some((n) => !drop.has(n)) || used.size >= budget) return;
    const pick = screen
      .filter((f) => f.important && !used.has(f.index) && f.t >= starts[k] - 2 && f.t < ends[k] && shownT().every((t) => Math.abs(t - f.t) >= minGap) &&
        ![...used].some((n) => lookalike(byIndex.get(n), f)))
      .sort((a, b) => figScore(b) - figScore(a))[0];
    if (!pick) return;
    used.add(pick.index);
    add.set(k, pick);
  });
  let si = 0;
  return parts.map((p) => {
    if (!p.startsWith('###')) return p;
    const k = si++;
    let out = p.replace(/\[\[FRAME:(\d+)\]\]\n?/g, (m, n) => (drop.has(Number(n)) ? '' : m));
    if (add.has(k)) out = insertFrames(out, [add.get(k)], duration, segs);
    return out;
  }).join('');
}

/**
 * A section heading's (mm:ss) is never later than the first figure inside it (the picture shows the
 * section has started), and never earlier than the previous heading. Pure.
 * @param {string} notes  @param {Map<number,{t:number}>} byIndex
 */
export function headersBeforeFigures(notes, byIndex) {
  let floor = 0;
  return notes.split(/^(?=###\s)/m).map((p) => {
    const head = /^(###[^\n]*\()(\d{1,3}):(\d{2})(?::(\d{2}))?(\)[ \t]*)$/m.exec(p);
    if (!p.startsWith('###') || !head) return p;
    const t = head[4] != null ? Number(head[2]) * 3600 + Number(head[3]) * 60 + Number(head[4]) : Number(head[2]) * 60 + Number(head[3]);
    const figs = [...p.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => byIndex.get(Number(m[1]))?.t).filter((x) => Number.isFinite(x) && x >= floor);
    const first = figs.length ? Math.min(...figs) : Infinity;
    const want = Math.max(floor, Math.min(t, first));
    floor = want;
    return Math.floor(want) === t ? p : p.replace(head[0], `${head[1]}${fmtTime(want)}${head[5]}`);
  }).join('');
}

const REDUNDANT_FRAMES = /^[ \t]*<!--\s*REDUNDANT\s+((?:F\d+\s*(?:,\s*)?)+)-->[ \t]*\n?/gim;

/** Correct misplaced figures with explicit topic evidence, within one source video. */
export function placeTopicFigures(notes, frames, duration, segs = [], redundant = new Set()) {
  const byId = new Map(frames.map(frame => [frame.index, frame]));
  const parts = notes.split(/^(?=###[ \t])/m);
  const titles = parts.map(part => (part.match(/^###[ \t]+([^\n]+)/)?.[1] || '').replace(/\s+\(\d+(?::\d{2}){1,2}\)\s*$/, ''));
  const acronyms = str => (str.match(/\b[A-Z]{3,}\b/g) || []).map(word => word.toLowerCase());
  const words = str => new Set([...keyWords(str), ...acronyms(str)]);
  const headings = titles.map(words);
  const moves = new Map();
  const clean = parts.map((part, current) => part.replace(/\[\[FRAME:(\d+)\]\]/g, (line, id) => {
    const frame = byId.get(Number(id));
    if (!frame) return line;
    const ocrTitle = String(frame.ocrTitle || frame.text || '').split(/\r?\n/, 2).join(' ');
    const visible = words(ocrTitle + ' ' + (frame.caption || '') + ' ' + (frame.vision || '').slice(0, 140));
    const rank = headings.map((topic, index) => {
      const unique = [...topic].filter(word => visible.has(word) && headings.every((other, i) => i === index || !other.has(word)));
      if (unique.length < 2 && !unique.some(word => acronyms(titles[index]).includes(word))) return 0;
      return unique.length + unique.length / topic.size;
    });
    const highest = Math.max(0, ...rank);
    const best = highest && rank.indexOf(highest) === rank.lastIndexOf(highest) ? rank.indexOf(highest) : current;
    const body = topicBody(parts[best]);
    const reproduces = body && (frame.tag === 'formula' ? /\$[^$\n]+\$|\$\$[\s\S]+?\$\$/.test(body)
      : frame.tag === 'table' ? /^\s*\|[^|\n]+\|/m.test(body) : frame.tag === 'code' ? /^\s*\x60{3}/m.test(body) : true);
    if (redundant.has(frame.index) && frame.presentation === 'reproducible' &&
        ['formula', 'table', 'code', 'slide', 'other'].includes(frame.tag) && reproduces) return '';
    if (best === current) return line;
    if (!moves.has(best)) moves.set(best, []);
    moves.get(best).push(frame);
    return '';
  }));
  return clean.map((part, index) => moves.has(index) ? insertFrames(part, moves.get(index), duration, segs) : part).join('');
}

/**
 * A video with few or no informative frames (a vlog, a song, a talk with no slides) still deserves a few
 * pictures. Returns up to `want - informative` extra frames from `distinct`, spread evenly over the video
 * (one per time bin, the frame nearest the bin's middle), skipping blank frames and ones already chosen.
 * Pure. @returns {object[]} frames, oldest first
 */
export function pickScenes(distinct, chosen, duration, want) {
  const taken = new Set(chosen.map((f) => f.index));
  const need = want - chosen.filter((f) => f.important).length;
  const pool = distinct.filter((f) => !f.blank && !taken.has(f.index));
  if (need <= 0 || !pool.length) return [];
  const k = Math.min(need, pool.length);
  const end = Math.max(duration || 0, ...pool.map((f) => f.t)) || 1;
  const out = [];
  for (let i = 0; i < k; i++) {
    const mid = ((i + 0.5) / k) * end;
    const left = pool.filter((f) => !out.includes(f));
    if (!left.length) break;
    out.push(left.reduce((a, b) => (Math.abs(b.t - mid) < Math.abs(a.t - mid) ? b : a)));
  }
  return out.sort((a, b) => a.t - b.t);
}

/** Frame PNG blob -> base64 JPEG no wider than maxW (small image = few tokens). */
async function jpegB64(blob, maxW = 1024, quality = 0.8, tag = '') {
  const bmp = await createImageBitmap(blob);
  const k = Math.min(1, maxW / bmp.width);
  const c = document.createElement('canvas');
  c.width = Math.round(bmp.width * k);
  c.height = Math.round(bmp.height * k);
  const g = c.getContext('2d');
  g.drawImage(bmp, 0, 0, c.width, c.height);
  // the frame's id, printed small in the top-left corner: a model that is shown many pictures reads the id off the
  // picture itself, so a description can never slip onto the neighbouring frame
  if (tag && g.fillText && g.measureText) {
    const fs = Math.max(14, Math.round(c.height * 0.045));
    g.font = `bold ${fs}px sans-serif`;
    g.textBaseline = 'top';
    const w = Math.ceil(g.measureText(tag).width) + 10;
    g.fillStyle = 'rgba(0,0,0,0.85)';
    g.fillRect(0, 0, w, fs + 8);
    g.fillStyle = '#fff';
    g.fillText(tag, 5, 4);
  }
  bmp.close?.();
  const jpg = await new Promise((r) => c.toBlob(r, 'image/jpeg', quality));
  const buf = new Uint8Array(await jpg.arrayBuffer());
  let bin = '';
  for (let i = 0; i < buf.length; i += 0x8000) bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(bin);
}

/** Split a markdown document on its "## " headings (not "###"). Returns { pre, sections: [{title, body}] }. */
export function splitH2(md) {
  const parts = String(md || '').replace(/\r/g, '').split(/^(?=##\s)/m);
  const out = { pre: '', sections: [] };
  for (const p of parts) {
    const m = /^##[ \t]+(.+?)[ \t]*(?:\n|$)/.exec(p);
    if (!m || !p.startsWith('##')) out.pre += p;
    else out.sections.push({ title: m[1].trim(), body: p.slice(m[0].length) });
  }
  return out;
}

/** Pull Overview / Detailed notes out of a "full" reply (a stray Exam hints section is dropped). Topic sections that ended up under Overview move to the notes. */
export function splitFull(md) {
  const { pre, sections } = splitH2(md);
  let overview = '', notes = '';
  const extra = [];
  for (const s of sections) {
    const t = s.title.toLowerCase();
    if (t.startsWith('overview')) {
      const i = s.body.search(/^###\s/m);
      overview = (i >= 0 ? s.body.slice(0, i) : s.body).trim();
      if (i >= 0) notes += `${s.body.slice(i)}\n`;
    } else if (t.startsWith('detailed')) notes += `${s.body}\n`;
    else if (t.startsWith('exam')) continue; // not wanted
    else extra.push(`## ${s.title}\n${s.body.trim()}`);
  }
  if (!notes.trim()) notes = pre;
  return { overview, notes: notes.trim(), extra };
}

const RESUMABLE_WRITERS = new Set(['geminiweb']);
const webInterface = provider => RESUMABLE_WRITERS.has(provider?.type);

function mergeWriterDetails(notes, details) {
  const splitSections = text => {
    const sections = [];
    let lines = [], fence = '';
    for (const line of text.split(/\r?\n/)) {
      if (!fence && /^#{1,3}[ \t]/.test(line) && lines.length) {
        sections.push(lines.join('\n'));
        lines = [];
      }
      const marker = /^\s*(```|~~~)/.exec(line)?.[1];
      if (marker && (!fence || marker === fence)) fence = fence ? '' : marker;
      lines.push(line);
    }
    return [...sections, lines.join('\n')];
  };
  const sections = splitSections(notes);
  const additions = splitSections(details);
  const detailed = sections.findIndex(section => /^##\s+Detailed notes\b/i.test(section));
  const start = detailed < 0 ? 0 : detailed + 1;
  let end = sections.findIndex((section, i) => i >= start && /^#{1,2}[ \t]/.test(section));
  if (end < 0) end = sections.length;
  const topicTime = section => {
    const timestamp = /\((\d+:\d{2}(?::\d{2})?)\)\s*$/.exec(section.split('\n')[0]);
    return timestamp ? timestamp[1].split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0) : NaN;
  };
  for (const part of additions) {
    const match = /^(### [^\n]+)\n([\s\S]+)$/.exec(part.trim());
    if (!match) continue;
    const [ , heading, content] = match;
    const index = sections.findIndex((section, i) => i >= start && i < end && section.split('\n')[0].trim() === heading.trim());
    const anchor = /^<!--AFTER: ([^\n]+?)-->[ \t]*\n/.exec(content);
    const body = (anchor ? content.slice(anchor[0].length) : content).trim();
    if (!body) continue;
    if (index < 0) {
      const time = topicTime(heading);
      const next = sections.findIndex((section, i) => i >= start && i < end && topicTime(section) > time);
      sections.splice(next < 0 ? end : next, 0, `${heading}\n\n${body}`);
      end++;
      continue;
    }
    const lines = sections[index].trimEnd().split('\n');
    const matches = [];
    let fence = '';
    for (let i = 1; anchor && i < lines.length; i++) {
      const marker = /^\s*(```|~~~)/.exec(lines[i])?.[1];
      if (marker && (!fence || marker === fence)) fence = fence ? '' : marker;
      if (!marker && !fence && lines[i].trim() === anchor[1].trim() && !lines[i + 1]?.trim()) matches.push(i);
    }
    lines.splice(matches.length === 1 ? matches[0] + 1 : lines.length, 0, '', body, '');
    sections[index] = lines.join('\n');
  }
  return sections.map(section => section.trim()).filter(Boolean).join('\n\n');
}

/** Languages whose blocks are runnable code (a block in any other language, e.g. text / json / steps, needs no output). */
const CODE_LANGS = new Set(['python', 'py', 'python3', 'js', 'javascript', 'node', 'ts', 'typescript', 'java', 'c', 'cpp', 'c++', 'cc', 'cs', 'csharp', 'go', 'golang', 'rust', 'rs', 'kotlin', 'kt', 'swift', 'ruby', 'rb', 'php', 'r', 'matlab', 'octave', 'scala', 'sql', 'bash', 'sh', 'shell', 'zsh', 'powershell', 'ps1', 'haskell', 'hs', 'lua', 'perl', 'pl', 'dart', 'julia', 'jl', 'fortran', 'pascal', 'vb', 'vbnet', 'elixir', 'clojure', 'prolog', 'scheme', 'lisp', 'asm', 'verilog', 'vhdl']);
const OUTPUT_START = /^(\*\*|__)?\s*(expected\s+)?output\b|^```\s*(text|output|console|plaintext|txt|stdout)?\s*$/i;

/**
 * Runnable code blocks with no output after them. A block "has" its output when the next non-blank line is an
 * "Output" label or a text/output fence. Pure. @returns {{lang:string, code:string, end:number}[]} end = line index of the closing fence
 */
export function codeWithoutOutput(md) {
  const lines = String(md || '').split('\n');
  const bare = (l) => l.replace(/^\s*(>\s*)*/, '').trim(); // blocks may sit inside a > callout
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const open = /^(```+)\s*([\w+#.-]*)$/.exec(bare(lines[i]));
    if (!open) continue;
    const fence = open[1], lang = open[2].toLowerCase();
    let j = i + 1;
    while (j < lines.length && !bare(lines[j]).startsWith(fence)) j++;
    if (j >= lines.length) break;
    if (CODE_LANGS.has(lang)) {
      let k = j + 1;
      while (k < lines.length && !bare(lines[k])) k++;
      if (!OUTPUT_START.test(bare(lines[k] || ''))) out.push({ lang, code: lines.slice(i + 1, j).map((l) => l.replace(/^\s*>\s?/, '')).join('\n'), end: j });
    }
    i = j;
  }
  return out;
}

/** Insert "**Output:**" + a text block after each listed code block (outputs[i] for blocks[i]; empty ones skipped). Pure. */
export function addOutputs(md, blocks, outputs) {
  const lines = String(md || '').split('\n');
  for (let b = blocks.length - 1; b >= 0; b--) { // from the end, so earlier line numbers stay valid
    const text = String(outputs[b] ?? '').trim();
    if (!text) continue;
    const indent = /^(\s*>?\s*)/.exec(lines[blocks[b].end])[1]; // keep a block that sits in a callout inside it
    lines.splice(blocks[b].end + 1, 0, `${indent}`, `${indent}**Output:**`, `${indent}\`\`\`text`, ...text.split('\n').map((l) => `${indent}${l}`), `${indent}\`\`\``);
  }
  return lines.join('\n');
}

/** `### Title (mm:ss)` headings -> [{title, time}] */
function groundedPractice(practice, notes, sourceLinks = '') {
  const clean = s => s.replace(/\s*\(\d+(?::\d+){1,2}\)\s*$/, '').trim();
  const byTopic = new Map();
  for (const block of practice.split(/^(?=### )/m)) {
    const [heading, ...lines] = block.split('\n');
    if (heading.startsWith('### ')) byTopic.set(clean(heading.slice(4)), lines.join('\n'));
  }
  const groups = [];
  for (const section of notes.split(/^(?=### )/m).filter(s => s.startsWith('### '))) {
    const [heading, ...lines] = section.split('\n');
    const title = clean(heading.slice(4));
    const source = lines.filter(l => !/\[EXTRA\]|Extra example|Background:|\[\[FRAME|\*\*Source:/i.test(l)).join('\n');
    const questions = [];
    for (const q of (byTopic.get(title) || '').split(/^(?=\*\*Q\d+\.)/m)) {
      if (!/^\*\*Q\d+\./.test(q)) continue;
      const concept = /^Ref:\s*(.+)$/m.exec(q)?.[1]?.trim();
      if (!concept || !source.includes(concept) || !q.includes('**Answer:**')) continue;
      if (/\[(?:Course Assignment|GATE PYQ)\]/i.test(q)) {
        const urls = q.match(/https:\/\/[^\s)\]]+/gi) || [];
        if (!urls.some(url => sourceLinks.includes(url) && /\.(?:ac\.in|edu(?:\.[a-z]{2})?|gov\.in)\//i.test(url))) continue;
      }
      const tagged = /\[(?:Lecture|Lecture-Grounded|Course Assignment|GATE PYQ)\]/i.test(q) ? q : q.replace(/^(\*\*Q\d+\.\*\*)/, '$1 [Lecture-Grounded]');
      questions.push(tagged.replace(/^Ref:\s*.+$/m, 'Formula / Concept Used: '+concept).trim());
    }
    if (!questions.length) {
      const concept = source.split('\n').map(s => s.replace(/^\s*(?:[-*>]+\s*)?(?:\*\*[^*]+:\*\*\s*)?/, '').trim()).find(s => s.length > 4 && !/^[|#`$]/.test(s));
      if (concept) questions.push('**Q1.** [Lecture-Grounded] State one point the lecture teaches about '+title+'.\n\n**Answer:**\nFormula / Concept Used: '+concept+'\n\n'+concept);
    }
    if (questions.length) groups.push('### '+title+'\n\n'+questions.join('\n\n'));
  }
  return groups.length ? '## Practice questions\n\n'+groups.join('\n\n') : '';
}

export function topicList(notes) {
  return [...notes.matchAll(/^###\s+(.+?)\s*$/gm)].map((m) => {
    const t = /^(.*?)\s*\((\d{1,3}:\d{2}(?::\d{2})?)\)\s*$/.exec(m[1]);
    return t ? { title: t[1], time: t[2] } : { title: m[1], time: '' };
  });
}

const withinVideo = (video, time) => time >= video.start && time < video.end;
const markdownVideoTime = value => value.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0);

/** Keep each video's transcript and visual evidence in its own writer block. */
export function combinedWriterEvidence(chunks, ocr, videos) {
  return videos.map((video, i) => {
    const evidence = chunks.map(chunk => ({
      segments: chunk.segments.filter(item => withinVideo(video, item.start)),
      screen: chunk.screen.filter(item => withinVideo(video, item.t)),
      extra: (chunk.extra || []).filter(item => withinVideo(video, item.t))
    }));
    return `VIDEO ${i + 1}: ${video.title} (${video.time})\n\n${writerEvidence(evidence, ocr)}`;
  }).join('\n\n');
}

/** Regroup timestamped sections in source order and only give each block access to its own evidence. */
export function byVideoSections(notes, videos, transform) {
  const parts = [];
  let block = [], fence = '';
  for (const line of notes.split('\n')) {
    if (!fence && /^###[ \t]/.test(line) && block.length) { parts.push(block.join('\n') + '\n'); block = []; }
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? '' : marker;
    block.push(line);
  }
  parts.push(block.join('\n'));
  const groups = videos.map(() => []);
  const preface = [];
  let videoIndex = -1;
  for (const part of parts) {
    const time = /^### [^\n]*\((\d+(?::\d{2}){1,2})\)[ \t]*$/m.exec(part.split('\n')[0])?.[1];
    if (/^###[ \t]/.test(part)) videoIndex = time ? videos.findIndex(video => withinVideo(video, markdownVideoTime(time))) : -1;
    (videoIndex < 0 ? preface : groups[videoIndex]).push(part);
  }
  return [preface.join('').replace(/\[\[FRAME:\d+\]\]/g, ''),
    ...groups.map((group, i) => group.length ? transform(group.join(''), videos[i]) : '')]
    .filter(Boolean).map(block => block.trim()).join('\n\n');
}

/**
 * Run the local pipeline for one lecture. Same options as runPipeline() in pipeline.js.
 * @returns {Promise<{title: string}>}
 */
export async function runLocalPipeline(o) {
  const { mode, key, course, settings, signal: jobSignal, onProgress: progress, regenerate } = o;
  // the run's own signal: the job's cancel, or (when transcript and slide scan run side by side) a failed
  // branch stopping the other one, so a pause is shown at once instead of after the other branch finishes
  const runCtl = new AbortController();
  if (jobSignal.aborted) runCtl.abort(); else jobSignal.addEventListener('abort', () => runCtl.abort(), { once: true });
  const signal = runCtl.signal;
  const videos = o.videos || [];
  const groupByVideo = (items, time) => videos.length
    ? videos.map(video => items.filter(item => withinVideo(video, time(item)))).filter(items => items.length)
    : [items];
  const tRun = Date.now();
  const strong = slotRef(settings, 'strong');
  const cheap = slotRef(settings, 'cheap');
  const onWait = (t) => progress('notes', null, t);
  const warn = (m) => { draft.warnings.push(m); log.alert('pipeline', m); };
  const warnOnce = (m) => { if (!draft.warnings.includes(m)) warn(m); };
  if (regenerate) { await deleteResult(key); await deleteDraft(key); }
  let draft = regenerate ? null : await getDraft(key);
  if (draft && draft.engine !== 'local') draft = null; // a draft from the old Gemini pipeline
  draft ||= { key, engine: 'local', warnings: [], ocr: {}, kind: {}, vis: {}, chunkNotes: {}, parts: {}, usage: {} };
  draft.kind ||= {};
  for (const s of ['cheap', 'strong', 'vision']) draft.usage[s] ||= { in: 0, out: 0 };
  log.info('pipeline', `${regenerate ? 'Regenerating' : draft.segments ? 'Resuming' : 'Starting'} notes for "${o.title || key}"`, { saved_transcript: !!draft.segments, scenes_done: Object.keys(draft.ocr || {}).length });
  const save = () => putDraft({ ...draft });
  const track = (slot) => (u) => { (draft.usage[slot] ||= { in: 0, out: 0 }).in += u?.in || 0; draft.usage[slot].out += u?.out || 0; };
  const aborted = () => { if (signal.aborted) throw new DOMException('Aborted', 'AbortError'); };
  // TEMP DEBUG (setting debugDump): every AI call and every step is recorded in the draft and saved with the
  // result as a plain-text dump (results page -> "Debug dump"). Remove after testing.
  const dbgOn = settings.debugDump !== false;
  if (dbgOn) draft.dbg ||= { steps: [], calls: [] };
  const mark = (step, note = '') => { if (dbgOn) draft.dbg.steps.push({ at: Math.round((Date.now() - tRun) / 1000), step, note: String(note).slice(0, 4000) }); };
  // Every AI call goes through here. `opts.pool` = the fallbacks of the slot (more Cheap AIs in order; the Strong AI's one
  // fallback): when a model fails, the next one answers. A model that is plainly unusable (401 / 403 / 404) is skipped for
  // the rest of the run. Only when ALL fail does the job pause (with the first model's error, so the dialog names it).
  const dead = new Set();
  const refKey = (p, m) => `${p?.id}|${m}`;
  const gen = async (provider, model, { pool: more = [], ...opts }) => {
    const task = /\[TASK:(\w+)\]/.exec(opts.prompt)?.[1] || '?';
    let chain = [{ provider, model }, ...more];
    const alive = chain.filter((c) => !dead.has(refKey(c.provider, c.model)));
    if (alive.length) chain = alive;
    let first = null;
    for (let i = 0; i < chain.length; i++) {
      const c = chain[i];
      const t0 = Date.now();
      try {
        const r = await generate(c.provider, c.model, opts);
        if (task === 'WRITE' || task === 'WRITE_CONTINUE') {
          (draft.writerReplies ||= []).push({ task, model: c.model, truncated: !!r.truncated, text: String(r.text || '') });
        }
        if (dbgOn) draft.dbg.calls.push({ task, model: c.model, ms: Date.now() - t0, images: opts.images?.length || 0, promptChars: opts.prompt.length, usage: r.usage || null, truncated: !!r.truncated, prompt: opts.prompt.slice(0, task === 'WRITE' || task === 'QUESTIONS' ? 1500 : 6000), reply: String(r.text || '').slice(0, 12000) });
        return { ...r, answeredBy: c.model, providerId: c.provider.id, imageCount: opts.images?.length || 0 };
      } catch (e) {
        if (dbgOn) draft.dbg.calls.push({ task, model: c.model, ms: Date.now() - t0, error: String(e?.message || e).slice(0, 500) });
        if (e?.name === 'AbortError') throw e;
        first ||= e;
        if ([401, 403, 404].includes(e?.status)) dead.add(refKey(c.provider, c.model));
        if (i < chain.length - 1) log.alert('pipeline', `${c.model} failed (${String(e?.message || e).slice(0, 140)}); trying ${chain[i + 1].model} instead`);
      }
    }
    throw first;
  };
  /**
   * gen() with ONE more try when the reply is unusable (no HTTP error: empty, not JSON, nothing readable).
   * A second unusable reply throws a plain error, and every caller turns it into a pause (the "model did not
   * work" window), exactly like an HTTP failure: no AI step is ever skipped silently.
   */
  const sure = async (provider, model, opts, valid = (r) => !!String(r?.text || '').trim()) => {
    for (let n = 0; ; n++) {
      let why;
      try {
        const r = await gen(provider, model, opts);
        if (valid(r)) return r;
        why = 'the reply was empty or could not be read';
      } catch (e) {
        if (e?.name === 'AbortError' || isHttpError(e)) throw e;
        why = e?.message || String(e);
      }
      if (n >= 1) throw new Error(`${model} gave an unusable answer twice (${why}).`);
      log.alert('pipeline', `${model}: unusable answer (${why}); asking once more`);
    }
  };
  /**
   * A model call failed in stage `id`: the job must PAUSE here (never carry on without the stage) so the user can
   * change the model or skip the stage. Returns the error to throw (a cancel stays a cancel).
   */
  let pauseLogged = false; // several parallel calls can fail together: say it once
  const stageFail = (id, ref, cause) => {
    if (cause?.name === 'AbortError' || cause?.name === 'StageError') return cause;
    const slot = STAGE[id].slot;
    const err = new StageError(id, ref, cause, { fallback: slot !== 'strong' && slot !== 'stt' && !(settings[slot]?.provider && settings[slot]?.model) });
    if (!pauseLogged) {
      pauseLogged = true;
      log.alert('pipeline', `Paused at "${STAGE[id].label}": ${err.info.slotLabel} (${err.info.model || 'no model'}) failed. ${err.info.reason}`, { status: err.info.status });
    }
    return err;
  };
  // stages the user chose to skip (after a model failed): remembered in the draft, so later resumes keep skipping them
  draft.skip ||= {};
  for (const id of o.skipStages || []) {
    const st = Object.values(STAGE).find((s) => s.skip === id);
    if (!st || draft.skip[id]) continue;
    draft.skip[id] = true;
    if (id === 'vision') draft.visionOff = true; // the old "vision is off" switch covers both vision stages
    warn(`Skipped as you chose: ${st.label}. ${st.skipNote}`);
  }
  // speech-to-text: a provider with a Whisper endpoint when one is chosen, else Whisper on this computer
  const cloud = sttRef(settings);
  const transcribe = async (audio, extra) => {
    if (!cloud) {
      const local = () => transcribeAudio(audio, { size: settings.asrModel, language: settings.asrLanguage, signal, progress, ...extra });
      if (!o.limitLocalAsr) return local();
      const report = extra.progress || progress;
      report('transcribe', null, 'Waiting for the local speech engine');
      return navigator.locks.request('vid2study:combined-local-asr', { signal }, local);
    }
    try {
      return await transcribeCloud(audio, { ref: cloud, language: settings.asrLanguage, signal, progress, ...extra });
    } catch (e) { throw stageFail('stt', cloud, e); }
  };
  let src;
  const getSource = () => (src ||= o.getSource());

  try {
    // ---------- 1. TRANSCRIPT ----------
    // (a function, because it can run side by side with the slide scan: see "1+2" below)
    const transcriptStep = async (progress) => {
    if (draft.segments) return;
    const tStep = Date.now();
    {
      let segs;
      if (o.transcript) {
        progress('transcribe', null, 'Reading captions');
        segs = parseTimestamped(o.transcript);
      } else if (mode === 'video') {
        // audio is read out of the file a few minutes at a time (no whole-file decode), then transcribed
        const audio = await openAudioSource(o.getStreamAudio ? await o.getStreamAudio() : await getSource(), progress);
        const engine = cloud ? 'cloud' : 'local';
        if (draft.asr && draft.asr.engine !== engine) delete draft.asr; // resume only with the same recogniser
        segs = await transcribe(audio, { progress, resume: draft.asr, onWindow: async (st) => { draft.asr = { ...st, engine }; await save(); } });
      }
      let listen = !segs && mode === 'youtube' && !o.getStreamAudio && !!o.getAudio;
      if (!segs && mode === 'youtube' && o.getStreamAudio) {
        // download-first: the audio stream was fetched before the pipeline started; Whisper here is
        // 10-50x real time instead of the ~2-4x playback speed of the listening path
        let audio = null;
        try {
          // a whole-file decode of a long download (12 h ~ 2.7 GB of samples) would run out of memory: listen instead
          audio = await openAudioSource(await o.getStreamAudio(), progress, o.getAudio ? { maxWholeBytes: 200 * 1048576 } : {});
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          if (!o.getAudio) throw new Error(`Could not read the downloaded audio (${e.message}). Turn off "YouTube: download the streams first" in Options to listen to the page instead.`);
          warn(`The downloaded audio could not be used (${e.message}), so the video was heard through the page player instead.`);
          listen = true; // a downloaded video, when there is one, is still used for the (seek-based) slide scan
        }
        if (audio) segs = await transcribe(audio, { progress });
      }
      if (!segs && listen) {
        // no captions: the page's own player is played muted (2-4x) and heard, and each 5-10 minute window is
        // transcribed as soon as it has been heard, so listening and transcribing overlap
        let listenPct = null, listenMsg = '', transMsg = '';
        const emit = () => progress('transcribe', listenPct, [listenMsg, transMsg].filter(Boolean).join(' · '));
        const heard = await o.getAudio((_s, p, t) => { listenPct = p; listenMsg = t; emit(); });
        draft.listened = heard.duration;
        [segs] = await Promise.all([
          transcribe(heard.audio, { mapTime: heard.mapTime, progress: (_s, _p, t) => { transMsg = t; emit(); } }),
          heard.finished
        ]);
      } else if (!segs) {
        throw new Error('No captions were found for this video and it cannot be heard from here. Use "Summarize from a file..." with the downloaded video.');
      }
      if (!o.transcript && segs.length && looksHallucinated(segs)) { // captions are written by people: never second-guessed
        // music or an unexpected language: Whisper invents stock phrases. Writing notes from them would only add noise.
        warn(`The speech recogniser heard only noise or made-up phrases (music, or a language other than "${settings.asrLanguage}"), so it was ignored. For songs or non-English videos set the spoken language to "auto" or "hi" in Options (with the Small model), or use a cloud speech-to-text provider.`);
        segs = [];
      }
      if (!segs.length) {
        // music, silence, or a language the speech model could not follow: the slides can still carry the notes
        segs = [{ start: 0, end: Math.max(60, draft.listened || 60), text: '(No speech was recognised in this video.)' }];
        warn('No speech was recognised, so the notes come from what is on screen. If the lecture is not in English, set the spoken language (or "auto") in Options.');
        draft.noSpeech = true;
      }
      draft.segments = segs;
      delete draft.asr;
      await save();
      if (!o.transcript) log.info('pipeline', `Transcript ready in ${took(tStep)} (${segs.length} lines)`);
    }
    };

    // ---------- 2. SCAN for slide changes, 3. OCR (each slide is read as soon as the scan finds it) ----------
    const visualStep = async (progress) => {
    const tStep = Date.now();
    const ocrQueue = limiter(OCR_WORKERS);
    const reading = [];
    let ocrDone = 0, ocrErr = null;
    const ocrOne = (f) => ocrQueue(async () => {
      aborted();
      if (draft.ocr[f.index]) return;
      const blob = await getFrame(`${key}/${f.filename}`);
      let kind = { kinds: [], primary: 'text', score: 0, blank: false };
      let ocr = { text: '', words: 0 };
      if (blob) {
        const o2 = await ocrImage(blob);
        ocr = { text: o2.text, words: o2.words, conf: o2.conf };
        // what is on it: code / table / diagram / formula / plain text (layout + pixels, no AI)
        try { kind = await analyzeFrame(blob, o2); } catch (e) { warn(`Could not classify a frame (${e.message}).`); }
      }
      draft.kind[f.index] = kind;
      draft.ocr[f.index] = ocr;
      if (++ocrDone % 10 === 0) await save();
    });
    try {
    if (mode !== 'text' && !o.audioOnly && !draft.scan) {
      await deleteFrames(key);
      // a new scan numbers its frames afresh: anything read from an earlier, unfinished scan is stale
      draft.ocr = {}; draft.kind = {}; draft.sel = {}; draft.vis = {};
      const yt = mode === 'youtube';
      try {
        // download-first mode: the scan seeks a hidden <video> over the downloaded stream (fast, O(k));
        // otherwise YouTube runs its page-player grabber and any other blob source is played locally
        const grabber = o.getStreamVideo
          ? blobGrabber(await o.getStreamVideo(), Number(settings.maxWidth) || 1600)
          : yt ? o.makeGrabber() : blobGrabber(await getSource(), Number(settings.maxWidth) || 1600);
        draft.scan = await scanScenes(grabber, {
          key, signal, progress,
          threshold: settings.sceneThreshold,
          sampleSeconds: yt ? Math.max(5, settings.sampleSeconds) : settings.sampleSeconds,
          maxSamples: yt ? 600 : 4000,
          maxScenes: Infinity,
          refine: 1,
          onFrame: (f) => reading.push(ocrOne(f).catch((e) => { ocrErr ||= e; }))
        });
      } catch (e) {
        if (e?.name === 'AbortError' || signal.aborted) throw e;
        warn(`Slides were not scanned (${e.message}). The notes use the transcript only.`);
        draft.scan = { frames: [], duration: 0, failed: true };
      }
      // slides found by the scan are already being read: wait for the last few
      const left = (draft.scan.frames || []).filter((f) => !draft.ocr[f.index]).length;
      if (left) progress('ocr', null, `Reading slide text (${left} left)`);
      await Promise.all(reading);
      if (ocrErr && (ocrErr.name === 'AbortError' || signal.aborted)) throw ocrErr;
      await save();
    }
    // frames not read yet (a resumed run, or a read that failed during the scan)
    const todo = (draft.scan?.frames || []).filter((f) => !draft.ocr[f.index]);
    if (todo.length) {
      let n = 0;
      progress('ocr', 0, `Reading slide text 0/${todo.length}`);
      const pending = todo.map((f) => ocrOne(f).then(() => { n++; progress('ocr', pct(n, todo.length), `Reading slide text ${n}/${todo.length}`); }));
      reading.push(...pending);
      await Promise.all(pending);
      await save();
    }
    } finally {
      await Promise.allSettled(reading);
      if (!o.keepOcr) await closeOcr();
    }
    if (draft.scan?.frames?.length) log.info('pipeline', `Slides scanned and read in ${took(tStep)} (${draft.scan.frames.length} slide changes)`);
    mark('scan', `${draft.scan?.frames?.length || 0} slide changes, ${draft.scan?.read ?? '-'} of ${draft.scan?.samples ?? '-'} samples read`);
    };

    // ---------- 1+2. run them: side by side when the slide scan does not need the page's player ----------
    const scanNeeded = mode !== 'text' && !o.audioOnly && !draft.scan;
    const overlap = !draft.segments && scanNeeded && (mode === 'video' || !!o.getStreamVideo);
    if (overlap) {
      // speech recognition and the video scan / OCR use different parts of the computer, so together they take
      // about as long as the slower one instead of the sum of both
      const live = { a: null, b: null };
      const show = () => {
        const { a, b } = live;
        const lead = a || b;
        if (lead) progress(lead.s, lead.p, [a?.t, b?.t].filter(Boolean).join(' · '));
      };
      let first = null;
      const branch = (p, which) => p
        .then(() => { live[which] = null; show(); })
        .catch((e) => { if (!first) first = e; runCtl.abort(); throw e; });
      await Promise.allSettled([
        branch(transcriptStep((s, p, t) => { live.a = { s, p, t }; show(); }), 'a'),
        branch(visualStep((s, p, t) => { live.b = { s, p, t }; show(); }), 'b')
      ]);
      if (jobSignal.aborted) throw new DOMException('Aborted', 'AbortError');
      if (first) throw first;
    } else {
      await transcriptStep(progress);
      await visualStep(progress);
    }
    if (o.evidenceOnly) {
      await save();
      return { evidence: draft };
    }
    // lossless code trim (fillers, stutters, sound tags, recognition loops): same timestamps, fewer tokens
    const trimmed = groupByVideo(draft.segments || [], segment => segment.start).map(trimSegments)
      .reduce((all, part) => ({ segs: all.segs.concat(part.segs), before: all.before + part.before, after: all.after + part.after }), { segs: [], before: 0, after: 0 });
    const segs = trimmed.segs;
    if (draft.segments?.length) log.info('pipeline', `Transcript trimmed (no AI): about ${trimmed.before} -> ${trimmed.after} tokens`);
    const frames = draft.scan?.frames || [];
    const duration = Math.max(transcriptDuration(segs), draft.scan?.duration || 0);

    // ---------- 3b. one entry per distinct screen (animated builds / repeats merged) ----------
    const kindOf = (f) => draft.kind[f.index] || { kinds: [], primary: 'text', score: 0, blank: false };
    const withOcr = frames.map((f) => ({ ...f, ...kindOf(f), words: draft.ocr[f.index]?.words || 0, conf: draft.ocr[f.index]?.conf, text: draft.ocr[f.index]?.text || '' }));
    // text-only merging first: a picture-based merge (handwriting build-ups, flip-backs) can wrongly join two different
    // illustrations, so it only runs for technical videos, once the video type is known (below)
    const dedupe = boards => groupByVideo(withOcr, frame => frame.t).flatMap(group => mergeRepeats(group, settings.ocrMinWords, { boards }));
    let distinct = dedupe(false);
    if (frames.length) {
      const sc = draft.scan;
      log.info('pipeline', `Frames 1/6 scan: ${sc.read ?? sc.samples ?? '?'} of ${sc.samples ?? '?'} sample times read, ${frames.length} screen changes saved`);
      log.info('pipeline', `Frames 2/6 dedup: ${distinct.length} distinct kept, ${frames.length - distinct.length} merged away (build-ups, repeats, flip-backs), ${distinct.filter((f) => f.blank).length} blank`);
    }

    // ---------- 3c. TRANSCRIPT AI: ONE model, always used when there are frames to judge. For the whole transcript
    // (in parts of up to 60 min) it writes (1) a brief summary, sent with all the frames to the screening call, and
    // (2) a shortened but detailed timeline with timestamps, sent to the describing calls. With its FIRST call go up to
    // 6 frames spread from the start to the end of the video, and it also gives (3) the video type (technical or
    // not), which decides what a valuable frame is (charts and code, or pictures of people, places and events).
    // The writer never sees these: it always gets the raw trimmed transcript. ----------
    let brief = '', timeline = '';
    const writerUsesWebInterface = settings.webSearch && webInterface(strong.provider);
    const nominateResearch = settings.webSearch && !writerUsesWebInterface;
    const fullLines = formatSegments(segs);
    {
      const words = `${segs.map((s) => s.text).join(' ')}\n${frames.map((f) => draft.ocr[f.index]?.text || '').join('\n')}`;
      const guess = () => isTechnical(words, draft.code || detectCode(frames.map((f) => draft.ocr[f.index]?.text || ''), segs.map((s) => s.text).join(' ')));
      // runs for the vision calls (a video with frames) AND for the references (any video: the Transcript AI also finds every source)
      const wanted = !draft.skip.digest && estimateTokens(fullLines) > 40 && ((distinct.length && settings.useVision && !draft.visionOff) || settings.researchReferences !== false);
      // text OCR read off the frames (a slide, a credits card: "Lesson by ...", a title, a quote): where the speech names no source, the screen may
      const onScreenFor = (from, to) => {
        const seen = new Set();
        const out = [];
        for (const f of frames) {
          const o2 = draft.ocr[f.index];
          if (!o2 || o2.words < 3 || !(o2.conf >= 70) || f.t < from || f.t > to + 20) continue;
          const one = o2.text.replace(/\s+/g, ' ').trim().slice(0, 200);
          if (one.length < 8 || seen.has(one)) continue;
          seen.add(one);
          out.push(`[${fmtTime(f.t)}] ${one}`);
        }
        return out.join('\n').slice(0, 2500);
      };
      if (!wanted) {
        if (draft.technical === undefined) draft.technical = guess(); // nothing to judge or the step was skipped: guess from the words
      } else {
        const ref = slotRef(settings, 'digest');
        const parts = chunkSegments(segs, { targetSec: 60 * 60 });
        draft.digest ||= {};
        const todoD = parts.filter((c) => draft.digest[c.index] === undefined);
        const askPart = async (c, withFrames) => {
          const lines = formatSegments(c.segments);
          const first = c.index === parts[0].index && draft.videoKind === undefined; // the first call also decides the video type
          let pics = [];
          if (first && withFrames && !draft.digestNoImages) {
            const pool6 = distinct.filter((x) => x.filename && !x.blank);
            const spread = pool6.length <= 6 ? pool6 : Array.from({ length: 6 }, (_, i) => pool6[Math.floor(((i + 0.5) * pool6.length) / 6)]);
            for (const f of spread) { // 6 frames from the start to the end of the video: a sample of what it shows
              try { pics.push({ mime: 'image/jpeg', b64: await jpegB64(await getFrame(`${key}/${f.filename}`), 768) }); } catch { /* unreadable frame: skip */ }
            }
          }
          const go = (images) => sure(ref.provider, ref.model, {
            pool: ref.pool, prompt: transcriptPrompt({ title: o.title, course, lines, span: `${fmtTime(c.start)}-${fmtTime(c.end)}`, images: images.length, withType: first, nominateResearch, onScreen: onScreenFor(c.start, c.end), videos: videos.map((video, index) => ({ ...video, number: index + 1 })).filter(video => video.start < c.end && video.end > c.start) }),
            images, maxTokens: Math.min(24000, 4200 + Math.ceil(estimateTokens(lines) * 0.6)), temperature: 0.1, signal, onWait
          }, (x) => String(x.text || '').trim().length > 20);
          let r;
          try { r = await go(pics); } catch (e) {
            if (e?.name === 'AbortError') throw e;
            // the model does not take images (found out now, at run time): ask again with the transcript only
            if (pics.length && (e?.status === 400 || /image|vision|multimodal|modalit|content type|image_url|not support/i.test(e?.message || ''))) {
              draft.digestNoImages = true; pics = [];
              log.info('pipeline', `${ref.model} does not accept images: the video type is decided from the transcript only`);
              r = await go([]);
            } else throw e;
          }
          track('cheap')(r.usage);
          const d = parseDigest(r.text, lines);
          if (first) {
            draft.videoKind = d.type || null;
            if (draft.technical === undefined) draft.technical = d.type ? d.type.technical : guess();
            log.info('pipeline', `Video type (${ref.model}${pics.length ? `, ${pics.length} frames` : ', transcript only'}): ${draft.technical ? 'technical' : 'not technical'}${d.type ? `, ${d.type.kind || '?'}${d.type.subject ? `, ${d.type.subject}` : ''}` : ' (guessed: the reply had no type)'}`);
          }
          const checklist = d.checklist.filter(item => item.time >= Math.floor(c.start) && item.time <= Math.ceil(c.end)
            && (videos.length ? videos[item.video - 1] && withinVideo(videos[item.video - 1], item.time) : item.video === 1));
          draft.digest[c.index] = { brief: d.brief, lines: d.lines, refs: d.refs || [], gaps: d.gaps, checklist };
        };
        if (todoD.length) {
          progress('vision', null, `Reading the transcript (${parts.length - todoD.length}/${parts.length})`);
          let bad = false;
          try {
            // the first part first (it carries the frames and decides the type), the others side by side
            if (todoD.some((c) => c.index === parts[0].index)) { await askPart(parts[0], true); await save(); }
            const errs = await pool(todoD.filter((c) => c.index !== parts[0].index), 3, async (c) => {
              if (bad) return;
              try { await askPart(c, false); } catch (e) { bad = true; throw e; }
              await save();
            });
            if (errs.length) throw errs[0];
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            throw stageFail('digest', ref, e);
          }
        }
        const dg = (c) => draft.digest[c.index] || { brief: '', lines: formatSegments(c.segments) };
        brief = clip(parts.map((c) => (dg(c).brief ? `[${fmtTime(c.start)}-${fmtTime(c.end)}] ${dg(c).brief.replace(/\s*\n\s*/g, ' ')}` : '')).filter(Boolean).join('\n'), 7000);
        timeline = parts.map((c) => dg(c).lines).join('\n');
        draft.refs = collectRefs(parts.flatMap((c) => dg(c).refs || []), []); // every source the speech or the screen names (quotes are added later)
        if (draft.technical === undefined) draft.technical = guess();
        mark('digest', `Transcript AI ${ref.model}: ${parts.length} part(s), type ${draft.technical ? 'technical' : 'not technical'}${draft.videoKind?.kind ? ` (${draft.videoKind.kind})` : ''}; transcript ~${estimateTokens(fullLines)} tokens -> brief ${estimateTokens(brief)} + timeline ${estimateTokens(timeline)} tokens (the writer still gets the full trimmed transcript)\nBRIEF:\n${brief}`);
      }
      await save();
    }

    if (draft.technical === true) distinct = dedupe(true);

    // ---------- 4. VISION ----------
    // Optimistic: flagged frames always qualify (however many words they hold); low-text frames qualify too.
    // Flagged ones go first when the per-lecture cap is reached.
    // 4a. SELECT: the vision model judges every candidate (each already its scene's settled, sharpest moment):
    // blur, transitions, half-drawn animations, logos and talking heads are rejected; the rest get a caption
    // written from the picture alone. Its verdict decides what can become a figure.
    draft.sel ||= {};
    const vision = slotRef(settings, 'vision');
    // speech from a frame's time until the next frame (at most 60 s), for the vision call
    const speechAt = (t, next) => {
      const end = Math.min(next ?? t + 45, t + 60);
      const video = videos.find(item => withinVideo(item, t));
      return clip((segs || []).filter((s) => (!video || withinVideo(video, s.start)) && s.end >= t - 5 && s.start <= end).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim(), 600);
    };
    const judge = async (list, label) => {
      const todo = list.filter((f) => draft.sel[f.index] === undefined && !f.blank);
      if (!settings.useVision || draft.visionOff || !todo.length) return;
      const batches = [];
      for (const group of groupByVideo(todo, frame => frame.t)) {
        for (let i = 0; i < group.length; i += SELECT_BATCH) batches.push(group.slice(i, i + SELECT_BATCH));
      }
      let done = 0, bad = false;
      progress('vision', 0, `${label} 0/${todo.length}`);
      const errs = await pool(batches, 2, async (batch) => {
        if (draft.visionOff || bad) return;
        try {
          const images = [];
          const readable = [];
          for (const f of batch) {
            try { images.push({ mime: 'image/jpeg', b64: await jpegB64(await getFrame(`${key}/${f.filename}`), 1024) }); readable.push(f); }
            catch { warnOnce('A few saved frames could not be read back and were left out.'); }
          }
          if (!readable.length) { done += batch.length; return; }
          batch = readable;
          // what is being SAID while each frame is up, in order: lets the model name and explain what it sees
          const frames = batch.map((f, i) => ({ id: `F${f.index}`, time: fmtTime(f.shot ?? f.t), speech: speechAt(f.t, batch[i + 1]?.t) }));
          const r = await sure(vision.provider, vision.model, { pool: vision.pool,
            prompt: selectPrompt({ title: o.title, frames, technical: draft.technical, kind: draft.videoKind?.kind || '' }),
            images, json: true, maxTokens: Math.min(16000, 800 + 700 * batch.length), temperature: 0.1, signal, onWait: (t) => progress('vision', null, t)
          }, (x) => Object.keys(readVerdicts(x.text, batch)).length > 0);
          track('vision')(r.usage);
          const verdicts = readVerdicts(r.text, batch);
          Object.assign(draft.sel, verdicts);
          // the same reply already holds the exact transcription / full description: no second vision call
          for (const [n, v] of Object.entries(verdicts)) if (v.keep && v.detail && draft.vis[n] === undefined) draft.vis[n] = v.detail;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          bad = true;
          throw stageFail('select', vision, e);
        }
        done += batch.length;
        progress('vision', pct(done, todo.length), `${label} ${Math.min(done, todo.length)}/${todo.length}`);
      });
      await save(); // what was judged before the failure is kept
      if (errs.length) throw errs[0];
    };
    // 4. VISION in stages, with very few calls:
    //   (0) optional Transcript summary AI, BEFORE the vision calls: a brief summary of the whole transcript and a
    //       shortened-but-detailed timeline with timestamps. (Only for the vision calls: the writer always gets the
    //       raw trimmed transcript.)
    //   (1) SCREEN: rank distinct frames in bounded calls. A ranking cannot delete source evidence.
    //   (2) DESCRIBE: review the same frames at higher quality. Attach the highest-ranked pictures to the
    //       writer request and include OCR and descriptions from the full reviewed set.
    // Pictures go inline in the request (~20 MB limit), so a stage splits into more calls when they do not fit.
    if (settings.useVision && !draft.visionOff && frames.length) {
      const LOW_W = 512, HIGH_W = 1280, MIN_W = 480; // 512 px keeps layout, boxes, big text and faces; small text is read in stage 2
      const MAX_REQ = requestBudget(settings, vision.provider); // base64 characters of pictures per request
      const browserImageCap = [vision, ...(vision.pool || [])].some(ref => ref.provider.type === 'geminiweb') ? 10 : Infinity;
      const kindOfVideo = draft.videoKind?.kind || '';
      const vOpts = { signal, onWait: (t) => progress('vision', null, t) };
      const jpegs = async (list, width, q, label) => {
        const out = new Array(list.length);
        let n = 0;
        await pool(list.map((f, i) => ({ f, i })), 4, async ({ f, i }) => {
          try { const b64 = await jpegB64(await getFrame(`${key}/${f.filename}`), width, q, `F${f.index}`); out[i] = { f, b64, bytes: b64.length }; }
          catch { warnOnce('A few saved frames could not be read back and were left out.'); }
          if (++n % 40 === 0) progress('vision', pct(n, list.length), `${label} ${n}/${list.length}`);
        });
        return out.filter(Boolean);
      };
      draft.described ||= {};
      // how long each distinct screen stays up (until the next one): a settled, finished picture stays; a state in the middle of an
      // animation is gone after a second or two. It breaks ties when the code has to cut frames, and the vision AI is told it.
      distinct.forEach((f, i) => { f.dwell = Math.max(0, Math.min(600, (distinct[i + 1]?.t ?? duration) - f.t)); });
      const reviewable = distinct.filter((f) => f.filename && !f.blank);
      const todo1 = reviewable.filter((f) => draft.sel[f.index] === undefined);
      const pending2 = () => reviewable.filter((f) => !draft.described[f.index] && draft.vis[f.index] === undefined);
      if (todo1.length) mark('code-screening', `${todo1.length} distinct nonblank frames queued for visual review`);

      // ---- 1. SCREEN everything at low quality ----
      if (todo1.length) {
        const t1 = Date.now();
        const small = await jpegs(todo1, LOW_W, 0.55, 'Preparing small copies');
        const batches = groupByVideo(small, item => item.f.t).flatMap(group => packByBudget(group, { maxCount: Math.min(3000, settings.screenImages, browserImageCap), maxBytes: MAX_REQ }));
        const capAll = Math.max(10, Math.ceil((duration / 3600) * settings.screenKeepPerHour));
        let done = 0, bad = false;
        const reviewed = { rescued: [], swapped: [] };
        progress('vision', 0, `Screening ${small.length} frames (${batches.length} call${batches.length === 1 ? '' : 's'})`);
        const errs = await pool(batches, 2, async (batch) => {
          if (bad) return;
          const share = batch.length / Math.max(1, small.length);
          const cap = Math.max(5, Math.ceil(capAll * share));
          const minKeep = Math.min(batch.length, Math.max(3, Math.ceil(10 * share)));
          const ids = batch.map((x) => x.f.index);
          try {
            const video = videos.find(item => withinVideo(item, batch[0].f.t));
            const r = await sure(vision.provider, vision.model, { pool: vision.pool,
              prompt: screenPrompt({ title: video?.title || o.title, frames: batch.map((x) => ({ id: `F${x.f.index}`, time: fmtTime(x.f.shot ?? x.f.t), dwell: x.f.dwell })), technical: draft.technical, kind: kindOfVideo, cap, minKeep, summary: video ? '' : brief }),
              images: batch.map((x) => ({ mime: 'image/jpeg', b64: x.b64, label: `F${x.f.index} at ${fmtTime(x.f.shot ?? x.f.t)}${onScreen(x.f.dwell)}:` })), json: true,
              maxTokens: Math.min(60000, 2000 + 50 * cap + 8 * batch.length), temperature: 0.1, ...vOpts
            }, (x) => { const j = parseReply(x.text); return Array.isArray(j?.keep) || Array.isArray(j); });
            track('vision')(r.usage);
            const res = readScreen(r.text, ids);
            const keptIds = Object.keys(res.keep).map(Number);
            if (keptIds.length > cap * 1.25) { // the model ignored the limit: keep the highest-scoring ones
              const top = new Set(keptIds.sort((a, b) => res.keep[b].info - res.keep[a].info || a - b).slice(0, Math.ceil(cap * 1.25)));
              for (const n of keptIds) if (!top.has(n)) { delete res.keep[n]; res.drop[n] = 'over the keep limit'; }
            }
            // the code reviews the model's drops (a drop must name a kept replacement; the settled copy wins a swap)
            const fx = fixScreen(res, Object.fromEntries(batch.map((x) => [x.f.index, { t: x.f.t, dwell: x.f.dwell, h: x.f.h }])));
            res.keep = fx.keep; res.drop = fx.drop;
            reviewed.rescued.push(...fx.rescued); reviewed.swapped.push(...fx.swapped);
            for (const x of batch) {
              const n = x.f.index, k = res.keep[n];
              draft.sel[n] = k
                ? { keep: true, kind: k.kind, info: k.info, caption: k.label, text: '', detail: '', reason: '', screened: true }
                : { keep: false, kind: 'other', info: 0, caption: '', text: '', detail: '', reason: res.drop[n] || 'dropped when screening', screened: true };
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            bad = true;
            throw stageFail('select', vision, e);
          }
          done += batch.length;
          await save();
          progress('vision', pct(done, small.length), `Screening frames ${Math.min(done, small.length)}/${small.length}`);
        });
        await save();
        if (errs.length) throw errs[0];
        const keptN = todo1.filter((f) => draft.sel[f.index]?.keep).length;
        const why = {};
        for (const f of todo1) { const s = draft.sel[f.index]; if (s && !s.keep) { const k = /same as|dup/i.test(s.reason) ? 'duplicate' : String(s.reason).toLowerCase().slice(0, 24); why[k] = (why[k] || 0) + 1; } }
        const mb = (small.reduce((s, x) => s + x.bytes, 0) * 0.75 / 1e6).toFixed(1);
        log.info('pipeline', `Frames 3/6 screening (vision, ${batches.length} call${batches.length === 1 ? '' : 's'}, ${small.length} small copies, ${mb} MB${brief ? ', with the transcript summary' : ''}): ${keptN} kept, ${todo1.length - keptN} dropped${todo1.length - keptN ? ` (${Object.entries(why).sort((a, b) => b[1] - a[1]).map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}, ${took(t1)}`);
        if (reviewed.rescued.length || reviewed.swapped.length) log.info('pipeline', `Screening review (code): ${reviewed.rescued.length} drop(s) rescued because no kept frame replaces them (${reviewed.rescued.map((n) => 'F' + n).join(' ')}), ${reviewed.swapped.length} repeat(s) swapped to the longer-lasting copy`);
        mark('screen', `${small.length} frames -> ${keptN} kept in ${batches.length} call(s); the code rescued ${reviewed.rescued.length} unsupported drop(s) and swapped ${reviewed.swapped.length} repeat(s)`);
      }

      // ---- 2. DESCRIBE all distinct nonblank frames ----
      const todo2 = pending2();
      if (todo2.length) {
        const t2 = Date.now();
        // the transcript every call gets: the digest timeline when there is one, else the full trimmed transcript
        let ctx = timeline || fullLines;
        if (estimateTokens(ctx) > 350000) ctx = formatSegments(fitTranscript(parseTimestamped(ctx), 350000)); // never more than the model's context
        const pack = images => groupByVideo(images, item => item.f.t).flatMap(group => splitEven(group, Math.max(describeCalls(group.length), Math.ceil(group.length / browserImageCap))));
        let width = HIGH_W;
        let big = await jpegs(todo2, width, 0.8, 'Preparing sharp copies');
        let batches = pack(big);
        // the pictures must fit a request: make them smaller rather than adding calls (never below MIN_W)
        for (let tryN = 0; tryN < 4; tryN++) {
          const worst = Math.max(...batches.map((g) => g.reduce((s, x) => s + x.bytes, 0)));
          if (worst <= MAX_REQ || width <= MIN_W) break;
          width = Math.max(MIN_W, Math.floor(width * Math.sqrt((MAX_REQ * 0.95) / worst)));
          big = await jpegs(todo2, width, 0.75, 'Making the copies smaller');
          batches = pack(big);
        }
        batches = batches.flatMap(batch => packByBudget(batch, { maxBytes: MAX_REQ }));
        const top = Math.min(Number(settings.writerImages ?? 10) || 10, 20);
        const perCall = Math.max(...batches.map((g) => g.length));
        const words = describeWords(perCall); // the more frames in a call, the shorter each description (the output must fit)
        let done = 0, bad = false;
        progress('vision', 0, `Ranking and describing ${big.length} frames (${batches.length} call${batches.length === 1 ? '' : 's'})`);
        const errs = await pool(batches, 2, async (batch) => {
          if (bad) return;
          const frames2 = batch.map((x) => ({ id: `F${x.f.index}`, time: fmtTime(x.f.shot ?? x.f.t), dwell: x.f.dwell }));
          const index = batch.map((x) => ({ index: x.f.index }));
          try {
            const video = videos.find(item => withinVideo(item, batch[0].f.t));
            const r = await sure(vision.provider, vision.model, { pool: vision.pool,
              prompt: describePrompt({ title: video?.title || o.title, frames: frames2, transcript: video ? formatSegments(segs.filter(segment => withinVideo(video, segment.start))) : ctx, technical: draft.technical, kind: kindOfVideo, top, detailWords: words, summarised: !video && !!timeline }),
              images: batch.map((x) => ({ mime: 'image/jpeg', b64: x.b64, label: `F${x.f.index} at ${fmtTime(x.f.shot ?? x.f.t)}${onScreen(x.f.dwell)}:` })), json: true,
              maxTokens: Math.min(64000, 1500 + batch.length * (Math.ceil(words * 1.7) + 150)), temperature: 0.2, ...vOpts
            }, (x) => Object.keys(readVerdicts(x.text, index, { force: true })).length > 0);
            track('vision')(r.usage);
            for (const [n, v] of Object.entries(readVerdicts(r.text, index, { force: true }))) {
              const old = draft.sel[n] || {};
              draft.sel[n] = { ...old, ...v, kind: v.kind !== 'other' ? v.kind : old.kind || 'other', caption: v.caption || old.caption || '' };
              draft.vis[n] = v.detail; // '' for a plain text slide: the describe pass below must not ask again
              draft.described[n] = true;
            }
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            bad = true;
            throw stageFail('describe', vision, e);
          }
          done += batch.length;
          await save();
          progress('vision', pct(done, big.length), `Ranking and describing ${Math.min(done, big.length)}/${big.length}`);
        });
        await save();
        if (errs.length) throw errs[0];
        const have = todo2.filter((f) => draft.described[f.index]).length;
        log.info('pipeline', `Frames 4/6 rank + describe (vision, ${batches.length} call${batches.length === 1 ? '' : 's'}, ${big.length} sharp copies at ${width} px, ${timeline ? 'summarised timeline' : 'full trimmed transcript'} ~${estimateTokens(ctx)} tokens, up to ${words} words each): ${have} described, ${big.length - have} not answered; ${took(t2)}`);
        mark('describe', `${big.length} frames -> ${have} ranked and described in ${batches.length} call(s)`);
      }
    }
    const sel = (f) => draft.sel[f.index];
    const kept = distinct.filter((f) => !f.blank);
    for (const f of kept) {
      const j = sel(f);
      if (!j) continue;
      // Keep the classification evidence alongside the model's chosen caption kind.
      f.tag = j.kind;
      const detected = ['code', 'table', 'formula'].includes(j.kind) ? [j.kind] : ['chart', 'diagram', 'schematic', 'patent', 'map'].includes(j.kind) ? ['diagram'] : [];
      f.kinds = [...new Set([...detected, ...f.kinds])];
      f.presentation = j.presentation;
      f.primary = f.kinds[0] || 'text';
      f.score = j.info / 10;
      f.caption = j.caption;
    }
    // priority of every kept frame (time on screen = until the next distinct screen)
    distinct.forEach((f, i) => { f.dwell = Math.max(0, (distinct[i + 1]?.t ?? duration) - f.t); });
    for (const f of kept) f.priority = framePriority(f, { technical: draft.technical });
    // the pictures each write part will get (same parts as the writer uses): the top frames by priority
    const picCap = Math.min(Number(settings.writerImages ?? 10) || 0, strong.provider?.type === 'geminiweb' ? 10 : 20);
    const planMin = duration / 60;
    const partStarts = planGroups(chunkSegments(segs, { targetSec: settings.chunkMinutes * 60, sceneTimes: frames.map((f) => f.t) }), {
      minutes: planMin, fullText: planMin > settings.shortVideoMinutes && !!settings.writeFullTranscript, detail: DETAIL[settings.detail] ? settings.detail : 'standard'
    }).map((g) => g[0].start);
    const toWriter = new Set(pictureSet(kept.filter((f) => !f.blank && f.tag !== 'quote'), partStarts, picCap).map((f) => f.index));
    if (kept.length) {
      const ranked = [...kept].sort((a, b) => b.priority - a.priority);
      log.info('pipeline', `Frames 5/6 ranked: ${ranked.filter((f) => f.priority >= IMPORTANT_PRIORITY).length} important (priority >= ${IMPORTANT_PRIORITY}) of ${kept.length}; ${toWriter.size} go to the Strong AI as pictures (${partStarts.length || 1} part(s), up to ${picCap} each)`, { top: ranked.slice(0, 15).map((f) => `F${f.index} ${fmtTime(f.t)} ${f.tag || f.kinds?.[0] || 'text'} ${f.priority}${toWriter.has(f.index) ? ' -> Strong AI' : ''}`) });
    }
    if (Object.keys(draft.sel).length) {
      const why = {};
      for (const f of distinct.filter((x) => sel(x)?.keep === false)) { const r = /same as/i.test(sel(f).reason) ? 'duplicate' : (sel(f).reason || 'low value').toLowerCase().slice(0, 30); why[r] = (why[r] || 0) + 1; }
      const judged = distinct.filter((f) => sel(f)).length;
      log.info('pipeline', `Frames 4/6 vision: ${judged} reviewed, ${kept.length} nonblank captures retained for evidence`, { lowerRanked: why });
    }

    // 4b. VISION details for code, tables and equations (exact transcription); other frames already have
    // the selector's caption. Frames the selector did not see follow the old rules (flagged / little text).
    if (settings.useVision && !draft.visionOff) {
      const needs = (f) => (sel(f) ? ['code', 'table', 'formula'].includes(sel(f).kind) : (f.kinds.length || f.words < settings.ocrMinWords))
        || (!toWriter.has(f.index) && f.priority >= IMPORTANT_PRIORITY); // important, but the writer will not see the picture
      const cands = kept
        .filter((f) => draft.vis[f.index] === undefined && !f.blank && (needs(f) || draft.sel[f.index]?.screened))
        .map((f) => ({ f, rank: f.priority }));
      const picks = cands.map(({ f }) => f);
      if (picks.length) log.info('pipeline', `Describe pass: using individual replies for ${picks.length} frame(s) missing a batch description`);
      if (picks.length) {
        let done = 0, bad = false;
        progress('vision', 0, `Looking at ${picks.length} code / table / diagram frame${picks.length === 1 ? '' : 's'}`);
        const errs = await pool(picks, 3, async (f) => {
          if (draft.visionOff || bad) return;
          try {
            let b64;
            try { b64 = await jpegB64(await getFrame(`${key}/${f.filename}`), f.kinds.some((k) => k === 'code' || k === 'table') ? 1600 : 1024); }
            catch { warnOnce('A few saved frames could not be read back and were left out.'); done++; return; }
            const r = await sure(vision.provider, vision.model, { pool: vision.pool,
              prompt: visionPrompt(f.kinds), images: [{ mime: 'image/jpeg', b64 }], maxTokens: f.kinds.some((k) => k === 'code' || k === 'table') ? 900 : 450,
              temperature: 0.2, signal, onWait: (t) => progress('vision', null, t)
            });
            track('vision')(r.usage);
            const txt = r.text.trim();
            draft.vis[f.index] = /^SKIP\b/i.test(txt) ? '' : txt;
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            bad = true;
            throw stageFail('describe', vision, e);
          }
          done++;
          progress('vision', pct(done, picks.length), `Describing diagram frames ${done}/${picks.length}`);
        });
        await save(); // the frames described before the failure are kept
        if (errs.length) throw errs[0];
      }
    }

    if (Object.keys(draft.sel).length || Object.keys(draft.vis).length) log.info('pipeline', `Figures checked by the vision model (${took(tRun)} since start)`);
    mark('vision', `${Object.keys(draft.sel).length} frames judged, ${kept.length} kept, ${Object.values(draft.vis).filter(Boolean).length} with an exact transcription / description`);

    // ---------- 5. ALIGN and CHUNK ----------
    const speech = segs.map((s) => s.text).join(' ');
    const code = draft.code || (draft.code = detectCode(frames.map((f) => draft.ocr[f.index]?.text || ''), speech));
    const textCap = code.likely ? 1500 : 700;
    // what the writer sees for each distinct screen. A code/table frame described by the vision model
    // drops its (garbled) OCR text; a flagged frame is kept even when it has no text at all.
    const screen = [];
    const quotes = []; // a quote / key statement shown on screen: its WORDS matter, its picture does not (a text-only line + a Quote callout)
    for (const f of kept) {
      const heavy = f.kinds.some((k) => k === 'code' || k === 'table');
      const j = sel(f);
      const vision = draft.vis[f.index] || f.caption || '';
      // the selector reads text off the picture better than OCR does (titles, labels on a chart)
      const text = heavy && vision ? '' : j?.text ? clip(j.text, textCap) : f.words >= 3 ? clip(f.text, textCap) : '';
      if (!text && !vision && !f.kinds.length && !j?.presentation) continue;
      if (f.tag === 'quote' && quoteKeys(text).length >= 3) { quotes.push({ t: f.t, index: f.index, text }); continue; }
      // judged: important when it teaches something (info >= 5); else when the pixel classifier flagged it
      // The 10 attached pictures (toWriter) are handled exactly as before: an important one the writer leaves out is still added. Every
      // OTHER frame is an extra: forced into the notes only for the kinds that must never be left out (code, tables, formulas, charts,
      // diagrams, maps); a picture, a scene or a text slide is shown only when the Strong AI lists it in its figure list.
      const forced = toWriter.has(f.index) || ALWAYS_SHOWN.includes(f.tag) || f.kinds.some((k) => ['code', 'table', 'formula', 'diagram'].includes(k));
      screen.push({ ...f, text, vision, ocrTitle: f.text.split(/\r?\n/, 2).join(' '),
        important: forced && (Number.isFinite(f.priority) ? f.priority : framePriority(f)) >= IMPORTANT_PRIORITY });
    }
    // few informative frames (a vlog, a song): add some key moments spread over the video (never a rejected one)
    {
      const lenMin = Math.max(transcriptDuration(segs), draft.scan?.duration || 0) / 60;
      const want = Math.min(8, Math.max(3, Math.round(lenMin / 2)));
      for (const f of pickScenes(kept.filter((x) => x.tag !== 'quote'), screen, lenMin * 60, want)) {
        screen.push({ ...f, text: f.words >= 3 ? clip(f.text, textCap) : '', vision: draft.vis[f.index] || f.caption || '', kinds: ['scene'], important: true, scene: true });
      }
      screen.sort((a, b) => a.t - b.t);
    }
    if (draft.noSpeech && !screen.length) throw new Error('No speech and no readable slides were found in this video, so there is nothing to write notes from. For a non-English lecture, set the spoken language (or "auto") in Options.');
    const chunks = assignFrames(chunkSegments(segs, { targetSec: settings.chunkMinutes * 60, sceneTimes: frames.map((f) => f.t) }), screen);
    const minutes = duration / 60;
    const short = minutes <= settings.shortVideoMinutes;
    // long videos: by default the strong model still reads the FULL transcript (in 2-3 parts), so no detail is
    // lost to a cheap summary; with writeFullTranscript off, the cheap model makes bullets first (map-reduce)
    const fullText = !short && !!settings.writeFullTranscript;
    const direct = short || fullText || o.singleWrite;
    const detail = DETAIL[settings.detail] ? settings.detail : 'standard';

    // frames the vision model dropped (a less complete step of a board, a variant of a kept slide) never become
    // figures, but what the cheap model read off them still reaches the writer as a text-only screen line
    for (const q of quotes) { // quotes shown on screen reach the writer as text, at their time
      const c = chunks[chunkIndexFor(chunks, q.t)];
      (c.extra ||= []).push({ t: q.t, line: `[${fmtTime(q.t)}] ON SCREEN (quote) text: ${clip(q.text.replace(/\s+/g, ' ').trim(), 600)}` });
    }
    // Also what OCR read off a frame that was dropped as a "title" or an "unfinished" state: a caption such as "WORLD WAR II" or
    // "BERLIN" is information even when the picture is not worth a figure. (Not for repeats: their text is on the kept copy;
    // not for blur, logos, credits, the opening and closing seconds, or text OCR was unsure of.)
    const screenIds = new Set(screen.map(frame => frame.index));
    for (const f of distinct) {
      const v = sel(f);
      if (!v || v.keep || screenIds.has(f.index)) continue;
      const why = String(v.reason || '');
      if (/outro|credit|logo|blank|talking|blur|transition|sponsor|cut by the code|over the keep|dup|same as|replaced/i.test(why)) continue;
      const o2 = draft.ocr[f.index];
      const ocrText = o2 && o2.words >= 1 && o2.conf >= 60 && f.t > 6 && f.t < duration - 30 ? o2.text : '';
      const said = (v.detail || ocrText || '').replace(/\s+/g, ' ').trim();
      if (said.replace(/[^A-Za-z0-9]/g, '').length < 3) continue;
      const c = chunks[chunkIndexFor(chunks, f.t)];
      (c.extra ||= []).push({ t: f.t, line: `[${fmtTime(f.t)}] ON SCREEN (no figure: ${why || 'a variant of a nearby frame'}) ${v.detail ? clip(said, 900) : `text: ${clip(said, 200)}`}` });
    }

    // ---------- 5b. TRIM (very long lectures): cheap model compresses the speech, losslessly ----------
    // The code trim (fillers, stutters, sound tags, loops) already ran. Only when the speech is still more than
    // `trimTokens` does each chunk go to the cheap model, which may only drop repetition and rambling, never a
    // fact, number, example, step or term. A reply that lost too much is ignored (the code-trimmed text is kept).
    const speechTokens = estimateTokens(segs.map((s) => s.text).join(' '));
    const trimAt = settings.trimTokens == null ? 40000 : Number(settings.trimTokens);
    mark('transcript', `${segs.length} lines after the code trim, about ${speechTokens} tokens (cheap trim above ${trimAt || 'never'})`);
    if (!videos.length && direct && trimAt > 0 && speechTokens > trimAt && !draft.skip.trim) {
      draft.trim ||= {};
      const todo = chunks.filter((c) => draft.trim[c.index] === undefined);
      let done = chunks.length - todo.length, bad = false;
      if (todo.length) progress('notes', pct(done, chunks.length), `Tightening the transcript ${done}/${chunks.length}`);
      const errs = await pool(todo, 3, async (c) => {
        if (bad) return;
        const lines = formatSegments(c.segments);
        try {
          const r = await sure(cheap.provider, cheap.model, { pool: cheap.pool, prompt: trimPrompt(lines), maxTokens: Math.min(16000, estimateTokens(lines) + 500), temperature: 0, signal, onWait });
          track('cheap')(r.usage);
          const out = parseTimestamped(unfence(r.text));
          const kept = out.map((s) => s.text).join(' ').length / Math.max(1, lines.length);
          draft.trim[c.index] = out.length && kept >= 0.45 && !r.truncated ? out : null;
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          bad = true;
          throw stageFail('trim', cheap, e);
        }
        done++;
        progress('notes', pct(done, chunks.length), `Tightening the transcript ${done}/${chunks.length}`);
        await save();
      });
      await save();
      if (errs.length) throw errs[0];
    }
    if (!videos.length && draft.trim) for (const c of chunks) if (draft.trim[c.index]?.length) c.segments = draft.trim[c.index];

    // ---------- 6a. MAP (long videos): cheap model, bullets per chunk ----------
    if (!direct) {
      const todo = chunks.filter((c) => draft.chunkNotes[c.index] == null);
      let done = chunks.length - todo.length;
      if (todo.length) progress('notes', pct(done, chunks.length), `Summarising part ${done}/${chunks.length}`);
      let bad = false;
      const errors = await pool(todo, 3, async (c) => {
        if (bad) return;
        let r;
        try {
          r = await gen(cheap.provider, cheap.model, { pool: cheap.pool,
            prompt: chunkPrompt({ block: interleave(c), from: fmtTime(c.start), to: fmtTime(c.end), total: chunks.length, index: c.index }),
            maxTokens: 1800, temperature: 0.2, level: settings.thinkingLevel, signal, onWait
          });
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          bad = true;
          throw stageFail('map', cheap, e);
        }
        track('cheap')(r.usage);
        draft.chunkNotes[c.index] = unfence(r.text);
        done++;
        progress('notes', pct(done, chunks.length), `Summarising part ${done}/${chunks.length}`);
        await save();
      });
      if (errors.length) {
        await save(); // the parts already summarised are kept
        throw errors[0];
      }
    }

    // ---------- 6b. REDUCE / WRITE: strong model ----------
    const groups = o.singleWrite ? [chunks] : planGroups(chunks, { minutes, fullText, detail });
    const full = groups.length === 1;
    // the cap on figures is a safety net, not a target: the Strong AI chooses (its figure list), so a short video is never held to the per-hour
    // number while it has more described frames than that
    const totalFrames = Math.min(120, Math.max(Math.ceil((Number(settings.maxFrames) || 15) * Math.max(1, minutes / 60)), kept.filter((f) => f.tag !== 'quote').length));
    const byIndex = new Map(screen.map((f) => [f.index, f]));

    // the sources the Transcript AI found that fall in a write part's time range: the writer must give each its own Source callout
    const partRefs = (g) => {
      if (settings.researchReferences === false) return [];
      const t0 = g[0].start - 5, t1 = g[g.length - 1].end + 5;
      const secs = (at) => String(at).split(':').reduce((a, v) => a * 60 + Number(v), 0);
      return (draft.refs || []).filter((r) => r.kind !== 'quote' && (!r.at || (secs(r.at) >= t0 && secs(r.at) <= t1)));
    };
    const researchGaps = nominateResearch && !draft.skip.digest
      ? Object.values(draft.digest || {}).flatMap(part => part.gaps || []) : [];
    const checklist = draft.skip.digest ? [] : [...new Map(Object.values(draft.digest || {}).flatMap(part => part.checklist || [])
      .map(item => [`${item.video}:${item.anchors.join('|')}`, item])).values()];
    const screenTopics = new Map();
    for (const frame of screen) {
      const title = sel(frame)?.topic;
      if (!title || title.length < 5) continue;
      const video = videos.findIndex(source => withinVideo(source, frame.t)) + 1;
      const key = video + ':' + title.toLowerCase();
      if (!screenTopics.has(key)) screenTopics.set(key, { title, video, time: frame.t, at: fmtTime(frame.t), item: 'Explain the taught slide topic ' + title });
    }
    const inGroup = (group, item) => groups.length === 1 || (item.time >= group[0].start && item.time < group.at(-1).end);
    const checklistFor = group => checklist.filter(item => inGroup(group, item));
    const slideTopicsFor = group => [...screenTopics.values()].filter(item => inGroup(group, item));
    const checkNotes = (group, markdown) => {
      const core = full ? splitFull(markdown).notes : markdown;
      const perVideo = new Map();
      if (videos.length) byVideoSections(core, videos, (text, video) => { perVideo.set(video, text); return text; });
      const notesFor = item => videos.length ? perVideo.get(videos[item.video - 1]) || '' : core;
      const gaps = [
        ...emptyTopics(core).map(item => ({ ...item, video: videos.findIndex(video => withinVideo(video, item.time)) + 1 })),
        ...unmatchedCoverage(checklistFor(group), notesFor),
        ...missingScreenTopics(slideTopicsFor(group), notesFor)
      ];
      return gaps;
    };
    if (draft.technical === undefined) draft.technical = isTechnical(`${speech}\n${frames.map((f) => draft.ocr[f.index]?.text || '').join('\n')}`, code);
    const technical = draft.technical;
    const todoG = groups.map((_, i) => i).filter((i) => draft.parts[i] == null || draft.missingWriterDetails?.[i]);
    let gDone = groups.length - todoG.length;
    const tWrite = Date.now();
    let writeBad = false;
    // parts are independent: up to three are written at a time (long lectures only; most have a single part)
    const writeErrs = await pool(todoG, 3, async (gi) => {
      if (writeBad) return;
      aborted();
      const g = groups[gi];
      const gMin = (g[g.length - 1].end - g[0].start) / 60;
      progress('notes', pct(gDone, groups.length), groups.length > 1 ? `Writing notes ${gDone + 1}/${groups.length}` : 'Writing the notes');
      const chunkNotes = direct ? undefined
        : g.map((c) => `--- ${fmtTime(c.start)}-${fmtTime(c.end)} ---\n${draft.chunkNotes[c.index]}`).join('\n\n');
      const body = videos.length ? combinedWriterEvidence(g, draft.ocr, videos) : writerEvidence(g, draft.ocr, chunkNotes);
      let writerWeb = '';
      if (researchGaps.length && draft.parts[gi] == null) {
        const from = g[0].start, to = g[g.length - 1].end;
        const terms = researchGaps.filter(gap => gap.start >= from && gap.start < to).map(gap => gap.text);
        if (terms.length) {
          draft.gapWeb ||= {};
          if (draft.gapWeb[gi] === undefined) {
            draft.gapWeb[gi] = await lectureTopicContext(terms, draft.videoKind?.subject || course, { signal });
            aborted();
            await save();
          }
          writerWeb = draft.gapWeb[gi];
        }
      }
      const ids = direct
        ? g.flatMap((c) => c.screen.map((f) => f.index))
        : [...new Set(g.flatMap((c) => [
          ...[...String(draft.chunkNotes[c.index]).matchAll(/\bF(\d+)\b/g)].map((m) => Number(m[1])),
          ...c.screen.filter((f) => f.important).map((f) => f.index) // flagged frames are always offered
        ]))].filter((n) => byIndex.has(n));
      // the frames themselves, as pictures (the writer sees what it places and explains); Gemini web takes 10 per message
      const picCap = Math.min(Number(settings.writerImages ?? 10) || 0, strong.provider?.type === 'geminiweb' ? 10 : 20);
      const picks = pickPictures(ids.map((n) => byIndex.get(n)).filter(Boolean), picCap);
      const images = [];
      if (!draft.noWriterImages) for (const f of picks) {
        try { const b64 = await jpegB64(await getFrame(`${key}/${f.filename}`), 1024); if (b64) images.push({ f, img: { mime: 'image/jpeg', b64 } }); } catch { /* a frame that cannot be read is just not attached */ }
      }
      const ask = (maxTokens, pics = images) => sure(strong.provider, strong.model, { pool: strong.pool,
        prompt: writePrompt({
          body, title: o.title, course, detail, full, part: gi + 1, parts: groups.length,
          code, search: writerUsesWebInterface, web: writerWeb, refs: partRefs(g), frameIds: ids.length ? ids.map((n) => `F${n}${byIndex.get(n).kinds.length ? `[${byIndex.get(n).kinds.join(',')}]` : ''}`).join(', ') : '',
          pictures: pics.map(({ f }) => ({ id: f.index, time: fmtTime(f.shot ?? f.t), video: videos.find(item => withinVideo(item, f.t))?.title })), technical, decide: true, videos: o.videos
        }),
        images: pics.map((x) => x.img),
        maxTokens, temperature: 0.5, level: settings.thinkingLevel, signal, onWait
      });
      const budget = writeTokens(gMin, detail, full);
      const unrepresented = markdown => {
        if (!o.singleWrite) return [];
        const starts = topicList(markdown).filter(topic => topic.time).map(topic => topic.time.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0));
        return o.videos.filter(video => !starts.some(at => at >= video.start && at < video.end));
      };
      const askOrPause = async (n) => {
        try { return await ask(n, draft.noWriterImages ? [] : images); } catch (e) {
          if (e?.name === 'AbortError') throw e;
          // a text-only model refuses pictures: write without them (and stop sending them for this video)
          if (images.length && !draft.noWriterImages && (e?.status === 400 || /image|vision|multimodal|modalit|content type|image_url|not support/i.test(e?.message || ''))) {
            draft.noWriterImages = true;
            warn(`The Strong AI (${strong.model}) did not accept pictures, so the notes were written from the frame descriptions only.`);
            try { return await ask(n, []); } catch (e2) { if (e2?.name === 'AbortError') throw e2; writeBad = true; throw stageFail('write', strong, e2); }
          }
          writeBad = true; throw stageFail('write', strong, e);
        }
      };
      if (draft.parts[gi] == null) {
        const r = await askOrPause(budget);
        track('strong')(r.usage);
        // the figure list is read first (it may sit before or after the NEEDS line), then the NEEDS line; each listed frame becomes a marker in its place
        const metadata = /^<!--LECTURE (\{[^\n]+\})-->$/m.exec(r.text);
        if (metadata) {
          try {
            const fields = JSON.parse(metadata[1]);
            const evidence = [speech, ...Object.values(draft.ocr).map(o => o.text)].join(' ').replace(/\s+/g, ' ').toLowerCase();
            draft.lectureMeta ||= {};
            for (const field of ['code','instructor','institution']) {
              const value = fields[field];
              if (typeof value === 'string' && value.trim() && evidence.includes(value.trim().toLowerCase())) draft.lectureMeta[field] = value.trim();
            }
          } catch { /* Missing metadata is omitted. */ }
        }
        const coverage = takeWriterCoverage(unfence(r.text));
        const picked = takeFigs(coverage.md.replace(/^<!--LECTURE .*?-->\s*$/gm, ''));
        const { md: written, needs } = takeNeeds(picked.md);
        (draft.writers ||= {})[gi] = r.answeredBy;
        (draft.writerInputs ||= {})[gi] = {
          provider: r.providerId, model: r.answeredBy, session: r.session,
          images: images.slice(0, r.imageCount).map(x => x.f.index)
        };
        const prefix = completeWriterPrefix(written);
        draft.parts[gi] = normaliseMarkers(applyFigs(prefix.text, picked.figs));
        (draft.needs ||= {})[gi] = needs; // the writer's own call: practice questions / maths needed?
        const truncated = !!r.truncated || prefix.incomplete;
        (draft.coverage ||= {})[gi] = { marker: coverage.marker, truncated };
        const missingVideos = unrepresented(draft.parts[gi]);
        const gaps = checkNotes(g, draft.parts[gi]);
        if (coverage.marker !== 'no' || truncated || missingVideos.length || gaps.length) {
          (draft.missingWriterDetails ||= {})[gi] = true;
          await save();
          const empty = emptyTopics(full ? splitFull(draft.parts[gi]).notes : draft.parts[gi]);
          if (o.singleWrite && !truncated && !coverage.missing && !empty.length) {
            const reason = missingVideos.length ? `Missing video sections: ${missingVideos.map(video => video.title).join(', ')}.`
              : gaps.length ? `${gaps.length} coverage checklist item(s) need review.`
              : 'The batch writer omitted a valid MISSING_DETAILS line.';
            throw stageFail('write', strong, new Error(`${reason} Resume to check the saved draft and recover any missing details.`));
          }
        }
      }
      if (draft.missingWriterDetails?.[gi]) {
        const writer = draft.writerInputs[gi];
        const useNewWriter = o.singleWrite && (strong.provider.id !== writer.provider || strong.model !== writer.model);
        const provider = useNewWriter ? strong.provider : settings.providers.find(p => p.id === writer.provider);
        const model = useNewWriter ? strong.model : writer.model;
        const session = !useNewWriter && RESUMABLE_WRITERS.has(provider?.type) ? writer.session : undefined;
        const written = draft.parts[gi];
        const missingVideos = unrepresented(written);
        const gaps = checkNotes(g, written);
        const usedIds = new Set([...written.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(match => Number(match[1])));
        const moreFrames = ids.filter(id => !usedIds.has(id)).map(id => `F${id}`).join(', ');
        progress('notes', null, 'Writing missing lecture details');
        try {
          if (!provider) throw new Error('The original writer provider is unavailable.');
          const attached = images.filter(image => writer.images.includes(image.f.index));
          const imageList = attached.map(({ f }, i) => `Image ${i + 1} = F${f.index} at ${fmtTime(f.shot ?? f.t)}`);
          const getMore = conversation => gen(provider, model, {
            prompt: writerContinuationPrompt({
              evidence: conversation ? '' : [body, imageList.join('\n')].filter(Boolean).join('\n\n'), written, frameIds: moreFrames,
              requirements: [
                missingVideos.length && 'Add the missing timestamped sections for: ' + missingVideos.map(video => `${video.time} — ${video.title}`).join('; '),
                gaps.length && 'Check these unmatched items against the saved notes and evidence. Add only details that are actually missing and supported. Keep each detail in its own video:\n' + gaps.map(item => `- ${item.video ? 'Video ' + item.video + ' at ' : ''}${item.at}: ${item.item}`).join('\n'),
                draft.coverage?.[gi]?.truncated && 'The saved reply hit its output limit. Continue from its cutoff and complete any missing evidence through the end of the lecture.',
                draft.coverage?.[gi]?.marker === 'unconfirmed' && 'The previous reply omitted the required final line. Check the existing notes against the lecture. If no detail is missing, reply with only MISSING_DETAILS: NO.'
              ]
            }),
            session: conversation, images: conversation ? [] : attached.map(item => item.img),
            maxTokens: budget, level: settings.thinkingLevel, temperature: 0.4, signal, onWait, retries: 0
          });
          let reply;
          try { reply = await getMore(session); } catch (error) {
            if (!session || signal.aborted || ![400, 404, 409].includes(error.status)) throw error;
            reply = await getMore();
          }
          track('strong')(reply.usage);
          const addition = takeWriterCoverage(unfence(reply.text));
          const prefix = completeWriterPrefix(addition.md);
          addition.md = prefix.text;
          if (addition.md && !/^###\s/m.test(addition.md)) throw new Error('The writer did not return recognisable topic sections.');
          if (!addition.md && addition.marker !== 'no') throw new Error('The writer returned neither missing details nor a valid completion line.');
          if (addition.md) {
            draft.parts[gi] = mergeWriterDetails(written, normaliseMarkers(addition.md));
            // The new material could contain formulas even when the initial reply contained none.
            draft.needs[gi] = { ...draft.needs[gi], math: null };
          }
          if (reply.session) writer.session = reply.session;
          (draft.coverage ||= {})[gi] = { marker: addition.marker, truncated: !!reply.truncated || prefix.incomplete };
          if (addition.missing || reply.truncated || prefix.incomplete) warn('The writer still reports missing details after the follow-up.');
          else if (addition.marker === 'unconfirmed') warn('The follow-up omitted a valid MISSING_DETAILS line. Coverage remains unconfirmed.');
        } catch (error) {
          if (signal.aborted || error?.name === 'AbortError') throw error;
          warn('Could not add the missing lecture details: ' + (error.message || error));
        }
        const stillMissing = unrepresented(draft.parts[gi]);
        if (stillMissing.length) warn('Coverage could not be confirmed for: ' + stillMissing.map(video => video.title).join(', '));
        delete draft.missingWriterDetails[gi];
      }
      gDone++;
      await save();
    });
    if (writeErrs.length) { await save(); throw writeErrs[0]; }
    if (todoG.length) log.info('pipeline', `Notes written in ${took(tWrite)} (${groups.length} part${groups.length === 1 ? '' : 's'})`);
    mark('write', `${groups.length} part(s) written`);

    const said = Object.values(draft.needs || {}).filter(Boolean);
    const wants = (k) => (said.some((n) => n[k] === true) ? true : said.length && said.every((n) => n[k] === false) ? false : null);
    const needMath = wants('math');
    const qStyle = said.find((n) => n.style)?.style || null, qSubject = said.find((n) => n.subject)?.subject || null;
    if (said.length) log.info('pipeline', `Writer says: maths ${needMath === false ? 'none' : 'present'}`);

    // math lint, per topic section, AI rewrite only for sections that need it (and only when the writer says the notes hold maths)
    if (!draft.linted) {
      const sectionsOf = (md) => md.split(/^(?=###\s)/m);
      const jobs = [];
      const fixed = groups.map((_, gi) => sectionsOf(draft.parts[gi]).map((sec) => {
        const l = lintSection(sec);
        if (l.needsAi) jobs.push({ gi, sec, l });
        return l.md;
      }));
      if (jobs.length && !draft.skip.math && needMath !== false) {
        progress('final', null, 'Fixing maths');
        const idx = new Map();
        // ALL broken sections in one cheap call (a very long lecture: a few calls of ~15k characters each)
        const batches = [];
        let curB = [], size = 0;
        for (const j of jobs) {
          if (curB.length && size + j.l.md.length > 15000) { batches.push(curB); curB = []; size = 0; }
          curB.push(j); size += j.l.md.length;
        }
        if (curB.length) batches.push(curB);
        for (const b of batches) {
          try {
            const r = await sure(cheap.provider, cheap.model, { pool: cheap.pool,
              prompt: fixMathBatchPrompt(b.map((j) => j.l.md)), maxTokens: Math.min(16000, 600 + Math.ceil(b.reduce((s, j) => s + j.l.md.length, 0) / 3)), temperature: 0.2, signal, onWait
            });
            track('cheap')(r.usage);
            readMathBatch(r.text, b.length).forEach((md, k) => {
              const j = b[k];
              if (!md) return; // missing from the reply: that section keeps its own lint fixes
              const again = lintSection(unfence(md));
              idx.set(j.sec, again.problems.length <= j.l.problems.length ? again.md : j.l.md);
            });
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            throw stageFail('math', cheap, e);
          }
        }
        groups.forEach((_, gi) => {
          const secs = sectionsOf(draft.parts[gi]);
          fixed[gi] = secs.map((sec, k) => idx.get(sec) ?? fixed[gi][k]);
        });
      }
      groups.forEach((_, gi) => { draft.parts[gi] = fixed[gi].map((x) => x.trim()).join('\n\n'); });
      draft.linted = true;
      await save();
    }

    // overview: from the "full" reply when it has one, else one small call over the topic outline
    let overview = '', extra = [], notes;
    if (full) ({ overview, notes, extra } = splitFull(draft.parts[0]));
    else notes = groups.map((_, gi) => draft.parts[gi].replace(/^##\s+Detailed notes\s*$/gim, '')).join('\n\n');
    if (videos.length && topicList(notes).some(topic => !topic.time || !videos.some(video => withinVideo(video, markdownVideoTime(topic.time))))) {
      warn('Some topic headings lacked a valid video timestamp. Their text is kept apart from the verified video sections.');
    }
    if (!overview) {
      if (!draft.final) {
        progress('final', null, 'Finishing');
        const outline = notes.split(/^(?=###\s)/m).filter((b) => b.startsWith('###')).map((b, i) => {
          const title = b.split('\n')[0].replace(/^###\s+/, '');
          const big = /\*\*Big idea:\*\*\s*(.+)/.exec(b)?.[1] || '';
          return `${i + 1}. ${title}: ${clip(big, 200)}`;
        }).join('\n');
        const topicOverview = `## Overview\n\n${topicList(notes).map((t) => `- ${t.title}`).join('\n')}`;
        if (o.singleWrite || draft.skip.overview) draft.final = topicOverview;
        else {
          try {
            const r = await sure(cheap.provider, cheap.model, { pool: cheap.pool, prompt: finalPrompt({ title: o.title, outline }), maxTokens: 600, temperature: 0.4, signal, onWait });
            track('cheap')(r.usage);
            draft.final = unfence(r.text);
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            throw stageFail('overview', cheap, e);
          }
        }
        await save();
      }
      overview = splitFinal(draft.final)[0].replace(/^##\s+Overview\s*/i, '').trim();
    }

    // every runnable code block gets its output (mandatory): the writer usually adds it; the rest are filled in one small call
    const noOut = codeWithoutOutput(notes);
    if (noOut.length) {
      if (!draft.outputs) {
        progress('final', null, `Adding the output of ${noOut.length} code example${noOut.length === 1 ? '' : 's'}`);
        if (draft.skip.outputs) draft.outputs = []; // skipped by the user
        else {
          try {
            const r = await sure(cheap.provider, cheap.model, { pool: cheap.pool, prompt: outputsPrompt(noOut), json: true, maxTokens: 300 + 150 * noOut.length, temperature: 0, signal, onWait }, (x) => { try { return !!parseJsonLoose(x.text); } catch { return false; } });
            track('cheap')(r.usage);
            const j = parseJsonLoose(r.text) || {};
            draft.outputs = noOut.map((_, i) => String(j[i + 1] ?? j[String(i + 1)] ?? ''));
          } catch (e) {
            if (e?.name === 'AbortError') throw e;
            throw stageFail('outputs', cheap, e);
          }
        }
        await save();
      }
      notes = addOutputs(notes, noOut, draft.outputs);
    }

    // The digest already extracted the bibliography. Render it without a second model call.
    const lectureRefs = collectRefs(draft.refs || [], quotes);
    const referencesMd = settings.researchReferences !== false ? formatReferences(lectureRefs) : '';

    // ---------- 7. PRACTICE QUESTIONS: strong model, one call over the finished notes ----------
    // Hard exam-level problems (IIT / GATE for theory and maths, LeetCode / interview level for code) with
    // worked answers, per topic. Web results (searched by the extension, or by the model itself) point it at
    // real question styles for the domain.
    const supplementalHeading = /^##[ \t]+Supplemental practice\b[^\n]*$/im;
    const validQuestions = text => {
      const core = String(text || '').split(supplementalHeading)[0];
      return /\*\*Q\d+\./m.test(core) && /\*\*Answer:\*\*/i.test(core);
    };
    if (!o.deferPractice && settings.practiceQuestions && (!draft.questions || !validQuestions(draft.questions))) {
      if (draft.skip.questions) draft.questions = '';
      else {
        progress('final', null, 'Writing practice questions');
        const paper = slotRef(settings, 'practice');
        const paperSearch = !!settings.webSearch && !!searchTool(paper.provider, paper.model);
        const paperInterfaceSearch = settings.webSearch && webInterface(paper.provider);
        const prefetchPractice = settings.webSearch && !paperSearch && !paperInterfaceSearch;
        const outline = notes.replace(/^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm, block =>
          /^[ \t]*>[ \t]*\**(?:\[EXTRA\]|Extra\b|Explanation:|Analogy\b|Background\b)/i.test(block) ? '' : block);
        if (prefetchPractice && draft.practiceWeb === undefined) {
          draft.practiceWeb = await practiceContext(topicList(notes).map((t) => t.title), { course, code: code.likely, style: qStyle, subject: qSubject, signal });
        }
        const referenceWeb = prefetchPractice
          ? await practiceReferenceContext(lectureRefs, qSubject || course, { signal }) : '';
        const research = { web: prefetchPractice ? draft.practiceWeb || '' : '', search: paperSearch || paperInterfaceSearch,
          lectureRefs: formatReferences(lectureRefs).replace(/^## References\s*/, 'LECTURE BIBLIOGRAPHY\n'), referenceWeb };
        const writer = groups.length === 1 ? draft.writerInputs?.[0] : null;
        const session = direct && writer?.provider === paper.provider.id && writer.model === paper.model
          && ['geminiweb'].includes(paper.provider.type) ? writer.session : null;
        const prompt = questionsPrompt({ title: o.title, course, outline, code, style: qStyle, subject: qSubject, ...research });
        const config = { maxTokens: Math.min(16000, 2500 + topicList(notes).length * 900 + (lectureRefs.length && (research.search || referenceWeb) ? 1800 : 0)), temperature: 0.4, level: settings.thinkingLevel, signal, onWait, search: paperSearch };
        try {
          let r;
          if (session) {
            try {
              const followUp = questionsPrompt({
                title: o.title, course, outline: topicList(notes).map(topic => topic.title).join('\n'),
                code, style: qStyle, subject: qSubject, ...research
              });
              r = await gen(paper.provider, paper.model, {
                ...config, prompt: `${followUp}\nUse the transcript, images, and notes from this conversation.`, session, retries: 0
              });
              if (!validQuestions(r.text) || r.truncated) r = undefined;
            } catch (error) {
              if (signal.aborted || error?.name === 'AbortError') throw error;
              log.alert('pipeline', 'Practice follow-up failed. Retrying with the lecture sources.');
            }
          }
          if (!r) {
            const ids = [...new Set(Object.values(draft.writerInputs || {}).flatMap(part => part.images || []))];
            const images = [];
            for (const id of ids) {
              const f = byIndex.get(id);
              if (!f?.filename) continue;
              const b64 = await jpegB64(await getFrame(`${key}/${f.filename}`), 1024);
              if (b64) images.push({ mime: 'image/jpeg', b64, label: `F${id} at ${fmtTime(f.t)}` });
            }
            const source = formatSegments(draft.segments || []);
            r = await sure(paper.provider, paper.model, { ...config, pool: paper.pool,
              prompt: `${prompt}\n\nRAW LECTURE TRANSCRIPT\n${source}\n\nATTACHED FRAMES IN ORDER\n${images.map(x => x.label).join('\n')}`, images
            }, answer => validQuestions(answer.text));
          }
          track('practice')(r.usage);
          const [core, supplemental = ''] = unfence(r.text).trim().split(supplementalHeading);
          const extras = lectureRefs.length && (research.search || referenceWeb)
            ? supplemental.split(/(?=^\*\*Q\d+\.)/m).filter(item => {
              const source = /^\s*(?:\*\*)?Source:(?:\*\*)?[^\n]*?(https?:\/\/[^\s)>\]]+)/im.exec(item)?.[1];
              return /^\*\*Q\d+\.\*\*\s*\[Supplemental\]/.test(item) && /\*\*Answer:\*\*/i.test(item)
                && source && (research.search || referenceWeb.includes(`(${source})`));
            }).slice(0, 3) : [];
          draft.questions = extras.length
            ? `${core.trim()}\n\n## Supplemental practice (web sources)\n\nThese questions extend the lecture topics using the cited sources.\n\n${extras.map(item => item.trim()).join('\n\n')}`
            : core.trim();
          if (r.truncated) warn('The practice questions were cut off at the output limit of the model; the last ones may be missing.');
        } catch (e) {
          if (e?.name === 'AbortError') throw e;
          throw stageFail('questions', paper, e);
        }
      }
      await save();
    }
    const practice = !o.deferPractice && settings.practiceQuestions && draft.questions
      ? (/^##\s/m.test(draft.questions) ? draft.questions : `## Practice questions\n\n${draft.questions}`)
      : '';

    // ---------- assemble ----------
    const link = (f) => (mode === 'youtube' ? `https://www.youtube.com/watch?v=${o.youtubeId}&t=${Math.floor(f.timestamp_seconds)}s` : null);
    const used = []; // frames the notes actually show, in order
    // Which figures reach the notes (and the PDF)? Not left to the writer alone: every frame flagged as
    // code / table / diagram / formula is guaranteed a place (the writer's placement wins, else it is
    // inserted under the topic being spoken at that time); the writer's other picks fill what is left.
    notes = notes.replace(/^[ \t>]*\[\[VISUAL:[^\]]*\]\][ \t]*\n?/gm, ''); // a marker a model still writes
    // every quote shown on screen is in the notes, as its own Quote callout, whatever the writer did with it
    const processSources = (text, operation) => videos.length ? byVideoSections(text, videos, operation) : operation(text);
    notes = processSources(notes, (text, video) => ensureQuotes(text, quotes.filter(q => (!video || withinVideo(video, q.t)) && !text.includes(q.text))));
    notes = processSources(notes, (block, video) => block.replace(/^> \*\*Quote:\*\* (.+)$/gm, (line, text) => {
      const match = quotes.find(q => (!video || withinVideo(video, q.t)) && text.includes(splitQuote(q.text).body));
      if (!match) return line;
      const body = splitQuote(match.text).body;
      const raw = String(draft.ocr[match.index]?.text || '').replace(/\s+/g, ' ');
      if (!raw.includes(body)) return '> **Watch Out:** Frame F' + match.index + ' was read as: ' + text + ' Check the original slide for exact wording.';
      const definition = /\b(?:defined as|is defined|definition|is an? |means )/i.test(body) && !splitQuote(match.text).who;
      return '> **Slide ' + (definition ? 'definition' : 'quote') + ':** “' + body + '”' + (splitQuote(match.text).who ? ' — '+splitQuote(match.text).who : '');
    }));
    // end cards (credits, channel logo, "view full lesson") are never figures, whoever chose them
    notes = normaliseMarkers(notes);
    const redundant = new Set();
    notes = notes.replace(REDUNDANT_FRAMES, (line, ids) => {
      for (const match of ids.matchAll(/F(\d+)/gi)) redundant.add(Number(match[1]));
      return '';
    });
    const outro = new Set(screen.filter(f => {
      const video = videos.find(item => withinVideo(item, f.t));
      return isOutro(draft.ocr[f.index]?.text, f.t - (video?.start || 0), video ? video.end - video.start : duration);
    }).map(f => f.index));
    if (outro.size) {
      log.info('pipeline', `Left out ${outro.size} end-card frame(s) (credits / logo)`);
      notes = notes.replace(/\[\[FRAME:(\d+)\]\]\n?/g, (m, n) => (outro.has(Number(n)) ? '' : m));
    }
    const screenOk = outro.size ? screen.filter((f) => !outro.has(f.index)) : screen;
    const writerPlaced = new Set([...notes.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => Number(m[1])));
    const sourceFigures = video => video ? screenOk.filter(frame => withinVideo(video, frame.t)) : screenOk;
    const sourceSpeech = video => video ? segs.filter(segment => withinVideo(video, segment.start)) : segs;
    notes = processSources(notes, (text, video) => {
      const frames = sourceFigures(video);
      if (!video) return chooseFigures(text, frames, byIndex, totalFrames, segs);
      const valid = new Set(frames.map(frame => frame.index));
      const clean = text.replace(/\[\[FRAME:(\d+)\]\]/g, (marker, id) => valid.has(Number(id)) ? marker : '');
      const present = new Set([...clean.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(match => Number(match[1])));
      const misplaced = frames.filter(frame => writerPlaced.has(frame.index) && !present.has(frame.index));
      const repaired = insertFrames(clean, misplaced, video.end, sourceSpeech(video));
      return chooseFigures(repaired, frames, byIndex, totalFrames, sourceSpeech(video));
    });
    const LABEL = {
      code: 'Code', table: 'Table', formula: 'Equations', diagram: 'Diagram', chart: 'Chart', schematic: 'Schematic',
      patent: 'Patent drawing', map: 'Map', slide: 'Slide', quote: 'Quote', photo: 'Photo', document: 'Document'
    };
    const saidAt = (t) => sourceSpeech(videos.find(video => withinVideo(video, t))).filter((s) => s.end >= t - 4 && s.start <= t + 6).map((s) => s.text).join(' ').replace(/\s+/g, ' ').trim();
    // A frame the writer placed that the selector never saw (long videos) is judged now; a rejected one
    // (blurred, a transition, half drawn) is taken out, whoever chose it.
    {
      const shown = [...new Set([...notes.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => Number(m[1])))].map((n) => byIndex.get(n)).filter(Boolean);
      await judge(shown, 'Checking the chosen figures');
      notes = notes.replace(/\[\[FRAME:(\d+)\]\]/g, (m, n) => {
        const verdict = draft.sel[Number(n)];
        return verdict?.keep === false && verdict.presentation !== 'visual' ? '' : m;
      });
    }
    // one figure per scene, and a figure for every section that has a fitting frame (never a rejected one)
    notes = processSources(notes, (text, video) => {
      const frames = sourceFigures(video).filter(f => draft.sel[f.index]?.keep !== false || f.presentation === 'visual');
      const speech = sourceSpeech(video), end = video?.end ?? duration;
      const balanced = balanceFigures(text, frames, byIndex, { budget: totalFrames, duration: end, minGap: duration > 120 ? 20 : 8, segs: speech });
      const marked = new Set([...balanced.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(m => Number(m[1])));
      const selected = insertFrames(balanced, frames.filter(f => f.filename && !marked.has(f.index) &&
        (f.presentation === 'visual' || ALWAYS_SHOWN.includes(f.tag) || f.kinds.some(k => ['schematic','diagram','table','chart','handwriting'].includes(k)))), end, speech);
      return placeTopicFigures(selected, frames, end, speech, redundant);
    });
    // Captions describe only what is visible in the picture (the selector never hears the narration).
    // Without a vision model the caption says honestly that it is the narration at that moment.
    const describe = (f, label) => {
      const j = draft.sel[f.index];
      if (f.primary === 'code' || f.primary === 'table') {
        const does = /```[\s\S]*?```\s*([^\n`]+)/.exec(f.vision || '')?.[1]; // the vision model's "what it does" line
        if (does) return clipSentence(does.trim(), 220);
      }
      if (j?.caption) return clipSentence(j.caption, 300);
      if (f.vision && !(f.primary === 'code' || f.primary === 'table')) return clipSentence(f.vision.replace(/\s+/g, ' ').trim(), 260);
      if (f.primary === 'code' || f.primary === 'table') return `${label} shown on screen.`;
      const said = saidAt(f.t);
      if (said) return `Narration at ${fmtTime(f.t)}: “${clipSentence(said, 200)}”`;
      return f.text && f.words >= 5 ? clipSentence(f.text.replace(/\s+/g, ' '), 200) : `On screen at ${fmtTime(f.t)}.`;
    };
    notes = notes.replace(/\[\[FRAME:(\d+)\]\]/g, (_m, n) => {
      const f = byIndex.get(Number(n));
      if (!f || used.some((u) => u.index === f.index)) return '';
      const time = fmtTime(f.t);
      const j = draft.sel[f.index];
      const label = (j && LABEL[j.kind]) || (f.scene ? 'Scene' : LABEL[f.primary] || (f.vision ? 'Diagram' : 'Slide'));
      used.push({
        index: f.index, figure: used.length + 1, timestamp_seconds: f.t, time, filename: f.filename,
        type: j?.kind || (f.scene ? 'scene' : LABEL[f.primary] ? f.primary : f.vision ? 'diagram' : 'slide'), title: `${label} at ${time}`,
        description: describe(f, label)
      });
      return `[[FRAME:${f.index}]]`;
    });
    // any marker that is still there (unknown frame, odd spelling) must never reach the reader
    notes = notes.replace(/[ \t]*\[\[\s*(?:FRAME|VISUAL)\b[^\]]*\]\][ \t]*/gi, (m) => (/\[\[FRAME:\d+\]\]/.test(m) ? m : ''));
    notes = notes.replace(/^[ \t]*[-*+][ \t]*$\n?/gm, ''); // empty bullets left by removed markers
    if (!o.singleWrite) notes = snapSectionTimes(notes, segs);
    notes = headersBeforeFigures(notes, byIndex);
    const byUsed = new Map(used.map((f) => [f.index, f]));
    notes = processSources(notes, (text, video) => text.replace(/^>\s*\*\*Slide (definition|quote) F(\d+):\*\*\s*(.+)$/gim, (_, type, id, passage) => {
      const frame = byIndex.get(Number(id));
      if (video && (!frame || !withinVideo(video, frame.t))) return '> **Watch Out:** The cited slide could not be verified for this video.';
      const source = String(draft.ocr[id]?.text || '').replace(/\s+/g, ' ');
      const exact = passage.trim().replace(/^[“"]|[”"]$/g, '');
      return source.includes(exact) ? `> **Slide ${type.toLowerCase()}:** “${exact}”` : '> **Watch Out:** Verify the formal wording against frame F' + id + '.';
    }));
    const richNotes = notes
      .replace(/\[\[FRAME:(\d+)\]\]/g, (_m, n) => `\n\n${figureMd(byUsed.get(Number(n)), link(byUsed.get(Number(n))))}\n\n`);
    const topics = topicList(notes);
    const title = o.title;
    const parts = (body) => [
      `# ${title}`,
      `## Overview\n\n${overview}`,
      topics.length ? `## Topics\n\n${topics.map((t) => `- ${t.time ? `${t.time} — ` : ''}${t.title}`).join('\n')}` : '',
      `## Detailed notes\n\n${body}`,
      ...extra,
      referencesMd,
      practice
    ].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');

    const total = { in: 0, out: 0 };
    for (const u of Object.values(draft.usage)) { total.in += u.in; total.out += u.out; }

    // TEMP DEBUG: one plain-text dump of every step, to check a run end to end (remove after testing)
    let debug = null;
    if (dbgOn) {
      const L = [];
      const H = (t) => L.push('', '='.repeat(100), t, '='.repeat(100));
      const slot = (s) => { const r = slotRef(settings, s); return `${r?.provider?.name || '-'} / ${r?.model || '-'}`; };
      const usedSet = new Set(used.map((f) => f.index));
      const distinctSet = new Set(distinct.map((f) => f.index));
      L.push(`DEBUG DUMP  ${new Date().toISOString()}`, `Title: ${title}`, `Key: ${key}`, `Mode: ${mode}`, `Course: ${course || '-'}`);
      H('SETTINGS');
      L.push(`Strong: ${slot('strong')}`, `Cheap: ${slot('cheap')}`, `Vision: ${slot('vision')} (useVision ${!!settings.useVision})`,
        `Speech-to-text: ${o.transcript ? 'captions / transcript given with the job' : cloud ? `cloud ${cloud.provider?.name || ''} / ${cloud.model}` : `Whisper ${settings.asrModel} on this computer`}, spoken language setting: ${settings.asrLanguage}`,
        `detail ${settings.detail} | scanRefine ${settings.scanRefine} | writeFullTranscript ${settings.writeFullTranscript} | trimTokens ${trimAt} | practiceQuestions ${settings.practiceQuestions} | webSearch ${settings.webSearch} | shortVideoMinutes ${settings.shortVideoMinutes}`);
      H('STEPS (seconds since start)');
      for (const s of draft.dbg.steps) L.push(`[${s.at}s] ${s.step}: ${s.note}`);
      L.push(`[${Math.round((Date.now() - tRun) / 1000)}s] finished`);
      H(`RAW TRANSCRIPT (${(draft.segments || []).length} lines, about ${trimmed.before} tokens)${draft.noSpeech ? '  !! NO SPEECH FOUND' : ''}`);
      L.push(formatSegments(draft.segments || []));
      H(`AFTER THE CODE TRIM (no AI): ${segs.length} lines, about ${trimmed.after} tokens (${trimmed.before ? Math.round((1 - trimmed.after / trimmed.before) * 100) : 0}% removed)`);
      L.push(formatSegments(segs));
      if (draft.trim) {
        H('AFTER THE CHEAP-MODEL TRIM (per chunk; "kept code trim" = the reply lost too much and was ignored)');
        for (const c of chunks) L.push(`--- chunk ${c.index + 1} ${fmtTime(c.start)}-${fmtTime(c.end)} ---`, draft.trim[c.index]?.length ? formatSegments(draft.trim[c.index]) : '(kept code trim)');
      }
      const sc = draft.scan || {};
      H('SLIDE SCAN');
      L.push(`duration ${fmtTime(sc.duration || 0)} | sample times ${sc.samples ?? '-'} | actually read ${sc.read ?? '-'} | slide changes saved ${frames.length} | distinct after dedup ${distinct.length} | screened ${Object.values(draft.sel || {}).filter((x) => x.screened).length} | described ${Object.keys(draft.described || {}).length} | kept ${kept.length} | shown in notes ${used.length}${sc.failed ? ' | SCAN FAILED' : ''}`);
      H('FRAMES (every saved slide change)');
      for (const f of frames) {
        const k = draft.kind[f.index] || {}, oc = draft.ocr[f.index] || {}, v = draft.sel?.[f.index];
        L.push('', `F${f.index} @ ${fmtTime(f.t)} (picture ${fmtTime(f.shot ?? f.t)}) | OCR words ${oc.words ?? '-'} conf ${oc.conf ?? '-'} | kinds [${(k.kinds || []).join(',')}]${k.blank ? ' BLANK' : ''} | ${distinctSet.has(f.index) ? 'distinct' : 'merged into a neighbour (dedup)'} | ${usedSet.has(f.index) ? 'SHOWN IN NOTES' : 'not shown'}`);
        if (v) L.push(`  vision: keep=${v.keep} kind=${v.kind} info=${v.info}${v.reason ? ` reason="${v.reason}"` : ''}`, `  caption: ${v.caption}`, v.detail ? `  detail: ${v.detail.slice(0, 1500)}` : '  detail: -');
        else if (draft.vis[f.index]) L.push(`  describe: ${String(draft.vis[f.index]).slice(0, 1500)}`);
        if (oc.text) L.push(`  OCR text: ${oc.text.replace(/\s+/g, ' ').slice(0, 600)}`);
      }
      H('WEB');
      L.push(`writer gap research:\n${Object.values(draft.gapWeb || {}).filter(Boolean).join('\n') || '-'}`);
      L.push('', `practice questions:\n${draft.practiceWeb || '-'}`);
      H(`WRITING: route ${fullText ? 'full-transcript' : direct ? 'direct' : 'map-reduce'}, ${chunks.length} chunks, ${groups.length} part(s)`);
      groups.forEach((g, gi) => L.push(`part ${gi + 1}: ${fmtTime(g[0].start)}-${fmtTime(g[g.length - 1].end)} (${g.length} chunks), notes ${String(draft.parts[gi] || '').length} chars`));
      H(`AI CALLS (${draft.dbg.calls.length})`);
      draft.dbg.calls.forEach((c, i) => {
        L.push('', `#${i + 1} ${c.task} | ${c.model} | ${(c.ms / 1000).toFixed(1)} s | images ${c.images ?? 0} | prompt ${c.promptChars ?? '-'} chars | tokens in ${c.usage?.in ?? '-'} out ${c.usage?.out ?? '-'}${c.truncated ? ' | CUT OFF' : ''}${c.error ? ` | ERROR: ${c.error}` : ''}`);
        if (c.prompt) L.push('--- prompt (start) ---', c.prompt);
        if (c.reply) L.push('--- reply ---', c.reply);
      });
      H('USAGE BY SLOT');
      for (const [s, u] of Object.entries(draft.usage)) L.push(`${s}: in ${u.in} out ${u.out}`);
      H(`WARNINGS (${draft.warnings.length})`);
      L.push(...(draft.warnings.length ? draft.warnings : ['none']));
      debug = L.join('\n');
    }
    const writers = [...new Set(groups.map((_, i) => draft.writers?.[i] || "Unknown writer (resumed part)"))];
    const coverage = groups.map((group, i) => {
      const items = checklistFor(group);
      const checks = [...items, ...slideTopicsFor(group)];
      return { ...draft.coverage?.[i], checked: checks.length,
        unlistedVideos: videos.filter((_, index) => !checks.some(item => item.video === index + 1)).map(video => video.title),
        unmatched: checkNotes(group, full ? notes : draft.parts[i]).map(item => ({
        video: videos[item.video - 1]?.title || o.title, at: item.at, item: item.item
      })) };
    });
    await putResult({
      key,
      videoUrl: o.videoUrl || key,
      title,
      course,
      source: mode,
      internal: !!o.singleWrite,
      ...(o.singleWrite ? { batchVideos: o.videos } : {}),
      lectureRefs,
      practiceStyle: qStyle,
      practiceSubject: qSubject,
      youtubeId: o.youtubeId || null,
      summary_raw: parts(notes),
      summary_markdown: parts(richNotes),
      frames: (log.info('pipeline', `Frames 6/6 figures: ${used.length} shown in the notes and PDF (cap ${totalFrames}): ${used.filter((f) => writerPlaced.has(f.index)).length} placed by the Strong AI, ${used.filter((f) => !writerPlaced.has(f.index)).length} important ones added by the code`), used),
      model: writers.join(', '),
      writers, formatVersion: 2, technical, lectureMeta: draft.lectureMeta,
      writerReplies: draft.writerReplies || [], coverage,
      sourceRecord: [
        'TRANSCRIPT', formatSegments(draft.segments || segs), '', 'FRAME OCR',
        ...frames.filter(f => draft.ocr[f.index]?.text).map(f => 'F'+f.index+' ('+fmtTime(f.t)+')\n'+draft.ocr[f.index].text)
      ].join('\n'),
      usage: { ...total, bySlot: draft.usage },
      pipeline: { engine: 'local', route: fullText ? 'full-transcript' : direct ? 'direct' : 'map-reduce', minutes: Math.round(minutes), chunks: chunks.length, scenes: frames.length, withText: screen.length, vision: Object.values(draft.vis).filter(Boolean).length, warnings: draft.warnings },
      ...(debug ? { debug } : {}), // TEMP DEBUG
      createdAt: Date.now()
    });
    // the scan keeps every slide change; only the ones the notes show are worth storing
    const keep = new Set(used.map((f) => f.filename));
    for (const f of frames) if (!keep.has(f.filename)) await deleteFrame(`${key}/${f.filename}`);
    await deleteDraft(key);
    const by = ['strong', 'cheap', 'vision'].filter((s) => draft.usage[s].in || draft.usage[s].out).map((s) => `${s} ${fmtK(draft.usage[s].in)}/${fmtK(draft.usage[s].out)}`).join(' · ');
    log.info('pipeline', `Finished in ${took(tRun)}`);
    progress('done', 100, `Done (tokens in/out: ${by || 'none'})${draft.warnings.length ? ` · ${draft.warnings[0]}` : ''}`);
    return { title };
  } catch (e) {
    await putDraft({ ...draft }).catch(() => {});
    throw e;
  }
}
