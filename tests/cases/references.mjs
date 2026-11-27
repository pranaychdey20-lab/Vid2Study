globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const lp = await import('./lib/local-pipeline.js');
const pr = await import('./lib/prompts.js');
const { getResult } = await import('./lib/db.js');
const { calls, failures } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline'); };

// ---- pure helpers
{
  const r = lp.readRefs('```json\n[{"kind":"Book","title":"The Wall","author":"A. Writer","at":"01:05","why":"cited"},{"kind":"zzz","title":"Odd Source"},{"title":""},{"kind":"book"},"junk"]\n```');
  assert.deepEqual(r.map((x) => [x.kind, x.title, x.at]), [['book', 'The Wall', '01:05'], ['other', 'Odd Source', '']]);
  assert.deepEqual(lp.readRefs('not json'), []);
  assert.deepEqual(lp.readRefs('Here: [{"kind":"film","title":"Das Leben der Anderen"}] done').map((x) => x.title), ['Das Leben der Anderen']);
  const d = lp.parseDigest('=== BRIEF ===\nb\n=== TIMELINE ===\n[00:01] a long enough timeline line here\n=== REFERENCES ===\n[{"kind":"book","title":"X Book","author":"Y"}]\n=== TYPE ===\n{"technical": false, "kind": "history", "subject": "wall"}', '[00:01] x');
  assert.equal(d.lines, '[00:01] a long enough timeline line here', 'the references are not part of the timeline');
  assert.equal(d.refs[0].title, 'X Book'); assert.equal(d.type.kind, 'history'); assert.equal(d.brief, 'b');
  const q = [{ t: 4, text: 'Forget not the tyranny of this wall ... nor the love of freedom that made it fall ...\n- Unknown, Graffiti on the Berlin Wall' }];
  const all = lp.collectRefs([{ kind: 'book', title: 'The Wall', author: 'A', at: '01:05' }, { kind: 'book', title: 'the wall', at: '09:00' }, { kind: 'film', title: 'Early Film', at: '00:02' }], q);
  assert.deepEqual(all.map((x) => x.kind), ['film', 'quote', 'book'], 'time order (film 00:02, quote 00:04, book 01:05), the repeat of "The Wall" dropped');
  assert.match(all[1].title, /^“Forget not the tyranny of this wall \.\.\./); assert.equal(all[1].author, 'Unknown, Graffiti on the Berlin Wall');
  const section = lp.formatReferences(all);
  assert.match(section, /^## References\n\n\*\*Films and documentaries\*\*/);
  assert.match(section, /Early Film[\s\S]*Forget not[\s\S]*The Wall/);
  assert.equal((section.match(/The Wall/g) || []).length, 1);
  assert.equal(lp.formatReferences([]), '');
  console.log('reference helpers ok');
}

// ---- prompts
{
  const tp = pr.transcriptPrompt({ title: 'T', lines: '[00:01] hi', onScreen: '[06:20] Lesson by Konrad H. Jarausch' });
  assert.match(tp, /=== REFERENCES ===/); assert.match(tp, /ON-SCREEN TEXT[\s\S]*Lesson by Konrad H\. Jarausch/); assert.match(tp, /=== COVERAGE CHECKLIST ===/);
  const wp = pr.writePrompt({ kind: 'speech', body: 'x', title: 't', course: 'c', detail: 'standard', full: true, code: {}, frameBudget: 1, frameIds: '', refs: [{ kind: 'book', title: 'The Wall', author: 'A', at: '01:05', why: 'cited' }] });
  assert.match(wp, /SOURCES \(never skip\)/); assert.match(wp, /> \*\*Source:\*\*/); assert.match(wp, /SOURCES FOUND IN THIS VIDEO[\s\S]*\[book\] The Wall — A \(at 01:05\): cited/);
  console.log('reference prompts ok');
}

const base = { providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }], strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'g', model: 'small' }, practiceQuestions: false, debugDump: false };
const mk = (min) => { let s = ''; for (let t = 0; t < min * 60; t += 20) s += `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}] word ${t} blah blah\n`; return s; };
const run = async (key, title, set, extra = {}) => {
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key, title, course: 'C', settings: set, signal: new AbortController().signal, onProgress() {}, transcript: mk(8), ...extra });
  return getResult(key);
};
const { runLocalPipeline } = lp;

// A lecture's extracted references go straight into the notes with either web search setting.
for (const webSearch of [false, true]) {
  const r = await run(`rf-${webSearch}`, 'REFS test', normalizeSettings({ ...base, webSearch }));
  assert.equal(calls.find(c => c.task === 'DIGEST')?.model, 'small');
  assert.match(calls.find(c => c.task === 'WRITE').all, /SOURCES FOUND IN THIS VIDEO[\s\S]*Basic Treaty of 1972/);
  assert.ok(!calls.some(c => c.task === 'REFERENCES'));
  assert.match(r.summary_markdown, /## References[\s\S]*Basic Treaty of 1972\*\* — FRG and GDR \(at 00:40\): West Germany recognised East Germany/);
  assert.match(r.summary_markdown, /The Berlin Wall: A World Divided\*\* — Frederick Taylor \(at 01:00\): cited for the building of the wall/);
}

const off = await run('rf-off', 'REFS off', normalizeSettings({ ...base, researchReferences: false }));
assert.ok(!calls.some(c => c.task === 'DIGEST' || c.task === 'REFERENCES'));
assert.doesNotMatch(off.summary_markdown, /## References/);

// Research supports a separate practice section in the same model call.
globalThis.fetch = async url => String(url).includes('wikipedia')
  ? { ok: true, json: async () => ({ query: { search: [] } }) }
  : { ok: true, text: async () => '<a class="result__a" href="https://example.org/treaty">Basic Treaty of 1972</a><a class="result__snippet">Treaty text and history</a>' };
failures.push({ task: 'QUESTIONS', model: 'BIG', reply: `## Practice questions
### Topic 1
**Q1.** [Lecture-Grounded] What was taught?
**Answer:** The lecture explanation.

## Supplemental practice (web sources)
**Q2.** [Supplemental] Why did the treaty matter?
Related lecture topic: Topic 1.
**Answer:** The treaty addressed mutual relations.
Source: https://example.org/treaty

**Q3.** [Supplemental] An unsupported question?
**Answer:** Unsupported.
Source: https://example.org/unverified` });
try {
  const r = await run('rf-practice-web', 'REFS practice', normalizeSettings({ ...base, webSearch: true, practiceQuestions: true }));
  const questions = calls.filter(c => c.task === 'QUESTIONS');
  assert.equal(questions.length, 1);
  assert.match(questions[0].prompt, /LECTURE BIBLIOGRAPHY[\s\S]*REFERENCE SEARCH RESULTS[\s\S]*https:\/\/example.org\/treaty/);
  assert.match(r.summary_markdown, /## Practice questions[\s\S]*## Supplemental practice \(web sources\)[\s\S]*Why did the treaty matter/);
  assert.doesNotMatch(r.summary_markdown, /unsupported question/);
  const offline = await run('rf-practice-offline', 'REFS practice', normalizeSettings({ ...base, webSearch: false, practiceQuestions: true }));
  assert.match(offline.summary_markdown, /## Practice questions/);
  assert.doesNotMatch(offline.summary_markdown, /## Supplemental practice/);
} finally { failures.pop(); }
