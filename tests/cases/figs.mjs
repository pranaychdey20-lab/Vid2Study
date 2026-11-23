// The Strong AI's figure list: the 10 attached pictures keep their inline [[FRAME]] markers; EXTRA frames (described only) are shown
// only when the Strong AI lists them, in one compact line after the notes that the code places.
globalThis.chrome = { runtime: { getURL: (p) => p } };
globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close() {} });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb(new Blob([new Uint8Array(10)])) }) };
const assert = (await import('node:assert')).default;
const lp = await import('./lib/local-pipeline.js');
const pr = await import('./lib/prompts.js');
const { getResult, putDraft, putFrame } = await import('./lib/db.js');
const { calls } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

// ---- reading the line
{
  const r = lp.takeFigs('## Detailed notes\n### A\n- x\n<!--FIGS 12@2|Entente Cordiale in 1904; F14@3 ;20@5|November 9;12@4;bad;7-->\n<!--NEEDS practice=no-->');
  assert.deepEqual(r.figs, [{ n: 12, topic: 2, words: 'Entente Cordiale in 1904' }, { n: 14, topic: 3, words: '' }, { n: 20, topic: 5, words: 'November 9' }], 'a frame once, junk entries skipped');
  assert.ok(!/FIGS/.test(r.md) && /NEEDS/.test(r.md), 'only the figure line is removed');
  assert.deepEqual(lp.takeFigs('no list here').figs, []);
  assert.equal(lp.takeFigs('a\n<!--FIGS 1@1-->\nb\n<!--FIGS 2@1-->').figs[0].n, 2, 'the last list wins');
  console.log('takeFigs ok');
}

// ---- placing the frames
{
  const notes = '## Detailed notes\n\n### Alliances (00:00)\n- **Big idea:** two blocs\n- **Key points:**\n    - In 1882 the Triple Alliance formed.\n        - Germany, Italy and Austria-Hungary.\n    - Britain and France signed the Entente Cordiale in 1904.\n> **Example:** an example\n\n### The spark (00:50)\n- **Big idea:** a murder\n- **Key points:**\n    - The Black Hand struck in 1914.\n';
  const out = lp.applyFigs(notes, [{ n: 3, topic: 1, words: 'Triple Alliance formed' }, { n: 4, topic: 1, words: '' }, { n: 5, topic: 2, words: 'Black Hand struck' }, { n: 6, topic: 9, words: 'nothing matches this at all' }, { n: 7, topic: 1, words: '' }]);
  const at = (n) => out.indexOf(`[[FRAME:${n}]]`);
  assert.ok(at(3) > out.indexOf('Germany, Italy and Austria-Hungary.') && at(3) < out.indexOf('Britain and France'), 'after the whole bullet, its sub-bullet too');
  assert.ok(at(4) > out.indexOf('Entente Cordiale') && at(4) < out.indexOf('> **Example:**'), 'no words: end of the topic points, before its first callout');
  assert.ok(at(7) > at(4) && at(7) < out.indexOf('> **Example:**'), 'same place: the listed order is kept');
  assert.ok(at(5) > out.indexOf('The Black Hand struck'), 'second topic');
  assert.ok(at(6) > out.indexOf('### The spark'), 'a topic number out of range goes to the nearest topic, words that match nothing to its end');
  assert.equal(lp.applyFigs('no topics', [{ n: 1, topic: 1 }]), 'no topics');
  console.log('applyFigs ok');
}

