/**
 * Algorithm walkthroughs for the notes and the PDF. The writer names an algorithm and its input in a
 * ```algo block (JSON); this module RUNS the real algorithm on that input, records every step of the run,
 * and draws each step as SVG shapes (boxes / circles / arrows), never as text art:
 *   1. the problem, the input and the idea   2. every step, in order   3. result, time/space, when to use.
 * Colours (legend on every frame): green = being processed / compared, red = swapped / changed / rejected,
 * blue = finished / sorted / visited, grey = untouched. Pointers (i, j, left, mid, prev, curr...) are labelled
 * arrows under the elements; a queue / stack / table is drawn beside the main picture.
 * Pure (no DOM): returns HTML strings, so the same output works in the viewer, the export and print.
 */

const COL = { grey: '#e4e4e4', green: '#7fd88f', red: '#ff8a8a', blue: '#8db6ff', white: '#ffffff' };
const LEGEND = [['green', 'Processing / comparing'], ['red', 'Swapped / changed / rejected'], ['blue', 'Finished / sorted / visited'], ['grey', 'Untouched']];
const FONT = 'font-family="Helvetica, Arial, sans-serif"';
const MAX_ITEMS = 10;
const MAX_NODES = 10;

const esc = (s) => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const list = (a) => `[${a.join(', ')}]`;
const paint = (n, fn) => Array.from({ length: n }, (_, k) => fn(k));
const show = (d) => (d === Infinity ? '∞' : String(d));

// ---------- what each algorithm is (section 1 and 3 text) ----------
const INFO = {
  bubble_sort: { name: 'Bubble sort', problem: 'Sort the numbers in ascending order.', idea: 'Walk through the array comparing neighbours and swap any pair that is out of order. After each pass the largest remaining value has "bubbled" to the end, so each pass can stop one place earlier.', time: 'O(n²) comparisons in the worst and average case; O(n) when already sorted (early stop).', space: 'O(1) extra: it sorts in place.', when: 'Tiny or almost-sorted arrays, and for teaching; prefer merge or quick sort for real data.' },
  selection_sort: { name: 'Selection sort', problem: 'Sort the numbers in ascending order.', idea: 'For each position from the left, find the smallest value in the unsorted rest and swap it into that position. The sorted part grows by one every pass.', time: 'O(n²) comparisons always.', space: 'O(1) extra: it sorts in place.', when: 'Small arrays where writes are expensive: it makes at most n − 1 swaps.' },
  insertion_sort: { name: 'Insertion sort', problem: 'Sort the numbers in ascending order.', idea: 'Keep a sorted part on the left. Take the next value (the key), shift every larger sorted value one place right, and drop the key into the gap.', time: 'O(n²) worst and average; O(n) when the input is nearly sorted.', space: 'O(1) extra: it sorts in place.', when: 'Small or nearly-sorted arrays, and data arriving one item at a time.' },
  merge_sort: { name: 'Merge sort', problem: 'Sort the numbers in ascending order.', idea: 'Split the array in half again and again until each part has one item, then merge neighbouring sorted parts by repeatedly taking the smaller front item.', time: 'O(n log n) in every case.', space: 'O(n) extra for the merge buffer.', when: 'Large data, linked lists, or when a stable sort with a guaranteed O(n log n) is needed.' },
  quick_sort: { name: 'Quick sort (Lomuto partition)', problem: 'Sort the numbers in ascending order.', idea: 'Pick the last item as the pivot, move every smaller item to its left, put the pivot right after them (its final place), then sort the left and right parts the same way.', time: 'O(n log n) on average; O(n²) worst case (already sorted input with this pivot choice).', space: 'O(log n) average for the recursion.', when: 'General in-memory sorting; it is usually the fastest in practice.' },
  binary_search: { name: 'Binary search', problem: 'Find the position of a target value in a sorted array.', idea: 'Look at the middle item. If it is the target, stop; if it is smaller, the target can only be in the right half; if larger, only in the left half. Halve the range until found or empty.', time: 'O(log n).', space: 'O(1) extra.', when: 'Repeated lookups in sorted data.' },
  linear_search: { name: 'Linear search', problem: 'Find the position of a target value in an array.', idea: 'Check every item from left to right until one equals the target, or the array ends.', time: 'O(n).', space: 'O(1) extra.', when: 'Small or unsorted data, or a single lookup where sorting first would cost more.' },
  bfs: { name: 'Breadth-first search (BFS)', problem: 'Visit every node reachable from the start, nearest first.', idea: 'Use a queue: visit the node at the front, then add each neighbour not seen before to the back. Nodes are therefore visited level by level.', time: 'O(V + E).', space: 'O(V) for the queue and the visited set.', when: 'Shortest paths in unweighted graphs, level order, "fewest steps" problems.' },
  dfs: { name: 'Depth-first search (DFS)', problem: 'Visit every node reachable from the start, going as deep as possible first.', idea: 'Use a stack: pop the top node, visit it if new, and push its unvisited neighbours. The most recently found node is explored first, so the search dives deep before backing up.', time: 'O(V + E).', space: 'O(V) for the stack and the visited set.', when: 'Cycle detection, topological order, connected components, mazes and backtracking.' },
  dijkstra: { name: "Dijkstra's shortest paths", problem: 'Find the shortest distance from the start to every node (edge weights ≥ 0).', idea: 'Repeatedly pick the unfinished node with the smallest known distance, mark it finished, and try to improve its neighbours: if dist(u) + weight is smaller than their current distance, update it.', time: 'O((V + E) log V) with a priority queue; O(V²) with the simple scan used here.', space: 'O(V) for the distance table.', when: 'Road maps, network routing: shortest paths with non-negative weights.' },
  reverse_list: { name: 'Reversing a singly linked list', problem: 'Reverse the direction of every link so the last node becomes the head.', idea: 'Walk the list with three pointers: prev (the reversed part), curr (the node being fixed) and next (the rest, saved before it is lost). Point curr back at prev, then move all three one step forward.', time: 'O(n).', space: 'O(1) extra: only three pointers.', when: 'Whenever a list must be read backwards without extra memory; a classic building block (palindromes, k-group reversal).' }
};
const ALIASES = { bubble: 'bubble_sort', bubblesort: 'bubble_sort', selection: 'selection_sort', insertion: 'insertion_sort', merge: 'merge_sort', mergesort: 'merge_sort', quick: 'quick_sort', quicksort: 'quick_sort', binarysearch: 'binary_search', linearsearch: 'linear_search', breadth_first_search: 'bfs', depth_first_search: 'dfs', reverse_linked_list: 'reverse_list', linked_list_reversal: 'reverse_list', reverse: 'reverse_list' };
export const ALGORITHMS = Object.keys(INFO);

