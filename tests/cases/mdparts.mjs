import assert from 'node:assert/strict';
import { stitch, isCut, completeParts } from './lib/md-parts.js';

const fence = '\x60'.repeat(3);
// plain continuation, mid-word
assert.equal(stitch('The signal is sam', 'pled twice per cycle.'), 'The signal is sampled twice per cycle.');
// the model repeats the last words: dropped
assert.equal(stitch('Step one: subtract the mean. Step two: divide', 'Step two: divide by the standard deviation.'), 'Step one: subtract the mean. Step two: divide by the standard deviation.');
// a repeated whole last line
assert.equal(stitch('### A\nfirst line\nsecond line is long enough', 'second line is long enough and goes on.\n### B'), '### A\nfirst line\nsecond line is long enough and goes on.\n### B');
// a fenced wrapper is removed; nothing is dropped when there is no overlap
assert.equal(stitch('abc\n', fence + 'markdown\n### Next\ntext\n' + fence), 'abc\n### Next\ntext');
assert.equal(stitch('Short.', ' More.'), 'Short. More.');
// cut detection
assert.equal(isCut({ truncated: true }, 'fine'), true);
assert.equal(isCut({}, 'fine\n\nMISSING_DETAILS: NO'), false);
assert.equal(isCut({}, 'text\n' + fence + 'visual\n{"type":"bar'), true);
assert.equal(isCut({}, 'text\n$$\nx = 1'), true);
assert.equal(isCut({}, 'text\n' + fence + 'visual\n{"type":"matrix"}\n' + fence + '\nMISSING_DETAILS: NO'), false);

// a document needing three parts: only "continue" calls after the first, the pieces are joined, usage adds up
const doc = ['## Overview\n- a\n\n### One (00:10)\nFirst topic text.\n', '### Two (05:00)\nSecond topic text.\n', '### Three (09:00)\nThird topic text.\nMISSING_DETAILS: NO'];
const seen = [];
const out = await completeParts({
  first: { text: doc[0] + '### Tw', truncated: true, usage: { in: 100, out: 50 }, session: 's1' },
  more: async (text, last, n) => { seen.push({ n, tail: text.slice(-10), session: last.session }); return n === 1 ? { text: 'o (05:00)\nSecond topic text.\n### Thr', truncated: true, usage: { in: 5, out: 40 } } : { text: 'ee (09:00)\nThird topic text.\nMISSING_DETAILS: NO', usage: { in: 5, out: 30 } }; }
});
assert.equal(out.parts, 3);
assert.equal(out.truncated, false);
assert.deepEqual(out.usage, { in: 110, out: 120 });
assert.equal(seen[1].session, 's1', 'the session of the first reply is kept');
assert.match(out.text, /### Two \(05:00\)\nSecond topic text\.\n### Three \(09:00\)\nThird topic text\./);
assert.equal(out.text.split('### Two').length, 2, 'no repeated heading');

// a model that keeps repeating itself, or returns nothing, cannot loop forever
let calls = 0;
const stuck = await completeParts({ first: { text: 'abc', truncated: true }, more: async () => { calls++; return { text: '', truncated: true }; } });
assert.equal(calls, 1); assert.equal(stuck.truncated, true);
calls = 0;
const endless = await completeParts({ first: { text: 'x'.repeat(40), truncated: true }, maxParts: 3, more: async () => { calls++; return { text: 'y'.repeat(20) + calls, truncated: true }; } });
assert.equal(calls, 2); assert.equal(endless.parts, 3);
console.log('md parts ok');
