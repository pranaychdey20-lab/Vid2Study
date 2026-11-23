globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
const assert=(await import('node:assert')).default;
const { makeTimeMap, cleanSegments } = await import('./lib/asr.js');
// 3 blocks of 5 s recorded (80000 samples each); played at 2x so each covers 10 s of video; an ad gap before block 3
const A=[{o:0,n:80000,t0:0,t1:10},{o:80000,n:80000,t0:10,t1:20},{o:160000,n:80000,t0:95,t1:105}];
const m=makeTimeMap(A);
assert.equal(m(0),0); assert.equal(m(2.5),5); assert.equal(m(5),10); assert.equal(m(7.5),15); assert.equal(m(10),95); assert.equal(m(12.5),100); assert.equal(m(99),105);
assert.equal(makeTimeMap([])(7),7);
console.log('time map ok');

// ---- spoken language: the English-only model must never get `task` / `language` (it throws)
const { whisperOptions, asrLang, asrRepo } = await import('./lib/asr.js');
{
  const en = whisperOptions('en'); assert.ok(!('task' in en) && !('language' in en), 'English-only model options');
  const hi = whisperOptions('hinglish'); assert.equal(hi.task, 'transcribe'); assert.equal(hi.language, 'hi');
  const au = whisperOptions('auto'); assert.equal(au.task, 'transcribe'); assert.ok(!('language' in au));
  assert.equal(whisperOptions('ES').language, 'es');
  assert.equal(asrLang('Hinglish'), 'hi'); assert.equal(asrLang(''), 'en'); assert.equal(asrLang(undefined), 'en');
  assert.equal(asrRepo('base', 'en'), 'onnx-community/whisper-base.en');
  assert.equal(asrRepo('small', 'hinglish'), 'onnx-community/whisper-small');
  assert.equal(asrRepo('base', 'auto'), 'onnx-community/whisper-base');
  const { writePrompt, chunkPrompt } = await import('./lib/prompts.js');
  const wp = writePrompt({ kind: 'speech', body: 'x', title: 't', course: 'c', detail: 'standard', full: true, part: 1, parts: 1, frameBudget: 1, visualBudget: 0, code: { likely: false, language: '' }, frameIds: '' });
  assert.match(wp, /clear, natural English ONLY/); assert.match(wp, /Hinglish/);
  assert.match(chunkPrompt({ block: 'x', from: '00:00', to: '10:00', total: 1, index: 0 }), /write these bullets in English/);
  console.log('language ok');
}
// garbage transcripts (music / wrong language) are recognised; real speech is not flagged
{
  const { looksHallucinated } = await import('./lib/asr.js');
  const junk = ["I'm not sure.", "I'm so sorry.", 'No! No! No!', "I'm so sorry.", 'Thank you.', "I'm not sure.", 'Oh.', 'No!', "I'm sorry.", 'Thank you.'].map((text) => ({ text }));
  assert.equal(looksHallucinated(junk), true);
  const real = ['Today we look at binary search trees.', 'Each node has at most two children.', 'The left subtree holds smaller keys.', 'Insertion walks down from the root.', 'So searching takes log n time when balanced.', 'Let us see an example with seven keys.', 'Thank you.'].map((text) => ({ text }));
  assert.equal(looksHallucinated(real), false);
  assert.equal(looksHallucinated(junk.slice(0, 3)), false); // too short to judge
  console.log('hallucination check ok');
}