// ---------- traces: the real algorithm, one frame per step ----------
const arr = (values, colors, pointers, caption, aux) => ({ kind: 'array', values: [...values], colors, pointers: pointers || {}, caption, aux });
const less = (x, y) => (typeof x === 'number' && typeof y === 'number' ? x < y : String(x).localeCompare(String(y), undefined, { numeric: true }) < 0);

function bubbleSort(input) {
  const a = [...input], n = a.length, F = [];
  let done = n; // positions >= done are final
  const base = (k) => (k >= done ? 'blue' : 'grey');
  F.push(arr(a, paint(n, base), {}, `Start: ${n} values, nothing is sorted yet.`));
  for (let i = 0; i < n - 1; i++) {
    let swapped = false;
    for (let j = 0; j < n - 1 - i; j++) {
      const x = a[j], y = a[j + 1], swap = less(y, x);
      F.push(arr(a, paint(n, (k) => (k === j || k === j + 1 ? 'green' : base(k))), { j, 'j+1': j + 1 },
        swap ? `Pass ${i + 1}: compare ${x} and ${y}. ${x} > ${y}, so swap them.` : `Pass ${i + 1}: compare ${x} and ${y}. ${x} ≤ ${y}, so leave them.`));
      if (swap) {
        a[j] = y; a[j + 1] = x; swapped = true;
        F.push(arr(a, paint(n, (k) => (k === j || k === j + 1 ? 'red' : base(k))), { j, 'j+1': j + 1 }, `Swapped: ${y} now comes before ${x}.`));
      }
    }
    if (!swapped) {
      done = 0;
      F.push(arr(a, paint(n, () => 'blue'), {}, `Pass ${i + 1} made no swaps, so the array is already sorted: stop early.`));
      return { frames: F, result: `Sorted: ${list(a)}` };
    }
    done = n - 1 - i;
    F.push(arr(a, paint(n, base), {}, `End of pass ${i + 1}: ${a[done]} was the largest left, it has reached position ${done} and is final.`));
  }
  F.push(arr(a, paint(n, () => 'blue'), {}, `Only ${a[0]} is left, so it is in place too. The array is sorted.`));
  return { frames: F, result: `Sorted: ${list(a)}` };
}

function selectionSort(input) {
  const a = [...input], n = a.length, F = [];
  F.push(arr(a, paint(n, () => 'grey'), {}, `Start: ${n} values, nothing is sorted yet.`));
  for (let i = 0; i < n - 1; i++) {
    let m = i;
    F.push(arr(a, paint(n, (k) => (k < i ? 'blue' : k === i ? 'green' : 'grey')), { i, min: m }, `Pass ${i + 1}: find the smallest value in positions ${i}..${n - 1}. Start with min = ${a[i]}.`));
    for (let j = i + 1; j < n; j++) {
      const better = less(a[j], a[m]);
      F.push(arr(a, paint(n, (k) => (k < i ? 'blue' : k === j || k === m ? 'green' : 'grey')), { i, min: m, j },
        better ? `${a[j]} < ${a[m]}, so ${a[j]} is the new minimum.` : `${a[j]} ≥ ${a[m]}, so the minimum stays ${a[m]}.`));
      if (better) m = j;
    }
    if (m !== i) {
      [a[i], a[m]] = [a[m], a[i]];
      F.push(arr(a, paint(n, (k) => (k < i ? 'blue' : k === i || k === m ? 'red' : 'grey')), { i, min: m }, `Swap: the minimum ${a[i]} moves to position ${i}, and ${a[m]} moves to position ${m}.`));
    } else {
      F.push(arr(a, paint(n, (k) => (k < i ? 'blue' : k === i ? 'green' : 'grey')), { i, min: m }, `${a[i]} is already the minimum, so no swap is needed.`));
    }
    F.push(arr(a, paint(n, (k) => (k <= i ? 'blue' : 'grey')), {}, `Position ${i} is final: ${a[i]}.`));
  }
  F.push(arr(a, paint(n, () => 'blue'), {}, `The last value ${a[n - 1]} is the largest, so it is already in place. The array is sorted.`));
  return { frames: F, result: `Sorted: ${list(a)}` };
}

function insertionSort(input) {
  const a = [...input], n = a.length, F = [];
  F.push(arr(a, paint(n, (k) => (k === 0 ? 'blue' : 'grey')), {}, `Start: the first value ${a[0]} on its own is a sorted part.`));
  for (let i = 1; i < n; i++) {
    const key = a[i], aux = { title: 'key', items: [key] };
    let j = i - 1;
    F.push(arr(a, paint(n, (k) => (k < i ? 'blue' : k === i ? 'green' : 'grey')), { i }, `Take key = ${key} from position ${i}; it must go into the sorted part on its left.`, aux));
    while (j >= 0 && less(key, a[j])) {
      F.push(arr(a, paint(n, (k) => (k === j ? 'green' : k <= i ? 'blue' : 'grey')), { j }, `${a[j]} > ${key}, so shift ${a[j]} one place to the right.`, aux));
      a[j + 1] = a[j];
      F.push(arr(a, paint(n, (k) => (k === j + 1 ? 'red' : k <= i ? 'blue' : 'grey')), { j }, `${a[j + 1]} copied to position ${j + 1}; position ${j} is now free for the key or the next shift.`, aux));
      j--;
    }
    if (j >= 0) F.push(arr(a, paint(n, (k) => (k === j ? 'green' : k <= i ? 'blue' : 'grey')), { j }, `${a[j]} ≤ ${key}, so the key belongs right after it.`, aux));
    a[j + 1] = key;
    F.push(arr(a, paint(n, (k) => (k === j + 1 ? 'red' : k <= i ? 'blue' : 'grey')), {}, `Insert ${key} at position ${j + 1}${j < 0 ? ' (the front: everything before was larger)' : ''}. Positions 0..${i} are sorted.`));
  }
  F.push(arr(a, paint(n, () => 'blue'), {}, 'Every value has been inserted. The array is sorted.'));
  return { frames: F, result: `Sorted: ${list(a)}` };
}

