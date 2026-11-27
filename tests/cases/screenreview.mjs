// The screening review: the Berlin Wall run (46 frames) lost 17 frames as "unfinished" (one on screen 24 s), kept early states
// instead of the settled copy, dropped a "WORLD WAR II" caption with its frame, and ranked the opening quote below every picture.
globalThis.chrome = { runtime: { getURL: (p) => p } };
globalThis.createImageBitmap = async () => ({ width: 640, height: 360, close() {} });
globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({ drawImage() {} }), toBlob: (cb) => cb(new Blob([new Uint8Array(10)])) }) };
const assert = (await import('node:assert')).default;
const lp = await import('./lib/local-pipeline.js');
const { getResult, putDraft, putFrame } = await import('./lib/db.js');
const { calls } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

// ---- the reply format: the reason AND the kept frame that replaces the dropped one
{
  const r = lp.readScreen('{"keep":[{"id":"F19","kind":"epigraph","info":7,"label":"q"}],"drop":"F20:dup>F19 F29:unfinished>F31 F5:blur, F6=title F7:dup (F19)"}', [5, 6, 7, 19, 20, 29, 31]);
  assert.equal(r.keep[19].kind, 'quote', 'epigraph / citation / statement = quote');
  assert.deepEqual([r.drop[20], r.into[20]], ['dup', 19]);
  assert.deepEqual([r.drop[29], r.into[29]], ['unfinished', 31]);
  assert.equal(r.drop[5], 'blur'); assert.equal(r.into[5], undefined); assert.equal(r.drop[6], 'title');
  assert.deepEqual([r.drop[7], r.into[7]], ['dup', 19]);
  console.log('screen reply format ok');
}

// ---- fixScreen with the real numbers from the run
{
  const H = '0'.repeat(64), far = '1'.repeat(64);
  const info = {
    19: { t: 152, dwell: 4, h: H }, 20: { t: 156, dwell: 8, h: H },           // Stasi: kept the 4 s state, dropped the 8 s settled one
    29: { t: 234, dwell: 24, h: H }, 31: { t: 260, dwell: 8, h: H },          // "unfinished" but on screen 24 s
    15: { t: 112, dwell: 6, h: H }, 16: { t: 122, dwell: 12, h: H },
    40: { t: 328, dwell: 8, h: far },                                         // "unfinished", replacement is a different picture
    50: { t: 400, dwell: 8, h: H },                                           // a dup without any replacement named
    60: { t: 500, dwell: 3, h: H }, 61: { t: 470, dwell: 8, h: H },           // "unfinished" by an EARLIER frame: nonsense
    5: { t: 40, dwell: 8, h: H }, 6: { t: 48, dwell: 8, h: H }
  };
  const keep = { 19: { kind: 'illustration', info: 7, label: 'phone' }, 31: { kind: 'illustration', info: 7, label: 'balloon' }, 16: { kind: 'illustration', info: 5, label: 'beach' }, 42: { kind: 'illustration', info: 8, label: 'crowd' }, 61: { kind: 'illustration', info: 6, label: 'x' } };
  const drop = { 20: 'dup', 29: 'unfinished', 15: 'unfinished', 40: 'unfinished', 50: 'dup', 60: 'unfinished', 5: 'blur', 6: 'title' };
  const into = { 20: 19, 29: 31, 15: 16, 40: 42, 60: 61 };
  const f = lp.fixScreen({ keep, drop, into }, info);
  assert.deepEqual(f.swapped, [[19, 20]], 'the 8 s settled copy replaces the 4 s early copy');
  assert.ok(f.keep[20] && !f.keep[19] && /longer-lasting F20/.test(f.drop[19]));
  assert.ok(f.rescued.includes(29), 'unfinished but on screen 24 s: rescued');
  assert.ok(f.rescued.includes(40), 'replaced by a different picture: rescued');
  assert.ok(f.rescued.includes(50), 'a dup that names no replacement: rescued');
  assert.ok(f.rescued.includes(60), 'a state is never replaced by an earlier frame');
  assert.ok(!f.rescued.includes(15) && f.drop[15] === 'unfinished', 'a 6 s state replaced by the later, settled F16 stays dropped');
  assert.equal(f.drop[5], 'blur'); assert.equal(f.drop[6], 'title'); assert.ok(!f.keep[5] && !f.keep[6], 'hard reasons are left alone');
  console.log('fixScreen ok');
}

