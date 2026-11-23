/**
 * Summary pipeline (ES module), shared by offscreen.js (CDN / local / YouTube / captions jobs) and
 * local.html (a File the user picked). Needs DOM APIs (<video>, canvas, iframe) so it only runs in
 * extension pages, never in the service worker.
 *
 *   1 EXTRACT  the only stage that sees the video (or captions): topics, formulas, frames
 *   2 NOTES    text-only, one call per topic, 2 at a time
 *   +  lint the math (free fixes first, AI only for sentences inside \text{}), one small final call
 *
 * Progress is saved in a "draft" after every step, so a failed run resumes where it stopped and
 * never re-processes the video. Token use is tracked and stored with the result.
 */
import { putResult, deleteResult, getDraft, putDraft, deleteDraft } from './db.js';
import { fmtTime } from './common.js';
import { resolveRef } from './settings.js';
import { gfetch, generate, readGemini, thinkingFor, parseJsonLoose, sleep } from './llm.js';
import { EXTRACT_SCHEMA, DETAIL, extractPrompt, notesPrompt, finalPrompt, fixMathPrompt } from './prompts.js';
import { lintSection } from './lint.js';
import { blobGrabber, captureFrames } from './frames.js';

export { sleep };
const CHUNK = 8 * 1024 * 1024; // 8 MB, a multiple of 256 KB
export const MAX_BYTES = 2 * 1024 ** 3;
export const mb = (n) => (n / 1024 / 1024).toFixed(0);
export const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);
const trim = (u) => String(u || '').replace(/\/+$/, '');
const fmtK = (n) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Run `fn` over `items` with at most `n` in flight. Collects errors instead of stopping early. */
export async function pool(items, n, fn) {
  const errors = [];
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      try { await fn(items[i], i); } catch (e) { if (e?.name === 'AbortError') throw e; errors.push(e); }
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return errors;
}

/**
 * Run the whole pipeline for one lecture.
 * @param {object} o
 * @param {'video'|'youtube'|'text'} o.mode  video = a file/blob, youtube = a YouTube URL, text = captions only
 * @param {() => Promise<Blob|File>} [o.getSource]  video mode: resolves the bytes (called lazily, at most once)
 * @param {string} [o.youtubeId]  youtube mode
 * @param {() => object} [o.makeGrabber]  youtube mode: frame grabber that asks the page's player
 * @param {string} [o.transcript]  text mode
 * @param {string} o.key  cache key (clean CDN URL, `yt:<id>`, ...)
 * @param {object} o.settings  normalised settings (providers with keys)
 * @param {AbortSignal} o.signal
 * @param {(stage:string, percent:number|null, text:string)=>void} o.onProgress
 * @returns {Promise<{title: string}>}
 */