function mergeSort(input) {
  const a = [...input], n = a.length, F = [];
  F.push(arr(a, paint(n, () => 'grey'), {}, `Start: ${n} values. Split until every part has one value, then merge.`));
  const rec = (l, r) => {
    if (l >= r) return;
    const m = (l + r) >> 1;
    F.push(arr(a, paint(n, (k) => (k >= l && k <= r ? 'green' : 'grey')), { left: l, mid: m, right: r }, `Split ${list(a.slice(l, r + 1))} into ${list(a.slice(l, m + 1))} and ${list(a.slice(m + 1, r + 1))}.`));
    rec(l, m);
    rec(m + 1, r);
    const L = a.slice(l, m + 1), R = a.slice(m + 1, r + 1), out = [];
    let i = 0, j = 0;
    while (i < L.length && j < R.length) {
      const takeL = !less(R[j], L[i]);
      F.push(arr(a, paint(n, (k) => (k === l + i || k === m + 1 + j ? 'green' : 'grey')), { i: l + i, j: m + 1 + j },
        takeL ? `Merge: ${L[i]} ≤ ${R[j]}, so take ${L[i]} from the left part.` : `Merge: ${R[j]} < ${L[i]}, so take ${R[j]} from the right part.`, { title: 'merged', items: [...out] }));
      out.push(takeL ? L[i++] : R[j++]);
    }
    while (i < L.length) { F.push(arr(a, paint(n, (k) => (k === l + i ? 'green' : 'grey')), { i: l + i }, `The right part is used up: take ${L[i]}.`, { title: 'merged', items: [...out] })); out.push(L[i++]); }
    while (j < R.length) { F.push(arr(a, paint(n, (k) => (k === m + 1 + j ? 'green' : 'grey')), { j: m + 1 + j }, `The left part is used up: take ${R[j]}.`, { title: 'merged', items: [...out] })); out.push(R[j++]); }
    for (let k = 0; k < out.length; k++) a[l + k] = out[k];
    const whole = l === 0 && r === n - 1;
    F.push(arr(a, paint(n, (k) => (k >= l && k <= r ? (whole ? 'blue' : 'red') : 'grey')), {}, `Write the merged part ${list(out)} back into positions ${l}..${r}.${whole ? ' That was the whole array: it is sorted.' : ''}`, { title: 'merged', items: out }));
  };
  rec(0, n - 1);
  if (n === 1) F.push(arr(a, ['blue'], {}, 'One value is already sorted.'));
  return { frames: F, result: `Sorted: ${list(a)}` };
}

function quickSort(input) {
  const a = [...input], n = a.length, F = [], fin = new Set();
  const base = (k) => (fin.has(k) ? 'blue' : 'grey');
  F.push(arr(a, paint(n, () => 'grey'), {}, `Start: ${n} values. Each step places one pivot in its final position.`));
  const rec = (lo, hi) => {
    if (lo > hi) return;
    if (lo === hi) {
      fin.add(lo);
      F.push(arr(a, paint(n, base), {}, `Part ${lo}..${hi} holds only ${a[lo]}, so it is already in its final place.`));
      return;
    }
    const p = a[hi];
    let i = lo;
    F.push(arr(a, paint(n, (k) => (k === hi ? 'green' : base(k))), { pivot: hi, i }, `Sort positions ${lo}..${hi}: the pivot is the last value, ${p}. Values smaller than ${p} will be gathered left of i.`));
    for (let j = lo; j < hi; j++) {
      const small = less(a[j], p);
      F.push(arr(a, paint(n, (k) => (k === j || k === hi ? 'green' : base(k))), { pivot: hi, i, j },
        small ? (i === j ? `${a[j]} < ${p} and it is already at i = ${i}: just move i forward.` : `${a[j]} < ${p}, so it belongs on the left: swap it with position i = ${i}.`) : `${a[j]} ≥ ${p}, so it stays on the right.`));
      if (small) {
        if (i !== j) {
          [a[i], a[j]] = [a[j], a[i]];
          F.push(arr(a, paint(n, (k) => (k === i || k === j ? 'red' : k === hi ? 'green' : base(k))), { pivot: hi, i, j }, `Swapped ${a[i]} and ${a[j]}; move i forward to ${i + 1}.`));
        }
        i++;
      }
    }
    [a[i], a[hi]] = [a[hi], a[i]];
    fin.add(i);
    F.push(arr(a, paint(n, (k) => (k === i ? 'blue' : k === hi && hi !== i ? 'red' : base(k))), { pivot: i },
      `Swap the pivot ${p} into position ${i}: everything left of it is smaller, everything right is larger or equal. ${p} is final.`));
    rec(lo, i - 1);
    rec(i + 1, hi);
  };
  rec(0, n - 1);
  F.push(arr(a, paint(n, () => 'blue'), {}, 'Every value has been a pivot or a one-value part. The array is sorted.'));
  return { frames: F, result: `Sorted: ${list(a)}` };
}

function binarySearch(input, target) {
  let a = [...input];
  const n = a.length, F = [], rej = new Set();
  const sorted = a.every((v, k) => !k || !less(v, a[k - 1]));
  if (!sorted) a = [...a].sort((x, y) => (less(x, y) ? -1 : less(y, x) ? 1 : 0));
  F.push(arr(a, paint(n, () => 'grey'), { left: 0, right: n - 1 }, `${sorted ? '' : 'Binary search needs sorted data, so the input was sorted first. '}Search for ${target} in positions 0..${n - 1}.`));
  let l = 0, r = n - 1, found = -1;
  while (l <= r) {
    const m = (l + r) >> 1;
    F.push(arr(a, paint(n, (k) => (k === m ? 'green' : rej.has(k) ? 'red' : 'grey')), { left: l, right: r, mid: m }, `mid = (${l} + ${r}) / 2 = ${m}. Compare a[mid] = ${a[m]} with ${target}.`));
    if (a[m] === target || String(a[m]) === String(target)) {
      found = m;
      F.push(arr(a, paint(n, (k) => (k === m ? 'blue' : rej.has(k) ? 'red' : 'grey')), { mid: m }, `${a[m]} = ${target}: found at position ${m}.`));
      break;
    }
    if (less(a[m], target)) {
      for (let k = l; k <= m; k++) rej.add(k);
      F.push(arr(a, paint(n, (k) => (rej.has(k) ? 'red' : 'grey')), { left: m + 1, right: r }, `${a[m]} < ${target}, so the target can only be on the right: discard positions ${l}..${m} and set left = ${m + 1}.`));
      l = m + 1;
    } else {
      for (let k = m; k <= r; k++) rej.add(k);
      F.push(arr(a, paint(n, (k) => (rej.has(k) ? 'red' : 'grey')), { left: l, right: m - 1 }, `${a[m]} > ${target}, so the target can only be on the left: discard positions ${m}..${r} and set right = ${m - 1}.`));
      r = m - 1;
    }
  }
  if (found < 0) F.push(arr(a, paint(n, () => 'red'), { left: l, right: r }, `left (${l}) > right (${r}): the range is empty, so ${target} is not in the array.`));
  return { frames: F, result: found >= 0 ? `${target} found at position ${found} after ${F.filter((f) => /^mid =/.test(f.caption)).length} comparisons.` : `${target} is not in the array.` };
}

