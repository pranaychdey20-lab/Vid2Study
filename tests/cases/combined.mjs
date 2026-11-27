import assert from 'node:assert/strict';
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: path => path } };
globalThis.fetch = async () => { throw new Error('offline'); };

const { planCombined, stitchCombined, runCombined } = await import('./lib/combined.js');
const { combinedNotesTitle, savedNotesTitle } = await import('./lib/common.js');
const { runLocalPipeline, formatReferences } = await import('./lib/local-pipeline.js');
const { getFrame, getResult, getDraft, putDraft, putFrame } = await import('./lib/db.js');
const { normalizeSettings } = await import('./lib/settings.js');
const { calls, failures } = await import('./lib/llm.js');
const lecture = (n, duration, chapter = '', module = 'Module 1') => ({ url: `https://video.example/${n}.mp4`, title: `Video ${n}`, duration, chapter, module });
const selected = [lecture(1, '13:31', 'Spatial'), lecture(2, '16:15', 'Spatial'), lecture(3, '13:07', 'Spatial'),
  lecture(4, '16:56', 'Histogram'), lecture(5, '11:08', 'Histogram'), lecture(6, '13:08', 'Histogram')];
assert.deepEqual(planCombined(selected).map(g => g.duration), [2573, 2472]);
assert.deepEqual(planCombined(selected.map(video => ({ ...video, chapter: '' }))).map(g => g.duration), [5045]);
assert.deepEqual(planCombined([1, 2, 3, 4].map(i => lecture(i, '25:00'))).map(g => g.videos.length), [3, 1]);
assert.deepEqual(planCombined([lecture(1, ''), lecture(2, '25:00'), lecture(3, '95:00')]).map(g => g.videos.length), [1, 1, 1]);
assert.deepEqual(planCombined([lecture(1, '12:00', 'Same'), lecture(2, '12:00', 'Same', 'Module 2')]).map(g => g.videos.length), [1, 1]);
{
  const course = 'Robotic Sensing and Vision';
  const original = { source: 'combined', title: course + ' — Combined notes', course };
  const intro = 'Introduction to Geometric Transforms';
  const perspective = 'Perspective Transforms and Image Registration';
  assert.equal(savedNotesTitle({ ...original, summary_markdown: '## Chapter: ' + intro }), course + ' — ' + intro + ' — Combined notes');
  assert.equal(savedNotesTitle({ ...original, summary_markdown: '## Chapter: ' + perspective }), course + ' — ' + perspective + ' — Combined notes');
  assert.equal(savedNotesTitle({ ...original, title: intro + ' — Combined notes', summary_markdown: '## Chapter: ' + intro }), combinedNotesTitle([intro], course));
  assert.equal(savedNotesTitle({ ...original, summary_markdown: '## Chapter: ' + intro + '\n## Chapter: ' + perspective }), combinedNotesTitle([intro, perspective], course));
  assert.equal(savedNotesTitle({ ...original, title: 'Custom title' }), 'Custom title');
  assert.equal(planCombined([lecture(1, '12:00', '', 'Geometric Transforms')])[0].videos[0].module, 'Geometric Transforms');
}

const note = (key, title) => ({
  key, model: 'Writer', frames: [{ index: 5, figure: 1, filename: 'frame.png', timestamp_seconds: 11 }],
  summary_raw: `## Overview\n- ${title}\n## Detailed notes\n### ${title} (00:10)\nContent.\n[[FRAME:5]]`,
  summary_markdown: `## Overview\n- ${title}\n## Detailed notes\n### ${title} (00:10)\nContent.\n\n![Figure 1: Example](images/frame.png)\n*FIG 1 · 00:11 — A chart*`,
  lectureRefs: [{ kind: 'book', title: 'A Textbook' }]
});
await putFrame('first/frame.png', new Blob(['first']));
await putFrame('second/frame.png', new Blob(['second']));
const stitched = await stitchCombined({ key: 'all', title: 'Combined', course: 'Course', formatReferences, parts: [
  { note: note('first', 'Spatial method'), group: { chapter: 'Spatial', chapterKey: '1' }, videos: [{ title: 'Spatial lecture', start: 0, end: 30 }] },
  { note: note('second', 'Histogram method'), group: { chapter: 'Histogram', chapterKey: '2' }, videos: [{ title: 'Histogram lecture', start: 0, end: 30 }] }
] });
assert.match(stitched.summary_markdown, /## Chapter: Spatial[\s\S]*## Chapter: Histogram/);
assert.match(stitched.summary_markdown, /images\/figure-2\.png\)\n\*FIG 2/);
assert.match(stitched.summary_raw, /\[\[FRAME:1\]\][\s\S]*\[\[FRAME:2\]\]/);
assert.equal((stitched.summary_markdown.match(/A Textbook/g) || []).length, 1);
assert.equal(await (await getFrame('all/figure-2.png')).text(), 'second');

const settings = normalizeSettings({
  providers: [{ id: 'p', name: 'P', type: 'openai', baseUrl: 'http://localhost' }],
  strong: { provider: 'p', model: 'writer' }, researchReferences: false, practiceQuestions: true, webSearch: false, useVision: false
});
const signal = new AbortController().signal;
const job = { url: 'combined:test', title: 'Combined notes', course: 'Course', settings,
  batch: planCombined([lecture(1, '20:00', 'Spatial'), lecture(2, '20:00', 'Spatial'), lecture(3, '15:00', 'Histogram')]) };