// ---- the prompt keeps the two groups apart
{
  const base = { kind: 'speech', body: 'x', title: 't', course: 'c', detail: 'standard', full: true, code: {}, frameBudget: 5, frameIds: 'F1, F2, F3' };
  const withPics = pr.writePrompt({ ...base, pictures: [{ id: 1, time: '00:01' }] });
  assert.match(withPics, /A\) THE ATTACHED PICTURES[\s\S]*Put \[\[FRAME:n\]\] on its own line/);
  assert.match(withPics, /B\) EVERY OTHER offered frame[\s\S]*ONLY IF YOU find it necessary[\s\S]*Never write a \[\[FRAME\]\] marker for an extra[\s\S]*<!--FIGS 12@2\|/);
  assert.match(withPics, /choosing none is fine/);
  const noPics = pr.writePrompt(base);
  assert.ok(!/A\) THE ATTACHED/.test(noPics) && /Put \[\[FRAME:n\]\] on its own line/.test(noPics), 'no pictures attached: the old rule for every frame');
  console.log('prompt groups ok');
}

// ---- end to end: 40 frames, the fake vision model keeps 14, 10 are attached, 4 are extras, the fake writer picks 2 extras
{
  const settings = normalizeSettings({
    providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
    strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' },
    useVision: true, practiceQuestions: false, webSearch: false, researchReferences: false, debugDump: false
  });
  const N = 40;
  // distinct picture hashes, so the look-alike rule does not merge them
  const hash = (i) => { let x = ((i + 1) * 2654435761) % 4294967296; return Array.from({ length: 64 }, () => { x = (x * 1664525 + 1013904223) % 4294967296; return Math.floor(x / 65536) % 2 ? '1' : '0'; }).join(''); };
  const frames = Array.from({ length: N }, (_, i) => ({ index: i + 1, t: i * 40, shot: i * 40, filename: `g_${i + 1}.png`, h: hash(i) }));
  for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) { let d = 0; for (let b = 0; b < 64; b++) if (frames[i].h[b] !== frames[j].h[b]) d++; assert.ok(d > 6, `hashes ${i}/${j} differ by ${d}`); }
  const segs = Array.from({ length: 80 }, (_, i) => ({ start: i * 20, end: i * 20 + 15, text: `and then the story goes on and on about the wall number ${i}` }));
  for (const f of frames) await putFrame(`fg1/${f.filename}`, new Blob([new Uint8Array(20)]));
  const ocr = {}, kind = {};
  for (const f of frames) { ocr[f.index] = { text: '', words: 0, conf: 0 }; kind[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
  await putDraft({ key: 'fg1', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 1600, samples: 800, read: 700 }, technical: false, videoKind: { technical: false, kind: 'history' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'fg1', title: 'FIGSTEST', course: 'C', settings, signal: new AbortController().signal, onProgress() {} });
  const w = calls.find((c) => c.task === 'WRITE').prompt;
  const attached = [...(/PICTURES \(attached[^\n]*/.exec(w)?.[0] || '').matchAll(/= F(\d+) at/g)].map((m) => Number(m[1]));
  const offered = [...(/Frames you may use: ([^\n]*)/.exec(w)?.[1] || '').matchAll(/F(\d+)/g)].map((m) => Number(m[1]));
  const extras = offered.filter((n) => !attached.includes(n));
  assert.equal(attached.length, 10, 'the top 10 are attached, as before');
  assert.ok(extras.length >= 2, 'and the rest are offered as described extras: ' + extras.length);
  const r = await getResult('fg1');
  const shown = new Set(r.frames.map((f) => f.index));
  for (const n of attached) assert.ok(shown.has(n), `attached F${n} is shown (the one the writer placed, and the important ones the code adds, as before)`);
  assert.ok(shown.has(extras[0]) && shown.has(extras[1]), 'the two extras the writer listed are shown');
  for (const n of extras.slice(2)) assert.ok(!shown.has(n), `extra F${n} was not chosen, so it is not shown`);
  assert.ok(!/<!--\s*FIGS|\[\[FRAME/.test(r.summary_markdown), 'no raw list or marker leaks into the notes');
  assert.ok(r.summary_markdown.indexOf('first point here') < r.summary_markdown.indexOf('a sub bullet'), 'sanity');
  console.log('extras only when the writer lists them ok; shown', r.frames.length, 'of', offered.length);
}
