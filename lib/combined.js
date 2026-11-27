import { fmtTime } from './common.js';
import { getDraft, putDraft, deleteDraft, getResult, putResult, deleteResult, getFrame, putFrame, deleteFrames, deleteFrame } from './db.js';
import { transcriptDuration } from './transcript.js';

const TARGET = 60 * 60;
const LIMIT = 90 * 60;
const seconds = value => /^\d+(?::\d{2}){0,2}$/.test(String(value))
  ? String(value).split(':').reduce((total, part) => total * 60 + Number(part), 0) : 0;
const singleLine = text => String(text || '').replace(/\s+/g, ' ').trim();

/** Keep course order and subtopic boundaries. An unknown or oversized video gets its own batch. */
export function planCombined(lectures) {
  const groups = [];
  for (const lecture of lectures) {
    const chapter = singleLine(lecture.chapter);
    const chapterKey = chapter ? `${lecture.module || ''}\n${chapter}` : '';
    const duration = seconds(lecture.duration);
    const last = groups.at(-1);
    const joins = last && last.chapterKey === chapterKey && duration && last.duration
      && last.duration < TARGET && last.duration + duration <= LIMIT;
    const group = joins ? last : { chapter, chapterKey, duration: 0, videos: [] };
    if (!joins) groups.push(group);
    group.videos.push({ url: lecture.url, title: singleLine(lecture.title) || 'Lecture', module: singleLine(lecture.module), duration });
    group.duration += duration;
  }
  const compact = [];
  for (const group of groups) {
    const previous = compact.at(-1);
    if (previous && previous.chapterKey === group.chapterKey && previous.duration && group.duration
      && previous.duration + group.duration <= LIMIT) {
      previous.duration += group.duration;
      previous.videos.push(...group.videos);
    } else compact.push(group);
  }
  return compact;
}

/** Read a small number of videos at once and wait for active workers before returning any failure. */
async function readSources(group, keys, extract, parallelism, signal) {
  const controller = new AbortController();
  const workSignal = AbortSignal.any([signal, controller.signal]);
  const sources = new Array(group.videos.length);
  let next = 0, failure;
  const worker = async () => {
    while (!workSignal.aborted && next < group.videos.length) {
      const i = next++;
      const video = group.videos[i];
      try {
        const previous = await getDraft(video.url);
        const existing = previous?.engine === 'local' && previous.segments && previous.scan
          && (previous.scan.frames || []).every(frame => !frame.filename || previous.ocr?.[frame.index]);
        workSignal.throwIfAborted();
        const source = existing ? previous : await extract(video, keys[i], workSignal);
        sources[i] = { source, owner: existing ? video.url : keys[i] };
      } catch (error) {
        failure ||= error;
        controller.abort();
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(parallelism, group.videos.length) }, worker));
  signal.throwIfAborted();
  if (failure) throw failure;
  return sources;
}

