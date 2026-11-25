globalThis.document = { createElement: () => ({ getContext: () => ({}), }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const { parseTimestamped, mergeSegments, formatSegments } = await import('./lib/transcript.js');
const { chunkSegments } = await import('./lib/chunk.js');
const { assignFrames, chunkIndexFor, interleave, screenLine } = await import('./lib/align.js');
const { SceneDetector, changedFraction } = await import('./lib/scenes.js');
const { detectCode } = await import('./lib/codedetect.js');
const lp = await import('./lib/local-pipeline.js');
const { normalizeSettings, slotRef, settingsProblem } = await import('./lib/settings.js');

// transcript
let s = parseTimestamped('[00:05] hello\nworld\n[01:10] next\n[125:03] long');
assert.equal(s.length, 3); assert.equal(s[0].text, 'hello world'); assert.equal(s[1].start, 70); assert.equal(s[2].start, 125*60+3);
assert.equal(s[0].end, 70);
console.log('transcript ok');

// chunking: 60 min of 10 s segments with a long pause at 12:40
const segs = []; for (let t=0;t<3600;t+=10) segs.push({start:t+(t>=760?20:0), end:t+9+(t>=760?20:0), text:'x'+t});
const ch = chunkSegments(segs, {targetSec:750});
assert.ok(ch.length>=4 && ch.length<=6, 'chunks '+ch.length);
assert.equal(ch.reduce((n,c)=>n+c.segments.length,0), segs.length);
for (let i=1;i<ch.length;i++) assert.ok(ch[i].start>=ch[i-1].end);
ch.forEach(c=>assert.ok(c.end-c.start <= 750*1.25+10, 'len '+(c.end-c.start)));
assert.equal(chunkSegments([{start:0,end:5,text:'a'}]).length,1);
assert.equal(chunkSegments([]).length,0);
// one giant segment must not loop forever
assert.equal(chunkSegments([{start:0,end:5000,text:'a'},{start:5000,end:5010,text:'b'}],{targetSec:750}).length >= 1, true);
console.log('chunk ok', ch.map(c=>Math.round((c.end-c.start)/60)));

// align
assignFrames(ch, [{t:0,index:1},{t:5000,index:2},{t:800,index:3}]);
assert.equal(ch[0].screen[0].index,1); assert.equal(ch.at(-1).screen[0].index,2);
assert.equal(chunkIndexFor(ch, 10), 0);
const il = interleave({segments:[{start:0,end:20,text:'hi'},{start:40,end:60,text:'bye'}], screen:[{t:30,index:7,text:'Slide A'}]});
assert.deepEqual(il.split('\n').map(l=>l.slice(0,22)), ['[00:00] hi', '[00:30] ON SCREEN F7 (te', '[00:40] bye'].map(l=>l.slice(0,22)));
console.log('align ok');

// scenes
const mk = (v)=>new Uint8Array(1000).fill(v);
const det = new SceneDetector({threshold:0.05});
const out=[]; const seq=[[0,10],[2,10],[4,200],[6,200],[8,200],[10,60],[12,60],[14,60]];
for (const [t,v] of seq){ const k=det.push(t,mk(v)); if(k!=null) out.push(k);} const f=det.finish(14); if(f!=null) out.push(f);
assert.deepEqual(out,[0,6,12]);
// animated: still moving then settles
const d2 = new SceneDetector({threshold:0.05}); const o2=[];
for (const [t,v] of [[0,10],[2,100],[4,150],[6,150],[8,150]]) { const k=d2.push(t,mk(v)); if(k!=null) o2.push(k);} 
assert.deepEqual(o2,[0,6]);
// text slide -> other text slide moving ~6% of pixels
const a=new Uint8Array(10000).fill(255), b=a.slice(); for(let i=0;i<600;i++) b[i*7]=0;
assert.ok(changedFraction(a,b)>=0.05);
console.log('scenes ok');

// code detect
assert.equal(detectCode(['def foo(x):','  return x+1','import os','print(foo(2))','for i in range(3):'],'we write a function and a loop').likely, true);
assert.equal(detectCode(['Newton second law','F = m a','Force and acceleration'],'the force is proportional').likely, false);
console.log('codedetect ok');

// splitFull / topics
const doc = `## Overview\n- a\n- b\n\n## Detailed notes\n### Topic One (00:10)\n- **Big idea:** x\n\n### Topic Two (1:02:03)\ntext\n\n## Exam hints\n- h1`;
const sp = lp.splitFull(doc);
assert.match(sp.overview,/- a/); assert.match(sp.notes,/Topic Two/); assert.equal(sp.hints,undefined); assert.ok(!/h1/.test(sp.notes));
assert.deepEqual(lp.topicList(sp.notes), [{title:'Topic One',time:'00:10'},{title:'Topic Two',time:'1:02:03'}]);
const sp2 = lp.splitFull('## Overview\n- a\n### T (00:01)\nbody\n## Exam hints\n- h');
assert.match(sp2.notes,/### T/); assert.equal(sp2.overview,'- a');
console.log('splitFull ok');

// settings migration
const st = normalizeSettings({ apiKey:'AIzaX', model:'gemini-2.5-flash' });
assert.equal(st.engine,'local'); assert.equal(st.strong.model,'gemini-2.5-flash'); assert.equal(st.cheap.provider,'');
assert.equal(slotRef(st,'cheap').model,'gemini-2.5-flash');
assert.equal(settingsProblem(st,'video') , null);
const st2 = normalizeSettings({ providers:[{id:'g',type:'gemini',name:'G',apiKey:'k',baseUrl:'x'},{id:'o',type:'openai',name:'O',apiKey:'k2',baseUrl:'http://localhost:11434/v1'}], strong:{provider:'g',model:'big'}, cheap:{provider:'o',model:'llama'}, vision:{provider:'g',model:'big'}, sceneThreshold: 7 });
assert.equal(slotRef(st2,'cheap').model,'llama'); assert.equal(st2.sceneThreshold,0.9);
console.log('settings ok');
const migrated = normalizeSettings({
  providers: [{ id: 'active', type: 'openai', models: ['active-model'] }, { id: 'retired', type: 'retired-backend' }],
  strong: { provider: 'active', model: 'active-model' },
  digest: { provider: 'retired', model: 'retired-model' },
  cheapPool: [{ provider: 'retired', model: 'retired-model' }]
});
assert.deepEqual(migrated.providers.map(provider => provider.id), ['active']);
assert.deepEqual(migrated.digest, { provider: '', model: '' });
assert.deepEqual(migrated.cheapPool, []);
assert.deepEqual(migrated.strong, { provider: 'active', model: 'active-model' });
{
  const providers = [
    { id: 'claude', type: 'claudecli' },
    { id: 'gemini-web', type: 'geminiweb' },
    { id: 'groq', type: 'openai', models: ['groq-model', 'shared-model'] },
    { id: 'ollama', type: 'openai', models: ['local-model', 'shared-model'] },
    { id: 'gemini', type: 'gemini' }
  ];
  const scoped = normalizeSettings({
    providers,
    strong: { provider: 'claude', model: 'neon-high' },
    digest: { provider: 'ollama', model: 'groq-model' },
    vision: { provider: 'ollama', model: 'shared-model' },
    cheap: { provider: 'ollama', model: 'my-unlisted-model' },
    practice: { provider: 'ollama', model: 'groq-model', custom: true },
    video: { provider: 'gemini', model: '' },
    notes: { provider: 'gemini', model: '' },
    cheapPool: [{ provider: 'claude', model: 'neon-high' }, { provider: 'gemini-web', model: 'neon-high' }]
  });
  assert.deepEqual(scoped.strong, { provider: 'claude', model: '' });
  assert.deepEqual(scoped.digest, { provider: 'ollama', model: '' });
  assert.equal(scoped.vision.model, 'shared-model');
  assert.equal(scoped.cheap.model, 'my-unlisted-model');
  assert.equal(scoped.practice.model, 'groq-model');
  assert.equal(scoped.video.model, '');
  assert.equal(scoped.notes.model, '');
  assert.deepEqual(scoped.cheapPool, [{ provider: 'gemini-web', model: 'neon-high' }]);
}
// extension-side web search: parsers and query
{
  const ws = await import('./lib/websearch.js');
  const html = '<div class="result"><a rel="nofollow" class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fen.wikipedia.org%2Fwiki%2FRamayana&amp;rut=x">Ramayana - <b>Wikipedia</b></a><a class="result__snippet" href="#">Ancient Sanskrit <b>epic</b> &amp; more</a></div>'
    + '<a class="result__a" href="https://example.com/ad">Other</a><a class="result__snippet">second</a>';
  const r = ws.parseDuckDuckGo(html);
  assert.equal(r[0].url, 'https://en.wikipedia.org/wiki/Ramayana');
  assert.equal(r[0].title, 'Ramayana - Wikipedia');
  assert.equal(r[0].snippet, 'Ancient Sanskrit epic & more');
  assert.equal(r[1].url, 'https://example.com/ad');
  assert.deepEqual(ws.parseDuckDuckGo('nothing here'), []);
  const w = ws.parseWikipedia({ query: { search: [{ title: 'Binary tree', snippet: 'a <span>tree</span> data' }] } });
  assert.equal(w[0].url, 'https://en.wikipedia.org/wiki/Binary_tree');
  assert.equal(w[0].snippet, 'a tree data');
  assert.equal(ws.queryFromTitle('Ramayana: Judi Jodi (Song) | Namit M, Nitesh T | Ranbir K'), 'Ramayana: Judi Jodi');
  console.log('websearch ok');
}
// code examples must show their output: find the ones without, insert what the model says
{
  const md = [
    '### Loops (01:00)',
    '```python',
    'for i in range(3):',
    '    print(i)',
    '```',
    '**Output:**',
    '```text',
    '0',
    '1',
    '2',
    '```',
    '> **Extra example:**',
    '> ```js',
    '> console.log(1 + 1)',
    '> ```',
    '',
    '```json',
    '{"a": 1}',
    '```',
    '```python',
    'x = [3, 1, 2]',
    'x.sort()',
    '```',
    'Done.'
  ].join('\n');
  const miss = lp.codeWithoutOutput(md);
  assert.deepEqual(miss.map((b) => b.lang), ['js', 'python']); // the first has its output; json is not code
  assert.equal(miss[0].code, 'console.log(1 + 1)');
  const out = lp.addOutputs(md, miss, ['2', 'x is now [1, 2, 3]']);
  assert.match(out, /> console\.log\(1 \+ 1\)\n> ```\n> \n> \*\*Output:\*\*\n> ```text\n> 2\n> ```/);
  assert.match(out, /x\.sort\(\)\n```\n\n\*\*Output:\*\*\n```text\nx is now \[1, 2, 3\]\n```\nDone\./);
  assert.equal(lp.codeWithoutOutput(out).length, 0);
  assert.equal(lp.addOutputs(md, miss, []), md); // nothing known: unchanged
  console.log('code outputs ok');
}
// ```steps blocks become rows of boxes (a picture of each phase), not text
{
  const { renderMarkdown, renderSteps } = await import('./lib/md.js');
  const h = renderSteps('# Bubble sort\n5* 3* 8 | compare\n3 5 8! | done\n_ 1 | empty slot');
  assert.equal((h.match(/min-width:30px/g) || []).length, 8); // one box per cell
  assert.match(h, /processing/); assert.match(h, /untouched/); // the colour key
  assert.match(renderSteps('3~ 5'), /background:#ff8a8a;">3</); // changed cell
  assert.match(h, /background:#7fd88f;">5</); // active cell
  assert.match(h, /background:#8db6ff;">8</); // finished cell
  assert.match(h, /border-style:dashed/); // empty cell
  assert.match(h, /Bubble sort/); assert.match(h, /compare/);
  assert.ok(!/\*|!/.test(h.replace(/<[^>]+>/g, '').replace(/·/g, ''))); // markers are not shown as text
  const page = renderMarkdown('Text\n\n```steps\n1* 2\n```\n\n```python\nprint(1)\n```');
  assert.match(page, /class="steps"/); assert.match(page, /<pre><code>print\(1\)/);
  assert.match(renderSteps('<b>* x | <i>'), /&lt;b&gt;/); // escaped
  console.log('steps ok');
}

{
  const { writerEvidence } = await import('./lib/align.js');
  const frames = [{
    index: 42, t: 4, text: 'Pitch diameter', vision: 'Two teeth are meshing.', kinds: ['diagram']
  }, {
    index: 43, t: 7, text: 'Legible alternate reading', vision: 'Separate frame detail.', kinds: ['table']
  }];
  const chunk = { segments: [{ start: 0, end: 3, text: 'Raw lecture wording' }], screen: frames,
    extra: [{ t: 8, line: '[00:08] ON SCREEN (quote) text: Quoted slide line' }] };
  const ocr = { 42: { text: 'Pitch\ndiameter', conf: 90 }, 43: { text: 'Verbatim cell\nSecond row', conf: 90 } };
  const direct = writerEvidence([chunk], ocr);
  assert.match(direct, /LECTURE TRANSCRIPT[\s\S]*FRAME OCR[\s\S]*VISION DESCRIPTIONS[\s\S]*TEXT-ONLY SCREEN EVIDENCE/);
  assert.match(direct, /Pitch\ndiameter/);
  assert.doesNotMatch(direct, /Pitch diameter/);
  for (const preserved of ['Raw lecture wording', 'Verbatim cell\nSecond row', 'Legible alternate reading', 'Two teeth are meshing.', 'Quoted slide line']) {
    assert.ok(direct.includes(preserved), preserved);
  }
  const reduced = writerEvidence([chunk], ocr, 'Cheap AI coverage');
  assert.match(reduced, /CHEAP AI CHUNK NOTES\nCheap AI coverage/);
  assert.match(reduced, /Verbatim cell\nSecond row/);
  assert.doesNotMatch(reduced, /Raw lecture wording/);
}