// ---- text on screen is content in a story video: the quote and the statistic rank as important
{
  const story = (f) => lp.framePriority(f, { technical: false });
  assert.ok(story({ tag: 'quote', score: 0.4, dwell: 8, words: 18 }) >= lp.IMPORTANT_PRIORITY, 'the opening quote (info 4 from the run) is important');
  assert.ok(story({ tag: 'slide', score: 0.7, dwell: 8, words: 3 }) >= lp.IMPORTANT_PRIORITY, 'the "3.5 million, 20%" slide is important');
  assert.ok(lp.framePriority({ tag: 'slide', score: 0.7, dwell: 8, words: 3 }, { technical: true }) < lp.IMPORTANT_PRIORITY, 'a plain slide in a technical lecture stays ordinary');
  assert.equal(lp.readVerdicts('{"frames":[{"id":"F1","kind":"quotation","info":8}]}', [{ index: 1 }])[1].kind, 'quote');
  console.log('quote weight ok');
}

// ---- the writer still gets what OCR read off a frame that was dropped as a "title" (a "WORLD WAR II" caption)
{
  const settings = normalizeSettings({
    providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
    strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' },
    useVision: true, practiceQuestions: false, webSearch: false, debugDump: false
  });
  const N = 12;
  const frames = Array.from({ length: N }, (_, i) => ({ index: i + 1, t: i * 20, shot: i * 20, filename: `r_${i + 1}.png`, h: '0'.repeat(64) }));
  const segs = Array.from({ length: 40 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: `and then the story goes on about the war number ${i}` }));
  for (const f of frames) await putFrame(`sr1/${f.filename}`, new Blob([new Uint8Array(20)]));
  const ocr = {}, kind = {};
  for (const f of frames) { ocr[f.index] = { text: '', words: 0, conf: 0 }; kind[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
  ocr[5] = { text: 'WORLD WAR II', words: 3, conf: 66 }; // frame 5 is dropped as a "title" by the fake model (every 5th)
  ocr[10] = { text: 'LESSON BANNER', words: 2, conf: 20 }; // too unsure: not passed on
  await putDraft({ key: 'sr1', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 240, samples: 120, read: 100 }, technical: false, videoKind: { technical: false, kind: 'history' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'sr1', title: 'War', course: 'C', settings, signal: new AbortController().signal, onProgress() {} });
  const w = calls.find((c) => c.task === 'WRITE').all;
  assert.match(w, /ON SCREEN F5 OCR:\nWORLD WAR II/);
  assert.ok(!/LESSON BANNER/.test(w), 'text OCR was unsure of is not passed on');
  assert.ok(await getResult('sr1'));
  assert.match(calls.find(c => c.task === 'DESCRIBE').prompt, /Image \d+ = F5 at/);
  console.log('lower-ranked-frame evidence reaches the writer');
}

// ---- a quote shown on screen is in the notes as its OWN callout (the frame itself is not needed)
{
  const Q = 'Forget not the tyranny of this wall ... nor the love of freedom that made it fall ...\n- Unknown, Graffiti on the Berlin Wall';
  const sp = lp.splitQuote(Q);
  assert.equal(sp.body, 'Forget not the tyranny of this wall ... nor the love of freedom that made it fall ...');
  assert.equal(sp.who, 'Unknown, Graffiti on the Berlin Wall');
  assert.equal(lp.splitQuote('“Be the change.” - Gandhi, attributed').who, 'Gandhi, attributed');
  const notes = '## Overview\n- o\n\n## Detailed notes\n\n### The Night Berlin Split (00:00)\n- **Big idea:** a\n- **Key points:**\n  - one\n\n### Post-WWII (00:37)\n- **Big idea:** b\n\n### The Fall (05:14)\n- **Big idea:** c\n';
  // 1. missing, an epigraph at 4 s: right under the first heading
  let md = lp.ensureQuotes(notes, [{ t: 4, text: Q }]);
  assert.match(md, /### The Night Berlin Split \(00:00\)\n> \*\*Quote:\*\* “Forget not the tyranny of this wall \.\.\. nor the love of freedom that made it fall \.\.\.” — Unknown, Graffiti on the Berlin Wall\n- \*\*Big idea:\*\* a/);
  // 2. already a callout: unchanged (no repeat)
  assert.equal(lp.ensureQuotes(md, [{ t: 4, text: Q }]), md);
  // 3. the writer buried it in a bullet: it becomes a callout of its own, words kept, nothing repeated
  const buried = notes.replace('  - one', '  - Graffiti on the wall summed up its legacy: "Forget not the tyranny of this wall ... nor the love of freedom that made it fall ..."');
  md = lp.ensureQuotes(buried, [{ t: 4, text: Q }]);
  assert.match(md, /^> \*\*Quote:\*\* Graffiti on the wall summed up its legacy: "Forget not/m);
  assert.equal(md.split('tyranny').length - 1, 1, 'said once');
  // 4. a quote shown later goes to the end of the topic it is shown in
  md = lp.ensureQuotes(notes, [{ t: 60, text: 'Those who cannot remember the past are condemned to repeat it\n- George Santayana' }]);
  const at = md.indexOf('condemned to repeat');
  assert.ok(at > md.indexOf('### Post-WWII') && at < md.indexOf('### The Fall'));
  // 5. too short to be a quote: ignored
  assert.equal(lp.ensureQuotes(notes, [{ t: 4, text: 'WORLD WAR' }]), notes);
  console.log('ensureQuotes ok');
}

// ---- the whole pipeline: the quote frame is text-only, and the callout is in the notes even though the (fake) writer ignored it
{
  const settings = normalizeSettings({
    providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }],
    strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, vision: { provider: 'g', model: 'LITE' },
    useVision: true, practiceQuestions: false, webSearch: false, debugDump: false
  });
  const N = 9;
  const frames = Array.from({ length: N }, (_, i) => ({ index: i + 1, t: i * 20, shot: i * 20, filename: `q_${i + 1}.png`, h: '0'.repeat(64) }));
  const segs = Array.from({ length: 30 }, (_, i) => ({ start: i * 6, end: i * 6 + 5, text: `and then the story goes on about the wall number ${i}` }));
  for (const f of frames) await putFrame(`sq1/${f.filename}`, new Blob([new Uint8Array(20)]));
  const ocr = {}, kind = {};
  for (const f of frames) { ocr[f.index] = { text: '', words: 0, conf: 0 }; kind[f.index] = { kinds: [], primary: 'text', score: 0, blank: false }; }
  await putDraft({ key: 'sq1', engine: 'local', warnings: [], ocr, kind, vis: {}, chunkNotes: {}, parts: {}, usage: {}, segments: segs, scan: { frames, duration: 180, samples: 90, read: 80 }, technical: false, videoKind: { technical: false, kind: 'history' }, skip: {} });
  calls.length = 0;
  await lp.runLocalPipeline({ mode: 'video', key: 'sq1', title: 'QUOTE test', course: 'C', settings, signal: new AbortController().signal, onProgress() {} });
  const w = calls.find((c) => c.task === 'WRITE').all;
  assert.match(w, /ON SCREEN \(quote\) text: Forget not the tyranny of this wall/);
  assert.ok(!/ON SCREEN F1 /.test(w), 'the quote frame is not offered as a figure');
  assert.match(w, /QUOTES \(never skip\)/);
  const r = await getResult('sq1');
  assert.match(r.summary_markdown, /> \*\*Watch Out:\*\* Frame F1 was read as: .*Forget not the tyranny/, 'unverified visual transcription is preserved with uncertainty');
  assert.ok(!r.frames.some((f) => f.index === 1), 'and no figure was made of it');
  assert.match(r.summary_markdown, /## References[\s\S]*Forget not the tyranny of this wall[^\n]*Unknown, Graffiti on the Berlin Wall/);
  assert.ok(!calls.some(c => c.task === 'REFERENCES'));
  console.log('quote callout through the pipeline ok');
}
