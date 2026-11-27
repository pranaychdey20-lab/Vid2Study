globalThis.document = { createElement: () => ({ getContext: () => ({}) }) };
globalThis.chrome = { runtime: { getURL: (p) => p } };
const assert = (await import('node:assert')).default;
const { runLocalPipeline, placeTopicFigures, canRedraw } = await import('./lib/local-pipeline.js');
const { getResult } = await import('./lib/db.js');
const { calls, failures } = await import('./lib/llm.js');
const { normalizeSettings } = await import('./lib/settings.js');
globalThis.fetch = async () => { throw new Error('offline (tests never use the network)'); };
const base = {
  providers: [{ id: 'g', type: 'gemini', name: 'G', apiKey: 'k', baseUrl: 'x' }, { id: 'o', type: 'openai', name: 'O', apiKey: 'k', baseUrl: 'http://localhost:11434/v1' }],
  strong: { provider: 'g', model: 'BIG' }, cheap: { provider: 'o', model: 'small' }, visuals: false, practiceQuestions: false, researchReferences: false
};
const transcript = (min) => { let s = ''; for (let t = 0; t < min * 60; t += 20) s += `[${String(Math.floor(t / 60)).padStart(2, '0')}:${String(t % 60).padStart(2, '0')}] word ${t} blah blah\n`; return s; };
const run = async (key, settings) => {
  calls.length = 0;
  await runLocalPipeline({ mode: 'text', key, title: 'T', course: 'C', settings: normalizeSettings({ ...base, ...settings }), signal: new AbortController().signal, onProgress() {}, transcript: transcript(20) });
  return { r: await getResult(key), calls: [...calls] };
};

// ---- 1. the data is a file, the rules are the message (writer)
{
  const { calls: made } = await run('plain', {});
  const write = made.find((c) => c.task === 'WRITE');
  assert.equal(write.attachments.length, 1);
  assert.equal(write.attachments[0].name, 'lecture-evidence.txt');
  assert.match(write.attachments[0].text, /word 0 blah/);
  assert.doesNotMatch(write.prompt, /word 0 blah/);
  assert.match(write.prompt, /attached file lecture-evidence\.txt/);
  assert.match(write.prompt, /VISUAL BLOCKS/);
}
// attachData off = the old inline behaviour
{
  const { calls: made } = await run('inline', { attachData: false });
  const write = made.find((c) => c.task === 'WRITE');
  assert.deepEqual(write.attachments, []);
  assert.match(write.prompt, /word 0 blah/);
}

// ---- 2. a reply cut at the output limit is continued in the SAME conversation and stitched
{
  failures.push(
    { task: 'WRITE', model: 'BIG', truncated: true, reply: '## Overview\n- o\n\n## Detailed notes\n### Alpha (00:10)\nAlpha is explained at length and the reply stops mid-wo' },
    { task: 'WRITE_CONTINUE', model: 'BIG', reply: 'rd here.\n\n### Beta (05:00)\nBeta text.\n\nMISSING_DETAILS: NO' }
  );
  try {
    const { r, calls: made } = await run('cut', {});
    assert.deepEqual(made.map((c) => c.task), ['WRITE', 'WRITE_CONTINUE'], 'one continuation, no regeneration');
    const more = made[1];
    assert.match(more.prompt, /Carry on the same Markdown document[\s\S]*mid-wo>>>/);
    assert.equal(more.attachments.length, 0, 'the evidence is not attached again');
    assert.equal(more.history[0].role, 'user');
    assert.equal(more.history[0].attachments[0].name, 'lecture-evidence.txt', 'the first turn (with its file) is what the provider replays from its cache');
    assert.equal(more.history[1].role, 'assistant');
    assert.match(more.history[1].text, /mid-wo$/);
    assert.match(r.summary_markdown, /mid-word here\./);
    assert.match(r.summary_markdown, /### Beta|Beta text\./);
    assert.doesNotMatch(r.summary_markdown, /MISSING_DETAILS|<<<|Carry on/);
    assert.equal(r.coverage[0].truncated, false);
  } finally { failures.splice(-2); }
}
// a session-keeping provider continues by id: no history is replayed
{
  failures.push(
    { task: 'WRITE', model: 'BIG', truncated: true, session: { chat: 'abc' }, reply: '## Overview\n- o\n\n## Detailed notes\n### Alpha (00:10)\nCut he' },
    { task: 'WRITE_CONTINUE', model: 'BIG', reply: 're.\nMISSING_DETAILS: NO' }
  );
  try {
    const { r, calls: made } = await run('cut-session', {});
    assert.deepEqual(made[1].session, { chat: 'abc' });
    assert.match(r.summary_markdown, /Cut here\./);
  } finally { failures.splice(-2); }
}
// a block cut in the middle (a visual) is finished by the continuation, not thrown away
{
  const fence = '\x60'.repeat(3);
  failures.push(
    { task: 'WRITE', model: 'BIG', reply: '## Overview\n- o\n\n## Detailed notes\n### Alpha (00:10)\nIntro text.\n\n' + fence + 'visual\n{"type":"gamma_correction","pixe' },
    { task: 'WRITE_CONTINUE', model: 'BIG', reply: 'ls":[10,200],"gamma":2}\n' + fence + '\n\nMISSING_DETAILS: NO' }
  );
  try {
    const { r } = await run('cut-visual', {});
    assert.match(r.summary_markdown, /"pixels":\[10,200\],"gamma":2\}/);
  } finally { failures.splice(-2); }
}

// ---- 3. a frame the writer redrew as a visual is dropped; one the code cannot redraw is kept
{
  const fence = '\x60'.repeat(3);
  const notes = ['### Pixel example (01:00)', 'A worked example.', '[[FRAME:5]]', fence + 'visual', '{"type":"pixel_grid","pixels":[1,2,3,4]}', fence,
    '### Mountain (05:00)', 'A landscape.', '[[FRAME:6]]', fence + 'visual', '{"type":"pixel_grid","pixels":[1,2,3,4]}', fence,
    '### No visual (08:00)', 'Text only.', '[[FRAME:7]]'].join('\n');
  const frames = [
    { index: 5, t: 62, tag: 'chart', kinds: ['chart'], caption: 'pixel example', presentation: 'visual' },
    { index: 6, t: 302, tag: 'photo', kinds: ['photo'], caption: 'mountain photo', presentation: 'visual' },
    { index: 7, t: 482, tag: 'chart', kinds: ['chart'], caption: 'text only', presentation: 'visual' }
  ];
  const out = placeTopicFigures(notes, frames, 600, [], new Set(), new Set([5, 6, 7]), {});
  assert.doesNotMatch(out, /FRAME:5/, 'a chart the visual redraws is dropped');
  assert.match(out, /FRAME:6/, 'a photo is never replaced by a visual');
  assert.match(out, /FRAME:7/, 'no visual in its topic: the frame stays');
  assert.equal(placeTopicFigures(notes, frames, 600, [], new Set(), new Set(), {}).includes('FRAME:5'), true, 'not listed as RENDERED: kept');
  assert.equal(canRedraw({ tag: 'chart', kinds: [] }, { kind: 'photo' }), false);
  assert.equal(canRedraw({ tag: 'diagram', kinds: ['diagram'] }, undefined), true);
  assert.equal(canRedraw({ tag: 'diagram', kinds: ['diagram', 'handwriting'] }, undefined), false);
}
console.log('mdwriter ok');
