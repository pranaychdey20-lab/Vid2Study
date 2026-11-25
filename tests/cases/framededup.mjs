import assert from 'node:assert/strict';
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const sc = await import('./lib/scenes.js');
const lp = await import('./lib/local-pipeline.js');
const W = 160, H = 90;
const slide = (lines) => { const g = new Uint8Array(W * H).fill(240); for (const y of lines) for (let x = 10; x < 100; x++) { g[y * W + x] = 20; g[(y + 1) * W + x] = 20; } return g; };
const face = (g, v) => { const o = g.slice(); for (let y = 60; y < 88; y++) for (let x = 120; x < 158; x++) o[y * W + x] = (x + y + v) % 2 ? 30 : 220; return o; };

// ---- motion mask: a webcam box that moves all the time is learned and ignored
{
  const mm = new sc.MotionMask(W, H);
  const base = slide([10, 20, 30]);
  let mask = null;
  for (let i = 0; i < 20; i++) mask = mm.push(face(base, i));
  assert.ok(mask, 'mask built after warmup');
  assert.equal(mask[70 * W + 130], 1, 'face pixels masked');
  assert.equal(mask[20 * W + 50], 0, 'slide text not masked');
  const a = face(base, 0), b = face(base, 1);
  assert.ok(sc.changedFraction(a, b) > 0.05, 'unmasked: the face looks like a slide change');
  assert.equal(sc.changedFraction(a, b, 24, mask), 0, 'masked: no change');
  const det = new sc.SceneDetector({ threshold: 0.05 });
  det.mask = mask;
  const keys = [];
  for (let i = 0; i < 10; i++) { const k = det.push(i * 2, face(base, i)); if (k != null) keys.push(k); }
  assert.deepEqual(keys, [0], 'turning head = no new scene');
  // a real slide change still triggers
  const other = slide([10, 20, 30, 40, 50, 60, 70]);
  for (let i = 10; i < 14; i++) { const k = det.push(i * 2, face(other, i)); if (k != null) keys.push(k); }
  assert.equal(keys.length, 2, 'new slide still found');
  // the whole frame moving (a camera video) = no mask
  const cam = new sc.MotionMask(W, H);
  let m2 = 'x';
  for (let i = 0; i < 20; i++) m2 = cam.push(new Uint8Array(W * H).fill(i % 2 ? 0 : 200));
  assert.equal(m2, null);
  // masked hash ignores the face
  assert.equal(sc.maskedHash(face(base, 0), W, H, mask), sc.maskedHash(face(base, 3), W, H, mask));
  console.log('motion mask ok');
}

// ---- ink blocks: a board written line by line only adds cells
{
  const s1 = sc.inkBlocks(slide([10]), W, H), s3 = sc.inkBlocks(slide([10, 30, 50]), W, H);
  assert.ok(sc.inkCount(s3) > sc.inkCount(s1) && sc.inkCount(s1) >= 4);
  assert.equal(sc.inkContainment(s1, s3), 1);
  assert.ok(sc.inkContainment(s3, s1) < 0.5);
  console.log('ink blocks ok');
}

// ---- mergeRepeats: build-ups, subsets, flip-backs
{
  const F = (i, t, o = {}) => ({ index: i, t, words: 0, text: '', kinds: [], h: '0'.repeat(64), scores: {}, ...o });
  // math solved step by step (each step adds a line): only the finished board
  const steps = ['x^2 - 5x + 6 = 0', 'x^2 - 5x + 6 = 0 factor (x - 2)(x - 3) = 0', 'x^2 - 5x + 6 = 0 factor (x - 2)(x - 3) = 0 so roots x = 2 or x = 3'];
  const m1 = lp.mergeRepeats(steps.map((s, i) => F(i + 1, i * 20, { words: s.split(' ').length, text: s, kinds: ['formula'] })));
  assert.deepEqual(m1.map((f) => f.index), [3]);
  // handwriting OCR cannot read: the ink grid still sees the build-up
  const e = [slide([10]), slide([10, 30]), slide([10, 30, 50])].map((g) => sc.inkBlocks(g, W, H));
  assert.deepEqual(lp.mergeRepeats(e.map((eb, i) => F(i + 1, i * 30, { eb, words: 1, text: '' }))).map((f) => f.index), [3]);
  // two different text slides on the same template are NOT merged by the ink grid
  const tA = 'binary search halves the sorted range each step until the target is found or empty';
  const tB = 'hash tables map keys to buckets using a hash function with chaining for collisions';
  const same = sc.inkBlocks(slide([10, 30, 50]), W, H);
  assert.equal(lp.mergeRepeats([F(1, 0, { words: 15, text: tA, eb: same }), F(2, 60, { words: 15, text: tB, eb: same })]).length, 2);
  // teacher flips back to an earlier slide: the repeat is dropped
  assert.deepEqual(lp.mergeRepeats([F(1, 0, { words: 15, text: tA }), F(2, 60, { words: 15, text: tB }), F(3, 300, { words: 15, text: tA })]).map((f) => f.index), [1, 2]);
  // a half-erased board after the full one adds nothing
  assert.deepEqual(lp.mergeRepeats([F(1, 0, { words: 1, eb: e[2] }), F(2, 20, { words: 1, eb: e[0] })]).map((f) => f.index), [1]);
  console.log('build-up dedup ok');
}

