// Figure quality: settled-frame choice, the frame selector's verdicts, section times, marker clean-up, prices.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const { frameMetrics, pickSettled, halve } = await import('./lib/scenes.js');
const lp = await import('./lib/local-pipeline.js');
const { renderMarkdown } = await import('./lib/md.js');
const { selectPrompt } = await import('./lib/prompts.js');

// ---- sharpness and "ink": a blurred copy is less sharp; a chart with its curve drawn has more ink
{
  const W = 320, H = 180;
  const axes = new Uint8Array(W * H).fill(20);
  for (let y = 20; y < 160; y++) axes[y * W + 40] = 230; // y axis
  for (let x = 40; x < 300; x++) axes[90 * W + x] = 230; // x axis
  const curve = axes.slice();
  for (let x = 40; x < 300; x++) { const y = Math.round(90 - 50 * Math.sin((x - 40) / 20)); curve[y * W + x] = 230; curve[(y + 1) * W + x] = 230; }
  const blur = new Uint8Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) { // horizontal motion blur, 9 px
    let s = 0, n = 0;
    for (let k = -4; k <= 4; k++) { const xx = Math.min(W - 1, Math.max(0, x + k)); s += curve[y * W + xx]; n++; }
    blur[y * W + x] = s / n;
  }
  const a = frameMetrics(axes, W, H), c = frameMetrics(curve, W, H), b = frameMetrics(blur, W, H);
  assert.ok(c.ink > a.ink, 'the finished chart has more ink than its empty axes');
  assert.ok(b.sharp < c.sharp * 0.5, 'motion blur lowers sharpness');
  assert.equal(halve(curve, W, H).length, (W / 2) * (H / 2));

  // one scene sampled at 19, 20, 21, 22 s: the sine wave draws in from 19 to 21 s, then holds still.
  // 19 s is mid-transition (moving + blurred), 20 s has axes only, 21 s half a curve, 22 s the full one.
  const scene = [
    { t: 19, motion: 0.2, sharp: b.sharp, ink: b.ink },
    { t: 20, motion: 0.01, sharp: a.sharp, ink: a.ink },
    { t: 21, motion: 0.02, sharp: c.sharp, ink: (a.ink + c.ink) / 2 },
    { t: 22, motion: 0.004, sharp: c.sharp, ink: c.ink }
  ];
  assert.equal(pickSettled(scene, 0.025), 22, 'the fully drawn, still moment');
  // the title card spinning in (all samples moving): the sharpest one, never a blurred one
  assert.equal(pickSettled([{ t: 0, motion: 0.5, sharp: 10, ink: 0.2 }, { t: 1, motion: 0.4, sharp: 90, ink: 0.1 }], 0.025), 1);
  console.log('settled frame ok');
}

