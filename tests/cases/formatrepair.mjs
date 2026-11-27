import assert from 'node:assert/strict';
import { repairFormatting, repairWithCheapAi, applyRawRepairs } from './lib/repair-formatting.js';
import { normalizeSettings } from './lib/settings.js';
import { calls, failures } from './lib/llm.js';
import { renderMarkdown } from './lib/md.js';

const sample = 'Formula / Concept Used: "h(k) = \\sum\\_{i=1}^{M} \\sum\\_{j=1}^{N} \\delta(I(i,j) - k)" ,';
const code = '\x60\x60\x60\n' + sample + '\n\x60\x60\x60';
const valid = tex => !tex.includes('\x60') && !!tex.trim();
const review = repairFormatting(sample + '\n\n' + code + '\n\nUse \\alpha=1.', valid);
assert.match(review.markdown, /Used: \$h\(k\) = \\sum_\{i=1\}\^\{M\} \\sum_\{j=1\}/);
assert.ok(review.markdown.includes(code));
assert.equal(review.repairs, 1);
assert.equal(review.issues.length, 1);
assert.equal(calls.length, 0);

const question = '**Q2.** [Lecture-Grounded] Three 8-bit pixels are ';
const readable = question + '$40, 120, 230$. Apply linear brightening with $\\alpha=1,\\ \\beta=30$.';
for (const broken of [
  '$40, 120, 230.Applylinearbrighteningwith\\alpha=1,\\ \\beta=30$.',
  '$40, 120, 230\\\n.Applylinearbrighteningwith\\alpha=1,\\ \\beta=30$.',
  '$40, 120, 230\x60.Applylinearbrighteningwith\x60\\alpha=1,\\ \\beta=30$.',
  '$40, 120, 230.$Applylinearbrighteningwith$\\alpha=1,\\ \\beta=30$.'
]) {
  const repaired = repairFormatting(question + broken, valid);
  assert.equal(repaired.markdown, readable);
  assert.deepEqual(repaired.issues, []);
}
assert.equal(repairFormatting('$40, 120, 230.Acompletelydifferentphrase\\alpha=1$', valid).issues.length, 1);
const seenMath = [];
renderMarkdown(readable, { math: tex => { seenMath.push(tex); return '<span>math</span>'; } });
assert.deepEqual(seenMath, ['40, 120, 230', '\\alpha=1,\\ \\beta=30']);
assert.match(renderMarkdown('Budget $40,120 and $30.', { math: () => assert.fail('Currency should remain text') }), /\$40,120/);

// a digit-led formula is maths, not a price: "$1/(MN)$" (the 2D DFT notes)
{
  const seen = [];
  const html = renderMarkdown('(and omitting the $1/(MN)$ factor used in the forward convention above) and $2\\pi$, $1/N$', { math: tex => { seen.push(tex); return '<i>m</i>'; } });
  assert.deepEqual(seen, ['1/(MN)', '2\\pi', '1/N']);
  assert.ok(!/\$1/.test(html));
  const price = renderMarkdown('it costs $5 and then $6 more', { math: () => assert.fail('price') });
  assert.match(price, /\$5 and then \$6/);
}
// more broken shapes the repair can fix without the AI
{
  const fix = md => repairFormatting(md, valid);
  assert.equal(fix('so \x60$x^2+1$\x60 holds').markdown, 'so $x^2+1$ holds');
  assert.equal(fix('so \\[x^2+1\\] holds').markdown, 'so $x^2+1$ holds');
  assert.equal(fix('so $\\\\frac{1}{2}$ holds').markdown, 'so $\\frac{1}{2}$ holds');
  assert.equal(fix('plain text, $\\frac{1}{2}$ stays').repairs, 0);
}

const settings = normalizeSettings({
  providers: [{ id: 'p', type: 'openai' }],
  cheap: { provider: 'p', model: 'weak' },
  strong: { provider: 'p', model: 'strong' }
});
const signal = new AbortController().signal;
failures.push({ task: 'FORMAT_REPAIR', model: 'weak', reply: JSON.stringify({ repairs: [{ id: 1, text: 'Use $\\alpha=1$.' }] }) });
try {
  const fixed = await repairWithCheapAi(review, settings, valid, signal);
  assert.match(fixed.markdown, /Use \$\\alpha=1\$\./);
  assert.deepEqual(fixed.accepted, [{ before: 'Use \\alpha=1.', after: 'Use $\\alpha=1$.' }]);
  assert.equal(calls[0].model, 'weak');
  assert.doesNotMatch(calls[0].prompt, /\\sum/);
  assert.equal(applyRawRepairs('A\nUse \\alpha=1.\nB', fixed.accepted), 'A\nUse $\\alpha=1$.\nB');
  assert.equal(applyRawRepairs('Use \\alpha=1.\nUse \\alpha=1.', fixed.accepted), 'Use \\alpha=1.\nUse \\alpha=1.');
  failures.at(-1).reply = JSON.stringify({ repairs: [{ id: 1, text: 'Use $\\alpha=2$.' }] });
  assert.equal((await repairWithCheapAi(review, settings, valid, signal)).markdown, review.markdown);
  await assert.rejects(repairWithCheapAi(review, { ...settings, cheap: {} }, valid, signal), /Choose a Cheap AI/);
} finally { failures.pop(); }
