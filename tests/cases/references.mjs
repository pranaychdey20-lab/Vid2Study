// References: every book / paper / film / document / source the video names (said or shown) and every on-screen quote is noted
// where it comes up AND listed in a separate References section, with a web search for each. The code guarantees the list.
globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const lp = await import('./lib/local-pipeline.js');
const pr = await import('./lib/prompts.js');
const { getResult } = await import('./lib/db.js');
const { calls } = await import('./lib/llm.js');
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
  assert.match(lp.refQuery(all[1]), /Forget not the tyranny.*Unknown, Graffiti on the Berlin Wall quote source/);
  assert.equal(lp.refQuery(all[2]), 'The Wall A');
  // the list is complete whatever the model wrote
  const sec = lp.ensureRefList('## References\n- **The Wall**: a book', all);
  assert.ok(/Early Film/.test(sec) && /Forget not/.test(sec) && (sec.match(/The Wall/g) || []).length === 1, 'missing sources are added, present ones not repeated');
  assert.match(lp.ensureRefList('', all), /^## References\n\n?- /);
  assert.equal(lp.ensureRefList('## References\n- x', []), '## References\n- x');
  console.log('reference helpers ok');
}

// ---- prompts
{
  const tp = pr.transcriptPrompt({ title: 'T', lines: '[00:01] hi', onScreen: '[06:20] Lesson by Konrad H. Jarausch' });
  assert.match(tp, /=== REFERENCES ===/); assert.match(tp, /ON-SCREEN TEXT[\s\S]*Lesson by Konrad H\. Jarausch/); assert.match(tp, /exactly three parts/);
  const wp = pr.writePrompt({ kind: 'speech', body: 'x', title: 't', course: 'c', detail: 'standard', full: true, code: {}, frameBudget: 1, frameIds: '', refs: [{ kind: 'book', title: 'The Wall', author: 'A', at: '01:05', why: 'cited' }] });
  assert.match(wp, /SOURCES \(never skip\)/); assert.match(wp, /> \*\*Source:\*\*/); assert.match(wp, /SOURCES FOUND IN THIS VIDEO[\s\S]*\[book\] The Wall — A \(at 01:05\): cited/);
  const rp = pr.referencesPrompt({ title: 'T', subject: 'wall', refs: [{ kind: 'book', title: 'The Wall', author: 'A', at: '01:05', why: 'cited', web: '- Page: about The Wall' }] });
  assert.match(rp, /\[TASK:REFERENCES\]/); assert.match(rp, /Never invent a title/); assert.match(rp, /1\. \[book\] The Wall — A \(at 01:05\)[\s\S]*WEB RESULTS[\s\S]*about The Wall/);
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

// ---- a text lecture (no frames): the Transcript AI finds the sources, the writer is told them, the section is written
{
  const r = await run('rf1', 'REFS test', normalizeSettings({ ...base, webSearch: false }));
  const dig = calls.find((c) => c.task === 'DIGEST');
  assert.ok(dig && dig.model === 'small', 'the Transcript AI also reads a text-only video, for the sources');
  const w = calls.find((c) => c.task === 'WRITE').prompt;
  assert.match(w, /SOURCES FOUND IN THIS VIDEO[\s\S]*Basic Treaty of 1972[\s\S]*The Berlin Wall: A World Divided/);
  const rc = calls.find((c) => c.task === 'REFERENCES');
  assert.ok(rc && rc.model === 'BIG', 'the Strong AI writes the section');
  assert.ok(!/WEB RESULTS/.test(rc.prompt), 'web search off: no web results');
  assert.match(r.summary_markdown, /## Detailed notes[\s\S]*## References\n+- \*\*Basic Treaty of 1972\*\*: researched background\n- \*\*The Berlin Wall: A World Divided\*\*/);
  console.log('references section ok');
}

// ---- with web search: every source is searched, the results go to the writer
{
  const real = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('wikipedia')
    ? { ok: true, json: async () => ({ query: { search: [{ title: 'Basic Treaty (1972)', snippet: 'a treaty between <b>East</b> and West Germany' }] } }) }
    : { ok: true, text: async () => '<a class="result__a" href="https://example.org/treaty">Basic Treaty explained</a><a class="result__snippet">the treaty recognised the GDR</a>' };
  await run('rf2', 'REFS web test', normalizeSettings({ ...base, webSearch: true }));
  const rc = calls.find((c) => c.task === 'REFERENCES').prompt;
  assert.match(rc, /WEB RESULTS[\s\S]*Basic Treaty/); assert.match(rc, /https:\/\/example\.org\/treaty/);
  globalThis.fetch = real;
  console.log('references web research ok');
}

// ---- the model forgets a source: the code adds it; and skipping the stage still lists them
{
  const r = await run('rf3', 'OMIT test', normalizeSettings({ ...base, webSearch: false }));
  assert.match(r.summary_markdown, /\*\*Basic Treaty of 1972\*\*: researched background/);
  assert.match(r.summary_markdown, /\*\*The Berlin Wall: A World Divided\*\* — Frederick Taylor \(book, at 01:00\): cited for the building of the wall/, 'added by the code: ' + r.summary_markdown.slice(r.summary_markdown.indexOf('## References')));
  const s = await run('rf4', 'REFS skip', normalizeSettings({ ...base, webSearch: false }), { skipStages: ['references'] });
  assert.ok(!calls.some((c) => c.task === 'REFERENCES'), 'a skipped stage makes no call');
  assert.match(s.summary_markdown, /## References[\s\S]*Basic Treaty of 1972[\s\S]*The Berlin Wall: A World Divided/);
  // switched off: no Transcript AI call, no section
  const off = await run('rf5', 'REFS off', normalizeSettings({ ...base, researchReferences: false }));
  assert.ok(!calls.some((c) => c.task === 'DIGEST' || c.task === 'REFERENCES'));
  assert.ok(!/## References/.test(off.summary_markdown));
  console.log('omitted / skipped / off ok');
}
