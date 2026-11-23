// Model pools: the Cheap AI is a pool (any number of fallbacks), the Strong AI a pool of at most two.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const { runLocalPipeline, StageError } = await import('./lib/local-pipeline.js');
const { getResult } = await import('./lib/db.js');
const { calls, failures } = await import('./lib/llm.js');
const { normalizeSettings, slotRef } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

const providers = [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }, { id: 'o', type: 'openai', name: 'O', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }];
const base = { providers, strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'o', model: 'small' }, practiceQuestions: false, debugDump: false, researchReferences: false };
const mk = (min) => { let s = ''; for (let t = 0; t < min * 60; t += 20) s += `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}] word ${t} blah blah\n`; return s; };
const run = async (key, min, set) => {
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key, title: 'T', course: 'C', settings: set, signal: new AbortController().signal, onProgress() {}, transcript: mk(min) });
  return getResult(key);
};

// ---- the settings: the pool in order, unknown providers dropped, the Strong AI has ONE fallback
{
  const s = normalizeSettings({ ...base, cheapPool: [{ provider: 'o', model: 'small2' }, { provider: 'nope', model: 'x' }, { provider: 'g', model: 'flash' }, { provider: 'o', model: '' }], strongFallback: { provider: 'g', model: 'BIG2' } });
  assert.deepEqual(s.cheapPool.map((r) => r.model), ['small2', 'flash']);
  const c = slotRef(s, 'cheap');
  assert.equal(c.model, 'small'); assert.deepEqual(c.pool.map((r) => r.model), ['small2', 'flash']);
  assert.deepEqual(slotRef(s, 'vision').pool.map((r) => r.model), ['small2', 'flash'], 'an empty Vision slot uses the whole Cheap pool');
  assert.equal(slotRef(s, 'vision').model, 'small');
  const st = slotRef(s, 'strong');
  assert.equal(st.model, 'BIG'); assert.deepEqual(st.pool.map((r) => r.model), ['BIG2']);
  assert.equal(slotRef(normalizeSettings({ ...base, vision: { provider: 'g', model: 'V' }, cheapPool: [{ provider: 'o', model: 'small2' }] }), 'vision').pool.length, 0, 'an explicit Vision model has no pool');
  const noCheap = slotRef(normalizeSettings({ providers, strong: base.strong, strongFallback: { provider: 'g', model: 'BIG2' } }), 'cheap');
  assert.equal(noCheap.model, 'BIG'); assert.deepEqual(noCheap.pool.map((r) => r.model), ['BIG2'], 'no Cheap AI: the Strong pool');
  console.log('pool settings ok');
}

// ---- a failing cheap model: the next one in the pool answers, the job does not pause
{
  failures.push({ model: 'small', status: 500, message: 'small is down' });
  const set = normalizeSettings({ ...base, cheapPool: [{ provider: 'o', model: 'small2' }], writeFullTranscript: true });
  const r = await run('p1', 200, set);
  assert.ok(r?.summary_markdown, 'finished without pausing');
  const fin = calls.filter((c) => c.task === 'FINAL').map((c) => c.model);
  assert.ok(fin.includes('small') && fin.includes('small2'), 'tried the first, then the next: ' + fin);
  failures.length = 0;
  console.log('cheap fallback ok');
}

// ---- a model that is plainly unusable (404) is skipped for the rest of the run
{
  failures.push({ model: 'small', status: 404 });
  const set = normalizeSettings({ ...base, cheapPool: [{ provider: 'o', model: 'small2' }], writeFullTranscript: false });
  const r = await run('p2', 200, set);
  assert.ok(r?.summary_markdown);
  assert.ok(calls.filter((c) => c.task === 'CHUNK').length >= 10);
  const tried = calls.filter((c) => c.model === 'small').length;
  assert.ok(tried <= 3 && tried < calls.filter((c) => c.task === 'CHUNK').length, 'only the calls already in flight (3 at a time) tried it, the rest skipped it: ' + tried);
  failures.length = 0;
  console.log('dead model skipped ok');
}

// ---- the Strong AI's second model writes when the first fails
{
  failures.push({ model: 'BIG', status: 429, message: 'quota' });
  const set = normalizeSettings({ ...base, strongFallback: { provider: 'g', model: 'BIG2' } });
  const r = await run('p3', 20, set);
  assert.ok(r?.summary_markdown);
  assert.deepEqual(calls.filter((c) => c.task === 'WRITE').map((c) => c.model), ['BIG', 'BIG2']);
  failures.length = 0;
  console.log('strong fallback ok');
}

// ---- every model in the pool fails: the job pauses, naming the first one
{
  failures.push({ model: 'small', status: 500 }, { model: 'small2', status: 500 });
  const set = normalizeSettings({ ...base, cheapPool: [{ provider: 'o', model: 'small2' }], writeFullTranscript: true });
  let e = null;
  try { await run('p4', 200, set); } catch (x) { e = x; }
  assert.ok(e instanceof StageError, 'paused');
  assert.equal(e.info.stage, 'overview'); assert.equal(e.info.model, 'small');
  failures.length = 0;
  console.log('pool exhausted pauses ok');
}
