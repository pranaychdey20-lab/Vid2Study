// The two-call vision flow: SCREEN (all frames, low quality) -> DESCRIBE (survivors, high quality, 1-3 calls).
globalThis.chrome = { runtime: { getURL: (p) => p } };
// a canvas that "encodes" every picture as 10 bytes: jpegB64 works without a browser
globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close() {} });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb(new Blob([new Uint8Array(10)])) }) };
const assert = (await import('node:assert')).default;
const lp = await import('./lib/local-pipeline.js');
const { getResult, putDraft, putFrame, getFrame } = await import('./lib/db.js');
const { calls } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

// ---- pure helpers
assert.deepEqual([1, 100, 101, 200, 201, 300, 450, 3000].map(lp.describeCalls), [1, 1, 2, 2, 2, 2, 2, 2], 'at most 2 describe calls, however many frames');
assert.equal(lp.describeWords(100), 150); assert.ok(lp.describeWords(300) < 60 && lp.describeWords(300) >= 25, 'more frames per call = shorter descriptions');
const dg = lp.parseDigest('=== BRIEF ===\nabout gods\n=== TIMELINE ===\n[00:01] long enough timeline line here', '[00:01] x');
assert.equal(dg.brief, 'about gods'); assert.match(dg.lines, /^\[00:01\] long/);
assert.equal(lp.parseDigest('', '[00:01] original').lines, '[00:01] original', 'an empty reply keeps the original lines');
assert.deepEqual(lp.splitEven([1, 2, 3, 4, 5, 6, 7], 3).map((g) => g.length), [2, 2, 3]);
assert.deepEqual(lp.splitEven([1], 3), [[1]]);
const p = lp.packByBudget([{ bytes: 6 }, { bytes: 6 }, { bytes: 6 }, { bytes: 30 }], { maxCount: 10, maxBytes: 14 });
assert.deepEqual(p.map((g) => g.length), [2, 1, 1], 'a request never exceeds the size budget (an oversized one goes alone)');
const sc = lp.readScreen('{"keep":[{"id":"F3","kind":"deity","info":7,"label":"Shiva"},{"id":"F9","kind":"x"}],"drop":"F4:dup F5:blur, F6=title"}', [3, 4, 5, 6]);
assert.deepEqual(Object.keys(sc.keep), ['3']);
assert.equal(sc.keep[3].kind, 'illustration', 'artwork-like kinds are pictures, not rejects');
assert.equal(sc.drop[4], 'dup'); assert.equal(sc.drop[5], 'blur'); assert.equal(sc.drop[6], 'title');
// a different god marked as "same_as" another is only dropped when that other frame really is kept
const v = lp.readVerdicts(JSON.stringify({ frames: [{ id: 'F1', keep: true, kind: 'statue', info: 6, same_as: 'F2' }, { id: 'F2', keep: true, kind: 'deity', info: 7 }, { id: 'F3', keep: true, kind: 'photo', info: 5, same_as: 'F99' }] }), [{ index: 1 }, { index: 2 }, { index: 3 }]);
assert.equal(v[2].keep, true);
assert.equal(v[1].keep, false);
assert.match(v[1].reason, /same as F2/);
assert.equal(v[3].keep, true, 'a claim about a frame that is not there is ignored');
assert.equal(v[1].kind, 'illustration');
assert.equal(lp.readVerdicts('{"frames":[{"id":"F1","keep":false,"kind":"photo","info":1}]}', [{ index: 1 }], { force: true })[1].keep, false);
assert.equal(lp.readVerdicts('{"frames":[{"id":"F1","kind":"other","info":0}]}', [{ index: 1 }], { force: true })[1].keep, true, 'describe call: only an explicit keep=false drops');
// picture-based merging is off for non-technical videos
const F = (i, t, o = {}) => ({ index: i, t, words: 0, text: '', kinds: [], h: '0'.repeat(64), mh: '0'.repeat(64), eb: '1'.repeat(576), ...o });
assert.equal(lp.mergeRepeats([F(1, 0), F(2, 30)], 12, { boards: false }).length, 2, 'two paintings are never merged by their picture');
assert.ok(lp.mergeRepeats([F(1, 0), F(2, 30)], 12).length < 2, 'technical boards still are');
assert.ok(lp.fitTranscript(Array.from({ length: 100 }, (_, i) => ({ start: i, end: i + 1, text: 'word '.repeat(40) })), 500).length < 100);
console.log('vision helpers ok');