// ---- local filter: only frames that need eyes go to the vision model
{
  assert.equal(lp.needsVision({ kinds: [], words: 40 }), false, 'full text slide: OCR is enough');
  assert.equal(lp.needsVision({ kinds: ['code'], words: 40 }), true);
  assert.equal(lp.needsVision({ kinds: [], words: 5 }), true, 'little text: may be a picture');
  assert.equal(lp.needsVision({ kinds: ['diagram'], words: 2, blank: true }), false);
  assert.equal(lp.contained('roots are two', 'so the roots are two and three'), 1);
  assert.equal(lp.needsVision({ kinds: [], words: 40, conf: 55 }), true, 'OCR unsure (handwriting, chart labels): vision');
  assert.equal(lp.needsVision({ kinds: [], words: 40, conf: 92 }), false);
  // one vision reply also carries the exact transcription / description
  const v = lp.readVerdicts(JSON.stringify({ frames: [{ id: 'F4', keep: true, kind: 'formula', info: 8, caption: 'c', text: 't', detail: '$$R_x$$' }, { id: 'F5', keep: false, kind: 'talking_head', info: 0 }] }), [{ index: 4 }, { index: 5 }]);
  assert.equal(v[4].detail, '$$R_x$$'); assert.equal(v[5].keep, false);
  // long videos: full transcript in 2-3 balanced parts
  assert.equal(lp.partsFor(70), 2); assert.equal(lp.partsFor(120), 2); assert.equal(lp.partsFor(150), 3); assert.equal(lp.partsFor(240), 4);
  const ch = Array.from({ length: 10 }, (_, i) => ({ start: i * 720, end: (i + 1) * 720 }));
  const g = lp.splitGroups(ch, 3);
  assert.equal(g.length, 3); assert.equal(g.flat().length, 10); assert.ok(g.every((x) => x.length >= 3));
  assert.equal(lp.splitGroups(ch.slice(0, 2), 3).length, 2, 'never an empty part');
  // the question writer gets topics without figures or callouts
  const out = lp.practiceOutline('### A (00:10)\n- **Big idea:** x\n[[FRAME:3]]\n> **Extra example:** e\n### B (05:00)\n- y');
  assert.ok(out.includes('### A') && out.includes('### B') && !out.includes('FRAME') && !out.includes('Extra example'));
  console.log('needsVision ok');
}

// ---- lossless trim, batch math reply, vision web query, debug dump
{
  const tr = await import('./lib/trim.js');
  assert.equal(tr.trimText('um so the the rotation matrix uh is 1 0 0'), 'so the rotation matrix is 1 0 0');
  assert.equal(tr.trimText('[Music] toh dekho dekho yeh matrix hai'), 'toh dekho yeh matrix hai');
  const t = tr.trimSegments([{ start: 0, end: 2, text: 'hello world' }, { start: 2, end: 4, text: 'Hello world' }, { start: 4, end: 5, text: '[Music]' }, { start: 5, end: 6, text: 'next' }]);
  assert.deepEqual(t.segs.map((s) => [s.start, s.end, s.text]), [[0, 4, 'hello world'], [5, 6, 'next']]);
  const pr = await import('./lib/prompts.js');
  assert.deepEqual(pr.readMathBatch('=== 1 ===\nA fixed\n\n=== 3 ===\nC fixed', 3), ['A fixed', '', 'C fixed']);
  assert.match(pr.fixMathBatchPrompt(['a', 'b']), /=== 2 ===\nb/);
  assert.match(pr.selectPrompt({ title: 't', frames: [{ id: 'F1', time: '00:01' }], web: '- hint' }), /WEB HINTS[\s\S]*- hint/);
  console.log('trim / math batch / web query ok');
}
