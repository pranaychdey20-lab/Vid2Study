import assert from 'node:assert/strict';
import { parseSections, outline, pickSections, notesFile, parseEditScript, contentProblem, wrapExtra, checkOp, applyOps, describeOp, mentioned,
  listFigures, withoutBadVisuals, moveFigure, removeFigure, renumberFigures, sectionText, setSectionText, sectionTitle } from './lib/notes-edit.js';

const F = '\x60'.repeat(3);
const raw = [
  '# Image enhancement', '', '## Overview', '', '- o', '', '## Detailed notes', '',
  '### Histogram equalisation (02:10)', 'Equalisation spreads the intensities so the histogram is flatter.', '', '[[FRAME:4]]', '', 'The CDF maps old to new levels.', '',
  '### Gamma correction (08:30)', 'Gamma changes brightness non-linearly: $s = c r^\\gamma$.', '', '> **Watch Out:** gamma below 1 brightens.', '',
  '### Laplacian sharpening (15:00)', 'The Laplacian highlights edges.', '', F + 'python', '### not a heading', F, '', 'End of section.', '',
  '## Practice questions', '', '### Topic 1', 'Q?'
].join('\n');

// ---- sections and outline
const { sections } = parseSections(raw);
assert.equal(sections.length, 4, 'the practice topic is a section too');
assert.deepEqual(sections.slice(0, 3).map(s => s.id), ['S1', 'S2', 'S3']);
assert.equal(sections[0].title, 'Histogram equalisation');
assert.equal(sections[0].time, '02:10');
assert.equal(sections[2].body.includes('### not a heading'), true, 'a heading inside a code fence is not a section');
assert.equal(sections[0].figures, 1);
assert.equal(sections[1].math, true);
const o = outline(sections);
assert.match(o, /^S1 Histogram equalisation \(02:10\) · \d+ chars · 1 figure — Equalisation spreads/m);
assert.ok(o.length < 900, 'the outline of 4 sections is tiny');

// ---- retrieval: only what the request needs, whole lecture only when asked
assert.deepEqual(mentioned('expand section 3 and the last section', 5).sort(), [3, 5]);
assert.deepEqual(mentioned('look at S2', 5), [2]);
assert.deepEqual(mentioned('the second topic', 5), [2]);
{
  const big = Array.from({ length: 20 }, (_, i) => `### Topic ${i + 1} (0${i % 10}:00)\n${('Filler words about topic number ' + (i + 1) + '. ').repeat(120)}${i === 7 ? ' The sobel operator estimates gradients.' : ''}`).join('\n\n');
  const { sections: many } = parseSections(big);
  const one = pickSections(many, 'How does the sobel operator work?', { budget: 9000 });
  assert.equal(one.mode, 'auto');
  assert.ok(one.picked.some(p => p.section.n === 8), 'the keyword match is found');
  assert.ok(one.picked.length <= 4, 'a narrow question sends a few sections, not 20 (' + one.picked.length + ')');
  assert.ok(one.picked.reduce((a, p) => a + p.text.length, 0) <= 9500);
  const all = pickSections(many, 'Complete the whole lecture with examples where it is thin', { budget: 20000 });
  assert.equal(all.mode, 'lecture');
  assert.equal(all.picked.length, 20, 'a whole-lecture request covers every section');
  assert.ok(all.picked.reduce((a, p) => a + p.text.length, 0) <= 20000 + 20 * 8, 'but every section is clipped to its share');
  const named = pickSections(many, 'Explain section 12 again', { budget: 6000 });
  assert.ok(named.picked.some(p => p.section.n === 12));
  const focused = pickSections(many, 'Explain this more simply', { focus: many[4], scope: 'section' });
  assert.deepEqual(focused.picked.map(p => p.section.n), [5]);
  const file = notesFile(many, one.picked, 'T');
  assert.match(file, /OUTLINE \(all 20 sections\)[\s\S]*S20 Topic 20[\s\S]*SECTIONS SENT IN FULL\n[\s\S]*=== S8 /);
}

