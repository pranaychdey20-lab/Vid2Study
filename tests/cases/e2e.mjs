globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert=(await import('node:assert')).default;
const { runLocalPipeline } = await import('./lib/local-pipeline.js');
const { getResult } = await import('./lib/db.js');
const { calls } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
const settings = normalizeSettings({ providers:[{id:'g',type:'gemini',name:'G',apiKey:'k',baseUrl:'x'},{id:'o',type:'openai',name:'O',apiKey:'k',baseUrl:'http://localhost:11434/v1'}], strong:{provider:'g',model:'BIG'}, cheap:{provider:'o',model:'small'}, visuals:false, practiceQuestions:false, researchReferences:false });
globalThis.fetch = async () => { throw new Error("offline (tests never use the network)"); };
const mk=(min)=>{let s='';for(let t=0;t<min*60;t+=20) s+=`[${String(Math.floor(t/60)).padStart(2,'0')}:${String(t%60).padStart(2,'0')}] word ${t} blah blah\n`;return s;};
const run=async(key,min,extra={})=>{calls.length=0; const prog=[]; await runLocalPipeline({mode:'text',key,title:'T',course:'C',settings:{...settings,...extra},signal:new AbortController().signal,onProgress:(s,p,t)=>prog.push(s+':'+t),transcript:mk(min)}); return {r:await getResult(key),calls:[...calls],prog};};
// short
let a=await run('short',20);
assert.deepEqual(a.calls.map(c=>c.task),['WRITE']); assert.equal(a.calls[0].model,'BIG');
assert.match(a.r.summary_markdown,/# T\n\n## Overview\n\n- o/); assert.match(a.r.summary_markdown,/## Topics\n\n- 00:10 — Topic 1/); assert.ok(!/Exam hints/.test(a.r.summary_markdown)); // dropped even when the model writes one
assert.ok(!/\[\[VISUAL/.test(a.r.summary_markdown)); assert.equal(a.r.pipeline.route,'direct');
console.log('short ok', a.r.usage, a.r.model);
// long: 100 min -> map (cheap) + several write groups + final
let b=await run('long',200,{writeFullTranscript:false});
const tasks=b.calls.map(c=>c.task); console.log(tasks.join(','));
assert.ok(tasks.filter(t=>t==='CHUNK').length>=14); assert.ok(b.calls.filter(c=>c.task==='CHUNK').every(c=>c.model==='small'));
assert.ok(b.calls.filter(c=>c.task==='WRITE').every(c=>c.model==='BIG')); assert.equal(tasks.at(-1),'FINAL');
assert.match(b.r.summary_markdown,/## Overview\n\n- ov/); assert.ok(!/Exam hints/.test(b.r.summary_markdown));
assert.equal(b.r.pipeline.route,'map-reduce'); assert.equal(b.r.model,'small + BIG');
console.log('long ok', b.r.usage.bySlot, b.r.pipeline.chunks);
// long, default: the strong model reads the FULL transcript in parts (no cheap summaries), parts in parallel
{
  const f = await run('longfull', 200, { writeFullTranscript: true });
  const t = f.calls.map((c) => c.task);
  assert.ok(!t.includes('CHUNK'), 'no cheap bullets in between');
  const w = f.calls.filter((c) => c.task === 'WRITE');
  assert.equal(w.length, 4, '200 min -> 4 parts of ~50 min');
  assert.ok(w.every((c) => c.model === 'BIG' && /word \d+ blah/.test(c.prompt)), 'raw transcript lines reach the writer');
  assert.ok(f.calls.filter((c) => c.task === 'FINAL').every((c) => c.model === 'small'), 'overview on the cheap model');
  assert.equal(f.r.pipeline.route, 'full-transcript');
  const q = await run('longq', 120, { writeFullTranscript: true, practiceQuestions: true });
  const qc = q.calls.find((c) => c.task === 'QUESTIONS');
  assert.ok(qc && qc.model === 'BIG', 'practice questions by the strong model');
  assert.equal(q.calls.filter((c) => c.task === 'WRITE').length, 2, '120 min -> 2 parts');
  assert.match(q.r.summary_markdown, /## Practice questions[\s\S]*\*\*Q1\.\*\*/);
  console.log('full transcript + questions ok');
}
// resume after failure in the middle of map: second run reuses chunk notes
// web search fallback: the stub model cannot search, so the extension searches and the writer gets the snippets
{
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (u) => String(u).includes('wikipedia')
    ? { ok: true, json: async () => ({ query: { search: [{ title: 'Topic T', snippet: 'about <b>T</b>' }] } }) }
    : { ok: true, text: async () => '<a class="result__a" href="https://example.org/t">T explained</a><a class="result__snippet">a short snippet</a>' };
  const w = await run('web1', 20);
  const prompt = w.calls.find((x) => x.task === 'WRITE').prompt;
  assert.match(prompt, /WEB RESULTS/); assert.match(prompt, /T explained/); assert.match(prompt, /Topic T/);
  const off = await run('web2', 20, { webSearch: false });
  assert.ok(!/WEB RESULTS/.test(off.calls.find((x) => x.task === 'WRITE').prompt));
  globalThis.fetch = async () => { throw new Error('offline'); }; // a failed search must never fail the notes
  const bad = await run('web3', 20);
  assert.ok(!/WEB RESULTS/.test(bad.calls.find((x) => x.task === 'WRITE').prompt)); assert.ok(bad.r.summary_markdown);
  globalThis.fetch = realFetch;
  console.log('web search fallback ok');
}
// a code example the writer left without output gets it from one extra call
{
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key: 'code1', title: 'CODEDEMO', course: 'C', settings, signal: new AbortController().signal, onProgress() {}, transcript: mk(10) });
  const r = await getResult('code1');
  assert.ok(calls.some((c) => c.task === 'OUTPUTS'));
  assert.match(r.summary_markdown, /print\(2 \+ 2\)\n```\n\n\*\*Output:\*\*\n```text\n4\n```/);
  console.log('outputs pass ok');
}
// a writer reply cut off by its output limit is written again with twice the room; odd markers never leak
{
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key: 'cut1', title: 'CUTOFF', course: 'C', settings, signal: new AbortController().signal, onProgress() {}, transcript: mk(2) });
  const r = await getResult('cut1');
  const w = calls.filter((c) => c.task === 'WRITE');
  assert.equal(w.length, 2); assert.equal(w[1].maxTokens, w[0].maxTokens * 2);
  assert.ok(w[0].maxTokens >= 4000, 'a short video still gets room to write');
  assert.match(r.summary_markdown, /the end/);
  assert.ok(!/\[\[/.test(r.summary_markdown), 'no raw markers in the notes');
  console.log('cut-off retry ok');
}

// TEMP DEBUG dump + cheap trim above trimTokens (a reply that loses too much keeps the code-trimmed text)
{
  const d = await run('dbg1', 30, { trimTokens: 50 });
  assert.ok(d.calls.some((c) => c.task === 'TRIM' && c.model === 'small'), 'cheap model trims a long transcript');
  assert.ok(d.r.debug.includes('RAW TRANSCRIPT') && d.r.debug.includes('word 20 blah'), 'the full transcript is in the dump');
  assert.ok(d.r.debug.includes('(kept code trim)'));
  assert.ok(/#1 TRIM \| small/.test(d.r.debug), 'AI calls listed');
  const n = await run('dbg2', 30, { trimTokens: 0, debugDump: false });
  assert.ok(!n.calls.some((c) => c.task === 'TRIM')); assert.equal(n.r.debug, undefined);
  console.log('debug dump + trim ok');
}
