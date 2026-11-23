import assert from 'node:assert/strict';
const { log, clean, clip, appendLog } = await import('./lib/log.js');

// secrets never reach the stored text or data
assert.equal(clip('bad key AIzaSyA1234567890abcdefghijklmnop used').includes('AIza'), false);
assert.equal(clip('Authorization: Bearer abcdefghijklmnop').includes('abcdefghijklmnop'), false);
const c = clean({ apiKey: 'x', provider: 'gemini', status: 429, big: 'y'.repeat(1000), nested: { a: 1 } });
assert.equal('apiKey' in c, false);
assert.equal(c.status, 429);
assert.equal(c.big.length <= 303, true);
assert.equal(clean(new Error('boom')).value, 'boom');
assert.equal(clean(undefined), undefined);

// logging without an extension (tests, plain pages) must not throw
log.info('test', 'info line', { a: 1 });
log.alert('test', 'alert line');
log.error('test', 'error line', new Error('x'));

// job tagging: setJob tags this page's entries, log.job names a job explicitly (and wins)
{
  const { setJob, groupJobs } = await import('./lib/log.js');
  assert.equal(log.info('s', 'no job').job, undefined);
  setJob({ id: 'j1', title: 'Lecture A', kind: 'youtube summary' });
  const e1 = log.info('stage', 'transcribe');
  assert.equal(e1.job, 'j1');
  assert.equal(e1.jobTitle, 'Lecture A');
  const e2 = log.job({ id: 'j2', title: 'Other', kind: 'download' }).error('queue', 'boom', { status: 'failed' });
  assert.equal(e2.job, 'j2');
  assert.equal(e2.jobKind, 'download');
  setJob(null);
  assert.equal(log.info('s', 'after').job, undefined);

  // grouping: jobs newest first, entries in time order, "no job" block last, status from the queue entry
  const now = Date.now();
  const list = [
    { t: now - 9000, level: 'info', scope: 'setup', msg: 'ready' },
    { t: now - 8000, level: 'info', scope: 'queue', msg: 'queued', job: 'a', jobTitle: 'A', jobKind: 'summary' },
    { t: now - 7000, level: 'alert', scope: 'llm', msg: 'rate limit', job: 'a', jobTitle: 'A', jobKind: 'summary' },
    { t: now - 6000, level: 'error', scope: 'queue', msg: 'failed', job: 'a', jobTitle: 'A', jobKind: 'summary', data: { status: 'failed' } },
    { t: now - 5000, level: 'info', scope: 'queue', msg: 'queued', job: 'b', jobTitle: 'B', jobKind: 'download' },
    { t: now - 4000, level: 'info', scope: 'queue', msg: 'done', job: 'b', jobTitle: 'B', jobKind: 'download', data: { status: 'done' } },
    { t: now - 3000, level: 'error', scope: 'console', msg: 'stray' }
  ];
  const g = groupJobs(list);
  assert.deepEqual(g.map((j) => j.id), ['b', 'a', '']);
  assert.equal(g[0].status, 'done');
  assert.equal(g[1].status, 'failed');
  assert.deepEqual([g[1].errors, g[1].alerts, g[1].entries.length], [1, 1, 3]);
  assert.equal(g[2].entries.length, 2, 'entries without a job are collected together');
  assert.equal(groupJobs([{ t: now - 3600000, level: 'info', scope: 'queue', msg: 'x', job: 'z', jobTitle: 'Z' }])[0].status, 'interrupted');
  assert.equal(groupJobs([{ t: now - 1000, level: 'info', scope: 'queue', msg: 'x', job: 'z', jobTitle: 'Z' }])[0].status, 'running');
}

// stored list: newest kept, capped at 1500, oldest dropped
const store = { activityLog: [] };
globalThis.chrome = {
  storage: {
    local: {
      get: async (k) => ({ activityLog: store.activityLog }),
      set: async (o) => { store.activityLog = o.activityLog; }
    }
  },
  runtime: {}
};
for (let i = 0; i < 1600; i++) await appendLog({ t: i, level: 'info', scope: 's', msg: `m${i}` });
assert.equal(store.activityLog.length, 1500);
assert.equal(store.activityLog[0].msg, 'm100');
assert.equal(store.activityLog.at(-1).msg, 'm1599');
console.log('log ok');