/** Stage source evidence under a batch key, with unique frame IDs and a shared timeline. */
async function preparePart(key, group, extractionKeys, extract, parallelism, signal) {
  const saved = await getDraft(key);
  if (saved?.batchVideos) return saved.batchVideos;
  const sources = await readSources(group, extractionKeys, extract, parallelism, signal);
  const draft = { key, engine: 'local', warnings: [], segments: [], scan: { frames: [], duration: 0 },
    ocr: {}, kind: {}, vis: {}, chunkNotes: {}, parts: {}, usage: {} };
  const videos = [];
  for (const [i, video] of group.videos.entries()) {
    signal.throwIfAborted();
    const { source, owner } = sources[i];
    const offset = draft.scan.duration;
    const duration = Math.ceil(Math.max(1, source.scan?.duration || 0, transcriptDuration(source.segments), video.duration));
    const inVideo = time => offset + Math.max(0, Math.min(duration - 0.001, time));
    videos.push({ ...video, start: offset, end: offset + duration, time: `${fmtTime(offset)}–${fmtTime(offset + duration)}` });
    draft.segments.push(...source.segments.map(s => ({ ...s, start: inVideo(s.start), end: Math.min(offset + duration, s.end + offset) })));
    for (const frame of source.scan?.frames || []) {
      const index = draft.scan.frames.length + 1;
      const blob = frame.filename && await getFrame(`${owner}/${frame.filename}`);
      const filename = blob ? `frame-${index}.png` : null;
      if (blob) await putFrame(`${key}/${filename}`, blob);
      draft.scan.frames.push({ ...frame, index, filename, t: inVideo(frame.t), shot: inVideo(frame.shot ?? frame.t) });
      if (source.ocr?.[frame.index]) draft.ocr[index] = source.ocr[frame.index];
      if (source.kind?.[frame.index]) draft.kind[index] = source.kind[frame.index];
    }
    draft.warnings.push(...(source.warnings || []).map(warning => `${video.title} — ${warning}`));
    draft.scan.duration += duration;
  }
  // The text entry point needs a timeline even when all of the available evidence is on slides.
  if (!draft.segments.length && !draft.scan.frames.length) throw new Error('No speech or slide evidence was available for this batch.');
  draft.noSpeech = !draft.segments.length;
  draft.batchVideos = videos;
  await putDraft(draft);
  return videos;
}

function markdownParts(markdown) {
  const sections = new Map();
  let name = '';
  let fence = '';
  for (const line of String(markdown || '').split('\n')) {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? '' : marker;
    const heading = !fence && /^##\s+(.+)$/.exec(line);
    if (heading) name = heading[1].trim().toLowerCase();
    else if (name) sections.set(name, (sections.get(name) || '') + line + '\n');
  }
  return sections;
}

const timedHeading = /^###\s+(.+?)\s*\((\d+(?::\d{2}){1,2})\)\s*$/;

