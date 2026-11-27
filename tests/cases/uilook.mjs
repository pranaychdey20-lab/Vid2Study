// UI changes: the assistant's look patch is validated, merged and turned into CSS; nothing unsafe gets through.
import assert from 'node:assert/strict';
import { sanitizeLook, mergeLook, lookCss, readLookReply, describeLook, safeValue, cleanSvg, orbIcon, sanitizeStored, ORB_ICONS, LOOK_GUIDE } from './lib/ui-theme.js';

// ---- reading a reply
assert.deepEqual(readLookReply('```json\n{"mode":"dark"}\n```'), { mode: 'dark' });
assert.deepEqual(readLookReply('Sure! {"mode":"dark"} done'), { mode: 'dark' });
assert.equal(readLookReply('no json here'), null);

// ---- values: plain CSS in, anything that can load or run something out
for (const ok of ['#fff', 'rgb(10, 20, 30)', 'linear-gradient(90deg, #0e6a64, #1d9a8f)', '0 2px 8px rgba(0,0,0,.3)', 'rotate(12deg)', '12px 8px', 'calc(100% - 8px)', 12]) assert.ok(safeValue(ok) != null, ok);
for (const bad of ['url(https://evil.example/x.png)', 'url(data:image/png;base64,AAAA)', 'red; background: blue', 'red} body{display:none', 'expression(alert(1))', 'var(--k)', '</style><script>', 'a'.repeat(200), '@import', 'foo(1)', '"x"', 'red /* hi */', '']) assert.equal(safeValue(bad), null, String(bad));

// ---- the model's patch: kept, clamped, or dropped (and reported)
{
  const { patch, dropped } = sanitizeLook({
    mode: 'dark', colors: { accent: '#4fd1c5', paper: 'red', ink: 'url(x)', bogus: '#fff' },
    font: { body: 'serif', heading: 'Comic Papyrus', size: 99, lineHeight: 1.7 }, layout: { width: 5000, radius: 8, headings: 'bar', spacing: 1.2 },
    orb: { icon: 'planet', size: 200, color: '#ff8800', glow: true, corner: 'top-left', label: 'Ask <b>me</b>' },
    targets: { figures: { 'border-radius': '12px', background: 'url(x)', hover: { transform: 'scale(1.02)', 'behavior': 'x' } }, evil: { color: 'red' } },
    animate: [{ target: 'orb', name: 'spin', when: 'hover', seconds: 2 }, { target: 'orb', name: 'explode' }, { target: 'nowhere', name: 'spin' }],
    runScript: 'alert(1)'
  });
  assert.equal(patch.mode, 'dark');
  assert.deepEqual(patch.colors, { accent: '#4fd1c5' });
  assert.deepEqual(patch.font, { body: 'serif', size: 24, lineHeight: 1.7 });
  assert.deepEqual(patch.layout, { width: 1400, radius: 8, spacing: 1.2, headings: 'bar' });
  assert.deepEqual(patch.orb, { icon: 'planet', size: 84, color: '#ff8800', glow: true, label: 'Ask bmeb', corner: 'top-left' });
  assert.deepEqual(patch.targets, { figures: { 'border-radius': '12px', hover: { transform: 'scale(1.02)' } } });
  assert.deepEqual(patch.animate, [{ target: 'orb', name: 'spin', when: 'hover', seconds: 2, count: '1', ease: 'linear' }]);
  for (const d of ['colors.paper', 'colors.ink', 'font.heading', 'figures.background', 'target "evil"']) assert.ok(dropped.includes(d), d);
  assert.ok(describeLook(patch).length >= 6);
}
assert.deepEqual(sanitizeLook('nope').patch, {});
assert.deepEqual(sanitizeLook({ reset: true }).patch, { reset: true });

// ---- orb icons: presets, emoji, and a custom drawing that is rebuilt from a whitelist
assert.ok(orbIcon('dragonball').html.startsWith('<svg'));
assert.ok(Object.keys(ORB_ICONS).length >= 10);
assert.deepEqual(orbIcon('🦉'), { glyph: '🦉' });
assert.deepEqual(orbIcon('AI'), { glyph: 'AI' });
assert.equal(orbIcon('<script>alert(1)</script>'), null);
assert.equal(orbIcon('hello world'), null);
const drawing = '<svg viewBox="0 0 64 64"><circle cx="32" cy="32" r="30" fill="#0e6a64"/><path d="M20 32h24" stroke="#fff" stroke-width="4"/></svg>';
assert.equal(cleanSvg(drawing).includes('<circle'), true);
for (const bad of [
  '<svg viewBox="0 0 64 64"><script>alert(1)</script></svg>', '<svg onload="alert(1)"><circle r="3"/></svg>', '<svg><image href="https://evil/x.png"/></svg>',
  '<svg><circle r="3" style="fill:url(https://evil/x)"/></svg>', '<svg><circle r="3" fill="url(https://evil/x)"/></svg>', '<svg><foreignObject/></svg>', '<svg><text>x</text></svg>',
  '<circle r="3"/>', '<svg><circle r="3"></svg>', '<svg><a href="javascript:1"><circle r="3"/></a></svg>', 'x'.repeat(6000)
]) assert.equal(cleanSvg(bad), null, bad.slice(0, 50));
assert.equal(cleanSvg('<svg width="900" height="900" viewBox="0 0 10 10"><rect x="1" y="1" width="3" height="3"/></svg>').includes('width="900"'), false, 'root size is dropped');