export async function runPipeline(o) {
  // Default engine: transcript + slide scan + OCR done locally, AI only writes the notes.
  if (o.settings.engine !== 'gemini') return (await import('./local-pipeline.js')).runLocalPipeline(o);
  // Legacy engine: Gemini watches the whole video (everything below).
  const { mode, key, course, settings, signal, onProgress: progress, regenerate } = o;
  const notesRef = resolveRef(settings, settings.notes);
  const onWait = (t) => progress('notes', null, t);
  if (regenerate) { await deleteResult(key); await deleteDraft(key); }
  const draft = (regenerate ? null : await getDraft(key)) || { key, notes: {}, usage: { in: 0, out: 0 } };
  const save = () => putDraft({ ...draft });
  const addUsage = (u) => { draft.usage.in += u?.in || 0; draft.usage.out += u?.out || 0; };
  let src;
  const getSource = () => (src ||= o.getSource());
  let remote = null; // Gemini file to delete afterwards
  let failed = false;

  try {
    // ---------- 1. EXTRACT ----------
    if (!draft.extract) {
      let raw;
      if (mode === 'text') {
        progress('extract', null, 'Reading captions');
        const isG = notesRef.provider.type === 'gemini';
        const r = await generate(notesRef.provider, notesRef.model, {
          prompt: extractPrompt({ maxFrames: 0, course, title: o.title, transcript: o.transcript, schemaInPrompt: !isG }),
          json: isG ? EXTRACT_SCHEMA : true, maxTokens: 12000, temperature: 0.2, level: settings.thinkingLevel, signal, onWait
        });
        addUsage(r.usage);
        raw = parseJsonLoose(r.text);
      } else {
        const vid = resolveRef(settings, settings.video);
        if (vid.provider.type !== 'gemini') throw new Error('Video summaries need a Gemini provider. Pick one for "Video AI" in Options, or use captions.');
        {
          let part;
          if (mode === 'youtube') {
            part = { file_data: { file_uri: `https://www.youtube.com/watch?v=${o.youtubeId}` } };
          } else {
            const blob = await getSource();
            if (blob.size > MAX_BYTES) throw new Error(`Video is ${mb(blob.size)} MB. Gemini's File API accepts up to 2 GB.`);
            const file = await uploadToGemini(blob, o.title, vid.provider, signal, progress);
            remote = file.name;
            const active = await waitUntilActive(file.name, vid.provider, signal, progress);
            part = { file_data: { mime_type: active.mimeType || 'video/mp4', file_uri: active.uri } };
          }
          raw = await geminiExtract(part, vid, o, signal, progress, addUsage);
        }
      }
      draft.extract = normalizeExtract(raw, settings, mode === 'text');
      await save();
    }
    const ex = draft.extract;

    // ---------- frames (same source as stage 1, no AI) ----------
    if (mode !== 'text' && !draft.frames) {
      const grabber = mode === 'youtube' ? o.makeGrabber() : blobGrabber(await getSource(), Number(settings.maxWidth) || 1600);
      try {
        draft.frames = await captureFrames(grabber, ex.key_frames, { key, signal, progress });
      } catch (e) {
        // A YouTube page we cannot capture still gets its figures, as timestamp links.
        if (mode !== 'youtube' || e?.name === 'AbortError') throw e;
        draft.frames = ex.key_frames.map((f, i) => ({ ...f, figure: i + 1, time: fmtTime(f.timestamp_seconds), filename: null }));
      }
      await save();
    }
    const frames = draft.frames || [];

    // ---------- 2. NOTES (text only) ----------
    const topics = ex.topics;
    const topicOf = (t) => { let k = 0; topics.forEach((tp, i) => { if (t >= tp.start_seconds) k = i; }); return k; };
    const framesFor = topics.map(() => []);
    for (const f of frames) framesFor[topicOf(f.timestamp_seconds)].push(f);

    let done = Object.keys(draft.notes).length;
    const todo = topics.map((_, i) => i).filter((i) => draft.notes[i] == null);
    if (todo.length) progress('notes', pct(done, topics.length), `Writing notes ${done}/${topics.length}`);
    const detail = DETAIL[settings.detail] ? settings.detail : 'standard';
    const errors = await pool(todo, 2, async (i) => {
      const t = topics[i];
      const payload = JSON.stringify({ ...t, topic_index: undefined });
      const r = await generate(notesRef.provider, notesRef.model, {
        prompt: notesPrompt({ topicJson: payload, detail, frames: framesFor[i] }),
        maxTokens: DETAIL[detail].maxTokens, temperature: 0.5, level: settings.thinkingLevel, signal, onWait
      });
      addUsage(r.usage);
      let md = unfence(r.text);
      // Lint: free fixes first, then at most one AI rewrite for this topic only.
      let lint = lintSection(md);
      if (lint.needsAi) {
        try {
          const fix = await generate(notesRef.provider, notesRef.model, {
            prompt: fixMathPrompt(lint.md), maxTokens: DETAIL[detail].maxTokens, temperature: 0.2, level: settings.thinkingLevel, signal, onWait
          });
          addUsage(fix.usage);
          const again = lintSection(unfence(fix.text));
          if (again.problems.length <= lint.problems.length) lint = again; // keep the better one, never fail the job
        } catch (e) { if (e?.name === 'AbortError') throw e; }
      }
      draft.notes[i] = lint.md;
      done++;
      progress('notes', pct(done, topics.length), `Writing notes ${done}/${topics.length}`);
      await save();
    });
    if (errors.length) {
      await save();
      const first = errors[0];
      throw new Error(`${first.message} The video is already processed, so pressing Summarize again only redoes the missing notes.`);
    }

    // ---------- final: overview (one small call), notation / doubts in code ----------
    if (!draft.final) {
      progress('final', null, 'Finishing');
      const outline = topics.map((t, i) => `${i + 1}. ${t.title}: ${[...(t.emphasis || []), ...(t.lecturer_points || []).slice(0, 2)].join('; ').slice(0, 300)}`).join('\n');
      try {
        const r = await generate(notesRef.provider, notesRef.model, {
          prompt: finalPrompt({ title: ex.lecture_title || o.title, outline }), maxTokens: 500, temperature: 0.4, level: settings.thinkingLevel, signal, onWait
        });
        addUsage(r.usage);
        draft.final = unfence(r.text);
      } catch (e) {
        if (e?.name === 'AbortError') throw e;
        draft.final = `## Overview\n\n${topics.map((t) => `- ${t.title}`).join('\n')}`;
      }
      await save();
    }

    // ---------- assemble ----------
    const title = ex.lecture_title || o.title;
    const link = (f) => (mode === 'youtube' ? `https://www.youtube.com/watch?v=${o.youtubeId}&t=${Math.floor(f.timestamp_seconds)}s` : null);
    const usedF = new Set();
    const byF = new Map(frames.map((f) => [f.index, f]));
    const rich = (md, i) => {
      let out = md.replace(/\[\[FRAME:(\d+)\]\]/g, (_, n) => {
        const f = byF.get(Number(n));
        if (!f || usedF.has(f.index)) return '';
        usedF.add(f.index);
        return `\n\n${figureMd(f, link(f))}\n\n`;
      });
      out = out.replace(/^[ \t>]*\[\[VISUAL:[^\]]*\]\][ \t]*\n?/gm, '');
      for (const f of framesFor[i]) if (!usedF.has(f.index)) { usedF.add(f.index); out += `\n\n${figureMd(f, link(f))}\n`; }
      return out;
    };
    const head = (t) => `- ${fmtTime(t.start_seconds)} — ${t.title}`;
    const [overview] = splitFinal(draft.final);
    const doubts = topics.flatMap((t) => (t.unclear || []).map((u) => `- ${fmtTime(t.start_seconds)} — ${u}`));
    const parts = (isRich) => [
      `# ${title}`,
      overview,
      `## Topics\n\n${topics.map(head).join('\n')}`,
      `## Detailed notes`,
      ...topics.map((_, i) => (isRich ? rich(draft.notes[i], i) : draft.notes[i])),
      notationTable(topics),
      doubts.length ? `## Doubts / unclear parts\n\n${doubts.join('\n')}` : ''
    ].filter(Boolean).join('\n\n').replace(/\n{3,}/g, '\n\n');
    const summaryRaw = parts(false);
    const summaryMd = parts(true);
    const lonely = frames.filter((f) => !usedF.has(f.index)); // frames no topic picked up (should not happen)
    const finalMd = lonely.length ? `${summaryMd}\n\n## Figures\n\n${lonely.map((f) => figureMd(f, link(f))).join('\n\n')}` : summaryMd;

    await putResult({
      key,
      videoUrl: o.videoUrl || key,
      title,
      course,
      source: mode,
      youtubeId: o.youtubeId || null,
      summary_raw: summaryRaw,
      summary_markdown: finalMd,
      frames,
      model: notesRef.model === settings.video.model || mode === 'text' ? notesRef.model : `${settings.video.model} + ${notesRef.model}`,
      usage: draft.usage,
      createdAt: Date.now()
    });
    await deleteDraft(key);
    progress('done', 100, `Done (${fmtK(draft.usage.in)} in / ${fmtK(draft.usage.out)} out tokens)`);
    return { title };
  } catch (e) {
    failed = true;
    throw e;
  } finally {
    if (remote && (failed || settings.deleteAfter)) await deleteRemote(remote, resolveRef(settings, settings.video).provider);
  }
}