function chapterText(markdown, videos, chapter, duplicateTitles) {
  let active = null;
  let fence = '';
  return markdown.trim().split('\n').map(line => {
    const marker = /^\s*(```|~~~)/.exec(line)?.[1];
    if (marker && (!fence || marker === fence)) fence = fence ? '' : marker;
    if (fence) return line;
    const heading = timedHeading.exec(line);
    if (!heading) return line;
    const at = seconds(heading[2]);
    const video = videos.find(v => at >= v.start && at < v.end) || active || videos[0];
    const prefix = video === active ? '' : chapter ? `\n#### Video: ${video.title}\n\n` : `## Chapter: ${video.title}\n\n`;
    active = video;
    const title = duplicateTitles.has(heading[1]) ? `${heading[1]} — ${video.title}` : heading[1];
    return `${prefix}### ${title} (${fmtTime(at - video.start)})`;
  }).join('\n');
}

/** Assemble completed parts without asking a model to rewrite their content. */
export async function stitchCombined({ key, title, course, parts, formatReferences }) {
  const frames = [], raw = [], rich = [], overview = [], refs = new Map();
  const appendices = { raw: [], rich: [] };
  const seenTitles = new Set(), duplicateTitles = new Set();
  for (const { note } of parts) {
    for (const line of (markdownParts(note.summary_raw).get('detailed notes') || '').split('\n')) {
      const heading = timedHeading.exec(line)?.[1];
      if (!heading) continue;
      if (seenTitles.has(heading)) duplicateTitles.add(heading);
      seenTitles.add(heading);
    }
  }
  let chapterKey = null, scenes = 0;
  const usage = { in: 0, out: 0 };
  const warnings = [];
  for (const { note, group, videos } of parts) {
    const byIndex = new Map(), byName = new Map(), byFigure = new Map();
    for (const frame of note.frames || []) {
      const number = frames.length + 1;
      const filename = frame.filename ? `figure-${number}.png` : null;
      const blob = frame.filename && await getFrame(`${note.key}/${frame.filename}`);
      if (blob) await putFrame(`${key}/${filename}`, blob);
      const video = videos.find(v => frame.timestamp_seconds >= v.start && frame.timestamp_seconds < v.end);
      const timestamp = Math.max(0, frame.timestamp_seconds - (video?.start || 0));
      byIndex.set(Number(frame.index), number);
      const mapped = { filename: blob ? filename : null, number, timestamp };
      byFigure.set(Number(frame.figure), mapped);
      if (frame.filename) byName.set(frame.filename, mapped);
      frames.push({ ...frame, index: number, figure: number, filename: blob ? filename : null,
        title: String(frame.title || '').replace(/ at [\d:]+$/, ` at ${fmtTime(timestamp)}`),
        timestamp_seconds: timestamp, time: fmtTime(timestamp), sourceVideo: video?.title });
    }
    const rawSections = markdownParts(note.summary_raw);
    const richSections = markdownParts(note.summary_markdown);
    for (const [variant, sections] of [['raw', rawSections], ['rich', richSections]]) {
      for (const [name, text] of sections) {
        if (!['overview', 'topics', 'detailed notes', 'references'].includes(name) && text.trim()) {
          appendices[variant].push(`### ${group.chapter ? `${group.chapter} — ` : ''}${name}\n\n${text.trim()}`);
        }
      }
    }
    const label = group.chapter && group.chapterKey !== chapterKey ? `## Chapter: ${group.chapter}\n\n` : '';
    chapterKey = group.chapterKey;
    const details = rawSections.get('detailed notes') || '';
    raw.push(label + chapterText(details, videos, group.chapter, duplicateTitles).replace(/\[\[FRAME:(\d+)\]\]/g, (_, id) => {
      const index = byIndex.get(Number(id));
      return index ? `[[FRAME:${index}]]` : '';
    }));
    let detailMd = chapterText(richSections.get('detailed notes') || '', videos, group.chapter, duplicateTitles);
    detailMd = detailMd.replace(/^(!\[Figure \d+:[^\n]*\]\(images\/([^\n)]+)\))\n(\*FIG \d+ · [^\n]+)$/gm, (match, image, name, caption) => {
      const mapped = byName.get(name);
      if (!mapped) return match;
      const cap = caption.replace(/^\*FIG \d+ · [\d:]+/, `*FIG ${mapped.number} · ${fmtTime(mapped.timestamp)}`);
      return mapped.filename ? image.replace(/^!\[Figure \d+:/, `![Figure ${mapped.number}:`).replace(`images/${name})`, `images/${mapped.filename})`) + '\n' + cap : cap;
    });
    detailMd = detailMd.replace(/^\*\*FIG (\d+) · [\d:]+\*\*/gm, (match, figure) => {
      const mapped = byFigure.get(Number(figure));
      return mapped ? `**FIG ${mapped.number} · ${fmtTime(mapped.timestamp)}**` : match;
    });
    rich.push(label + detailMd);
    overview.push((richSections.get('overview') || '').trim());
    for (const ref of note.lectureRefs || []) {
      const normalized = ref.title.toLowerCase();
      const prior = refs.get(normalized);
      refs.set(normalized, { ...ref, at: '', author: ref.author || prior?.author, why: ref.why || prior?.why });
    }
    scenes += note.pipeline?.scenes || 0;
    usage.in += note.usage?.in || 0;
    usage.out += note.usage?.out || 0;
    warnings.push(...(note.pipeline?.warnings || []));
  }
  const lectureRefs = [...refs.values()];
  const refsMd = formatReferences(lectureRefs);
  const compose = (items, appendix) => [`# ${title}`, `## Overview\n\n${overview.filter(Boolean).join('\n\n')}`, '## Detailed notes', ...items,
    ...(appendix.length ? ['## Beyond the Lecture', ...appendix] : []), refsMd].filter(Boolean).join('\n\n');
  const writers = [...new Set(parts.flatMap(({ note }) => note.writers || [note.model]).filter(Boolean))];
  const sourceRecord = parts.filter(part => part.note.sourceRecord).map(({ note, videos }) => `${videos.map(v => `${v.time} — ${v.title}`).join('\n')}\n\n${note.sourceRecord}`).join('\n\n');
  const result = { key, title, course, source: 'combined', formatVersion: 2, frames, writers, model: writers.join(', '),
    library: {
      module: [...new Set(parts.flatMap(({ group }) => (group.videos || []).map(video => video.module).filter(Boolean)))].join(' + '),
      category: [...new Set(parts.map(({ group }) => group.chapter).filter(Boolean))].join(' + ')
    },
    technical: parts.some(({ note }) => note.technical), summary_raw: compose(raw, appendices.raw), summary_markdown: compose(rich, appendices.rich),
    lectureRefs, sourceRecord, usage, pipeline: { scenes, warnings }, createdAt: Date.now(),
    coverage: parts.flatMap(({ note }) => note.coverage || [{ checked: 0, unmatched: [] }]),
    writerReplies: parts.flatMap(({ note }, i) => (note.writerReplies || []).map(reply => ({ ...reply, batch: i + 1 }))) };
  await putResult(result);
  return result;
}

/** The queue owns one combined job. Each completed write batch survives a pause or cancellation. */
export async function runCombined(job, { signal, progress, run, getSource, formatReferences, parallelism = 2 }) {
  const finished = [];
  const ownedSources = new Set();
  for (const [i, group] of job.batch.entries()) {
    signal.throwIfAborted();
    const key = `${job.url}:part:${i}`;
    const extractionKeys = group.videos.map((_, j) => `${key}:source:${j}`);
    extractionKeys.forEach(sourceKey => ownedSources.add(sourceKey));
    const onProgress = (stage, percent, text) => progress(stage === 'done' ? 'final' : stage, percent,
      `Batch ${i + 1}/${job.batch.length} · ${text || stage}`, { batch: i + 1, batches: job.batch.length });
    let note = await getResult(key);
    let videos = note?.batchVideos;
    if (!note) {
      const active = new Map();
      videos = await preparePart(key, group, extractionKeys, async (video, sourceKey, sourceSignal) => {
        const report = (stage, percent, text) => {
          active.set(sourceKey, `${video.title}: ${text || stage}${percent == null || /\d%/.test(text || '') ? '' : ` (${percent}%)`}`);
          onProgress(stage, active.size === 1 ? percent : null, [...active.values()].join(' · '));
        };
        report('source', null, 'Preparing video');
        try {
          const saved = await getResult(video.url);
          const transcript = /^TRANSCRIPT\r?\n([\s\S]*?)^FRAME OCR\s*$/m.exec(saved?.sourceRecord || '')?.[1]?.trim();
          const { evidence } = await run({ key: sourceKey, mode: 'video', title: video.title, course: job.course, evidenceOnly: true,
            keepOcr: true, limitLocalAsr: true,
            transcript: transcript && !transcript.includes('(No speech was recognised in this video.)') ? transcript : undefined,
            settings: job.settings, signal: sourceSignal, onProgress: report, getSource: () => getSource(video, sourceSignal, report) });
          return evidence;
        } finally {
          active.delete(sourceKey);
        }
      }, parallelism, signal);
      await run({ key, mode: 'text', title: group.chapter || job.title, course: job.course, videos, singleWrite: true,
        settings: job.settings, signal, onProgress, skipStages: job.skipStages });
      note = await getResult(key);
    }
    if (!note || !videos) throw new Error('The batch result could not be recovered.');
    finished.push({ note, group, videos });
  }
  signal.throwIfAborted();
  progress('final', null, 'Stitching the completed batches');
  const result = await stitchCombined({ key: job.url, title: job.title, course: job.course, parts: finished,
    formatReferences: job.settings.researchReferences ? formatReferences : () => '' });
  for (const { note } of finished) await deleteResult(note.key).catch(() => {});
  for (const key of ownedSources) {
    await deleteFrames(key).catch(() => {});
    await deleteDraft(key).catch(() => {});
  }
  progress('done', 100, 'Combined notes ready');
  return { title: result.title };
}
