globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const fk = await import('./lib/framekind.js');
const lp = await import('./lib/local-pipeline.js');
const W=480,H=270;
const blank=(v=255)=>new Uint8Array(W*H).fill(v);
const rect=(g,x,y,w,h,v)=>{for(let j=y;j<y+h;j++)for(let i=x;i<x+w;i++)g[j*W+i]=v;};
const frame=(g)=>fk.pixelFeatures(g,W,H,[]);
// words helper: lines of text positioned like a slide
const mkWords=(rows,x0=40,cw=9,gapCols)=>{const words=[];rows.forEach((row,r)=>{let x=x0;row.split(' ').forEach(t=>{words.push({x,y:30+r*28,w:t.length*cw,h:18,conf:90,text:t,line:`1.1.${r+1}`});x+=t.length*cw+cw;});});return words;};
const cls=(rows,g,opts={})=>fk.classify({lines:fk.groupLines(mkWords(rows)),W,px:frame(g),sat:opts.sat||0});

// 1. plain bullet slide with lots of words -> NOT flagged
let text=['Introduction to thermodynamics and energy','The first law states that energy is conserved','Heat flows from hot bodies to cold bodies','Entropy always increases in isolated systems','Engines convert heat into useful mechanical work','Efficiency is limited by the Carnot bound'];
let c=cls(text,blank()); console.log('text', c.kinds, c.scores); assert.deepEqual(c.kinds,[]);
// 2. code on a dark editor, MANY words -> code
let code=['def fibonacci(n):','    if n <= 1:','        return n','    return fibonacci(n-1) + fibonacci(n-2)','for i in range(10):','    print(fibonacci(i))','result = [fibonacci(x) for x in range(5)]'];
c=cls(code,blank(30)); console.log('code', c.kinds, c.scores); assert.ok(c.kinds.includes('code'));
// code on a LIGHT slide too
c=cls(code,blank(250)); console.log('code light', c.kinds, c.scores); assert.ok(c.kinds.includes('code'));
// 3. ruled table with words
let g=blank(); for(const y of [60,100,140,180,220]) rect(g,40,y,400,2,0); for(const x of [40,160,280,438]) rect(g,x,60,2,162,0);
c=cls(['Name Age City','Anna 23 Delhi','Ravi 31 Pune','Mei 28 Oslo'],g); console.log('table grid', c.kinds, c.scores); assert.ok(c.kinds.includes('table'));
// table without ruling: aligned columns only
const colRows=[]; const mk=(a,b,c2)=>({a,b,c2});
const cw=9; const words=[]; [['Name','Age','City'],['Anna','23','Delhi'],['Ravi','31','Pune'],['Mei','28','Oslo'],['Tom','40','Rome']].forEach((r,i)=>{[40,200,340].forEach((x,k)=>words.push({x,y:30+i*28,w:r[k].length*cw,h:18,conf:90,text:r[k],line:`1.1.${i+1}`}))});
c=fk.classify({lines:fk.groupLines(words),W,px:frame(blank()),sat:0}); console.log('table cols', c.kinds, c.scores); assert.ok(c.kinds.includes('table'));
// 4. diagram: boxes + arrows + few labels, plus a label-heavy diagram
g=blank(); rect(g,60,60,100,60,0); rect(g,64,64,92,52,255); rect(g,300,60,100,60,0); rect(g,304,64,92,52,255); rect(g,160,88,140,3,0); rect(g,200,150,3,80,0); rect(g,150,225,120,3,0);rect(g,100,140,60,60,0);rect(g,104,144,52,52,255);rect(g,330,150,80,80,0);rect(g,334,154,72,72,255);
c=cls(['Input Layer','Hidden','Output'],g); console.log('diagram', c.kinds, c.scores); assert.ok(c.kinds.includes('diagram'));
// diagram with MANY label words (not low-text) still flagged because edges are outside the text boxes
const lab=mkWords(['Client sends request to the load balancer','Balancer picks one of three app servers','App server queries the database cluster','Replica copies writes from the primary node'],200,9);
c=fk.classify({lines:fk.groupLines(lab),W,px:fk.pixelFeatures(g,W,H,lab.map(w=>({x:w.x,y:w.y,w:w.w,h:w.h}))),sat:0.1}); console.log('diagram labelled', c.kinds, c.scores); assert.ok(c.kinds.includes('diagram'));
// 5. formulas
c=cls(['E = m c^2','F = m a','v = d / t','where m is the mass of the body'],blank()); console.log('formula', c.kinds, c.scores); assert.ok(c.kinds.includes('formula'));
// 6. blank frame
c=cls([],blank(0)); assert.equal(c.blank,true); assert.deepEqual(c.kinds,[]);
// tsv parse
const tsv='1\t1\t0\t0\t0\t0\t0\t0\t480\t270\t-1\t\n5\t1\t1\t1\t1\t1\t40\t30\t50\t18\t91\tHello\n5\t1\t1\t1\t1\t2\t100\t30\t50\t18\t90\tworld\n5\t1\t1\t1\t2\t1\t40\t60\t50\t18\t-1\t';
const p=fk.parseTsv(tsv); assert.equal(p.W,480); assert.equal(p.words.length,2); assert.equal(fk.groupLines(p.words)[0].text,'Hello world');
console.log('framekind ok');