// ---- the selector's verdicts
{
  const batch = [{ index: 1 }, { index: 4 }, { index: 6 }, { index: 7 }, { index: 9 }];
  const reply = '```json\n' + JSON.stringify({ frames: [
    { id: 'F1', keep: false, reason: 'split-flap letters spinning, motion blur', kind: 'transition', info: 0, caption: '' },
    { id: 'F4', keep: true, kind: 'chart', info: 8, caption: 'This image shows a graph with vertical axis "CURRENT" and horizontal axis "TIME"; a flat line above zero.', text: 'CURRENT TIME' },
    { id: 'F6', keep: true, kind: 'patent', info: 9, caption: 'Patent drawing labelled "N. TESLA. ELECTRO MAGNETIC MOTOR. No. 382,280".', text: 'No. 382,280' },
    { id: 'F7', keep: true, kind: 'chart', info: 8, caption: 'Same graph', same_as: 'F4' },
    { id: 'F9', keep: true, kind: 'logo', info: 1, caption: 'Channel logo' }
  ] }) + '\n```';
  const v = lp.readVerdicts(reply, batch);
  assert.equal(v[1].keep, false); assert.match(v[1].reason, /blur/);
  assert.equal(v[4].keep, true); assert.equal(v[4].kind, 'chart');
  assert.ok(!/^This image shows/i.test(v[4].caption), 'stock opening removed');
  assert.match(v[6].caption, /382,280/);
  assert.equal(v[7].keep, false, 'a near-duplicate is never kept');
  assert.equal(v[9].keep, false, 'a logo is never a figure, whatever "keep" says');
  assert.deepEqual(lp.readVerdicts('not json at all', batch), {});
  assert.ok(!lp.readVerdicts(JSON.stringify({ frames: [{ id: 'F99', keep: true, kind: 'map', info: 9 }] }), batch)[99], 'unknown ids ignored');
  // the selector never sees the transcript, so its captions cannot borrow from the narration
  const p = selectPrompt({ title: 'AC vs DC', frames: [{ id: 'F4', time: '00:22' }] });
  assert.match(p, /\[TASK:SELECT\]/); assert.match(p, /Image 1 = F4 at 00:22/); assert.match(p, /never guess/i);
  console.log('frame verdicts ok');
}

