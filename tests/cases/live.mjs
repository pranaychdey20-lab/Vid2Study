globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const assert=(await import('node:assert')).default;
const { createLiveAudio } = await import('./lib/asr.js');
const { transcribeCloud } = await import('./lib/stt.js');
const { posts } = await import('./lib/llm.js');
const SR=16000; const tick=()=>new Promise(r=>setTimeout(r,40)); const waitFor=async(f)=>{for(let i=0;i<400&&!f();i++) await new Promise(r=>setTimeout(r,25)); };
const block=(seq,rate=2)=>{ const a=new Int16Array(5*SR); for(let i=0;i<a.length;i++) a[i]=Math.round(3000*Math.sin(i/9)); return {seq,n:a.length,t0:seq*5*rate,t1:(seq+1)*5*rate,b64:Buffer.from(a.buffer).toString('base64')}; };
const ref={ref:{provider:{name:'G',baseUrl:'x'},model:'m'},language:'en',progress(){},signal:new AbortController().signal};

// 1. windows are sent while the video is still playing; out-of-order blocks are handled
{ posts.length=0; const live=createLiveAudio();
  const run=transcribeCloud(live.audio,{...ref,mapTime:live.mapTime});
  for(let i=0;i<119;i++){ live.push(block(i)); } await tick();
  assert.equal(posts.length,0,'window not full yet (9m55s)');
  live.push(block(120)); await tick(); assert.equal(posts.length,0,'seq 119 missing: block 120 must wait');
  live.push(block(119)); await waitFor(()=>posts.length>=1); assert.equal(posts.length,1,'first 10-min window sent mid-recording');
  assert.equal(live.audio.length, 121*5*SR);
  for(let i=121;i<300;i++) live.push(block(i)); await waitFor(()=>posts.length>=2); assert.equal(posts.length,2);
  live.audio.release(1200*SR); // memory: finished windows are dropped
  for(let i=300;i<360;i++) live.push(block(i)); // 30 min total of recording
  live.finish(); const segs=await run;
  assert.equal(posts.length,3,'last window after finish'); // 0-10, 10-20, 20-30
  // 2x playback: recorded second r is video second 2r; the segment at recorded 1s of window 1 -> video 2s
  assert.equal(segs.length,3); assert.equal(segs[0].start,2); assert.equal(segs[1].start,(600+1)*2); assert.equal(segs[2].start,(1200+1)*2);
  assert.equal(live.audio.slice(0,10).length,10); }
// 2. a listening failure rejects the waiting transcription instead of hanging
{ posts.length=0; const live=createLiveAudio(); const run=transcribeCloud(live.audio,{...ref});
  live.push(block(0)); live.fail(new Error('page closed')); await assert.rejects(run,/page closed/); }
// 3. a short recording (< one window) is still transcribed at the end
{ posts.length=0; const live=createLiveAudio(); const run=transcribeCloud(live.audio,{...ref});
  live.push(block(0)); live.push(block(1)); live.finish(); const s=await run; assert.equal(posts.length,1); assert.equal(s.length,1); }
// 4. nothing recorded -> empty, no requests
{ posts.length=0; const live=createLiveAudio(); const run=transcribeCloud(live.audio,{...ref}); live.finish(); assert.deepEqual(await run,[]); assert.equal(posts.length,0); }
console.log('live ok');
