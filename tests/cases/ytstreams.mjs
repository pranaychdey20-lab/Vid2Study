import assert from 'node:assert/strict';
const { extractPlayerResponse, pickStreams, resolveYoutubeStreams } = await import('./lib/ytstreams.js');

const fmts = [
  { url: 'https://a/low', mimeType: 'audio/webm; codecs="opus"', bitrate: 160000 },
  { url: 'https://a/m4a-hi', mimeType: 'audio/mp4; codecs="mp4a.40.2"', bitrate: 130000 },
  { url: 'https://a/m4a-lo', mimeType: 'audio/mp4; codecs="mp4a.40.5"', bitrate: 48000 },
  { url: 'https://v/144', mimeType: 'video/mp4; codecs="avc1"', height: 144, bitrate: 1 },
  { url: 'https://v/720', mimeType: 'video/mp4; codecs="avc1"', height: 720, bitrate: 3 },
  { url: 'https://v/360', mimeType: 'video/mp4; codecs="avc1"', height: 360, bitrate: 2 },
  { url: 'https://v/360av1', mimeType: 'video/mp4; codecs="av01"', height: 360, bitrate: 1 }
];
const pr = { playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: fmts } };

// picks: best mp4 audio, lowest video >= 360p, never AV1
let r = pickStreams(pr);
assert.equal(r.audioUrl, 'https://a/m4a-hi');
assert.equal(r.videoUrl, 'https://v/360');
assert.equal(r.reason, '');

// encrypted streams are reported, not silently skipped
r = pickStreams({ playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: [{ signatureCipher: 's=x&url=y', mimeType: 'audio/mp4' }] } });
assert.equal(r.audioUrl, null);
assert.match(r.reason, /signatureCipher/);
assert.match(pickStreams({ playabilityStatus: { status: 'LOGIN_REQUIRED', reason: 'Sign in' } }).reason, /LOGIN_REQUIRED: Sign in/);
assert.match(pickStreams(null).reason, /no player data/);
assert.match(pickStreams({ playabilityStatus: { status: 'OK' }, streamingData: {} }).reason, /no stream list/);

// extraction: braces inside strings and escaped quotes must not break the scan
const json = JSON.stringify({ a: 'text with } and { and \\" quote', playabilityStatus: { status: 'OK' }, streamingData: { adaptiveFormats: fmts } });
const html = `<html><script>var x=1;var ytInitialPlayerResponse = ${json};var y=2;</script></html>`;
const got = extractPlayerResponse(html);
assert.equal(pickStreams(got).audioUrl, 'https://a/m4a-hi');
assert.equal(extractPlayerResponse('<html>nothing</html>'), null);
assert.equal(extractPlayerResponse('ytInitialPlayerResponse = {"broken": '), null);

// resolve: watch page first, app endpoint second, reasons combined when both fail
const calls = [];
const fakeFetch = (watchBody, appBody) => async (url) => {
  calls.push(url);
  if (String(url).includes('/watch')) return { ok: true, text: async () => watchBody };
  return { ok: true, json: async () => appBody };
};
let res = await resolveYoutubeStreams('abc', undefined, fakeFetch(html, {}));
assert.equal(res.via, 'watch page');
assert.equal(calls.length, 1);
calls.length = 0;
res = await resolveYoutubeStreams('abc', undefined, fakeFetch('<html></html>', pr));
assert.equal(res.via, 'app player endpoint');
assert.equal(calls.length, 2);
res = await resolveYoutubeStreams('abc', undefined, fakeFetch('<html></html>', { playabilityStatus: { status: 'ERROR' } }));
assert.equal(res.audioUrl, null);
assert.match(res.reason, /watch page: .*; app endpoint: /);
console.log('ytstreams ok');
