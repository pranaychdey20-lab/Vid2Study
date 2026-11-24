// A model failing in a stage pauses the job (instead of skipping the stage); it resumes from the saved draft,
// with another model, or with the stage skipped when the user chooses so.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const { runLocalPipeline, StageError, STAGE } = await import('./lib/local-pipeline.js');
const { getResult, getDraft } = await import('./lib/db.js');
const { calls, failures } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

const base = {
  providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }, { id: 'o', type: 'openai', name: 'O', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }],
  strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'o', model: 'small' }, practiceQuestions: false
};
const mapSet = normalizeSettings({ ...base, writeFullTranscript: false });
const settings = normalizeSettings(base);
const mk = (min) => { let s = ''; for (let t = 0; t < min * 60; t += 20) s += `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}] word ${t} blah blah\n`; return s; };
const run = async (key, min, { title = 'T', set = settings, skipStages } = {}) => {
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key, title, course: 'C', settings: set, signal: new AbortController().signal, onProgress() {}, transcript: mk(min), skipStages });
  return getResult(key);
};
const pauses = async (fn) => { try { await fn(); } catch (e) { return e; } assert.fail('expected the job to pause'); };

// 1. the writer's model is gone (404): the job pauses at "write" with everything needed for the dialog
{
  failures.push({ model: 'BIG', task: 'WRITE', status: 404 });
  const e = await pauses(() => run('w1', 20));
  assert.ok(e instanceof StageError && e.name === 'StageError');
  assert.equal(e.info.stage, 'write');
  assert.equal(e.info.slot, 'strong');
  assert.equal(e.info.model, 'BIG');
  assert.equal(e.info.providerName, 'G');
  assert.equal(e.info.status, 404);
  assert.equal(e.info.skip, null, 'the writer cannot be skipped');
  assert.ok(await getDraft('w1'), 'the draft is saved so the job can resume');
  assert.equal(await getResult('w1'), undefined, 'no half-finished notes are saved');
  // the user picks another model and continues: same draft, the new model writes
  failures.length = 0;
  const r = await run('w1', 20, { set: normalizeSettings({ ...base, strong: { provider: 'g', model: 'OTHER' } }) });
  assert.ok(r?.summary_markdown);
  assert.ok(calls.every((c) => c.model === 'OTHER'));
  assert.equal(await getDraft('w1'), undefined, 'the draft is removed once the notes are saved');
  console.log('write pause + resume ok');
}

// 2. a long video: the cheap model is rate limited. Pauses at "map", slot cheap, not the strong model
{
  failures.push({ model: 'small', task: 'CHUNK', status: 429, message: 'Rate limited by O. Try again later.' });
  const e = await pauses(() => run('m1', 200, { set: mapSet }));
  assert.equal(e.info.stage, 'map');
  assert.equal(e.info.slot, 'cheap');
  assert.equal(e.info.status, 429);
  assert.equal(e.info.fallback, false);
  failures.length = 0;
  const r = await run('m1', 200, { set: mapSet });
  assert.equal(r.pipeline.route, 'map-reduce');
  console.log('map pause + resume ok');
}

// 3. an empty cheap slot falls back to the strong model: the dialog says so
{
  failures.push({ model: 'BIG', task: 'CHUNK', status: 404 });
  const e = await pauses(() => run('m2', 200, { set: normalizeSettings({ ...base, cheap: { provider: '', model: '' }, writeFullTranscript: false }) }));
  assert.equal(e.info.slot, 'cheap');
  assert.equal(e.info.fallback, true);
  failures.length = 0;
  console.log('fallback slot ok');
}

// 4. the overview can be skipped: the topics are listed instead, and the skip is noted
{
  failures.push({ task: 'FINAL', status: 500 });
  const e = await pauses(() => run('f1', 200));
  assert.equal(e.info.stage, 'overview');
  assert.equal(e.info.skip, 'overview');
  assert.ok(e.info.skipNote.length > 0);
  const r = await run('f1', 200, { skipStages: ['overview'] });
  assert.match(r.summary_markdown, /## Overview\n\n- Topic 1/);
  assert.ok(r.pipeline.warnings.some((w) => /Skipped as you chose/.test(w)));
  assert.ok(!calls.some((c) => c.task === 'FINAL'), 'a skipped stage makes no call');
  failures.length = 0;
  console.log('overview skip ok');
}

// 5. code outputs: a failing service pauses; an unreadable reply (no HTTP error) keeps the old behaviour
{
  failures.push({ task: 'OUTPUTS', status: 401, message: 'G refused access (401): invalid API key.' });
  const e = await pauses(() => run('c1', 10, { title: 'CODEDEMO' }));
  assert.equal(e.info.stage, 'outputs');
  assert.equal(e.info.status, 401);
  const r = await run('c1', 10, { title: 'CODEDEMO', skipStages: ['outputs'] });
  assert.ok(!/\*\*Output:\*\*/.test(r.summary_markdown));
  failures.length = 0;
  // an unreadable reply (no HTTP error) is asked once more, then PAUSES too: no AI step is skipped silently
  failures.push({ task: 'OUTPUTS', message: 'The AI did not return valid JSON.' }); // no status
  const e2 = await pauses(() => run('c2', 10, { title: 'CODEDEMO' }));
  assert.equal(e2.info.stage, 'outputs');
  assert.match(e2.info.reason, /unusable answer twice/);
  assert.equal(calls.filter((c) => c.task === 'OUTPUTS').length, 2, 'asked once more before pausing');
  failures.length = 0;
  const r2 = await run('c2', 10, { title: 'CODEDEMO' }); // resumes and finishes once the model answers
  assert.match(r2.summary_markdown, /\*\*Output:\*\*/);
  failures.length = 0;
  console.log('outputs pause / skip / unreadable ok');
}

// every stage table entry names a known slot, and skippable ones say what skipping does
for (const [id, s] of Object.entries(STAGE)) {
  assert.ok(['stt', 'vision', 'cheap', 'strong', 'digest', 'practice'].includes(s.slot), id);
  if (s.skip) assert.ok(s.skipNote, `${id} needs a skip note`);
}
console.log('pause ok');

// advice for the dialog depends on what failed
{
  const { adviceFor } = await import('./lib/stagefix.js');
  assert.match(adviceFor({ status: 404, reason: 'x', slot: 'strong' }), /does not know this model/);
  assert.match(adviceFor({ status: 404, reason: 'No endpoints found that support image input', slot: 'vision' }), /cannot read pictures/);
  assert.match(adviceFor({ status: 429, reason: 'x', slot: 'cheap' }), /rate or quota/);
  assert.match(adviceFor({ status: 401, reason: 'x', slot: 'strong' }), /API key/);
  assert.match(adviceFor({ status: 503, reason: 'x', slot: 'strong' }), /problem on its side/);
  assert.match(adviceFor({ status: 0, reason: 'x', slot: 'strong' }), /could not be reached/);
  assert.match(adviceFor({ status: null, reason: 'x', slot: 'stt' }), /Whisper/);
  console.log('advice ok');
}
