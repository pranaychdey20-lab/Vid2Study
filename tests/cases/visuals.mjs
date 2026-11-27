import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Script } from 'node:vm';
import { compileExpr, readVisual, renderVisual, transformedPixels, visualRuntime, VISUAL_CANONICAL, VISUAL_GUIDE, VISUAL_TYPES } from './lib/textbook-visuals.js';
import { renderMarkdown } from './lib/md.js';

// ---- expressions: safe, correct, bounded
const f = compileExpr('a*sin(b*x)+c', ['a', 'b', 'c', 'x']);
assert.ok(Math.abs(f({ a: 2, b: 1, c: 1, x: Math.PI / 2 }) - 3) < 1e-9);
assert.equal(compileExpr('2x^2 - 3x + 1', ['x'])({ x: 2 }), 3);
assert.equal(compileExpr('-x^2', ['x'])({ x: 3 }), -9);
assert.equal(compileExpr('2^3^2', [])({}), 512);
assert.equal(compileExpr('pi', [])({}), Math.PI);
for (const bad of ['process.exit()', 'constructor', 'x.y', '__proto__', 'alert(1)', 'sin(', '1+', '', 'a'.repeat(300), 'x;y', 'globalThis']) {
  assert.equal(compileExpr(bad, ['x']), null, bad);
}

