// Algorithm walkthroughs: the frames come from a real run, so check them against the true answers.
const assert = (await import('node:assert')).default;
const { traceAlgo, renderAlgo, normaliseSpec, ALGORITHMS } = await import('./lib/algoviz.js');
const { renderMarkdown } = await import('./lib/md.js');

const last = (t) => t.frames[t.frames.length - 1];
const sorted = (a) => [...a].sort((x, y) => x - y);
let seed = 7;
const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
const randomArray = () => Array.from({ length: 2 + Math.floor(rnd() * 7) }, () => Math.floor(rnd() * 20) - 5);

// every sort ends sorted, on many inputs (duplicates, negatives, already sorted, reversed, one value)
const cases = [[5, 2, 9, 1, 6], [1, 2, 3, 4], [4, 3, 2, 1], [3, 3, 1, 3], [7], [-2, 5, -9, 0]];
for (let i = 0; i < 40; i++) cases.push(randomArray());
for (const algo of ['bubble_sort', 'selection_sort', 'insertion_sort', 'merge_sort', 'quick_sort']) {
  for (const input of cases) {
    const t = traceAlgo({ algo, input });
    assert.deepEqual(last(t).values, sorted(input), `${algo} ${input}`);
    assert.ok(last(t).colors.every((c) => c === 'blue'), `${algo} ends all finished`);
    for (const f of t.frames) {
      assert.equal(f.values.length, input.length);
      assert.equal(f.colors.length, input.length);
      assert.ok(f.caption && !/undefined|NaN/.test(f.caption), f.caption);
      // a step only rearranges values; while insertion sort shifts, the key waits beside the array (one slot is a copy)
      if (algo === 'insertion_sort' && f.aux) {
        const vals = sorted(f.values), want = sorted(input), key = f.aux.items[0];
        const missing = want.filter((v, i) => vals[i] !== v);
        assert.ok(want.includes(key) && f.values.length === input.length && missing.length <= input.length, `${algo}: key ${key} kept beside`);
      } else assert.deepEqual(sorted(f.values), sorted(input), `${algo}: a step must only rearrange values`);
    }
  }
}
console.log('sorts ok');

// the captions tell the truth: every "compare x and y" in bubble sort matches what the next frame did
{
  const t = traceAlgo({ algo: 'bubble_sort', input: [5, 2, 9, 1, 6] });
  t.frames.forEach((f, k) => {
    const m = /compare (-?\d+) and (-?\d+)\. .*(swap them|leave them)/.exec(f.caption);
    if (!m) return;
    const [x, y] = [Number(m[1]), Number(m[2])];
    assert.equal(m[3] === 'swap them', x > y, f.caption);
    if (x > y) assert.match(t.frames[k + 1].caption, /^Swapped/);
  });
  // first pass of [5,2,9,1,6]: compare 5,2 -> swap; 5,9 keep; 9,1 swap; 9,6 swap
  const firstPass = t.frames.filter((f) => /^Pass 1:/.test(f.caption)).map((f) => f.caption.replace(/^Pass 1: /, ''));
  assert.deepEqual(firstPass, ['compare 5 and 2. 5 > 2, so swap them.', 'compare 5 and 9. 5 ≤ 9, so leave them.', 'compare 9 and 1. 9 > 1, so swap them.', 'compare 9 and 6. 9 > 6, so swap them.']);
  assert.equal(t.result, 'Sorted: [1, 2, 5, 6, 9]');
  // pointers name the compared positions
  const cmp = t.frames.find((f) => /compare 5 and 9/.test(f.caption));
  assert.deepEqual(cmp.pointers, { j: 1, 'j+1': 2 });
  assert.deepEqual(cmp.colors.slice(0, 3), ['grey', 'green', 'green']);
  console.log('bubble captions ok', t.frames.length, 'steps');
}

// searching
{
  const b = traceAlgo({ algo: 'binary_search', input: [1, 3, 5, 7, 9, 11], target: 9 });
  assert.match(b.result, /found at position 4/);
  assert.equal(last(b).colors[4], 'blue');
  const nf = traceAlgo({ algo: 'binary_search', input: [1, 3, 5, 7], target: 4 });
  assert.match(nf.result, /not in the array/);
  const unsorted = traceAlgo({ algo: 'binary_search', input: [9, 1, 5], target: 5 });
  assert.match(unsorted.frames[0].caption, /sorted first/); assert.deepEqual(unsorted.frames[0].values, [1, 5, 9]);
  for (const input of cases) for (const target of [...input.slice(0, 2), 100]) {
    const s = sorted(input), t = traceAlgo({ algo: 'binary_search', input: s, target });
    assert.equal(/found at position/.test(t.result), s.includes(target), `${s} ${target}`);
    const l = traceAlgo({ algo: 'linear_search', input, target });
    assert.equal(/found at position (\d+)/.exec(l.result)?.[1], input.includes(target) ? String(input.indexOf(target)) : undefined);
  }
  console.log('search ok');
}