let extracted = 0;
let reading = 0, peak = 0;
const completionOrder = [];
let finishFirst;
const secondFinished = new Promise(resolve => { finishFirst = resolve; });
const run = async options => {
  if (!options.evidenceOnly) return runLocalPipeline({ ...options, deferPractice: true });
  reading++;
  peak = Math.max(peak, reading);
  if (options.title === 'Video 1') await secondFinished;
  const evidence = {
    segments: [{ start: 0, end: 60, text: `evidence for ${options.title}` }],
    scan: { frames: [{ index: 1, t: 11, filename: 'slide.png' }], duration: 60 },
    ocr: { 1: { text: 'Shared slide text with enough words to trigger repeat checking', words: 10, conf: 100 } },
    kind: { 1: { kinds: ['diagram'], primary: 'diagram', score: 1 } }
  };
  await putFrame(`${options.key}/slide.png`, new Blob([options.title]));
  extracted++;
  await putDraft({ key: options.key, ...evidence });
  reading--;
  completionOrder.push(options.title);
  if (options.title === 'Video 2') finishFirst();
  return { evidence };
};
const opts = { signal, progress() {}, formatReferences, run, getSource: () => { throw new Error('Expected local test evidence'); } };
const firstReply = '## Overview\n- Learn spatial filters\n## Detailed notes\n### First method (00:10)\nFirst detail.\n[[FRAME:2]]\n<!--MISSING_DETAILS: no-->';
failures.push({ task: 'WRITE', model: 'writer', reply: firstReply });
try {
  await assert.rejects(runCombined(job, opts), error => error.name === 'StageError' && /Video 2/.test(error.info.reason));
  assert.equal(calls.filter(call => call.task === 'WRITE').length, 1);
  assert.equal(calls.filter(call => call.task === 'WRITE_CONTINUE').length, 0);
  assert.equal(await getResult(job.url), undefined);
  assert.equal(extracted, 2);
  assert.equal(peak, 2);
  assert.deepEqual(completionOrder, ['Video 2', 'Video 1']);
  const prompt = calls.find(call => call.task === 'WRITE').all;
  assert.match(prompt, /VIDEO 1: Video 1[\s\S]*evidence for Video 1[\s\S]*ON SCREEN F1 OCR[\s\S]*VIDEO 2: Video 2[\s\S]*evidence for Video 2[\s\S]*ON SCREEN F2 OCR/);
  failures[0].reply = '## Overview\n- Understand histograms\n## Detailed notes\n### Histogram method (00:10)\nHistogram detail.\n<!--MISSING_DETAILS: no-->';
  failures.push({ task: 'WRITE_CONTINUE', model: 'writer', reply: '### Second method (20:00)\nRecovered detail.\n<!--MISSING_DETAILS: no-->' });
  await runCombined(job, opts);
  assert.deepEqual(calls.filter(call => /^WRITE/.test(call.task)).map(call => call.task), ['WRITE', 'WRITE_CONTINUE', 'WRITE']);
  assert.equal(calls.filter(call => call.task === 'QUESTIONS').length, 0);
  assert.equal(extracted, 3);
  const result = await getResult(job.url);
  assert.match(result.summary_markdown, /## Chapter: Spatial[\s\S]*First detail[\s\S]*Video: Video 2[\s\S]*Recovered detail[\s\S]*## Chapter: Histogram[\s\S]*Histogram detail/);
  const secondFrame = result.frames.find(frame => frame.sourceVideo === 'Video 2');
  assert.ok(secondFrame, 'the similar slide from Video 2 survives');
  const [beforeSecond, afterSecond] = result.summary_markdown.split('#### Video: Video 2');
  assert.ok(!beforeSecond.includes(secondFrame.filename), 'the writer’s incorrectly placed marker is removed from Video 1');
  assert.ok(afterSecond.includes(secondFrame.filename), 'the image is placed back with Video 2');
  assert.equal(await (await getFrame(`${job.url}/${secondFrame.filename}`)).text(), 'Video 2');
  assert.equal(await getDraft('combined:test:part:0:source:0'), undefined);
} finally { failures.splice(0); }

const checkedJob = { ...job, url: 'combined:boundary-check', settings: { ...settings, researchReferences: true }, batch: [job.batch[0]] };
const runWithChecklist = async options => options.evidenceOnly ? {
  evidence: { segments: [{ start: 0, end: 60, text: 'The camera measures light. The complete example shows an impulse and a filter applied to a neighborhood of nine pixels. The lesson explains this calculation step by step with a comparison of two methods.' }], scan: { frames: [], duration: 60 } }
} : runLocalPipeline({ ...options, deferPractice: true });
failures.push(
  { task: 'DIGEST', model: 'writer', reply: '=== COVERAGE CHECKLIST ===\n[{"video":2,"at":"20:20","item":"Mean filter calculation","anchors":["mean filter","58 9"]}]\n=== BRIEF ===\nFiltering example.\n=== TIMELINE ===\n[20:20] Mean filter calculation\n=== REFERENCES ===\n[]' },
  { task: 'WRITE', model: 'writer', reply: '## Overview\n- Compare filters\n## Detailed notes\n### First video example (00:10)\nMean filter $58/9$.\n### Second video example (20:10)\nSome discussion.\n<!--MISSING_DETAILS: no-->' }
);
try {
  calls.length = 0;
  await assert.rejects(runCombined(checkedJob, { ...opts, run: runWithChecklist }), error => /1 coverage checklist item/.test(error.info?.reason));
  assert.match(calls.find(call => call.task === 'DIGEST').prompt, /SOURCE VIDEO BOUNDARIES[\s\S]*2\. Video 2/);
  assert.equal(calls.filter(call => call.task === 'DIGEST').length, 1);
  assert.equal(calls.filter(call => call.task === 'WRITE_CONTINUE').length, 0);
} finally { failures.splice(0); }
