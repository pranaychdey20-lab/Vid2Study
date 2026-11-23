// YouTube captions without listening: json3 -> lines, track choice, and the in-page grab against a fake player.
import assert from 'node:assert/strict';
const { json3ToLines, pickTrack, pagePlayerCaptions } = await import('./lib/ytcaptions.js');

// json3 -> "[mm:ss] text" lines of ~20 s; empty and line-break events skipped
{
  const j = { events: [
    { tStartMs: 0, segs: [{ utf8: 'forward' }, { utf8: ' kinematics' }] },
    { tStartMs: 3000, segs: [{ utf8: '\n' }] },
    { tStartMs: 4000 },
    { tStartMs: 9000, segs: [{ utf8: 'uses DH parameters' }] },
    { tStartMs: 3725000, segs: [{ utf8: 'an hour in' }] }
  ] };
  assert.equal(json3ToLines(j), '[00:00] forward kinematics uses DH parameters\n[62:05] an hour in');
  assert.equal(json3ToLines(JSON.stringify(j)).split('\n').length, 2, 'accepts the raw text too');
  assert.equal(json3ToLines('not json'), '');
  const { parseTimestamped } = await import('./lib/transcript.js');
  assert.equal(parseTimestamped(json3ToLines(j))[1].start, 3725, 'the pipeline reads minutes past 59');
}

// track choice: hand-made English > auto English > any hand-made > first
{
  assert.equal(pickTrack([{ languageCode: 'hi', kind: 'asr' }, { languageCode: 'en', kind: 'asr' }, { languageCode: 'en' }]).kind, undefined);
  assert.equal(pickTrack([{ languageCode: 'hi', kind: 'asr' }, { languageCode: 'en', kind: 'asr' }]).languageCode, 'en');
  assert.equal(pickTrack([{ languageCode: 'hi', kind: 'asr' }, { languageCode: 'hi' }]).kind, undefined);
  assert.equal(pickTrack([]), null);
}

// the in-page grab: the player loads the captions itself (with its token); the reply is kept, captions restored
{
  const body = JSON.stringify({ events: [{ tStartMs: 1000, segs: [{ utf8: 'hello class' }] }] });
  let option = null, unloaded = false;
  const realFetch = async (u) => ({ ok: true, text: async () => body, clone() { return this; }, url: u });
  globalThis.window = globalThis;
  globalThis.location = { href: 'https://www.youtube.com/watch?v=abcdefghijk' };
  globalThis.performance = { getEntriesByType: () => [] };
  globalThis.XMLHttpRequest = class { open() {} addEventListener() {} };
  globalThis.fetch = realFetch;
  const player = {
    getPlayerResponse: () => ({ captions: { playerCaptionsTracklistRenderer: { captionTracks: [{ languageCode: 'en', kind: 'asr' }] } } }),
    getVideoData: () => ({ video_id: 'abcdefghijk' }),
    getOption: (m, k) => (k === 'tracklist' ? [{ languageCode: 'en', kind: 'asr' }] : option),
    setOption: (m, k, v) => {
      option = v;
      // turning a track on makes the player fetch it, token included
      if (v?.languageCode) window.fetch('https://www.youtube.com/api/timedtext?v=abcdefghijk&lang=en&pot=TOKEN&fmt=json3');
    },
    loadModule() {}, unloadModule() { unloaded = true; }
  };
  globalThis.document = { getElementById: (id) => (id === 'movie_player' ? player : null) };
  const r = await pagePlayerCaptions('abcdefghijk', 2000);
  assert.equal(r.via, 'player');
  assert.equal(json3ToLines(r.json), '[00:01] hello class');
  assert.equal(globalThis.fetch, realFetch, 'the page fetch is restored');
  assert.ok(unloaded && !option?.languageCode, 'captions turned back off for the viewer');
  // another video on the page, or no captions: a reason, never a wrong transcript
  assert.match((await pagePlayerCaptions('zzzzzzzzzzz', 200)).error, /another video/);
  player.getPlayerResponse = () => ({});
  assert.match((await pagePlayerCaptions('abcdefghijk', 200)).error, /no captions/);
}
console.log('ytcaptions ok');