function linearSearch(input, target) {
  const a = [...input], n = a.length, F = [];
  F.push(arr(a, paint(n, () => 'grey'), {}, `Search for ${target}, checking each value from the left.`));
  for (let i = 0; i < n; i++) {
    const hit = a[i] === target || String(a[i]) === String(target);
    F.push(arr(a, paint(n, (k) => (k < i ? 'red' : k === i ? 'green' : 'grey')), { i }, `Check position ${i}: is ${a[i]} equal to ${target}?`));
    if (hit) {
      F.push(arr(a, paint(n, (k) => (k < i ? 'red' : k === i ? 'blue' : 'grey')), { i }, `Yes: ${target} found at position ${i}.`));
      return { frames: F, result: `${target} found at position ${i} after ${i + 1} checks.` };
    }
    F.push(arr(a, paint(n, (k) => (k <= i ? 'red' : 'grey')), { i }, `No (${a[i]} ≠ ${target}): reject it and move on.`));
  }
  F.push(arr(a, paint(n, () => 'red'), {}, `Every value was checked: ${target} is not in the array.`));
  return { frames: F, result: `${target} is not in the array (${n} checks).` };
}

// ---------- graphs ----------
const byName = (x, y) => String(x).localeCompare(String(y), undefined, { numeric: true });

/** {nodes?, edges:[[u,v,w?]], start, directed?} -> graph with sorted adjacency and a layered layout. */
function buildGraph(spec) {
  const edges = (Array.isArray(spec.edges) ? spec.edges : []).filter((e) => Array.isArray(e) && e.length >= 2)
    .map((e) => ({ u: String(e[0]), v: String(e[1]), w: e.length > 2 && Number.isFinite(Number(e[2])) ? Number(e[2]) : null }));
  const nodes = [...new Set([...(Array.isArray(spec.nodes) ? spec.nodes.map(String) : []), ...edges.flatMap((e) => [e.u, e.v])])];
  if (!nodes.length) throw new Error('the graph has no nodes');
  if (nodes.length > MAX_NODES) throw new Error(`keep the graph to ${MAX_NODES} nodes or fewer`);
  const directed = !!spec.directed;
  const adj = Object.fromEntries(nodes.map((x) => [x, []]));
  for (const e of edges) { adj[e.u].push({ to: e.v, w: e.w }); if (!directed) adj[e.v].push({ to: e.u, w: e.w }); }
  for (const x of nodes) adj[x].sort((p, q) => byName(p.to, q.to));
  const start = spec.start != null && adj[String(spec.start)] ? String(spec.start) : [...nodes].sort(byName)[0];
  // layered layout: depth from the start (ignoring direction), unreachable nodes on an extra row
  const depth = { [start]: 0 }, q = [start];
  const und = Object.fromEntries(nodes.map((x) => [x, new Set()]));
  for (const e of edges) { und[e.u].add(e.v); und[e.v].add(e.u); }
  while (q.length) { const u = q.shift(); for (const v of [...und[u]].sort(byName)) if (depth[v] === undefined) { depth[v] = depth[u] + 1; q.push(v); } }
  const maxD = Math.max(...Object.values(depth));
  for (const x of nodes) if (depth[x] === undefined) depth[x] = maxD + 1;
  const rows = {};
  for (const x of nodes) (rows[depth[x]] ||= []).push(x);
  const pos = {};
  const GW = 400;
  for (const [d, row] of Object.entries(rows)) row.sort(byName).forEach((x, i) => { pos[x] = { x: Math.round(((i + 1) * GW) / (row.length + 1)), y: 46 + Number(d) * 96 }; });
  return { nodes, edges, directed, adj, start, pos, height: 46 + (Math.max(...Object.values(depth)) + 1) * 96 - 40 };
}

const gframe = (G, colors, caption, extra = {}) => ({ kind: 'graph', G, colors: { ...colors }, caption, active: extra.active || null, tree: [...(extra.tree || [])], aux: extra.aux || null, order: [...(extra.order || [])], table: extra.table || null });
const ekey = (u, v) => `${u}->${v}`;

function bfs(spec) {
  const G = buildGraph(spec), s = G.start, F = [];
  const vis = new Set([s]), q = [s], order = [], tree = new Set();
  const col = (cur, fresh) => Object.fromEntries(G.nodes.map((x) => [x, x === fresh ? 'red' : x === cur ? 'green' : order.includes(x) ? 'blue' : vis.has(x) ? 'blue' : 'grey']));
  const aux = () => ({ title: 'Queue (front → back)', items: [...q], dir: 'row' });
  F.push(gframe(G, col(null, s), `Start at ${s}: mark it visited and put it in the queue.`, { aux: aux(), order, tree }));
  while (q.length) {
    const u = q.shift();
    order.push(u);
    F.push(gframe(G, col(u), `Take ${u} from the front of the queue and visit it. Now check its neighbours${G.adj[u].length ? ` (${G.adj[u].map((e) => e.to).join(', ')})` : ': it has none'}.`, { aux: aux(), order, tree }));
    for (const { to: v } of G.adj[u]) {
      if (!vis.has(v)) {
        vis.add(v); q.push(v); tree.add(ekey(u, v));
        F.push(gframe(G, col(u, v), `${v} has not been seen: mark it visited and add it to the back of the queue.`, { active: [u, v], aux: aux(), order, tree }));
      } else {
        F.push(gframe(G, col(u), `${v} was already seen: skip it.`, { active: [u, v], aux: aux(), order, tree }));
      }
    }
  }
  F.push(gframe(G, col(null), `The queue is empty, so BFS is finished. Visit order: ${order.join(' → ')}.`, { aux: aux(), order, tree }));
  return { frames: F, result: `Visit order from ${s}: ${order.join(' → ')}${order.length < G.nodes.length ? ` (not reachable: ${G.nodes.filter((x) => !order.includes(x)).join(', ')})` : ''}.` };
}

