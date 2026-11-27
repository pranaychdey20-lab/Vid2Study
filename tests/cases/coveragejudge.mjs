// The coverage check only JUDGES: a prompt that forbids rewriting, and a strict reader for its reply.
import assert from 'node:assert/strict';
import { coveragePrompt, coverageFile, readCoverage } from './lib/prompts.js';

const p = coveragePrompt('1. scaling matrix\n2. homogeneous coordinates', 'NOTES TEXT', true);
assert.match(p, /^\[TASK:COVERAGE\]/);
assert.match(p, /Do not rewrite or add anything/);
assert.ok(!p.includes('NOTES TEXT'), 'attached: the notes travel as a file, not in the chat text');
assert.ok(coveragePrompt('1. x', 'NOTES TEXT', false).includes('NOTES TEXT'), 'inline when attachments are off');
assert.deepEqual(coverageFile('n'), { name: 'notes.txt', text: 'n' });

assert.deepEqual([...readCoverage('{"missing":[2]}', 3)], [2]);
assert.deepEqual([...readCoverage('```json\n{"missing":[]}\n```', 3)], []);
assert.deepEqual([...readCoverage('{"missing":[1,"3",9,0,1.5]}', 3)].sort(), [1, 3], 'only valid point numbers count');
assert.equal(readCoverage('all covered', 3), null);
assert.equal(readCoverage('{"covered":[1]}', 3), null);
console.log('coverage judge ok');
