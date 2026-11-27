import assert from 'node:assert/strict';
import { createNotesStore } from './lib/notes-store.js';
import { putResult, getResult } from './lib/db.js';

let shown = { key: 'k', summary_raw: 'A', summary_markdown: 'a', frames: [1] };
await putResult(shown);
const drawn = [];
const store = createNotesStore({ key: 'k', read: () => shown, redraw: (next) => { shown = next; drawn.push(next.summary_raw); } });
let changes = 0;
store.subscribe(() => changes++);

assert.equal(store.canUndo(), false);
await store.commit(() => ({ summary_raw: 'B', summary_markdown: 'b' }));
assert.equal((await getResult('k')).summary_raw, 'B');
assert.equal(shown.summary_markdown, 'b');
assert.equal(store.canUndo(), true);
await store.commit(() => ({ summary_raw: 'C', summary_markdown: 'c', frames: [2] }));
assert.deepEqual((await getResult('k')).frames, [2]);

await store.undo();
assert.equal(shown.summary_raw, 'B');
assert.deepEqual(shown.frames, [1], 'the figure list is restored with the text');
await store.undo();
assert.equal((await getResult('k')).summary_raw, 'A');
assert.equal(store.canUndo(), false);
assert.equal(await store.undo(), null, 'nothing left to undo');
await store.redo();
assert.equal(shown.summary_raw, 'B');
await store.commit(() => ({ summary_raw: 'D', summary_markdown: 'd' }));
assert.equal(store.canRedo(), false, 'a new edit clears redo');

// no change = no history entry
const before = changes;
await store.commit(() => ({}));
assert.equal(changes, before);

// notes changed elsewhere: refuse, never overwrite
await putResult({ ...shown, summary_raw: 'changed elsewhere' });
await assert.rejects(store.commit(() => ({ summary_raw: 'X' })), /changed in another tab/);
assert.equal((await getResult('k')).summary_raw, 'changed elsewhere');
// a failing transform writes nothing
shown = await getResult('k');
await assert.rejects(store.commit(() => { throw new Error('bad edit'); }), /bad edit/);
assert.equal((await getResult('k')).summary_raw, 'changed elsewhere');
console.log('notes store ok');
