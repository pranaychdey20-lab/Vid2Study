import assert from 'node:assert/strict';
import { appendPracticePaper, assignmentNeedsImage, practiceSource, withoutPractice, writePracticePaper } from './lib/practice-paper.js';
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
const appended = appendPracticePaper(existing, '## Practice questions\nNew paper');
assert.equal(appended, existing + '\n\n## Practice questions — Paper 2\nNew paper');
assert.match(appendPracticePaper(appended, '## Practice questions\nThird paper'), /## Practice questions — Paper 3\nThird paper$/);
assert.equal(withoutPractice(appended), notes);
assert.match(practiceSource(notes), /\$x\^2\$[\s\S]*\| A \| 3 \|[\s\S]*chart values/);
assert.doesNotMatch(practiceSource(notes), /images\/frame\.png/);

const settings = normalizeSettings({ providers: [{ id: 'a', type: 'openai', name: 'A', baseUrl: 'http://localhost' }],
  strong: { provider: 'a', model: 'writer' }, practice: { provider: 'a', model: 'paper' }, webSearch: false });
const moreQuestions = label => [2, 3, 4, 5].map(n =>
  '**Q' + n + '.** ' + label + ' Explain another case.\n\n**Ans.**\n\nWork.').join('\n\n');
const reply = '## Practice questions\n### 1. **KERNELS** (02:00)\n**Q1.** [Lecture-Grounded] Explain the formula.\n\n**Answer:**\nRef: $x^2$\n\nWork.\n\n' +
  moreQuestions('[AI · Lecture Topics]') + '\n\n## Assignment question review\n1. Relevant topic: Kernels.\n2. Excluded: needs material outside the lecture.';
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
  assert.match(paper, /^### \[T1\] Kernels$/m);
  assert.match(paper, /^\*\*Ans\.\*\*$/m);
  assert.match(call.prompt, /\[AI · Assignment-Inspired\][\s\S]*\[AI · Lecture Topics\][\s\S]*Include and fully solve every supplied question/);
} finally { failures.pop(); }

{
  const gemini = normalizeSettings({ providers: [{ id: 'web', type: 'geminiweb' }],
    strong: { provider: 'web', model: 'neon-high' }, webSearch: false });
  failures.push({ model: 'neon-high', task: 'QUESTIONS', reply: reply.replace('1. **KERNELS** (02:00)', '[T1] Kernel calculation') });
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
    assert.match(calls.at(-1).prompt, /attached combined lecture notes PDF[\s\S]*\[T1\] Kernels[\s\S]*ASSIGNMENT MATERIAL/);
    assert.doesNotMatch(calls.at(-1).prompt, /\| A \| 3 \|/);
    assert.match(paper, /^### \[T1\] Kernels$/m);
    failures.at(-1).reply = failures.at(-1).reply.replace('[T1]', '[T99]');
    await assert.rejects(writePracticePaper({ ...result, source: 'combined' }, gemini, {
      text: 'Explain kernels.', signal: new AbortController().signal
    }), /could not be linked.*T99/);
  } finally { failures.pop(); }
}

{
  const original = '## Practice questions\n### [T1]\n**Q1.** [Assignment · Original] Work out the following.\n(a) What is $2^2$?\n(b) What is $3^2$?\nAssignment ID: A1\n\n**Ans.**\n\n**(a) Square 2**\n\n1. Square 2 to obtain 4.\n\n**(b) Square 3**\n\n1. Square 3 to obtain 9.\n\n' +
    moreQuestions('[AI · Assignment-Inspired]') + '\n\n## Assignment question review\n- [Matched] A1 Image 1 question 1';
  const initial = calls.length;
  failures.push({ model: 'paper', task: 'QUESTIONS', reply: original });
  try {
    const options = { text: 'Work out $2^2$.', signal: new AbortController().signal };
    const paper = await writePracticePaper({ ...result, technical: true }, settings, options);
    assert.match(calls[initial].prompt, /IIT end-semester difficulty/);
    assert.match(calls[initial].prompt, /Keep every meaningful symbol[\s\S]*Define each symbol[\s\S]*under the answer’s lecture reference[\s\S]*underlying taught concept[\s\S]*\\alpha=1[\s\S]*\\beta=30/);
    assert.match(paper, /\[Assignment · Original\][\s\S]*\*\*Ans\.\*\*[\s\S]*Square 2/);
    assert.equal([...paper.matchAll(/^\*\*Q\d+\.\*\*/gm)].length, 5);
    failures.at(-1).reply = original.replace('Work out the following.', 'Values $40, 120, 230\x60.Applylinearbrighteningwith\x60\\alpha=1$.');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /mixes math delimiters/);
    failures.at(-1).reply = original.replace('**(a) Square 2**', '**Square 2**');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /missing or misorders its labeled subparts/);
    failures.at(-1).reply = original.replace(moreQuestions('[AI · Assignment-Inspired]'), '');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /fewer than five/);
    failures.at(-1).reply = original.replaceAll('[AI · Assignment-Inspired]', '[AI · Lecture Topics]');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /More than half/);
    failures.at(-1).reply = original.replace('[Assignment · Original]', '[AI · Assignment-Inspired]');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /distinct original question and solution/);
    failures.at(-1).reply = original.replace('Assignment ID: A1', 'Assignment ID: A2');
    await assert.rejects(writePracticePaper({ ...result, technical: true }, settings, options), /distinct original question and solution/);
  } finally { failures.pop(); }
}