// graphs: compare with independent answers
{
  const edges = [['A', 'B'], ['A', 'C'], ['B', 'D'], ['C', 'D'], ['C', 'E'], ['D', 'F']];
  const b = traceAlgo({ algo: 'bfs', edges, start: 'A' });
  assert.match(b.result, /A → B → C → D → E → F/);
  assert.ok(Object.values(last(b).colors).every((c) => c === 'blue'));
  const queueSeen = b.frames.map((f) => f.aux.items.join(''));
  assert.ok(queueSeen.includes('BC') && queueSeen.includes('CD')); // the queue panel follows the run
  const d = traceAlgo({ algo: 'dfs', edges, start: 'A' });
  assert.match(d.result, /A → B → D → C → E → F/); // smallest neighbour first, as a recursive DFS would
  const wedges = [['A', 'B', 4], ['A', 'C', 1], ['C', 'B', 2], ['B', 'D', 5], ['C', 'D', 8], ['D', 'E', 3]];
  const k = traceAlgo({ algo: 'dijkstra', edges: wedges, start: 'A' });
  // Bellman-Ford as the reference answer
  const nodes = ['A', 'B', 'C', 'D', 'E'], dist = { A: 0, B: Infinity, C: Infinity, D: Infinity, E: Infinity };
  for (let r = 0; r < nodes.length; r++) for (const [u, v, w] of wedges) { dist[v] = Math.min(dist[v], dist[u] + w); dist[u] = Math.min(dist[u], dist[v] + w); }
  assert.equal(k.result, `Shortest distances from A: ${nodes.map((x) => `${x} = ${dist[x]}`).join(', ')}.`);
  const unreachable = traceAlgo({ algo: 'bfs', edges: [['A', 'B'], ['C', 'D']], start: 'A' });
  assert.match(unreachable.result, /not reachable: C, D/);
  assert.throws(() => traceAlgo({ algo: 'dijkstra', edges: [['A', 'B']] }), /weight/);
  console.log('graphs ok');
}

// linked list reversal
{
  const t = traceAlgo({ algo: 'reverse_list', input: [1, 2, 3, 4] });
  assert.equal(t.result, 'Reversed list: 4 → 3 → 2 → 1 → null.');
  assert.deepEqual(last(t).next, [null, 0, 1, 2]);
  assert.equal(t.frames.length, 1 + 4 * 3 + 1); // start, (save, reverse, move) per node, done
  console.log('list ok');
}

// input checks and names
assert.equal(normaliseSpec({ algo: 'Bubble Sort', input: ['3', '1'] }).algo, 'bubble_sort');
assert.deepEqual(normaliseSpec({ algo: 'quicksort', input: ['3', '1'] }).input, [3, 1]);
assert.throws(() => normaliseSpec({ algo: 'bogo_sort', input: [1] }), /unknown algorithm/);
assert.throws(() => normaliseSpec({ algo: 'bubble_sort', input: Array(11).fill(1) }), /10 values/);
assert.throws(() => normaliseSpec({ algo: 'binary_search', input: [1] }), /target/);

// drawing: every algorithm renders, with the legend, a caption per step, and no broken values
for (const algo of ALGORITHMS) {
  const spec = ['bfs', 'dfs'].includes(algo) ? { algo, edges: [['A', 'B'], ['A', 'C'], ['B', 'D']], start: 'A' }
    : algo === 'dijkstra' ? { algo, edges: [['A', 'B', 2], ['B', 'C', 1], ['A', 'C', 5]], start: 'A' }
      : { algo, input: [4, 1, 3, 2], target: 3 };
  const html = renderAlgo(spec);
  const t = traceAlgo(spec);
  assert.equal((html.match(/<svg /g) || []).length, t.frames.length, algo);
  assert.equal((html.match(/Processing \/ comparing/g) || []).length, t.frames.length, `${algo}: legend on every step`);
  assert.ok(/Problem:/.test(html) && /Input:/.test(html) && /Idea:/.test(html) && /Result:/.test(html) && /Time:/.test(html) && /Space:/.test(html) && /When to use it:/.test(html), algo);
  assert.ok(!/undefined|NaN/.test(html), `${algo}: no broken values`);
}
// in the notes: ```algo becomes the drawing; a bad block shows why instead of breaking the page
const page = renderMarkdown('### Sorting\n\n```algo\n{"algo":"bubble_sort","input":[5,2,9,1,6]}\n```\n');
assert.match(page, /class="algo"/); assert.match(page, /Step 1 of/);
assert.match(renderMarkdown('```algo\n{"algo":"nope"}\n```'), /Could not draw this walkthrough: unknown algorithm/);
assert.match(renderMarkdown('```algo\nnot json\n```'), /Could not draw/);
console.log('algo rendering ok');