// ---- the whole flow with a seeded draft: 60 frames of a story video
const settings = normalizeSettings({
  providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
  strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' },
  useVision: true, practiceQuestions: false, webSearch: false, debugDump: true
});
const N = 60;
const frames = Array.from({ length: N }, (_, i) => ({ index: i + 1, t: i * 20, shot: i * 20, filename: `scene_${i + 1}.png`, h: '0'.repeat(64) }));
const segs = Array.from({ length: 70 }, (_, i) => ({ start: i * 17, end: i * 17 + 15, text: `the story goes on and on about gods number ${i}` }));
for (const f of frames) await putFrame(`dv1/${f.filename}`, new Blob([new Uint8Array(20)]));
const ocr = {}, kind = {};
for (const f of frames) { ocr[f.index] = { text: '', words: 0, conf: 0 }; kind[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
await putDraft({ key: 'dv1', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 1200, samples: 600, read: 300 }, technical: false, videoKind: { technical: false, kind: 'religion' }, skip: {} });
calls.length = 0;
await lp.runLocalPipeline({ mode: 'video', key: 'dv1', title: 'Gods', course: 'C', settings, signal: new AbortController().signal, onProgress() {} });
const screens = calls.filter((c) => c.task === 'SCREEN'), described = calls.filter((c) => c.task === 'DESCRIBE');
assert.equal(screens.length, 1, 'all 60 frames in ONE screening call');
assert.equal(described.length, 1, '20 survivors = one describe call');
assert.ok(/\[00:00\] the SUMMARY-LINE/.test(described[0].all) && /Image 1 = F1 at 00:00/.test(described[0].prompt), 'the describe call has the Transcript AI timeline and timed images');
assert.ok(calls.some((c) => c.task === 'DIGEST' && c.model === 'small'), 'the Transcript AI is always used (the Cheap AI when its own slot is empty)');
assert.ok(!calls.some((c) => c.task === 'SELECT'), 'no per-batch judge calls');
const w = calls.find((c) => c.task === 'WRITE');
assert.ok(/detail of 1\b|cap 1\b/.test(w.all), 'the described frames reach the writer (in the evidence file)');
assert.ok(w.attachments.length === 1 && w.attachments[0].name === 'lecture-evidence.txt' && !/detail of 1\b/.test(w.prompt), 'the evidence is a file, the rules are the message');
assert.equal(await getFrame('dv1/scene_2.png'), null, 'a rejected frame has its full-size copy deleted');
const r = await getResult('dv1');
assert.ok(r.debug.includes('SCREEN') && r.debug.includes('DESCRIBE'));
console.log('two-call vision flow ok:', calls.map((c) => c.task).join(','));

// ---- 330 frames: all distinct captures reach description in bounded calls.
{
  const M = 330;
  const fr = Array.from({ length: M }, (_, i) => ({ index: i + 1, t: i * 10, shot: i * 10, filename: `s_${i + 1}.png`, h: '0'.repeat(64) }));
  for (const f of fr) await putFrame(`dv2/${f.filename}`, new Blob([new Uint8Array(20)]));
  const o2 = {}, k2 = {};
  for (const f of fr) { o2[f.index] = { text: '', words: 0, conf: 0 }; k2[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
  await putDraft({ key: 'dv2', engine: 'local', warnings: [], ocr: o2, kind: k2, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames: fr, duration: 3300, samples: 1600, read: 900 }, technical: false, videoKind: { technical: false, kind: 'religion' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'dv2', title: 'Gods 2', course: 'C', settings: { ...settings, screenInPerHour: 1500 }, signal: new AbortController().signal, onProgress() {} });
  const d = calls.filter((c) => c.task === 'DESCRIBE');
  assert.equal(calls.filter((c) => c.task === 'SCREEN').length, 1, '330 small frames still fit ONE screening call');
  assert.equal(d.length, 2, '330 frames -> 2 describe calls');
  const tr = (p) => p.slice(p.indexOf('TRANSCRIPT'));
  assert.equal(tr(d[0].prompt), tr(d[1].prompt), 'every call gets the same transcript');
  const ids = d.map((c) => [...c.prompt.matchAll(/Image \d+ = F(\d+) at/g)].map((m) => Number(m[1])));
  assert.equal(ids[0].length + ids[1].length, 330);
  assert.ok(Math.max(...ids[0]) < Math.min(...ids[1]), 'consecutive time ranges, each frame with its time');
  console.log('describe split ok', ids.map((x) => x.length));
}

// ---- with the Transcript summary AI: it runs FIRST; its brief goes to screening, its timeline to describing, the writer gets the raw transcript
{
  const withDigest = normalizeSettings({
    providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
    strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' }, digest: { provider: 'g', model: 'DIGESTM' },
    useVision: true, practiceQuestions: false, webSearch: false, debugDump: true
  });
  for (const f of frames) await putFrame(`dv3/${f.filename}`, new Blob([new Uint8Array(20)]));
  await putDraft({ key: 'dv3', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 1200, samples: 600, read: 300 }, technical: false, videoKind: { technical: false, kind: 'religion' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'dv3', title: 'Gods 3', course: 'C', settings: withDigest, signal: new AbortController().signal, onProgress() {} });
  const order = calls.map((c) => c.task);
  assert.ok(order.indexOf('DIGEST') >= 0 && order.indexOf('DIGEST') < order.indexOf('SCREEN'), 'the summary AI runs before the screening call');
  assert.ok(calls.filter((c) => c.task === 'DIGEST').every((c) => c.model === 'DIGESTM'));
  assert.ok(/BRIEF-LINE/.test(calls.find((c) => c.task === 'SCREEN').prompt), 'the brief goes to the screening call');
  const d = calls.find((c) => c.task === 'DESCRIBE').all;
  assert.ok(/SUMMARY-LINE/.test(d.slice(d.indexOf('TRANSCRIPT'))) && !/story goes on/.test(d), 'the timeline goes to the describing call');
  const w = calls.find((c) => c.task === 'WRITE').all;
  assert.ok(/story goes on/.test(w) && !/SUMMARY-LINE/.test(w), 'the writer reads the raw trimmed transcript');
  console.log('summary AI before screening ok');
}

// ---- an empty Vision slot uses the Cheap AI
{
  const { slotRef } = await import('./lib/settings.js');
  const s = normalizeSettings({ providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }], strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' } });
  assert.equal(slotRef(s, 'vision').model, 'small');
  assert.equal(slotRef(normalizeSettings({ providers: s.providers, strong: s.strong }), 'vision').model, 'BIG', 'no Cheap AI either: the Strong AI');
  console.log('vision slot fallback ok');
}

// ---- request size budget: Gemini ~85 MB, other services ~17 MB, overridable
{
  assert.equal(lp.requestBudget({ maxRequestMB: 0 }, { type: 'gemini' }), 85e6);
  assert.equal(lp.requestBudget({ maxRequestMB: 0 }, { type: 'openai' }), 17e6);
  assert.equal(lp.requestBudget({ maxRequestMB: 40 }, { type: 'gemini' }), 40e6);
  const imgs = Array.from({ length: 3000 }, () => ({ bytes: 20000 })); // 3000 small frames, ~60 MB
  assert.equal(lp.packByBudget(imgs, { maxCount: 3000, maxBytes: lp.requestBudget({}, { type: 'gemini' }) }).length, 1, 'all 3000 in one Gemini call');
  assert.ok(lp.packByBudget(imgs, { maxCount: 3000, maxBytes: lp.requestBudget({}, { type: 'openai' }) }).length > 1, 'a smaller-limit service splits');
  console.log('request budget ok');
}

// ---- ONE Transcript AI call set gives the brief, the timeline AND the video type; its first call carries 6 frames; no separate type call
{
  const s4 = normalizeSettings({
    providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
    strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' },
    useVision: true, practiceQuestions: false, webSearch: false, debugDump: true
  });
  for (const f of frames) await putFrame(`dv4/${f.filename}`, new Blob([new Uint8Array(20)]));
  // no technical / videoKind in the draft: the Transcript AI decides the type
  await putDraft({ key: 'dv4', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 1200, samples: 600, read: 300 }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'dv4', title: 'Gods 4', course: 'C', settings: s4, signal: new AbortController().signal, onProgress() {} });
  const dig = calls.filter((c) => c.task === 'DIGEST');
  assert.equal(dig.length, 1, 'a 20 min video = one Transcript AI call');
  assert.equal(dig[0].images, 6, 'up to 6 frames from the start to the end of the video go with it');
  assert.ok(dig[0].prompt.includes('=== TYPE ==='));
  assert.ok(!calls.some((c) => c.task === 'CLASSIFY'), 'no separate video type call');
  assert.ok(/NOT A TECHNICAL LECTURE/.test(calls.find((c) => c.task === 'SCREEN').prompt), 'the type it gave steers the screening');
  assert.ok(/BRIEF-LINE/.test(calls.find((c) => c.task === 'SCREEN').prompt));
  const r4 = await getResult('dv4');
  assert.ok(/Transcript AI/.test(r4.debug));
  // parseDigest reads the type, and an old Video type model carries over to the Transcript AI
  assert.equal(lp.parseDigest('=== BRIEF ===\nb\n=== TIMELINE ===\n[00:01] long enough timeline line here\n=== TYPE ===\n{"technical": true, "kind": "lecture", "subject": "robotics"}', '[00:01] x').type.subject, 'robotics');
  const mig = normalizeSettings({ providers: s4.providers, strong: s4.strong, classify: { provider: 'g', model: 'OLDTYPE' } });
  assert.equal(mig.digest.model, 'OLDTYPE'); assert.equal(mig.classify, undefined);
  console.log('Transcript AI: brief + timeline + type ok');
}

// ---- code screening before the screening AI: capCandidates spreads the cut over the whole video
{
  const L = Array.from({ length: 400 }, (_, i) => ({ index: i + 1, t: i * 9, kinds: [], words: 0 }));
  const cut = lp.capCandidates(L, 100);
  assert.equal(cut.length, 100);
  assert.ok(cut[0].t < 100 && cut[99].t > 3400, 'spread over the whole video, not just the first frames');
  const withFlag = L.map((f) => (f.index === 203 ? { ...f, kinds: ['diagram'], score: 0.9 } : f));
  assert.ok(lp.capCandidates(withFlag, 100).some((f) => f.index === 203), 'a flagged frame wins its slice');
  assert.equal(lp.capCandidates(L.slice(0, 50), 100).length, 50, 'under the cap: nothing is cut');
  assert.deepEqual(lp.capCandidates(L, 100).map((f) => f.t), [...lp.capCandidates(L, 100).map((f) => f.t)].sort((a, b) => a - b), 'in time order');
  console.log('capCandidates ok');
}

// ---- 330 frames: the request includes every distinct capture, each labelled independently.
{
  const M = 330;
  const fr = Array.from({ length: M }, (_, i) => ({ index: i + 1, t: i * 10, shot: i * 10, filename: `c_${i + 1}.png`, h: '0'.repeat(64) }));
  for (const f of fr) await putFrame(`dv5/${f.filename}`, new Blob([new Uint8Array(20)]));
  const o5 = {}, k5 = {};
  for (const f of fr) { o5[f.index] = { text: '', words: 0, conf: 0 }; k5[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
  await putDraft({ key: 'dv5', engine: 'local', warnings: [], ocr: o5, kind: k5, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames: fr, duration: 3300, samples: 1600, read: 900 }, technical: false, videoKind: { technical: false, kind: 'religion' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'dv5', title: 'Gods 5', course: 'C', settings, signal: new AbortController().signal, onProgress() {} });
  const sc = calls.find((c) => c.task === 'SCREEN');
  const listed = [...sc.prompt.matchAll(/Image \d+ = F(\d+) at/g)].map((m) => Number(m[1]));
  assert.equal(listed.length, M);
  assert.equal(sc.images, M);
  assert.match(sc.labels[0], /^F\d+ at 00:00 \(on screen ~\d+ s\):$/, 'each image is preceded by its own id, time and how long it stays on screen');
  assert.ok(sc.labels.every((l, i) => l.startsWith('F' + listed[i] + ' at ')), 'labels match the prompt order exactly');
  const dsc = calls.filter((c) => c.task === 'DESCRIBE');
  for (const d of dsc) assert.ok(d.labels.every((l) => /^F\d+ at \d\d:\d\d/.test(l)), 'describing calls label every image too');
  console.log('complete screen review and labels ok');
}

// ---- animation: when the code must cut, the state that stays on screen longest wins its slice (not the earliest)
{
  // a map drawn in 4 steps, 2 s apart; the last state stays 40 s. All rank the same. A cap of 1 per slice keeps ONE of them.
  const anim = [0, 2, 4, 6].map((t, i) => ({ index: i + 1, t, kinds: [], words: 0, dwell: i < 3 ? 2 : 40 }));
  const far = { index: 9, t: 300, kinds: [], words: 0, dwell: 30 };
  const rank = (f) => lp.codeRank(f, 12) + Math.min(0.9, (f.dwell || 0) / 60);
  const kept = lp.capCandidates([...anim, far], 2, rank);
  assert.ok(kept.some((f) => f.index === 4), 'the finished (longest on screen) state of the animation is the one kept');
  assert.ok(!kept.some((f) => f.index === 1), 'not the first, half-drawn state');
  assert.equal(lp.onScreen(2), ' (on screen ~2 s)'); assert.equal(lp.onScreen(undefined), '');
  const pr = await import('./lib/prompts.js');
  const sp = pr.screenPrompt({ title: 'T', frames: [{ id: 'F1', time: '00:05', dwell: 2 }], cap: 3 });
  assert.match(sp, /Image 1 = F1 at 00:05 \(on screen ~2 s\)/);
  assert.match(sp, /unfinished>Fn/); assert.match(sp, /Opening artwork is a title only when/); assert.match(sp, /TEXT ON SCREEN IS CONTENT/);
  assert.match(sp, /NEVER dropped for these two reasons/);
  console.log('animation state + intro rules ok');
}