// ---- every example in the writer guide must be a real, drawable visual
const SAMPLES = {
  histogram: [{ values: [0, 50, 100, 150], frequencies: [3, 3, 4, 2] }, { data: [1, 2, 2, 3, 3, 3, 9], bins: 4 }, { pixels: [10, 20, 200, 250] }],
  equation_steps: [{ steps: ['a=b+c', { tex: 'a-c=b', note: 'subtract c' }] }],
  matrix: [{ matrix: [[1, 2], [3, 4]], highlight: [[0, 1]] }],
  matrix_operation: [{ op: 'multiply', a: [[1, 2], [3, 4]], b: [[0, 1], [1, 0]] }, { op: 'determinant', a: [[1, 2], [3, 4]] }, { op: 'transpose', a: [[1, 2, 3]] }],
  function_plot: [{ fn: 'a*sin(b*x)', params: { a: [0, 3, 1], b: [1, 5, 2] }, xmin: -3, xmax: 3 }, { fns: ['x^2', 'x'], xmin: -2, xmax: 2 }],
  surface_plot: [{ fn: 'x^2+y^2' }],
  numerical_calculator: [{ expr: 'm*a', vars: { m: [0, 10, 2, 'kg'], a: [0, 9, 3] }, result: 'F' }],
  vector_diagram: [{ vectors: [{ x: 2, y: 1, label: 'a' }, { x: -1, y: 3 }], sum: true }],
  vector_decomposition: [{ magnitude: 10, angle: 30 }],
  coordinate_plane: [{ points: [{ x: 1, y: 2, label: 'P' }], lines: [{ x1: 0, y1: 0, x2: 3, y2: 3 }] }],
  number_line: [{ min: -5, max: 5, points: [{ value: 2, label: 'x' }], intervals: [{ from: -1, to: 3 }] }],
  bar_chart: [{ labels: ['a', 'b'], values: [3, 5] }, { labels: ['a', 'b'], series: [{ name: 'x', values: [1, 2] }, { name: 'y', values: [2, 1] }] }],
  line_chart: [{ x: [1, 2, 3], series: [{ name: 's', values: [1, 4, 9] }] }, { labels: ['a', 'b', 'c'], values: [1, 2, 3] }],
  scatter_plot: [{ points: [[1, 2], [2, 4], [3, 5.5]] }, { r: 0.8 }],
  box_plot: [{ groups: [{ name: 'A', values: [1, 2, 3, 4, 5, 20] }, { name: 'B', values: [2, 3, 4, 5, 6] }] }],
  normal_distribution: [{ mu: 0, sigma: 1, shade: [-1, 1] }],
  probability_distribution: [{ kind: 'binomial', n: 10, p: 0.3 }, { kind: 'poisson', lambda: 4 }],
  pixel_grid: [{ pixels: [1, 2, 3, 4], width: 2 }],
  brightness_contrast: [{ pixels: [40, 120, 230], beta: 30 }],
  gamma_correction: [{ pixels: [30, 90, 160, 230], gamma: 0.6 }],
  laplacian_sharpening: [{ pixels: [50, 50, 80, 120, 150, 150], alpha: 1 }],
  convolution: [{ image: [[1, 2, 3], [4, 5, 6], [7, 8, 9]], kernel: [[0, 1, 0], [1, -4, 1], [0, 1, 0]] }],
  before_after: [{ before: [10, 20], after: [30, 40] }],
  noise_simulator: [{ pixels: [100, 120, 140, 160], width: 2 }],
  colour_mixer: [{ rgb: [200, 100, 50] }],
  frequency_filter: [{ components: [{ f: 2, a: 1 }, { f: 12, a: 0.5 }], mode: 'lowpass' }],
  robot_arm: [{ links: [1, 1], angles: [30, 45] }, { links: [1, 1, 0.5], angles: [0, 0, 0] }],
  free_body_diagram: [{ forces: [{ label: 'W', magnitude: 10, angle: 270 }, { label: 'N', magnitude: 10, angle: 90 }] }],
  control_block: [{ blocks: ['Controller', 'Plant'], sensor: 'Sensor' }, { blocks: ['G'], feedback: false }, { blocks: ['K', 'G'] }],
  signal_plot: [{ kind: 'square', amplitude: 2, frequency: 3 }],
  circuit_diagram: [{ topology: 'series', elements: [{ type: 'R', value: 100 }, { type: 'R', value: 200 }], voltage: 9 }, { topology: 'parallel', elements: [{ type: 'R', value: 100 }, { type: 'R', value: 100 }], voltage: 5 }],
  mass_spring_damper: [{ m: 1, k: 20, c: 2 }, { m: 1, k: 20, c: 20 }],
  comparison_grid: [{ columns: [{ title: 'A', matrix: [[0, 1], [1, 0]], formula: 'g=f-L' }, { title: 'B', items: ['one', 'two'] }] }],
  process_flow: [{ steps: ['Capture', { title: 'Filter', text: 'remove noise' }] }],
  flowchart: [{ nodes: [{ id: 'a', label: 'Start' }, { id: 'b', label: 'ok?', shape: 'decision' }, { id: 'c', label: 'End' }], edges: [['a', 'b'], ['b', 'c', 'yes'], ['b', 'a', 'no']] }],
  timeline: [{ events: [{ when: '1950', title: 'One' }, { when: '1960', title: 'Two', text: 'more' }] }],
  concept_diagram: [{ center: 'Vision', nodes: [{ label: 'Light' }, { label: 'Lens', note: 'focus' }] }],
  data_table: [{ columns: ['a', 'b'], rows: [[1, 2], ['x', 'y']] }],
  stepper: [{ steps: [{ title: 'One', text: 'first' }, { title: 'Two' }] }],
  quiz: [{ question: 'Q?', options: ['a', 'b'], answer: 1, explain: 'because' }],
  reveal: [{ question: 'Q?', answer: 'A' }]
};
for (const type of VISUAL_CANONICAL) assert.ok(SAMPLES[type], 'no sample for ' + type);
const covered = new Set(Object.keys(SAMPLES));
for (const type of covered) {
  for (const input of SAMPLES[type]) {
    const json = JSON.stringify({ type, ...input });
    const spec = readVisual(json);
    assert.ok(spec, 'readable: ' + json);
    for (const live of [true, false]) {
      const html = renderVisual(json, live, (tex) => '<span class="katex">' + tex + '</span>');
      assert.match(html, /<figure class="study-visual/, type);
      assert.doesNotMatch(html, /NaN|undefined|Infinity|\[object/, type + ': ' + html.match(/.{40}(NaN|undefined|Infinity|\[object).{40}/)?.[0]);
      assert.doesNotMatch(html, /<script|onerror|javascript:/i);
    }
    // print / PDF form: no sliders
    assert.doesNotMatch(renderVisual(json, false), /type="range"/, type);
  }
}
assert.ok(covered.size >= 38, 'registry covers ' + covered.size + ' types');

// every type named in the guide exists (the guide is what the writer is told)
for (const [, name] of VISUAL_GUIDE.matchAll(/(?:^|\| |: )([a-z_]+)\{/gm)) assert.ok(VISUAL_TYPES.includes(name), 'guide names unknown type ' + name);
assert.ok(VISUAL_GUIDE.length < 5200, 'guide stays compact (' + VISUAL_GUIDE.length + ' chars)');
const example = /Example: (\{.*\})/.exec(VISUAL_GUIDE)[1];
assert.ok(readVisual(example), 'guide example is valid');

// ---- the maths is right
const mm = renderVisual(JSON.stringify({ type: 'matrix_operation', op: 'multiply', a: [[1, 2], [3, 4]], b: [[5, 6], [7, 8]] }), false);
assert.match(mm, /<td>19<\/td><td>22<\/td>/);
assert.match(mm, /<td>43<\/td><td>50<\/td>/);
assert.match(renderVisual('{"type":"matrix_operation","op":"determinant","a":[[1,2],[3,4]]}', false), /det\(A\) = -2/);
assert.match(renderVisual('{"type":"normal_distribution","mu":0,"sigma":1,"shade":[-1,1]}', false), /0\.6827/);
assert.match(renderVisual('{"type":"probability_distribution","kind":"binomial","n":10,"p":0.5}', false), /Mean<\/dt><dd>5</);
assert.match(renderVisual('{"type":"vector_decomposition","magnitude":10,"angle":30}', false), /8\.66/);
assert.match(renderVisual('{"type":"colour_mixer","rgb":[255,128,0]}', false), /#ff8000/);
assert.match(renderVisual('{"type":"robot_arm","links":[1,1],"angles":[0,90]}', false), /\(1, 1\)/);
assert.match(renderVisual('{"type":"numerical_calculator","expr":"m*a","vars":{"m":[0,10,2],"a":[0,9,3]}}', false), /= m\*a<\/dt><dd>6</);
assert.match(renderVisual('{"type":"mass_spring_damper","m":1,"k":4,"c":4}', false), /critically damped/);
assert.match(renderVisual('{"type":"box_plot","groups":[{"name":"A","values":[1,2,3,4,5]}]}', false), /<td>3<\/td><td>1\.581<\/td>/);
const conv = renderVisual('{"type":"convolution","image":[[1,2,3],[4,5,6],[7,8,9]],"kernel":[[0,1,0],[1,-4,1],[0,1,0]]}', false);
assert.match(conv, /Output\[1, 1\] =/);
assert.deepEqual(transformedPixels('gamma_correction', [255, 0], { gamma: 2 }), [255, 0]);

// ---- hostile or broken input is rejected, never executed or drawn wrong
const bad = [
  '{"type":"<script>alert(1)</script>"}', '{"type":"function_plot","fn":"process.exit()"}', '{"type":"function_plot","fn":"x","params":{"constructor":[0,1,0]}}',
  '{"type":"histogram","frequencies":[1,2,"x"]}', '{"type":"pixel_grid","pixels":[999]}', '{"type":"flowchart","nodes":[{"id":"a","label":"A"},{"id":"a","label":"B"}],"edges":[]}',
  '{"type":"flowchart","nodes":[{"id":"a","label":"A"},{"id":"b","label":"B"}],"edges":[["a","zzz"]]}', '{"type":"quiz","question":"q","options":["a","b"],"answer":5}',
  '{"type":"constructor"}', '{"type":"__proto__"}', 'not json', '[]', 'null', '{"type":"matrix_operation","op":"multiply","a":[[1,2]],"b":[[1,2]]}',
  '{"type":"scatter_plot","points":[[1,"2"]]}', '{"type":"robot_arm","links":[1],"angles":[0]}', JSON.stringify({ type: 'data_table', columns: ['a'], rows: [['x'.repeat(500)]] })
];
for (const json of bad) {
  assert.equal(readVisual(json), null, json.slice(0, 60));
  assert.match(renderVisual(json), /could not be drawn/);
}
assert.doesNotMatch(renderVisual(JSON.stringify({ type: 'timeline', events: [{ when: '1', title: '<img src=x onerror=alert(1)>' }, { when: '2', title: 'b' }] }), false), /<img/);
assert.doesNotMatch(renderVisual(JSON.stringify({ type: 'bar_chart', labels: ['<b>x</b>', 'y'], values: [1, 2], title: '"><script>' }), false), /<b>x|<script/);

// ---- through the Markdown renderer, and the exported runtime parses
const fence = '\x60'.repeat(3);
const md = renderMarkdown('Intro\n\n' + fence + 'visual\n{"type":"gamma_correction","pixels":[10,200],"gamma":2}\n' + fence + '\n\nAfter');
assert.match(md, /data-study-visual=/);
assert.match(md, /type="range"/);
const source = readFileSync(new URL('./lib/textbook-visuals.js', import.meta.url), 'utf8');
const runtime = await visualRuntime(source);
assert.ok(runtime.startsWith('(function(){') && runtime.endsWith('bindVisuals(document);\n})();'));
assert.doesNotMatch(runtime, /import\.meta/);
assert.doesNotThrow(() => new Script(runtime), 'a classic script: it loads from file:// with no module');
assert.doesNotThrow(() => new Script(runtime), "a classic script: it loads from file:// with no module");
assert.doesNotMatch(runtime, /^export /m);
assert.doesNotThrow(() => new Script('(async()=>{' + runtime.replace(/import\.meta\.url/g, '"x"') + '})'));

// ---- the runtime really re-renders on a slider move (tiny DOM)
const listeners = [];
const body = { innerHTML: '' };
const slider = { name: 'gamma', value: '2', defaultValue: '1', parentElement: { querySelector: () => ({ textContent: '' }) } };
const figure = {
  dataset: { studyVisual: JSON.stringify(readVisual('{"type":"gamma_correction","pixels":[64,128],"gamma":1}')) },
  querySelectorAll: sel => (sel === 'input[type=range]' ? [slider] : []),
  querySelector: sel => (sel === '[data-sv-body]' ? body : { addEventListener: () => {} }),
  addEventListener: (type, fn) => listeners.push([type, fn])
};
const { bindVisuals } = await import('./lib/textbook-visuals.js');
bindVisuals({ querySelectorAll: () => [figure] });
assert.match(body.innerHTML, /--shade:64/, 'initial draw uses the slider value 2 on 64 -> 16');
listeners.find(([type]) => type === 'input')[1]();
assert.match(body.innerHTML, /study-pixels/);
console.log('visuals ok:', covered.size, 'types');