// ---- merging: patches build on the saved look; reset clears
{
  let look = mergeLook({}, sanitizeLook({ mode: 'dark', colors: { accent: '#ff0066' }, orb: { icon: 'star' } }).patch);
  look = mergeLook(look, sanitizeLook({ colors: { paper: '#101010' }, animate: [{ target: 'orb', name: 'pulse', when: 'always', seconds: 3 }] }).patch);
  assert.deepEqual(look.colors, { accent: '#ff0066', paper: '#101010' });
  assert.equal(look.orb.icon, 'star');
  assert.equal(look.animate[0].count, 'infinite');
  look = mergeLook(look, { reset: ['orb', 'animate'] });
  assert.equal(look.orb, undefined); assert.equal(look.animate, undefined); assert.equal(look.mode, 'dark');
  assert.deepEqual(mergeLook(look, { reset: true }), {});
  // a stored look is checked again on load: a tampered value cannot smuggle CSS
  assert.deepEqual(sanitizeStored({ colors: { accent: 'red;}body{display:none' }, targets: { page: { background: 'url(x)' } } }), {});
}

// ---- CSS
{
  assert.equal(lookCss({}), '', 'no saved look: the page is untouched');
  const dark = lookCss(mergeLook({}, sanitizeLook({ mode: 'dark' }).patch));
  assert.match(dark, /html\[data-look\]\{--k:#e8eeec;--w:#14181b/);
  assert.match(dark, /color-scheme:dark/);
  const auto = lookCss({ mode: 'auto' });
  assert.match(auto, /@media \(prefers-color-scheme:dark\)/);
  const spin = lookCss(mergeLook({}, sanitizeLook({ animate: [{ target: 'orb', name: 'spin', when: 'hover', seconds: 2, count: 'infinite' }] }).patch));
  assert.match(spin, /\.ask-orb:hover \.ask-face\{animation:v2s-spin 2s linear infinite both;\}/);
  assert.match(spin, /@keyframes v2s-spin/);
  assert.match(spin, /prefers-reduced-motion:reduce/);
  const fig = lookCss({ targets: { figures: { 'border-radius': '14px', hover: { transform: 'scale(1.03)' } }, toolbar: { background: '#112233' } } });
  assert.match(fig, /html\[data-look\] #out img\{border-radius:14px\}/);
  assert.match(fig, /html\[data-look\] #out img:hover\{transform:scale\(1\.03\)\}/);
  assert.match(fig, /\.bar2\{background:#112233\}/);
  const heads = lookCss({ layout: { headings: 'bar', width: 900 }, font: { body: 'serif', size: 17 } });
  assert.match(heads, /html\[data-look\] #out h2\{border-top:0;padding:6px 12px/);
  assert.match(heads, /max-width:900px/);
  assert.match(heads, /font-size:17px/);
  const corner = lookCss({ orb: { corner: 'top-left', size: 60, glow: false } });
  assert.match(corner, /left:14px;right:auto;top:14px;bottom:auto/);
  assert.match(corner, /\.ask-orb::before\{display:none\}/);
  // nothing the model can send ends up outside the style rules
  const all = lookCss(mergeLook({}, sanitizeLook({ colors: { accent: '#abc' }, targets: { text: { color: 'red; } body { display:none' } } }).patch));
  assert.ok(!all.includes('display:none'));
}
assert.match(LOOK_GUIDE, /\[TASK:UI_LOOK\]/);
assert.ok(LOOK_GUIDE.length < 4500, 'the look instructions stay small');
console.log('uilook ok');

// an animation-only look must not recolour the page (the contents links turned yellow once)
{
  const only = lookCss(mergeLook({}, sanitizeLook({ animate: [{ target: 'orb', name: 'spin', when: 'hover', seconds: 2 }] }).patch));
  assert.ok(!only.includes('--y'), 'no colour tokens');
  assert.ok(!only.includes('#out a'), 'links untouched');
  assert.ok(!only.includes('background:var(--w)'), 'page colours untouched');
}