function dfs(spec) {
  const G = buildGraph(spec), s = G.start, F = [];
  const vis = new Set(), st = [s], order = [], tree = new Set(), parent = {};
  const col = (cur, fresh = []) => Object.fromEntries(G.nodes.map((x) => [x, x === cur ? 'green' : fresh.includes(x) ? 'red' : vis.has(x) ? 'blue' : 'grey']));
  const aux = () => ({ title: 'Stack (top ↑)', items: [...st].reverse(), dir: 'column' });
  F.push(gframe(G, col(null, [s]), `Start: push ${s} onto the stack.`, { aux: aux(), order, tree }));
  while (st.length) {
    const u = st.pop();
    if (vis.has(u)) {
      F.push(gframe(G, col(null), `Pop ${u}: it was already visited, so skip it.`, { aux: aux(), order, tree }));
      continue;
    }
    vis.add(u); order.push(u);
    if (parent[u] != null) tree.add(ekey(parent[u], u));
    F.push(gframe(G, col(u), `Pop ${u} from the top of the stack and visit it.`, { active: parent[u] != null ? [parent[u], u] : null, aux: aux(), order, tree }));
    const nb = G.adj[u].map((e) => e.to).filter((v) => !vis.has(v));
    for (const v of [...nb].reverse()) { st.push(v); parent[v] = u; }
    F.push(gframe(G, col(u, nb), nb.length ? `Push ${u}'s unvisited neighbours ${nb.join(', ')} in reverse order, so ${nb[0]} is on top and explored first.` : `${u} has no unvisited neighbours: nothing to push, so we back up.`, { aux: aux(), order, tree }));
  }
  F.push(gframe(G, col(null), `The stack is empty, so DFS is finished. Visit order: ${order.join(' → ')}.`, { aux: aux(), order, tree }));
  return { frames: F, result: `Visit order from ${s}: ${order.join(' → ')}${order.length < G.nodes.length ? ` (not reachable: ${G.nodes.filter((x) => !order.includes(x)).join(', ')})` : ''}.` };
}

function dijkstra(spec) {
  const G = buildGraph(spec), s = G.start, F = [];
  if (G.edges.some((e) => e.w == null)) throw new Error('every edge needs a weight: ["A", "B", 4]');
  if (G.edges.some((e) => e.w < 0)) throw new Error("Dijkstra's algorithm needs non-negative weights");
  const dist = Object.fromEntries(G.nodes.map((x) => [x, x === s ? 0 : Infinity])), prev = {}, done = new Set(), tree = new Set();
  const table = (cur, changed) => ({ rows: [...G.nodes].sort(byName).map((x) => ({ node: x, dist: show(dist[x]), via: prev[x] ?? '–', color: x === changed ? 'red' : x === cur ? 'green' : done.has(x) ? 'blue' : 'white' })) });
  const col = (cur, changed) => Object.fromEntries(G.nodes.map((x) => [x, x === changed ? 'red' : x === cur ? 'green' : done.has(x) ? 'blue' : 'grey']));
  F.push(gframe(G, col(null), `Set dist(${s}) = 0 and every other distance to ∞.`, { table: table(), tree }));
  for (;;) {
    const u = G.nodes.filter((x) => !done.has(x) && dist[x] < Infinity).sort((x, y) => dist[x] - dist[y] || byName(x, y))[0];
    if (u == null) break;
    F.push(gframe(G, col(u), `Pick ${u}: the unfinished node with the smallest distance (${dist[u]}).`, { table: table(u), tree }));
    for (const { to: v, w } of G.adj[u]) {
      if (done.has(v)) continue;
      const nd = dist[u] + w, better = nd < dist[v];
      const old = show(dist[v]);
      if (better) {
        dist[v] = nd;
        for (const k of [...tree]) if (k.endsWith(`->${v}`)) tree.delete(k);
        prev[v] = u; tree.add(ekey(u, v));
      }
      F.push(gframe(G, col(u, better ? v : null), better ? `Edge ${u}–${v}: ${dist[u]} + ${w} = ${nd} < ${old}, so update dist(${v}) to ${nd} (via ${u}).` : `Edge ${u}–${v}: ${dist[u]} + ${w} = ${nd} ≥ ${old}, so keep dist(${v}).`, { active: [u, v], table: table(u, better ? v : null), tree }));
    }
    done.add(u);
    F.push(gframe(G, col(null), `${u} is finished: dist(${u}) = ${dist[u]} can no longer improve.`, { table: table(), tree }));
  }
  F.push(gframe(G, col(null), `No unfinished node is reachable any more: done.`, { table: table(), tree }));
  return { frames: F, result: `Shortest distances from ${s}: ${[...G.nodes].sort(byName).map((x) => `${x} = ${show(dist[x])}`).join(', ')}.` };
}

// ---------- linked list ----------
const lframe = (values, next, colors, pointers, caption) => ({ kind: 'list', values: [...values], next: [...next], colors, pointers, caption });

function reverseList(input) {
  const v = [...input], n = v.length, F = [];
  const next = v.map((_, k) => (k + 1 < n ? k + 1 : null));
  const name = (k) => (k == null || k < 0 || k >= n ? 'null' : v[k]);
  let prev = null, curr = 0;
  const col = (fixed, cur, changed) => paint(n, (k) => (k === changed ? 'red' : k === cur ? 'green' : k < fixed ? 'blue' : 'grey'));
  F.push(lframe(v, next, col(0), { prev: -1, curr: 0 }, `The list is ${v.join(' → ')} → null. Start with prev = null and curr = the head (${v[0]}).`));
  while (curr != null) {
    const nx = next[curr];
    F.push(lframe(v, next, col(curr, curr), { prev: prev ?? -1, curr, next: nx ?? n }, `Save next = ${name(nx)} first, so the rest of the list is not lost.`));
    next[curr] = prev;
    F.push(lframe(v, next, col(curr, null, curr), { prev: prev ?? -1, curr, next: nx ?? n }, `Reverse the link: ${v[curr]}.next now points back to ${name(prev)}.`));
    prev = curr; curr = nx;
    F.push(lframe(v, next, col(prev + 1), { prev, curr: curr ?? n }, `Move both pointers one step: prev = ${name(prev)}, curr = ${name(curr)}.`));
  }
  const out = [];
  for (let k = prev; k != null; k = next[k]) out.push(v[k]);
  F.push(lframe(v, next, paint(n, () => 'blue'), { head: prev }, `curr is null, so every link is reversed. prev (${v[prev]}) is the new head: ${out.join(' → ')} → null.`));
  return { frames: F, result: `Reversed list: ${out.join(' → ')} → null.` };
}