// ---------- helpers: text ----------
/** Remove a wrapping ``` fence that chat models like to add. */
export const unfence = (t) => String(t || '').trim().replace(/^```(?:markdown|md)?\s*\n([\s\S]*?)\n```$/i, '$1').trim();

/** Split the final call's reply into [Overview section, Exam hints section]. */
export function splitFinal(text) {
  const i = text.search(/^##\s*Exam hints/im);
  const a = (i >= 0 ? text.slice(0, i) : text).trim();
  const b = i >= 0 ? text.slice(i).trim() : '';
  return [a.startsWith('##') ? a : `## Overview\n\n${a}`, b];
}

/** Notation table built from the extracted symbols (no AI needed). */
function notationTable(topics) {
  const rows = new Map();
  for (const t of topics) for (const f of t.formulas || []) for (const s of f.symbols || []) {
    const sym = String(s.symbol || '').trim();
    if (sym && !rows.has(sym)) rows.set(sym, s);
  }
  if (!rows.size) return '';
  const cell = (x) => String(x || '').replace(/\|/g, '/').replace(/\s+/g, ' ').trim();
  const lines = [...rows].map(([sym, s]) => `| ${/\$/.test(sym) ? sym : `$${sym.replace(/(^|[^\\A-Za-z])(alpha|beta|gamma|delta|theta|lambda|mu|pi|rho|sigma|tau|phi|psi|omega)(?![A-Za-z])/g, '$1\\$2')}$`} | ${cell(s.meaning)} | ${cell(s.unit) || '-'} |`);
  return `## Notation\n\n| Symbol | Meaning | Unit |\n|---|---|---|\n${lines.join('\n')}`;
}

/** Markdown for one figure: image + caption, or a text-only line with a timestamp link. */
export function figureMd(f, link) {
  const desc = String(f.description || '').replace(/\*/g, '');
  const title = String(f.title || '').replace(/[[\]]/g, '');
  if (!f.filename) {
    return `**FIG ${f.figure} · ${fmtTime(f.timestamp_seconds)}** — ${title}. ${desc}${link ? ` ([watch at ${fmtTime(f.timestamp_seconds)}](${link}))` : ''}`;
  }
  return `![Figure ${f.figure}: ${title}](images/${f.filename})\n*FIG ${f.figure} · ${fmtTime(f.timestamp_seconds)} — ${desc}*` +
    (link ? `\n\n[Watch at ${fmtTime(f.timestamp_seconds)}](${link})` : '');
}

/** Clean up stage 1 output: ordered topics and numbered frames. */
function normalizeExtract(obj, settings, textOnly) {
  const num = (x, d = 0) => (Number.isFinite(Number(x)) ? Number(x) : d);
  const arr = (x) => (Array.isArray(x) ? x.map((s) => (typeof s === 'string' ? s : JSON.stringify(s))).filter(Boolean) : []);
  const topics = (Array.isArray(obj?.topics) ? obj.topics : [])
    .filter((t) => t && (t.title || (t.lecturer_points || []).length))
    .map((t) => ({
      title: String(t.title || 'Topic').trim(),
      start_seconds: num(t.start_seconds),
      end_seconds: num(t.end_seconds, null),
      lecturer_points: arr(t.lecturer_points),
      definitions: arr(t.definitions),
      formulas: (Array.isArray(t.formulas) ? t.formulas : []).filter((f) => f?.latex).map((f) => ({
        latex: String(f.latex), meaning: String(f.meaning || ''),
        symbols: (Array.isArray(f.symbols) ? f.symbols : []).filter((s) => s?.symbol).map((s) => ({ symbol: String(s.symbol), meaning: String(s.meaning || ''), unit: String(s.unit || '') }))
      })),
      examples: arr(t.examples),
      emphasis: arr(t.emphasis),
      unclear: arr(t.unclear)
    }))
    .sort((a, b) => a.start_seconds - b.start_seconds);
  if (!topics.length) throw new Error('The AI found no topics in this lecture. Try again, or pick a stronger model.');
  const cap = textOnly ? 0 : Math.min(40, Math.max(5, Number(settings.maxFrames) || 15));
  const seen = new Set();
  const key_frames = (Array.isArray(obj.key_frames) ? obj.key_frames : [])
    .filter((f) => f && Number.isFinite(Number(f.timestamp_seconds)))
    .map((f, i) => ({
      index: Number.isInteger(f.index) ? f.index : i + 1,
      timestamp_seconds: Number(f.timestamp_seconds),
      type: f.type || 'other',
      title: String(f.title || `Figure ${i + 1}`).trim(),
      description: String(f.description || '').trim()
    }))
    .filter((f) => (seen.has(f.index) ? false : seen.add(f.index)))
    .sort((a, b) => a.timestamp_seconds - b.timestamp_seconds)
    .slice(0, cap);
  const topicOf = (t) => { let k = 0; topics.forEach((tp, i) => { if (t >= tp.start_seconds) k = i; }); return k; };
  return { lecture_title: String(obj.lecture_title || '').trim(), topics, key_frames };
}

// ---------- Gemini video calls ----------
/** Stage 1 call on a video part. Retries once on invalid JSON. */
async function geminiExtract(part, vid, o, signal, progress, addUsage) {
  const { settings } = o;
  const started = Date.now();
  const beat = setInterval(() => progress('extract', null, `Watching the lecture... ${Math.round((Date.now() - started) / 1000)}s`), 5000);
  progress('extract', null, 'Watching the lecture...');
  try {
    for (let attempt = 0; attempt < 2; attempt++) {
      const parts = [part, { text: extractPrompt({ maxFrames: Math.min(40, Math.max(5, Number(settings.maxFrames) || 15)), course: o.course, title: o.title }) }];
      if (attempt > 0) parts.push({ text: 'Your previous reply was not valid JSON. Return valid JSON only, exactly matching the schema.' });
      const generationConfig = { temperature: 0.2, maxOutputTokens: 32768, responseMimeType: 'application/json', responseSchema: EXTRACT_SCHEMA };
      if (settings.mediaResolution && settings.mediaResolution !== 'AUTO') generationConfig.mediaResolution = settings.mediaResolution;
      const thinking = thinkingFor(vid.model, settings.thinkingLevel);
      if (thinking) generationConfig.thinkingConfig = thinking;
      let r;
      try {
        const res = await gfetch(`${trim(vid.provider.baseUrl)}/v1beta/models/${encodeURIComponent(vid.model)}:generateContent`, {
          method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ contents: [{ role: 'user', parts }], generationConfig })
        }, vid.provider, signal, (t) => progress('extract', null, t));
        r = readGemini(await res.json());
      } catch (e) { throw e?.name === 'AbortError' ? e : youtubeHint(e, part); }
      addUsage(r.usage);
      try {
        return parseJsonLoose(r.text);
      } catch (e) {
        if (attempt === 1) {
          throw new Error(r.finishReason === 'MAX_TOKENS'
            ? 'The AI ran out of output space before finishing. Try a shorter lecture or fewer key frames.'
            : `The AI returned invalid JSON (${e.message}).`);
        }
      }
    }
  } finally {
    clearInterval(beat);
  }
}