// ---- section times follow the transcript, not the writer's guess
{
  const segs = [
    { start: 0, end: 6, text: 'In 1884, engineer Nikola Tesla was hired by Thomas Edison\'s headquarters in New York City.' },
    { start: 6, end: 12, text: 'Tesla idolized Edison, but they disagreed about one thing.' },
    { start: 12, end: 20, text: 'Edison favored DC, direct current, while Tesla believed in AC, alternating current.' },
    { start: 24, end: 31, text: 'Tesla offered to improve Edison\'s motor and generator, and Edison offered him $50,000.' },
    { start: 31, end: 37, text: 'After months of work Tesla succeeded, but Edison dismissed the offer as a joke.' },
    { start: 41, end: 48, text: 'Edison and Westinghouse battled over which type of electricity was more efficient.' }
  ];
  const notes = `### Two currents (00:00)
- **Big idea:** they disagreed
- **Key points:**
    - In 1884, Nikola Tesla was hired at Thomas Edison's headquarters in New York City.

### The $50,000 bet (00:18)
- **Key points:**
    - Tesla offered to improve Edison's DC motor and generator.
    - Edison offered him $50,000 if he succeeded.

### Edison vs. Westinghouse (00:34)
- **Key points:**
    - Edison and Westinghouse battled over which electricity was more efficient.
`;
  const out = lp.snapSectionTimes(notes, segs);
  assert.match(out, /### Two currents \(00:00\)/);
  assert.match(out, /### The \$50,000 bet \(00:24\)/);
  assert.match(out, /### Edison vs\. Westinghouse \(00:41\)/);
  // a coarse transcript (one piece per minute) cannot say better: left alone
  const coarse = [0, 60, 120, 180].map((s) => ({ start: s, end: s + 60, text: 'x' }));
  assert.equal(lp.snapSectionTimes(notes, coarse), notes);
  console.log('section times ok');
}

// ---- a marker written as a bullet must not leave an empty "◦"
{
  const md = lp.normaliseMarkers('- **Key points:**\n    - AC reverses direction.\n    - [[FRAME:F4]]\n');
  assert.ok(!/-\s*\[\[FRAME/.test(md)); assert.match(md, /\n\[\[FRAME:4\]\]\n/);
  console.log('bullet markers ok');
}

// ---- prices are not maths: "\$50,000" and "$10 on top of his $18" print as dollars
{
  const a = renderMarkdown('Edison offered him \\$50,000 if he succeeded.');
  assert.match(a, /him \$50,000 if/); assert.ok(!/\\\$/.test(a));
  const b = renderMarkdown('a bonus of $10 on top of his $18 weekly wage', { math: () => '<b>MATH</b>' });
  assert.match(b, /\$10 on top of his \$18 weekly/); assert.ok(!/MATH/.test(b));
  const c = renderMarkdown('so $2 + 3 = 5$ holds', { math: () => '<b>MATH</b>' });
  assert.match(c, /MATH/, 'real maths still renders');
  const d = renderMarkdown('the value $5$ here', { math: () => '<b>MATH</b>' });
  assert.match(d, /MATH/);
  console.log('prices ok');
}

// ---- figures spread over the story (the Tesla short: two frames of one desk scene, sections with none)
{
  const F = (index, t, extra = {}) => ({ index, t, score: 0.6, kinds: [], tag: 'photo', ...extra });
  const screen = [
    F(1, 0), F(2, 40, { score: 0.7 }), F(3, 46, { score: 0.5 }), F(4, 62),
    F(5, 83, { score: 0.6, caption: 'Tesla digging a ditch', important: true }), F(6, 114, { score: 0.8 }), F(7, 122, { score: 0.9, important: true }),
    F(8, 160, { tag: 'chart', kinds: ['diagram'] }), F(9, 163, { tag: 'chart', kinds: ['diagram'] }), F(10, 185)
  ];
  const by = new Map(screen.map((f) => [f.index, f]));
  const notes = `### Arrival (00:09)
- **Key points:**
    - Tesla lands in New York.

[[FRAME:1]]

### The broken promise (00:52)
- **Key points:**
    - Tesla pitches Edison.

[[FRAME:2]]

[[FRAME:3]]

    - Edison offers $50,000.

[[FRAME:4]]

### Rock bottom (01:20)
- **Key points:**
    - Tesla digs ditches for $2 a day.

### The War of the Currents (01:50)
- **Key points:**
    - Edison warns newspapers.

### The charts (02:35)
- **Key points:**
    - two charts

[[FRAME:8]]

[[FRAME:9]]
`;
  const out = lp.balanceFigures(notes, screen, by, { budget: 15, duration: 200, minGap: 20 });
  const shown = [...out.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map((m) => +m[1]);
  assert.ok(shown.includes(2) && !shown.includes(3), 'same desk scene 6 s apart: only the stronger frame stays');
  assert.ok(shown.includes(4), '01:02 is a different moment (22 s later): kept');
  assert.ok(out.indexOf('[[FRAME:5]]') > out.indexOf('### Rock bottom') && out.indexOf('[[FRAME:5]]') < out.indexOf('### The War'), 'an empty section gets a frame from its own time');
  const war = out.slice(out.indexOf('### The War'), out.indexOf('### The charts'));
  assert.match(war, /\[\[FRAME:7\]\]/, 'the best frame of the section, 20+ s from the others');
  assert.ok(shown.includes(8) && shown.includes(9), 'charts are never thinned out');
  // a section is only given an IMPORTANT frame: no filler pictures
  const plain = screen.map((f) => ({ ...f, important: false }));
  const out2 = lp.balanceFigures(notes, plain, new Map(plain.map((f) => [f.index, f])), { budget: 15, duration: 200, minGap: 20 });
  assert.ok(!out2.includes('[[FRAME:5]]') && !out2.includes('[[FRAME:7]]'), 'no filler frame for an empty section');
  assert.equal(new Set(shown).size, shown.length, 'no figure twice');
  // headings are never later than the figures inside them, and never go back past the previous one
  const h = lp.headersBeforeFigures(out, by);
  assert.match(h, /### Arrival \(00:00\)/);
  assert.match(h, /### The broken promise \(00:40\)/);
  assert.match(h, /### Rock bottom \(01:20\)/, 'figure later than the heading: heading stays');
  const order = [...h.matchAll(/^### .*\((\d+):(\d+)\)/gm)].map((m) => +m[1] * 60 + +m[2]);
  assert.deepEqual(order, [...order].sort((a, b) => a - b), 'heading times only go forward');
  console.log('figure spread ok');
}
