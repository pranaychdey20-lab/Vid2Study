globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const assert=(await import('node:assert')).default;
const { transcribeCloud } = await import('./lib/stt.js');
const { posts } = await import('./lib/llm.js');
const SR=16000, dur=1500; // 25 min -> 3 windows of 10 min
const audio={length:dur*SR, slice:async(a,b)=>{const x=new Float32Array(b-a); for(let i=0;i<x.length;i++) x[i]=0.2*Math.sin(i/10); return x;}};
const prog=[]; const segs=await transcribeCloud(audio,{ref:{provider:{name:'Groq',baseUrl:'https://api.groq.com/openai/v1/'},model:'whisper-large-v3-turbo'},language:'en',signal:new AbortController().signal,progress:(s,p,t)=>prog.push(t)});
assert.equal(posts.length,3); assert.equal(posts[0].url,'https://api.groq.com/openai/v1/audio/transcriptions');
assert.deepEqual(segs.map(s=>s.start),[1,601,1201]);
const f=posts[0].form; assert.equal(f.get('model'),'whisper-large-v3-turbo'); assert.equal(f.get('language'),'en'); assert.equal(f.get('response_format'),'verbose_json'); assert.ok(f.get('file').size>600*SR*2);
// auto language omits the field; mapTime applies; silence is not uploaded
posts.length=0;
const quiet={length:60*SR, slice:async(a,b)=>new Float32Array(b-a)};
const s2=await transcribeCloud(quiet,{ref:{provider:{baseUrl:'x'},model:'m'},language:'auto',signal:new AbortController().signal,progress(){}}); assert.equal(posts.length,0); assert.equal(s2.length,0);
const s3=await transcribeCloud({length:60*SR,slice:audio.slice},{ref:{provider:{baseUrl:'x'},model:'m'},language:'auto',mapTime:(s)=>s*2,signal:new AbortController().signal,progress(){}});
assert.equal(posts[0].form.get('language'),null); assert.equal(s3[0].start,2);
console.log('stt ok');
// model names per service: OpenAI's whisper-1 chosen with Groq is swapped for Groq's model before sending
{
  const { sttModelFor, sttModelsFor } = await import('./lib/stt.js');
  const groq = { name: 'Groq', baseUrl: 'https://api.groq.com/openai/v1' }, oai = { baseUrl: 'https://api.openai.com/v1' };
  assert.equal(sttModelFor(groq, 'whisper-1'), 'whisper-large-v3-turbo');
  assert.equal(sttModelFor(oai, 'whisper-large-v3-turbo'), 'whisper-1');
  assert.equal(sttModelFor(oai, 'gpt-4o-mini-transcribe'), 'gpt-4o-mini-transcribe');
  assert.equal(sttModelFor(groq, 'my-custom-model'), 'my-custom-model'); // unknown names are respected
  assert.equal(sttModelsFor(groq)[0], 'whisper-large-v3-turbo');
  const one = { length: 60 * SR, slice: audio.slice };
  posts.length = 0;
  await transcribeCloud(one, { ref: { provider: groq, model: 'whisper-1' }, language: 'en', signal: new AbortController().signal, progress() {} });
  assert.equal(posts[0].form.get('model'), 'whisper-large-v3-turbo');
  // a model the service rejects (404) falls back to the next one it has, and the job keeps going
  posts.length = 0;
  const odd = { name: 'Odd', baseUrl: 'https://notturbo.example/v1' };
  const out = await transcribeCloud(one, { ref: { provider: odd, model: 'missing-model' }, language: 'en', signal: new AbortController().signal, progress() {} });
  assert.deepEqual(posts.map((p) => p.form.get('model')), ['missing-model', 'whisper-large-v3-turbo', 'whisper-large-v3']);
  assert.ok(out.length);
  // gpt-4o transcribe models get plain json
  posts.length = 0;
  await transcribeCloud(one, { ref: { provider: oai, model: 'gpt-4o-mini-transcribe' }, language: 'en', signal: new AbortController().signal, progress() {} });
  assert.equal(posts[0].form.get('response_format'), 'json');
  console.log('stt model fallback ok');
}
// a model that only answers plain json (OpenRouter): switch once, then send 1-minute pieces so timestamps survive
{
  posts.length = 0;
  const or = { name: 'OpenRouter', baseUrl: 'https://plainonly.example/api/v1' };
  const three = { length: 180 * SR, slice: audio.slice };
  const segs = await transcribeCloud(three, { ref: { provider: or, model: 'openai/whisper-1' }, language: 'en', signal: new AbortController().signal, progress() {} });
  assert.equal(posts[0].form.get('response_format'), 'verbose_json');
  assert.ok(posts.slice(1).every((p) => p.form.get('response_format') === 'json'));
  assert.equal(posts.length, 4); // 1 rejected + 3 one-minute pieces
  assert.deepEqual(segs.map((x) => x.start), [0, 60, 120]);
  console.log('stt plain json ok');
}
