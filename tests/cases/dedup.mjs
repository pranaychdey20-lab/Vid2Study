import assert from 'node:assert/strict';
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const { balanceFigures, isOutro } = await import('./lib/local-pipeline.js');
const { stripTimestamps } = await import('./lib/common.js');

const H0 = '0'.repeat(64), H1 = '1'.repeat(64), H0b = `${'0'.repeat(63)}1`;
const fr = (index, t, o = {}) => ({ index, t, kinds: ['diagram'], words: 0, score: 1, h: H1, ...o });
const mk = (frames) => ({ screen: frames, byIndex: new Map(frames.map((f) => [f.index, f])) });
const opts = { budget: 20, duration: 300, minGap: 20 };
const has = (s, n) => s.includes(`[[FRAME:${n}]]`);

// cartoon frames (flagged "diagram" but no text) 12 s apart in one section: thinned to one
{
  const { screen, byIndex } = mk([fr(1, 208, { h: H0 }), fr(2, 212, { h: H1 }), fr(3, 220, { h: `${'01'.repeat(32)}` })]);
  const out = balanceFigures('### A (03:28)\n- x\n[[FRAME:1]]\n[[FRAME:2]]\n[[FRAME:3]]\n', screen, byIndex, opts);
  const n = [1, 2, 3].filter((i) => has(out, i)).length;
  assert.equal(n, 1, 'one picture per scene for text-poor drawings');
}

// the same picture in two sections (identical flag): the later one is dropped
{
  const { screen, byIndex } = mk([fr(1, 100, { h: H0 }), fr(2, 280, { h: H0b })]);
  const out = balanceFigures('### A (01:30)\n[[FRAME:1]]\n### B (04:30)\n[[FRAME:2]]\n', screen, byIndex, opts);
  assert.ok(has(out, 1) && !has(out, 2));
}

// code frames are never thinned or judged look-alikes, even 4 s apart with the same hash
{
  const { screen, byIndex } = mk([fr(1, 100, { kinds: ['code'], h: H0 }), fr(2, 104, { kinds: ['code'], h: H0 })]);
  const out = balanceFigures('### A (01:30)\n[[FRAME:1]]\n[[FRAME:2]]\n', screen, byIndex, opts);
  assert.ok(has(out, 1) && has(out, 2));
}

// a diagram with real text (words >= 8) is still never thinned
{
  const { screen, byIndex } = mk([fr(1, 100, { words: 20, h: H0 }), fr(2, 104, { words: 25, h: H1 })]);
  const out = balanceFigures('### A (01:30)\n[[FRAME:1]]\n[[FRAME:2]]\n', screen, byIndex, opts);
  assert.ok(has(out, 1) && has(out, 2));
}

// end cards
assert.equal(isOutro('Lesson by Alex Narration by Addison', 326, 336), true);
assert.equal(isOutro('View full lesson on ed.ted.com Nominate an Educator', 330, 336), true);
assert.equal(isOutro('Lesson by the way, mid-video', 20, 336), false, 'only late in the video');
assert.equal(isOutro('The Reichstag fire', 330, 336), false);

// timestamps stripped for print, kept in the source notes
const md = [
  '### The Post-WWI Context (00:19)', '',
  '## Topics', '', '- 00:19 — The Post-WWI Context', '- 01:28 — Early Rise', '',
  '![Figure 1: Scene at 01:40](images/a.png)',
  '*FIG 1 · 01:40 — Narration at 01:40: “By this time”*', '',
  '[Watch at 01:40](https://www.youtube.com/watch?v=x&t=100s)', '',
  '**FIG 2 · 02:06** — Scene at 02:06. On screen at 02:06. ([watch at 02:06](https://y))'
].join('\n');
const clean = stripTimestamps(md);
assert.equal(/\d{1,2}:\d{2}/.test(clean), false, clean);
assert.ok(clean.includes('### The Post-WWI Context\n'));
assert.ok(clean.includes('- The Post-WWI Context'));
assert.ok(clean.includes('*Fig 1 — “By this time”*'));
assert.ok(!clean.includes('Watch at'));
assert.ok(md.includes('00:19'), 'the stored notes keep their times');
console.log('dedup ok');
