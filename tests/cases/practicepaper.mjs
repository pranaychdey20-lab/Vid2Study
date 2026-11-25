import assert from 'node:assert/strict';
import { assignmentNeedsImage, practiceSource, withoutPractice, writePracticePaper } from './lib/practice-paper.js';
import { normalizeSettings } from './lib/settings.js';
import { calls, failures } from './lib/llm.js';

const text = { text: 'Find the result for these inputs', conf: 97, words: 6, boxes: [{ conf: 98 }] };
assert.equal(assignmentNeedsImage(text, { kinds: [] }), false);
assert.equal(assignmentNeedsImage({ ...text, boxes: [{ conf: 40 }] }, { kinds: [] }), true);
assert.equal(assignmentNeedsImage(text, { kinds: ['diagram'] }), true);
assert.equal(assignmentNeedsImage({ ...text, text: 'Read the chart shown below' }, { kinds: [] }), true);
const notes = '# Lesson\n## Detailed notes\n### Kernels (02:00)\nUse $x^2$.\n| Name | Value |\n| --- | --- |\n| A | 3 |\n![Figure 1](images/frame.png)\n*FIG 1 — chart values*';
const existing = notes + '\n## Practice questions\nOld paper';
assert.equal(withoutPractice(existing), notes);
assert.match(practiceSource(notes), /\$x\^2\$[\s\S]*\| A \| 3 \|[\s\S]*chart values/);
assert.doesNotMatch(practiceSource(notes), /images\/frame\.png/);

const settings = normalizeSettings({ providers: [{ id: 'a', type: 'openai', name: 'A', baseUrl: 'http://localhost' }],
  strong: { provider: 'a', model: 'writer' }, practice: { provider: 'a', model: 'paper' }, webSearch: false });
const reply = '## Practice questions\n### Kernels\n**Q1.** [Lecture-Grounded] Explain the formula.\n\n**Answer:**\nRef: $x^2$\n\nWork.\n\n## Assignment question review\n1. Matched under Kernels.\n2. Excluded: needs material outside the lecture.';
const result = { title: 'Lecture', course: 'Robotics', summary_markdown: existing, sourceRecord: 'RAW TRANSCRIPT MUST STAY OUT' };
failures.push({ model: 'paper', task: 'QUESTIONS', reply });
try {
  const paper = await writePracticePaper(result, settings, { text: 'Explain kernels. Solve an unrelated problem.', signal: new AbortController().signal });
  const call = calls.at(-1);
  assert.equal(call.model, 'paper');
  assert.equal(call.images, 0);
  assert.match(call.prompt, /\$x\^2\$[\s\S]*\| A \| 3 \|[\s\S]*chart values[\s\S]*ASSIGNMENT MATERIAL/);
  assert.doesNotMatch(call.prompt, /RAW TRANSCRIPT|images\/frame\.png|Old paper/);
  assert.match(paper, /\*\*Q1\.\*\*[\s\S]*Assignment question review[\s\S]*Excluded/);
} finally { failures.pop(); }

{
  const gemini = normalizeSettings({ providers: [{ id: 'web', type: 'geminiweb' }],
    strong: { provider: 'web', model: 'neon-high' }, webSearch: false });
  failures.push({ model: 'neon-high', task: 'QUESTIONS', reply });
  const initialCalls = calls.length;
  try {
    const paper = await writePracticePaper({ ...result, source: 'combined' }, gemini, {
      text: 'Explain kernels.', signal: new AbortController().signal,
      prepareNotesPdf: async markdown => {
        assert.equal(markdown, notes);
        return '<html>Printable combined notes</html>';
      }
    });
    assert.equal(calls.length, initialCalls + 1);
    assert.equal(calls.at(-1).notesHtml, '<html>Printable combined notes</html>');
    assert.equal(calls.at(-1).singleRequest, true);
    assert.match(calls.at(-1).prompt, /attached combined lecture notes PDF[\s\S]*ASSIGNMENT MATERIAL/);
    assert.doesNotMatch(calls.at(-1).prompt, /\| A \| 3 \|/);
    assert.match(paper, /Practice questions/);
  } finally { failures.pop(); }
}