// ---- the edit script
const visual = '{"type":"gamma_correction","pixels":[30,90,160,230],"gamma":0.6,"title":"Gamma 0.6"}';
const reply = [
  '@@ after S2 | Gamma changes brightness', 'A worked example makes the idea concrete.', '', F + 'visual', visual, F, '',
  '@@ append S1', 'Equalisation is a monotone mapping, so the order of grey levels never changes.',
  '@@ section S3 | Unsharp masking', 'Subtract a blurred copy to sharpen.',
  '@@ end'
].join('\n');
const script = parseEditScript(reply);
assert.equal(script.complete, true);
assert.deepEqual(script.ops.map(op => [op.op, op.n, op.arg]), [['after', 2, 'Gamma changes brightness'], ['append', 1, ''], ['section', 3, 'Unsharp masking']]);
assert.match(script.ops[0].content, /visual\n\{"type":"gamma_correction"/);
// a cut-off reply keeps its complete blocks and says it is incomplete
const cut = parseEditScript(reply.replace('@@ end', '').slice(0, reply.length - 60));
assert.equal(cut.complete, false);
assert.equal(cut.ops.length, 3);
// a fence-wrapped reply and an @@ line inside a code block
assert.equal(parseEditScript(F + '\n@@ append S1\nText\n@@ end\n' + F).ops.length, 1);
assert.equal(parseEditScript('@@ append S1\n' + F + 'text\n@@ append S2\n' + F + '\n@@ end').ops.length, 1);

// ---- validation
assert.equal(contentProblem('Plain text with $x^2$ and a link [a](https://example.org).'), null);
assert.equal(contentProblem('Text\n\n' + F + 'visual\n' + visual + '\n' + F), null);
assert.match(contentProblem(F + 'visual\n{"type":"nope"}\n' + F), /not a valid visual/);
assert.match(contentProblem(F + 'visual\n{"type":"function_plot","fn":"process.exit()"}\n' + F), /not a valid visual/);
assert.match(contentProblem('## Heading'), /heading/);
assert.match(contentProblem('<script>alert(1)</script>'), /HTML/);
assert.match(contentProblem('<img src=x onerror=alert(1)>'), /HTML/);
assert.match(contentProblem('![x](https://e.org/a.png)'), /image/);
assert.match(contentProblem('[[FRAME:3]]'), /marker/);
assert.match(contentProblem('[click](javascript:alert(1))'), /non-web link/);
assert.match(contentProblem(F + 'visual\n' + visual), /not closed/);
assert.match(contentProblem(''), /empty/);
assert.equal(contentProblem('a < b and $c < d$'), null, 'a less-than sign is not HTML');
assert.match(checkOp({ op: 'append', n: 9, arg: '', content: 'x' }, sections).error, /S9 does not exist/);
assert.match(checkOp({ op: 'replace', n: 1, arg: '', content: 'x' }, sections).error, /first words/);
assert.equal(checkOp(script.ops[0], sections).ok, true);

// ---- applying: only the target changes; supplementary prose is labelled; visuals stand alone
const ops = script.ops.map(op => checkOp(op, sections).op);
const { markdown: out } = applyOps(raw, ops);
assert.match(out, /Gamma changes brightness[^\n]*\n\n> \*\*Extra Context:\*\* A worked example makes the idea concrete\.\n\n\x60{3}visual\n\{"type":"gamma_correction"/);
assert.match(out, /The CDF maps old to new levels\.\n\n> \*\*Extra Context:\*\* Equalisation is a monotone mapping[^\n]*\n\n### Gamma correction/);
assert.match(out, /End of section\.\n\n### Unsharp masking\n\n> \*\*Extra Context:\*\* Subtract a blurred copy to sharpen\.\n\n## Practice questions/);
assert.equal(out.split('\n').filter(l => /^### /.test(l)).length, 6); // 3 topics + practice topic + the new one + a '###' line inside a code fence
assert.ok(out.includes('[[FRAME:4]]') && out.includes('### not a heading'), 'nothing else was touched');
// a missing anchor falls back to the end of the section, with a note
const fallback = applyOps(raw, [checkOp({ op: 'after', n: 2, arg: 'words that are not there', content: 'More.' }, sections).op]);
assert.equal(fallback.notes.length, 1);
assert.match(fallback.markdown, /> \*\*Extra Context:\*\* More\.\n\n### Laplacian/);
// replace swaps one block
const swapped = applyOps(raw, [checkOp({ op: 'replace', n: 2, arg: 'Gamma changes brightness', content: 'Gamma changes brightness non-linearly: **a power law**.' }, sections).op]);
assert.match(swapped.markdown, /\*\*a power law\*\*\.\n\n> \*\*Watch Out:\*\*/);
assert.doesNotMatch(swapped.markdown, /Extra Context/);
assert.throws(() => applyOps(raw, [checkOp({ op: 'replace', n: 2, arg: 'no such passage here', content: 'x' }, sections).op]), /Could not find/);
// the same ops apply to the saved form (figures expanded) and land in the same sections
const rich = raw.replace('[[FRAME:4]]', '![Figure 1: Slide](images/a.png)\n*FIG 1 · 02:50 — slide*');
assert.match(applyOps(rich, ops).markdown, /monotone mapping[\s\S]*### Gamma correction/);
assert.match(describeOp(ops[0], sections), /Add in S2 · Gamma correction, after “Gamma changes brightness”/);
assert.equal(wrapExtra('> **Watch Out:** already a callout'), '> **Watch Out:** already a callout');

// ---- figures
const doc = ['### A (00:10)', 'Para one.', '', '![Figure 1: x](images/a.png)', '*FIG 1 · 00:10 — x*', '', '[Watch at 00:10](https://y.be/1)', '', 'Para two.', '', '### B (01:00)', 'Para three.', '', '![Figure 2: y](images/b.png)', '*FIG 2 · 01:00 — y*', '', '## Practice questions'].join('\n');
assert.deepEqual(listFigures(doc).map(f => f.key), ['images/a.png', 'images/b.png']);
assert.deepEqual(listFigures('A\n\n[[FRAME:4]]\n\nB').map(f => f.key), ['F4']);
let moved = moveFigure(doc, 'images/a.png', +1);
assert.match(moved, /Para one\.\n\nPara two\.\n\n!\[Figure 1: x\]\(images\/a\.png\)\n\*FIG 1 · 00:10 — x\*\n\n\[Watch at 00:10\]/, 'down one block: past the paragraph, caption and watch link with it');
moved = moveFigure(doc, 'images/a.png', -1);
assert.match(moved, /### A \(00:10\)\n\n?!\[Figure 1/, 'moved up to the top of its topic');
assert.match(moved, /!\[Figure 1: x\]\(images\/a\.png\)\n\*FIG 1 · 00:10 — x\*\n\n\[Watch at 00:10\]\(https:\/\/y\.be\/1\)/, 'caption and watch link travel with the picture');
// a figure at the end of a topic hops into the next topic by stepping over its heading
const hopped = moveFigure(moveFigure(doc, 'images/a.png', +1), 'images/a.png', +1);
assert.match(hopped, /### B \(01:00\)\n\n?!\[Figure 1: x\]/);
assert.equal(moveFigure(doc, 'images/b.png', +1), null, 'never past the end of the notes region');
assert.equal(moveFigure(doc, 'images/zzz.png', +1), null);
const raw2 = 'A\n\nP1\n\n[[FRAME:4]]\n\nP2';
assert.equal(moveFigure(raw2, 'F4', -1), 'A\n\n[[FRAME:4]]\n\nP1\n\nP2');
assert.equal(removeFigure(raw2, 'F4'), 'A\n\nP1\n\nP2');
const swappedDoc = moveFigure(moveFigure(doc, 'images/b.png', -1), 'images/b.png', -1);
assert.match(renumberFigures(moveFigure(swappedDoc, 'images/b.png', -1) ?? swappedDoc), /Figure 1: y|Figure 1: x/);
assert.equal(renumberFigures('![Figure 7: a](images/a.png)\n*FIG 7 · 00:01 — a*\n\n![Figure 3: b](images/b.png)\n*FIG 3 · 00:02 — b*'), '![Figure 1: a](images/a.png)\n*FIG 1 · 00:01 — a*\n\n![Figure 2: b](images/b.png)\n*FIG 2 · 00:02 — b*');

// ---- section text edits
assert.equal(sectionText(raw, '### Gamma correction (08:30)'.slice(4)).startsWith('Gamma changes brightness'), true);
const edited = setSectionText(raw, 'Histogram equalisation (02:10)', 'New intro.\n\n[[FRAME:4]]\n\nEdited tail.', { allowedFrames: new Set([4]) });
assert.match(edited, /### Histogram equalisation \(02:10\)\n\nNew intro\.\n\n\[\[FRAME:4\]\]\n\nEdited tail\.\n\n### Gamma/);
assert.throws(() => setSectionText(raw, 'Histogram equalisation (02:10)', 'x\n\n[[FRAME:99]]', { allowedFrames: new Set([4]) }), /not a figure/);
assert.throws(() => setSectionText(raw, 'Histogram equalisation (02:10)', 'x\n\n### Another'), /headings/);
assert.equal(sectionTitle('Gamma (08:30)'), 'Gamma');
console.log('notes edit ok');

// quoted sections are always sent, whatever the scope
{
  const md = ['## Detailed notes', '### Alpha (00:10)', 'alpha text about gamma', '### Beta (01:00)', 'beta text', '### Gamma (02:00)', 'gamma text about histograms', '### Delta (03:00)', 'delta text'].join('\n\n');
  const { sections } = parseSections(md);
  const one = pickSections(sections, 'explain this', { scope: 'section', focus: sections[0], must: [3] });
  assert.deepEqual(one.picked.map(p => p.section.n), [3]);
  const auto = pickSections(sections, 'explain this', { scope: 'auto', focus: sections[0], must: [4] });
  assert.ok(auto.picked.some(p => p.section.n === 4));
  const all = pickSections(sections, 'rewrite the whole lecture', { scope: 'lecture', must: [2] });
  assert.equal(all.picked.length, 4);
}

// a bad visual is explained to the model, and can be cut out while the text is kept
{
  const F3 = '\x60'.repeat(3);
  const good = F3 + 'visual\n{"type":"image_lab","scene":"low_contrast","ops":["clahe"]}\n' + F3;
  const bad = F3 + 'visual\n{"type":"image_lab","scene":"low_contrast","ops":[{"op":"clahe","clip":99}]}\n' + F3;
  const text = 'CLAHE equalises each tile.\n\n' + bad + '\n\nThen tiles are blended.\n\n' + good;
  const problem = contentProblem(text);
  assert.match(problem, /visual block 1 is not a valid visual: type "image_lab" rejected its values/);
  assert.match(contentProblem('x\n\n' + F3 + 'visual\n{"type":"warp_drive"}\n' + F3), /unknown type "warp_drive" \(the only types are: .*image_lab/);
  const cut = withoutBadVisuals(text);
  assert.equal(cut.removed, 1);
  assert.ok(cut.content.includes('CLAHE equalises each tile.') && cut.content.includes('Then tiles are blended.') && cut.content.includes('"scene":"low_contrast","ops":["clahe"]'));
  assert.ok(!cut.content.includes('"clip":99'));
  assert.equal(contentProblem(cut.content), null);
}
