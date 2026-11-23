// The writer decides whether practice questions and the maths fix are needed; frames go to it as pictures.
import assert from 'node:assert/strict';
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const lp = await import('./lib/local-pipeline.js');
const { writePrompt } = await import('./lib/prompts.js');

// the NEEDS line is read and removed; a missing line = null (fall back to the settings)
assert.deepEqual(lp.takeNeeds('### A\n- x\n\n<!--NEEDS practice=no math=yes-->\n'), { md: '### A\n- x', needs: { practice: false, math: true, style: null, subject: null } });
assert.deepEqual(lp.takeNeeds('### A\n- x\n<!-- needs practice=YES math=no -->'), { md: '### A\n- x', needs: { practice: true, math: false, style: null, subject: null } });
assert.deepEqual(lp.takeNeeds('x\n<!--NEEDS practice=yes math=no style=general subject=Hindu mythology: Ramayana-->').needs, { practice: true, math: false, style: 'general', subject: 'Hindu mythology: Ramayana' });
// a story video: illustrations rank like charts do in a lecture
assert.ok(lp.framePriority({ tag: 'illustration', score: 0.7, dwell: 30 }, { technical: false }) >= lp.IMPORTANT_PRIORITY);
assert.ok(lp.framePriority({ tag: 'illustration', score: 0.7, dwell: 30 }) < lp.IMPORTANT_PRIORITY, 'in a lecture a picture is not a chart');
assert.deepEqual(lp.takeNeeds('### A\n- x'), { md: '### A\n- x', needs: null });

// a story is not technical; a robotics lecture is
assert.equal(lp.isTechnical('Rama went to the forest with Sita and Lakshmana for fourteen years', {}), false);
assert.equal(lp.isTechnical('the rotation matrix about x, a revolute joint, the transform of a vector: 2 + 3 = 5, equation, derivative', {}), true);
assert.equal(lp.isTechnical('anything', { likely: true }), true);

// pictures: flagged / informative frames first, at most n, back in time order, only frames with a file
const fr = [
  { index: 1, t: 10, filename: 'a', kinds: [], score: 0.2 },
  { index: 2, t: 20, filename: 'b', kinds: ['diagram'], important: true, score: 0.8 },
  { index: 3, t: 30, filename: null, kinds: ['code'], score: 1 },
  { index: 4, t: 40, filename: 'd', kinds: ['table'], important: true, score: 0.5 }
];
assert.deepEqual(lp.pickPictures(fr, 2).map((f) => f.index), [2, 4]);
assert.deepEqual(lp.pickPictures(fr, 0), []);

// the prompt: pictures listed in order; no TECH / MATH rules for a non-technical video; NEEDS asked when deciding
const base = { kind: 'speech', body: '[00:00] hi', title: 'T', course: 'C', detail: 'standard', full: true, part: 1, parts: 1, frameBudget: 3, code: {} };
const story = writePrompt({ ...base, frameIds: '', technical: false, decide: true });
assert.ok(!/STEP BY STEP|CODE \(mandatory\)|\nMATH\n/.test(story));
assert.match(story, /no frames for this part/);
assert.ok(story.includes('<!--NEEDS practice=yes|no math=yes|no style='), 'asks for practice, math and the question style');
const tech = writePrompt({ ...base, frameIds: 'F2[diagram], F4[table]', pictures: [{ id: 2, time: '00:20' }, { id: 4, time: '00:40' }] });
assert.match(tech, /Image 1 = F2 at 00:20; Image 2 = F4 at 00:40/);
assert.match(tech, /STEP BY STEP/);
assert.ok(!/NEEDS practice/.test(tech), 'only asked when deciding');
// frame priority: a map / chart beats a text slide, which beats a talking scene; time on screen and info count
{
  const map = lp.framePriority({ tag: 'map', score: 0.8, dwell: 90, words: 10 });
  const slide = lp.framePriority({ tag: 'slide', score: 0.6, dwell: 90, words: 40 });
  const scene = lp.framePriority({ scene: true, kinds: ['scene'], dwell: 10 });
  assert.ok(map > slide && slide > scene, `${map} > ${slide} > ${scene}`);
  assert.ok(map >= lp.IMPORTANT_PRIORITY && slide < lp.IMPORTANT_PRIORITY);
  assert.ok(lp.framePriority({ tag: 'chart', score: 0.8, dwell: 120 }) > lp.framePriority({ tag: 'chart', score: 0.8, dwell: 5 }), 'longer on screen ranks higher');
  // the top n of EACH write part: a 2-part video with n = 1 sends the best frame of each half
  const fr2 = [
    { index: 1, t: 100, filename: 'a', priority: 30 }, { index: 2, t: 200, filename: 'b', priority: 10 },
    { index: 3, t: 4000, filename: 'c', priority: 12 }, { index: 4, t: 5000, filename: 'd', priority: 25 }
  ];
  assert.deepEqual(lp.pictureSet(fr2, [0, 3600], 1).map((f) => f.index), [1, 4]);
  assert.deepEqual(lp.pictureSet(fr2, [], 2).map((f) => f.index), [1, 4], 'no parts known: one window');
  // the write parts: full transcript in 2 parts for a 100-min video
  const chunks = Array.from({ length: 10 }, (_, i) => ({ index: i, start: i * 600, end: (i + 1) * 600 }));
  assert.equal(lp.planGroups(chunks, { minutes: 100, fullText: true, detail: 'standard' }).length, 2);
}
console.log('writer needs ok');
// the local filter after the video type is known: a story / religion video sends every non-blank picture to vision
assert.equal(lp.needsVision({ kinds: [], words: 40, conf: 95 }), false, 'lecture: a fully read text slide skips vision');
assert.equal(lp.needsVision({ kinds: [], words: 40, conf: 95 }, 12, { technical: false }), true, 'story video: it may be the content');
assert.equal(lp.needsVision({ kinds: [], words: 0, blank: true }, 12, { technical: false }), false);
console.log('filter by video type ok');