/** Gemini gives odd errors for YouTube links it cannot read; say what to do instead. */
function youtubeHint(e, part) {
  if (!part.file_data?.file_uri?.includes('youtube.com')) return e;
  return new Error(`${e.message} Gemini can only read public YouTube videos (private, age-restricted or very long ones fail, and there is a daily limit). Try captions, or "Summarize from a file...".`);
}

/** Resumable upload in 8 MB chunks. Returns the Gemini file object ({name, uri, state, ...}). */
async function uploadToGemini(blob, title, p, signal, progress) {
  const base = trim(p.baseUrl);
  progress('upload', 0, 'Uploading to Gemini 0%');
  const start = await gfetch(`${base}/upload/v1beta/files`, {
    method: 'POST',
    headers: {
      'X-Goog-Upload-Protocol': 'resumable',
      'X-Goog-Upload-Command': 'start',
      'X-Goog-Upload-Header-Content-Length': String(blob.size),
      'X-Goog-Upload-Header-Content-Type': 'video/mp4',
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ file: { display_name: String(title || 'lecture').slice(0, 100) } })
  }, p, signal);
  const uploadUrl = start.headers.get('x-goog-upload-url');
  if (!uploadUrl) throw new Error('Gemini did not return an upload URL.');

  let offset = 0;
  let res;
  while (offset < blob.size) {
    const end = Math.min(offset + CHUNK, blob.size);
    const last = end === blob.size;
    res = await gfetch(uploadUrl, {
      method: 'POST',
      headers: { 'X-Goog-Upload-Command': last ? 'upload, finalize' : 'upload', 'X-Goog-Upload-Offset': String(offset) },
      body: blob.slice(offset, end)
    }, p, signal, (t) => progress('upload', pct(offset, blob.size), t));
    offset = end;
    progress('upload', pct(offset, blob.size), `Uploading to Gemini ${pct(offset, blob.size)}%`);
  }
  const data = await res.json();
  if (!data?.file?.name) throw new Error('Upload finished but Gemini returned no file info.');
  return data.file;
}

/** Poll until the uploaded file is processed. */
async function waitUntilActive(name, p, signal, progress) {
  const started = Date.now();
  for (;;) {
    const res = await gfetch(`${trim(p.baseUrl)}/v1beta/${name}`, { method: 'GET' }, p, signal);
    const file = await res.json();
    if (file.state === 'ACTIVE') return file;
    if (file.state === 'FAILED') throw new Error(`Gemini could not process the video: ${file.error?.message || 'unknown error'}`);
    const secs = Math.round((Date.now() - started) / 1000);
    if (secs > 15 * 60) throw new Error('Gemini took more than 15 minutes to process the video. Try again later.');
    progress('processing', null, `Gemini processing... ${secs}s`);
    await sleep(5000, signal);
  }
}

async function deleteRemote(name, p) {
  try {
    await fetch(`${trim(p.baseUrl)}/v1beta/${name}`, { method: 'DELETE', headers: { 'x-goog-api-key': p.apiKey } });
  } catch { /* best effort */ }
}