// ---------- drawing ----------
const legendHtml = () => `<span style="display:inline-flex;flex-wrap:wrap;gap:4px 12px;font:12px Helvetica,Arial,sans-serif">${LEGEND.map(([c, t]) => `<span style="display:inline-flex;align-items:center;gap:4px"><span style="display:inline-block;width:13px;height:13px;border:1.5px solid #000;background:${COL[c]}"></span>${esc(t)}</span>`).join('')}</span>`;

/** Labelled up-arrows under positions. `slot(k)` -> x centre; several names at one position stack, so labels never overlap. */
function pointerSvg(pointers, slot, y) {
  const at = {};
  for (const [name, k] of Object.entries(pointers || {})) if (Number.isFinite(k)) (at[k] ||= []).push(name);
  let s = '', bottom = y;
  for (const [k, names] of Object.entries(at)) {
    const x = slot(Number(k));
    s += `<line x1="${x}" y1="${y + 24}" x2="${x}" y2="${y + 6}" stroke="#000" stroke-width="2"/><path d="M${x - 6},${y + 12} L${x},${y + 3} L${x + 6},${y + 12} Z" fill="#000"/>`;
    names.forEach((nm, i) => { s += `<text x="${x}" y="${y + 42 + i * 18}" text-anchor="middle" font-size="16" font-weight="700" ${FONT}>${esc(nm)}</text>`; });
    bottom = Math.max(bottom, y + 46 + (names.length - 1) * 18);
  }
  return { svg: s, bottom };
}

/** A row (queue / merged buffer / key) or column (stack) of small boxes with a title. */
function auxSvg(aux, x0, y0, maxW) {
  if (!aux) return { svg: '', w: 0, h: 0 };
  const B = 40, G = 6;
  let s = `<text x="${x0}" y="${y0 + 14}" font-size="15" font-weight="700" ${FONT}>${esc(aux.title)}</text>`;
  const items = aux.items || [];
  if (!items.length) {
    s += `<rect x="${x0}" y="${y0 + 24}" width="${B * 2}" height="${B}" fill="#fff" stroke="#000" stroke-width="1.5" stroke-dasharray="5 4"/><text x="${x0 + B}" y="${y0 + 24 + B / 2 + 5}" text-anchor="middle" font-size="14" fill="#555" ${FONT}>empty</text>`;
    return { svg: s, w: Math.max(B * 2, aux.title.length * 8.5), h: 24 + B };
  }
  if (aux.dir === 'column') {
    items.forEach((it, i) => { const y = y0 + 24 + i * (B + G); s += `<rect x="${x0}" y="${y}" width="${B * 1.6}" height="${B}" fill="${COL.white}" stroke="#000" stroke-width="2"/><text x="${x0 + B * 0.8}" y="${y + B / 2 + 6}" text-anchor="middle" font-size="17" font-weight="700" ${FONT}>${esc(it)}</text>`; });
    return { svg: s, w: Math.max(B * 1.6, aux.title.length * 8.5), h: 24 + items.length * (B + G) };
  }
  const per = Math.max(1, Math.floor((maxW + G) / (B + G)));
  items.forEach((it, i) => {
    const x = x0 + (i % per) * (B + G), y = y0 + 24 + Math.floor(i / per) * (B + G);
    s += `<rect x="${x}" y="${y}" width="${B}" height="${B}" fill="${COL.white}" stroke="#000" stroke-width="2"/><text x="${x + B / 2}" y="${y + B / 2 + 6}" text-anchor="middle" font-size="16" font-weight="700" ${FONT}>${esc(it)}</text>`;
  });
  const rows = Math.ceil(items.length / per);
  return { svg: s, w: Math.max(Math.min(items.length, per) * (B + G), aux.title.length * 8.5), h: 24 + rows * (B + G) };
}

function arraySvg(f, room = {}) {
  const n = f.values.length;
  const B = n <= 8 ? 60 : Math.max(40, Math.floor(600 / n) - 6), G = 8;
  const ks = Object.values(f.pointers || {}).filter(Number.isFinite);
  const padL = 24 + (room.left || ks.some((k) => k < 0) ? B + G : 0);
  const slot = (k) => padL + k * (B + G) + B / 2;
  const rowW = padL + n * (B + G) + (room.right || ks.some((k) => k >= n) ? B + G : 0) + 16;
  const top = 26;
  let s = '';
  for (let k = 0; k < n; k++) {
    const x = padL + k * (B + G);
    s += `<text x="${x + B / 2}" y="${top - 8}" text-anchor="middle" font-size="12" fill="#555" ${FONT}>${k}</text>`;
    s += `<rect x="${x}" y="${top}" width="${B}" height="${B}" rx="4" fill="${COL[f.colors[k]] || COL.grey}" stroke="#000" stroke-width="2"/>`;
    s += `<text x="${x + B / 2}" y="${top + B / 2 + 7}" text-anchor="middle" font-size="${Math.round(Math.min(22, B * 0.4))}" font-weight="700" ${FONT}>${esc(f.values[k])}</text>`;
  }
  for (const k of ks) if (k < 0 || k >= n) {
    const x = slot(k) - B / 2;
    s += `<rect x="${x}" y="${top}" width="${B}" height="${B}" fill="#fff" stroke="#999" stroke-width="1.5" stroke-dasharray="4 4"/><text x="${x + B / 2}" y="${top + B / 2 + 5}" text-anchor="middle" font-size="12" fill="#777" ${FONT}>outside</text>`;
  }
  const p = pointerSvg(f.pointers, slot, top + B);
  s += p.svg;
  let h = Math.max(top + B + 8, p.bottom) + 8;
  let w = rowW;
  if (f.aux) {
    const a = auxSvg(f.aux, 24, h + 6, Math.max(rowW, 400) - 48);
    s += a.svg;
    h += a.h + 16;
    w = Math.max(w, a.w + 48);
  }
  return { svg: s, w: Math.max(w, 320), h };
}