// ---- mergeRepeats
const F=(i,t,o={})=>({index:i,t,words:0,text:'',kinds:[],h:'0'.repeat(64),scores:{},...o});
const m=lp.mergeRepeats([F(1,0,{words:20,text:'alpha beta gamma delta epsilon zeta eta theta'}),F(2,5,{words:25,text:'alpha beta gamma delta epsilon zeta eta theta iota kappa'}),F(3,50,{words:20,text:'completely different words about something else entirely here'})]);
assert.deepEqual(m.map(f=>f.index),[2,3]);
// two different code screens with identical (dark) hashes must NOT merge
const codeA={words:30,text:'def a(): return 1 print(a())',kinds:['code']}, codeB={words:30,text:'class B: pass import os os.listdir',kinds:['code']};
assert.equal(lp.mergeRepeats([F(1,0,codeA),F(2,20,codeB)]).length,2);
// diagram built step by step: merged to last
assert.deepEqual(lp.mergeRepeats([F(1,0,{kinds:['diagram'],scores:{diagram:.5}}),F(2,10,{kinds:['diagram'],scores:{diagram:.8}})]).map(f=>f.index),[2]);
console.log('merge ok');

// ---- figures: guaranteed insertion
const notes=`### Intro (00:10)\n- **Big idea:** a\n> **Example:** e\n\n### Loops (10:00)\n- **Key points:** b\n[[FRAME:5]]\n> **Quick check:** q\n\n### Tables (20:00)\n- **Key points:** c\n`;
const screen=[{index:1,t:30,important:false,score:0},{index:5,t:700,important:false,score:0},{index:7,t:650,important:true,score:.9,kinds:['code']},{index:8,t:1300,important:true,score:.7,kinds:['table']},{index:9,t:100,important:true,score:.6,kinds:['diagram']}];
const by=new Map(screen.map(f=>[f.index,f]));
const out=lp.chooseFigures(notes,screen,by,10);
console.log(out);
const order=[...out.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(m=>+m[1]);
assert.deepEqual(order.sort(),[5,7,8,9]); // flagged 7,8,9 inserted + writer's 5 kept
assert.ok(out.indexOf('[[FRAME:9]]') < out.indexOf('### Loops')); // diagram at 1:40 -> Intro, before its Example callout
assert.ok(out.indexOf('[[FRAME:9]]') < out.indexOf('> **Example:**'));
assert.ok(out.indexOf('[[FRAME:8]]') > out.indexOf('### Tables'));
// budget: only 2 -> flagged by score win over the writer's plain pick
const small=lp.chooseFigures(notes,screen,by,2); const kept=[...small.matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(m=>+m[1]).sort(); assert.deepEqual(kept,[7,8]);
console.log('figures ok');
// a video with no informative frames (song / vlog) still gets a few spread-out scenes
{
  const distinct = Array.from({ length: 20 }, (_, i) => ({ index: i, t: i * 12, blank: i === 0 }));
  const picks = lp.pickScenes(distinct, [], 240, 4);
  assert.equal(picks.length, 4);
  assert.ok(picks.every((f) => !f.blank));
  assert.ok(picks[0].t < 60 && picks[3].t > 180, 'spread over the video');
  assert.equal(lp.pickScenes(distinct, [{ index: 3, important: true }, { index: 4, important: true }], 240, 4).length, 2);
  assert.equal(lp.pickScenes(distinct, Array.from({ length: 5 }, (_, i) => ({ index: i, important: true })), 240, 4).length, 0);
  console.log('scenes ok');
}

// ---- figures sit right after the bullet that talks about them (the WW1 explainer, real transcript lines)
{
  const notes = `### Alliances (00:00)
- **Big idea:** two blocs
- **Key points:**
    - In 1882, Germany, Italy and Austria-Hungary formed the Triple Alliance.
    - Britain and France signed the Entente Cordiale in 1904.
    - Both sides believed their pacts made them too strong to attack.
> **Extra (beyond the lecture):** MAIN

### The spark (00:50)
- **Key points:**
    - In 1908 Austria-Hungary annexed Bosnia, angering Serbia.
    - The Black Hand assassinated Archduke Franz Ferdinand on 28 June 1914.
    - Germany invaded Belgium; Russia mobilised faster than predicted.
`;
  const segs = [
    { start: 20, end: 27, text: 'In 1904 they put aside their differences and signed the Entente Cordiale followed by the Triple Entente to include Russia.' },
    { start: 50, end: 59, text: 'Meanwhile in 1908 Austria-Hungary annexed Bosnia to the anger of Serbia.' },
    { start: 101, end: 110, text: 'Russia mobilized troops quicker than predicted and Germany found themselves surrounded.' }
  ];
  const out = lp.insertFrames(notes, [{ index: 3, t: 22 }, { index: 4, t: 55 }, { index: 7, t: 105 }, { index: 9, t: 200 }], 120, segs);
  const after = (marker, line) => { const a = out.indexOf(line), m = out.indexOf(marker); return m > a && !out.slice(a + line.length, m).includes('- '); };
  assert.ok(after('[[FRAME:3]]', 'Entente Cordiale in 1904.'), 'empire map under the 1904 bullet');
  assert.ok(after('[[FRAME:4]]', 'angering Serbia.'), 'Bosnia map under the annexation bullet');
  assert.ok(after('[[FRAME:7]]', 'faster than predicted.'), 'troops under the last bullet');
  assert.ok(out.indexOf('[[FRAME:9]]') > out.indexOf('### The spark'), 'no match: still under the topic of its time');
  // writers spell markers in several ways
  assert.equal(lp.normaliseMarkers('a [[FRAME:F3]] b [[ frame: 4 ]] c [[F5]] d [[FRAME:6]]'), 'a [[FRAME:3]] b [[FRAME:4]] c [[FRAME:5]] d [[FRAME:6]]');
  const by = new Map([[3, { index: 3, t: 22 }]]);
  assert.match(lp.chooseFigures('### A (00:00)\n- x\n[[FRAME:F3]]\n', [{ index: 3, t: 22, important: false }], by, 5), /\[\[FRAME:3\]\]/);
  // captions are cut at a sentence or word end, never mid-word
  assert.equal(lp.clipSentence('A map of Europe. Germany is red and France is blue.', 30), 'A map of Europe.');
  assert.match(lp.clipSentence('Great Britain dark green upper left Germany dark red', 30), /^Great Britain dark green…$/);
  console.log('figure placement ok');
}
// ---- flag stripes read by OCR as "=== —— ___" are not code; real code still is
{
  const noise = fk.classify({ lines: fk.groupLines(mkWords(['=== —— ___', '—— == ——', '=_= —— ==', '|| == ——'])), W, px: frame(blank()), sat: 0.2 });
  assert.ok(!noise.kinds.includes('code'), `stripes are not code: ${JSON.stringify(noise.scores)}`);
  const code = fk.classify({ lines: fk.groupLines(mkWords(['def add(a, b):', '    return a + b', 'for i in range(3):', '    print(add(i, 1))'])), W, px: frame(blank(30)), sat: 0 });
  assert.ok(code.kinds.includes('code'), `code still found: ${JSON.stringify(code.scores)}`);
  console.log('noise is not code ok');
}
