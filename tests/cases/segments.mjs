import assert from 'node:assert/strict';
const { parseHls, isManifestUrl, downloadParts } = await import('./lib/segments.js');
const { createSpool } = await import('./lib/spool.js');

assert.ok(isManifestUrl('https://x/a.m3u8?t=1') && isManifestUrl('https://x/a.mpd') && !isManifestUrl('https://x/a.mp4'));

// master playlist: variants + audio group
const master = parseHls(`#EXTM3U
#EXT-X-MEDIA:TYPE=AUDIO,GROUP-ID="aud",DEFAULT=YES,URI="audio/a.m3u8"
#EXT-X-STREAM-INF:BANDWIDTH=900000,RESOLUTION=1280x720,AUDIO="aud"
v720.m3u8
#EXT-X-STREAM-INF:BANDWIDTH=300000,RESOLUTION=640x360,AUDIO="aud"
v360.m3u8`, 'https://cdn.test/p/master.m3u8');
assert.equal(master.type, 'master');
assert.equal(master.variants.length, 2);
assert.equal(master.variants[1].url, 'https://cdn.test/p/v360.m3u8');
assert.equal(master.variants[1].height, 360);
assert.equal(master.audio.aud[0].url, 'https://cdn.test/p/audio/a.m3u8');

// fMP4 media playlist with init map and byte ranges
const media = parseHls(`#EXTM3U
#EXT-X-MAP:URI="init.mp4"
#EXTINF:6,
#EXT-X-BYTERANGE:100@0
f.m4s
#EXTINF:6,
#EXT-X-BYTERANGE:50
f.m4s
#EXT-X-ENDLIST`, 'https://cdn.test/p/v.m3u8');
assert.equal(media.init.url, 'https://cdn.test/p/init.mp4');
assert.deepEqual(media.segments[1].range, { offset: 100, length: 50 });
assert.equal(media.live, false);
assert.equal(media.ts, false);
assert.equal(media.encrypted, false);

// TS and encrypted streams are flagged
assert.equal(parseHls('#EXTM3U\n#EXTINF:6,\na.ts\n#EXT-X-ENDLIST', 'https://c/x.m3u8').ts, true);
assert.equal(parseHls('#EXTM3U\n#EXT-X-KEY:METHOD=AES-128,URI="k"\n#EXTINF:6,\na.ts', 'https://c/x.m3u8').encrypted, true);
assert.throws(() => parseHls('hello', 'https://c/'));

// segments are written in order even when they finish out of order
globalThis.fetch = async (url) => {
  const i = Number(/(\d+)$/.exec(url)[1]);
  await new Promise((r) => setTimeout(r, (5 - i) * 10));
  return { ok: true, headers: { get: () => 'video/mp4' }, arrayBuffer: async () => new Uint8Array([i]).buffer };
};
const blob = await downloadParts([0, 1, 2, 3, 4].map((i) => ({ url: `https://c/s${i}` })), { signal: new AbortController().signal });
assert.deepEqual([...new Uint8Array(await blob.arrayBuffer())], [0, 1, 2, 3, 4]);

// a failing part aborts the download
globalThis.fetch = async () => ({ ok: false, status: 403, headers: { get: () => '' } });
await assert.rejects(downloadParts([{ url: 'https://c/x' }], { signal: new AbortController().signal }), /403/);

// spool keeps memory fallback when OPFS is missing, even past the limit
const sp = createSpool('t', 4);
await sp.write(new Uint8Array([1, 2, 3])); await sp.write(new Uint8Array([4, 5, 6]));
assert.deepEqual([...new Uint8Array(await (await sp.finish()).arrayBuffer())], [1, 2, 3, 4, 5, 6]);
console.log('segments ok');