function graphSvg(f) {
  const { G } = f;
  const R = 23, GW = 400;
  const isTree = (u, v) => f.tree.includes(ekey(u, v)) || (!G.directed && f.tree.includes(ekey(v, u)));
  const isActive = (u, v) => f.active && ((f.active[0] === u && f.active[1] === v) || (!G.directed && f.active[0] === v && f.active[1] === u));
  let s = '<defs><marker id="ah" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#333"/></marker></defs>';
  for (const e of G.edges) {
    const a = G.pos[e.u], b = G.pos[e.v];
    const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
    const x1 = a.x + (dx / len) * R, y1 = a.y + (dy / len) * R, x2 = b.x - (dx / len) * (R + (G.directed ? 3 : 0)), y2 = b.y - (dy / len) * (R + (G.directed ? 3 : 0));
    const act = isActive(e.u, e.v), tr = isTree(e.u, e.v);
    s += `<line x1="${x1}" y1="${y1}" x2="${x2}" y2="${y2}" stroke="${act ? '#1f9d3a' : tr ? '#222' : '#9a9a9a'}" stroke-width="${act ? 6 : tr ? 4 : 2}"${G.directed ? ' marker-end="url(#ah)"' : ''}/>`;
    if (e.w != null) {
      const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
      s += `<rect x="${mx - 14}" y="${my - 12}" width="28" height="22" rx="4" fill="#fff" stroke="#000" stroke-width="1"/><text x="${mx}" y="${my + 4}" text-anchor="middle" font-size="14" font-weight="700" ${FONT}>${esc(e.w)}</text>`;
    }
  }
  for (const x of G.nodes) {
    const p = G.pos[x];
    s += `<circle cx="${p.x}" cy="${p.y}" r="${R}" fill="${COL[f.colors[x]] || COL.grey}" stroke="#000" stroke-width="2.5"/><text x="${p.x}" y="${p.y + 6}" text-anchor="middle" font-size="18" font-weight="700" ${FONT}>${esc(x)}</text>`;
  }
  let h = G.height;
  // beside the graph: queue / stack, or the distance table
  const X = GW + 24;
  let sideH = 0;
  if (f.aux) { const a = auxSvg(f.aux, X, 8, 200); s += a.svg; sideH = a.h + 8; }
  if (f.table) {
    const cw = [52, 64, 64], rh = 28;
    const head = ['node', 'dist', 'via'];
    let y = 8;
    s += `<text x="${X}" y="${y + 14}" font-size="15" font-weight="700" ${FONT}>Distance table</text>`;
    y += 22;
    const row = (cells, fill, bold) => {
      let x = X, out = '';
      cells.forEach((c, i) => { out += `<rect x="${x}" y="${y}" width="${cw[i]}" height="${rh}" fill="${fill}" stroke="#000" stroke-width="1.5"/><text x="${x + cw[i] / 2}" y="${y + rh / 2 + 6}" text-anchor="middle" font-size="15" ${bold ? 'font-weight="700"' : ''} ${FONT}>${esc(c)}</text>`; x += cw[i]; });
      y += rh;
      return out;
    };
    s += row(head, '#f2f2f2', true);
    for (const r of f.table.rows) s += row([r.node, r.dist, r.via], COL[r.color] || COL.white, false);
    sideH = Math.max(sideH, y + 6);
  }
  h = Math.max(h, sideH);
  if (f.order.length) {
    s += `<text x="24" y="${h + 22}" font-size="15" ${FONT}><tspan font-weight="700">Visited so far:</tspan> ${esc(f.order.join(' → '))}</text>`;
    h += 34;
  }
  return { svg: s, w: GW + 24 + (f.table ? 200 : f.aux ? 220 : 0), h: h + 6 };
}

function listSvg(f, room = {}) {
  const n = f.values.length, BW = 70, BH = 48, NW = 22, G = 46;
  const ks = Object.values(f.pointers || {}).filter(Number.isFinite);
  const padL = 24 + (room.left || ks.some((k) => k < 0) ? BW + G : 0);
  const left = (k) => padL + k * (BW + G);
  const slot = (k) => left(k) + (BW - NW) / 2;
  const arcs = f.next.some((t, k) => t != null && t !== k + 1 && t !== k - 1);
  const top = arcs ? 70 : 22; // room for links that jump further than a neighbour (drawn as arcs above)
  let s = '<defs><marker id="la" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto-start-reverse"><path d="M0,0 L10,5 L0,10 z" fill="#222"/></marker></defs>';
  for (let k = 0; k < n; k++) {
    const x = left(k);
    s += `<rect x="${x}" y="${top}" width="${BW}" height="${BH}" fill="${COL[f.colors[k]] || COL.grey}" stroke="#000" stroke-width="2"/>`;
    s += `<line x1="${x + BW - NW}" y1="${top}" x2="${x + BW - NW}" y2="${top + BH}" stroke="#000" stroke-width="2"/>`;
    s += `<text x="${x + (BW - NW) / 2}" y="${top + BH / 2 + 7}" text-anchor="middle" font-size="20" font-weight="700" ${FONT}>${esc(f.values[k])}</text>`;
    const t = f.next[k], cx = x + BW - NW / 2, cy = top + BH / 2;
    if (t == null) s += `<line x1="${x + BW - NW + 4}" y1="${top + BH - 4}" x2="${x + BW - 4}" y2="${top + 4}" stroke="#000" stroke-width="2"/>`; // null: slash
    else if (t === k + 1) s += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#000"/><line x1="${cx}" y1="${cy}" x2="${left(t) - 3}" y2="${cy}" stroke="#222" stroke-width="2.5" marker-end="url(#la)"/>`;
    else if (t === k - 1) {
      // a link to the left neighbour (a reversed link): a straight arrow in the gap, so neighbouring links never cross
      const red = f.colors[k] === 'red';
      s += `<line x1="${x - 2}" y1="${cy}" x2="${left(t) + BW + 4}" y2="${cy}" stroke="${red ? '#d42020' : '#222'}" stroke-width="${red ? 3.5 : 2.5}" marker-end="url(#la)"/>`;
      s += `<text x="${x + BW - NW / 2}" y="${cy + 6}" text-anchor="middle" font-size="15" font-weight="700" ${FONT}>←</text>`;
    } else {
      const tx = left(t) + (BW - NW) / 2, lift = 26 + Math.abs(t - k) * 10;
      const red = f.colors[k] === 'red';
      s += `<circle cx="${cx}" cy="${cy}" r="3.5" fill="#000"/><path d="M${cx},${top} C${cx},${top - lift} ${tx},${top - lift} ${tx},${top - 3}" fill="none" stroke="${red ? '#d42020' : '#222'}" stroke-width="${red ? 3.5 : 2.5}" marker-end="url(#la)"/>`;
    }
  }
  for (const k of ks) if (k < 0 || k >= n) {
    const x = left(k);
    s += `<rect x="${x + 8}" y="${top + 6}" width="${BW - 16}" height="${BH - 12}" fill="#fff" stroke="#999" stroke-width="1.5" stroke-dasharray="4 4"/><text x="${x + BW / 2}" y="${top + BH / 2 + 5}" text-anchor="middle" font-size="14" fill="#666" ${FONT}>null</text>`;
  }
  const p = pointerSvg(f.pointers, (k) => (k < 0 || k >= n ? left(k) + BW / 2 : slot(k)), top + BH);
  s += p.svg;
  const w = left(n) + (room.right || ks.some((k) => k >= n) ? BW : 0) + 24;
  return { svg: s, w: Math.max(w, 320), h: Math.max(top + BH + 8, p.bottom) + 10 };
}

const frameSvg = (f, room) => (f.kind === 'graph' ? graphSvg(f) : f.kind === 'list' ? listSvg(f, room) : arraySvg(f, room));

function frameHtml(f, i, total, room) {
  const { svg, w, h } = frameSvg(f, room);
  return `<div class="algo-frame" style="border:2px solid #000;margin:10px 0;padding:8px 12px 10px;background:#fff;break-inside:avoid;page-break-inside:avoid">` +
    `<div style="display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:6px 16px;margin-bottom:4px"><b style="font:800 14px Helvetica,Arial,sans-serif">Step ${i + 1} of ${total}</b>${legendHtml()}</div>` +
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${Math.ceil(w)} ${Math.ceil(h)}" width="100%" style="max-width:${Math.ceil(w)}px;display:block;margin:4px auto" role="img" aria-label="${esc(f.caption)}">${svg}</svg>` +
    `<div style="font:15px/1.45 Helvetica,Arial,sans-serif;margin-top:6px;padding-top:6px;border-top:1px solid #bbb">${esc(f.caption)}</div></div>`;
}

// ---------- entry points ----------
/** Normalise a spec ({"algo": ..., "input"/"edges"...}); throws a readable error for a bad one. Pure. */
export function normaliseSpec(raw) {
  const spec = typeof raw === 'string' ? JSON.parse(raw) : { ...raw };
  let algo = String(spec.algo || spec.algorithm || '').toLowerCase().trim().replace(/[\s-]+/g, '_');
  algo = ALIASES[algo] || ALIASES[algo.replace(/_/g, '')] || algo;
  if (!INFO[algo]) throw new Error(`unknown algorithm "${spec.algo || spec.algorithm || ''}" (known: ${ALGORITHMS.join(', ')})`);
  spec.algo = algo;
  if (!['bfs', 'dfs', 'dijkstra'].includes(algo)) {
    const input = Array.isArray(spec.input) ? spec.input : Array.isArray(spec.array) ? spec.array : Array.isArray(spec.list) ? spec.list : null;
    if (!input || input.length < 1) throw new Error('"input" must be a list of values');
    if (input.length > MAX_ITEMS) throw new Error(`keep "input" to ${MAX_ITEMS} values or fewer so every step fits`);
    spec.input = input.map((x) => (typeof x === 'number' || (typeof x === 'string' && x.trim() !== '' && !Number.isNaN(Number(x))) ? Number(x) : String(x)));
    if ((algo === 'binary_search' || algo === 'linear_search') && spec.target == null) throw new Error('searching needs a "target"');
    if (spec.target != null && typeof spec.target === 'string' && spec.target.trim() !== '' && !Number.isNaN(Number(spec.target))) spec.target = Number(spec.target);
  }
  return spec;
}

/** Run the algorithm for real. @returns {{info, frames, result, spec}} */
export function traceAlgo(raw) {
  const spec = normaliseSpec(raw);
  const run = {
    bubble_sort: () => bubbleSort(spec.input), selection_sort: () => selectionSort(spec.input), insertion_sort: () => insertionSort(spec.input),
    merge_sort: () => mergeSort(spec.input), quick_sort: () => quickSort(spec.input),
    binary_search: () => binarySearch(spec.input, spec.target), linear_search: () => linearSearch(spec.input, spec.target),
    bfs: () => bfs(spec), dfs: () => dfs(spec), dijkstra: () => dijkstra(spec), reverse_list: () => reverseList(spec.input)
  }[spec.algo];
  return { ...run(), info: INFO[spec.algo], spec };
}

/** What the input is, in words (section 1). */
function inputText(spec) {
  if (['bfs', 'dfs', 'dijkstra'].includes(spec.algo)) {
    const G = buildGraph(spec);
    const es = G.edges.map((e) => `${e.u}${G.directed ? '→' : '–'}${e.v}${e.w != null ? ` (${e.w})` : ''}`).join(', ');
    return `${G.directed ? 'Directed' : 'Undirected'} graph with nodes ${G.nodes.join(', ')}; edges ${es}. Start at ${G.start}.`;
  }
  if (spec.algo === 'reverse_list') return `The linked list ${spec.input.join(' → ')} → null.`;
  return `${list(spec.input)}${spec.target != null ? `, target = ${spec.target}` : ''}.`;
}

/** A ```algo block -> the full walkthrough (problem, every step, result) as HTML. Throws on a bad spec. */
export function renderAlgo(raw) {
  const t = traceAlgo(raw);
  const { info, frames, result, spec } = t;
  // the same slots in every step (a pointer that is null or outside the array in ANY step), so nothing jumps between frames
  const outside = frames.flatMap((f) => Object.values(f.pointers || {}).filter(Number.isFinite).map((k) => [k, (f.values || []).length]));
  const room = { left: outside.some(([k]) => k < 0), right: outside.some(([k, n]) => k >= n) };
  const title = spec.title ? String(spec.title) : `${info.name} on ${['bfs', 'dfs', 'dijkstra'].includes(spec.algo) ? 'this graph' : list(spec.input)}`;
  const para = (label, text) => `<p style="margin:4px 0"><b>${label}</b> ${esc(text)}</p>`;
  return `<section class="algo" style="margin:14px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact">` +
    `<div style="font:800 17px Helvetica,Arial,sans-serif;border-bottom:3px solid #000;padding-bottom:4px;margin-bottom:6px">Step by step: ${esc(title)}</div>` +
    `<div style="font-size:15px;line-height:1.5;break-inside:avoid;page-break-inside:avoid">${para('Problem:', info.problem)}${para('Input:', inputText(spec))}${para('Idea:', info.idea)}</div>` +
    frames.map((f, i) => frameHtml(f, i, frames.length, room)).join('') +
    `<div style="border:2px solid #000;background:#f2f2f2;padding:8px 12px;margin:10px 0;font-size:15px;line-height:1.5;break-inside:avoid;page-break-inside:avoid">` +
    `${para('Result:', result)}${para('Time:', info.time)}${para('Space:', info.space)}${para('When to use it:', info.when)}</div></section>`;
}
