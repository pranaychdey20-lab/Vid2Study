/**
 * Minimal MP4 / M4A audio demuxer (pure, no DOM). It reads only the movie header (`moov`) and the
 * audio sample table, so a 10 GB lecture file is never loaded into memory: the audio bytes are fetched
 * later by offset, a few minutes at a time (see audiofile.js).
 *
 * `read(start, end)` must return a Promise<Uint8Array> for that byte range, so it works on a Blob
 * (Blob.slice) in the browser and on a Buffer in tests.
 */

const ascii = (u8, p) => String.fromCharCode(u8[p], u8[p + 1], u8[p + 2], u8[p + 3]);

/** Child boxes of [start, end) in u8. */
function* boxes(u8, start = 0, end = u8.length) {
  const dv = new DataView(u8.buffer, u8.byteOffset, u8.byteLength);
  let p = start;
  while (p + 8 <= end) {
    let size = dv.getUint32(p);
    let hdr = 8;
    if (size === 1) { size = Number(dv.getBigUint64(p + 8)); hdr = 16; } else if (size === 0) size = end - p;
    if (size < hdr || p + size > end) break;
    yield { type: ascii(u8, p + 4), start: p, hdr, end: p + size };
    p += size;
  }
}
const child = (u8, box, type) => { for (const b of boxes(u8, box.start + box.hdr, box.end)) if (b.type === type) return b; return null; };

/** MPEG-4 descriptor length (1-4 bytes, 7 bits each). */
function readDesc(u8, p) {
  const tag = u8[p++];
  let len = 0;
  for (let i = 0; i < 4; i++) { const b = u8[p++]; len = (len << 7) | (b & 0x7f); if (!(b & 0x80)) break; }
  return { tag, len, body: p };
}

/** esds -> { oti, asc } (object type indication and the AudioSpecificConfig bytes). */
export function parseEsds(u8, box) {
  let p = box.start + box.hdr + 4; // full box: version + flags
  const es = readDesc(u8, p);
  if (es.tag !== 0x03) return null;
  p = es.body + 2;
  const flags = u8[p++];
  if (flags & 0x80) p += 2;
  if (flags & 0x40) p += 1 + u8[p];
  if (flags & 0x20) p += 2;
  const dc = readDesc(u8, p);
  if (dc.tag !== 0x04) return null;
  const oti = u8[dc.body];
  const si = readDesc(u8, dc.body + 13);
  const asc = si.tag === 0x05 ? u8.slice(si.body, si.body + si.len) : null;
  return { oti, asc };
}

/** WebCodecs codec string from the esds info. */
export function codecString({ oti, asc }) {
  if (oti === 0x40 || oti === 0x66 || oti === 0x67 || oti === 0x68) return `mp4a.40.${asc && asc.length ? asc[0] >> 3 : 2}`;
  if (oti === 0x6b || oti === 0x69) return 'mp3';
  return null;
}

/**
 * Parse the audio track of an MP4 / M4A.
 * @param {(start:number,end:number)=>Promise<Uint8Array>} read
 * @param {number} size file size in bytes
 * @returns {Promise<null | {codec:string, sampleRate:number, channels:number, description:Uint8Array|null,
 *   count:number, offsets:Float64Array, sizes:Uint32Array, times:Float64Array, duration:number}>}
 *   null when there is no moov / no supported audio track
 */
export async function parseMp4Audio(read, size) {
  // top-level boxes: hop over mdat (huge) until moov
  let pos = 0, moov = null;
  while (pos + 8 <= size) {
    const h = await read(pos, Math.min(pos + 16, size));
    const dv = new DataView(h.buffer, h.byteOffset, h.byteLength);
    let sz = dv.getUint32(0);
    const type = ascii(h, 4);
    if (sz === 1 && h.length >= 16) sz = Number(dv.getBigUint64(8));
    else if (sz === 0) sz = size - pos;
    if (sz < 8) break;
    if (type === 'moov') { moov = await read(pos, Math.min(pos + sz, size)); break; }
    pos += sz;
  }
  if (!moov) return null;
  const dv = new DataView(moov.buffer, moov.byteOffset, moov.byteLength);
  const root = { start: 0, hdr: 8, end: moov.length };

  for (const trak of boxes(moov, root.start + root.hdr, root.end)) {
    if (trak.type !== 'trak') continue;
    const mdia = child(moov, trak, 'mdia');
    const hdlr = mdia && child(moov, mdia, 'hdlr');
    if (!hdlr || ascii(moov, hdlr.start + hdlr.hdr + 8) !== 'soun') continue;
    const mdhd = child(moov, mdia, 'mdhd');
    const stbl = child(moov, child(moov, mdia, 'minf') || { start: 0, hdr: 0, end: 0 }, 'stbl');
    const stsd = stbl && child(moov, stbl, 'stsd');
    if (!mdhd || !stsd) continue;
    const timescale = dv.getUint32(mdhd.start + mdhd.hdr + (moov[mdhd.start + mdhd.hdr] === 1 ? 20 : 12));

    // sample description: channels, rate, esds
    const entry = [...boxes(moov, stsd.start + stsd.hdr + 8, stsd.end)][0];
    if (!entry || entry.type !== 'mp4a') continue; // AAC / MP3 in MP4 only
    const ver = dv.getUint16(entry.start + 16);
    const channels = dv.getUint16(entry.start + 24);
    let sampleRate = dv.getUint16(entry.start + 32);
    const esds = child(moov, { start: entry.start, hdr: 36 + (ver === 1 ? 16 : 0), end: entry.end }, 'esds');
    const info = esds && parseEsds(moov, esds);
    const codec = info && codecString(info);
    if (!codec) continue;
    if (info.asc && info.asc.length >= 2 && !sampleRate) { // rate from the AudioSpecificConfig when the entry says 0
      const rates = [96000, 88200, 64000, 48000, 44100, 32000, 24000, 22050, 16000, 12000, 11025, 8000, 7350];
      sampleRate = rates[((info.asc[0] & 7) << 1) | (info.asc[1] >> 7)] || 44100;
    }

    // sample tables
    const full = (type) => { const b = child(moov, stbl, type); return b && { b, p: b.start + b.hdr + 4 }; }; // after version+flags
    const stsz = full('stsz'), stsc = full('stsc'), stts = full('stts'), co = full('stco') || full('co64');
    if (!stsz || !stsc || !stts || !co) continue;
    const wide = co.b.type === 'co64';

    const fixed = dv.getUint32(stsz.p);
    const count = dv.getUint32(stsz.p + 4);
    const sizes = new Uint32Array(count);
    for (let i = 0; i < count; i++) sizes[i] = fixed || dv.getUint32(stsz.p + 8 + i * 4);

    const nChunks = dv.getUint32(co.p);
    const chunkOff = (c) => (wide ? Number(dv.getBigUint64(co.p + 4 + c * 8)) : dv.getUint32(co.p + 4 + c * 4));
    const nRuns = dv.getUint32(stsc.p);
    const offsets = new Float64Array(count);
    let s = 0;
    for (let r = 0; r < nRuns && s < count; r++) {
      const first = dv.getUint32(stsc.p + 4 + r * 12) - 1;
      const per = dv.getUint32(stsc.p + 4 + r * 12 + 4);
      const last = r + 1 < nRuns ? dv.getUint32(stsc.p + 4 + (r + 1) * 12) - 1 : nChunks;
      for (let c = first; c < last && c < nChunks && s < count; c++) {
        let off = chunkOff(c);
        for (let k = 0; k < per && s < count; k++) { offsets[s] = off; off += sizes[s]; s++; }
      }
    }

    const times = new Float64Array(count);
    const nT = dv.getUint32(stts.p);
    let i = 0, t = 0;
    for (let e = 0; e < nT && i < count; e++) {
      const n = dv.getUint32(stts.p + 4 + e * 8), d = dv.getUint32(stts.p + 4 + e * 8 + 4);
      for (let k = 0; k < n && i < count; k++) { times[i++] = t / timescale; t += d; }
    }
    return { codec, sampleRate, channels, description: info.asc, count, offsets, sizes, times, duration: t / timescale };
  }
  return null;
}

/** First sample index whose time is >= sec. */
export function sampleAt(times, sec) {
  let lo = 0, hi = times.length;
  while (lo < hi) { const mid = (lo + hi) >> 1; if (times[mid] < sec) lo = mid + 1; else hi = mid; }
  return lo;
}

/**
 * Average-and-interpolate resampling to 16 kHz (speech only needs 8 kHz of bandwidth; averaging
 * over the step acts as the low-pass filter).
 * @param {Float32Array} x mono samples  @param {number} rate source sample rate
 */
export function resampleTo16k(x, rate) {
  if (rate === 16000) return x;
  const ratio = rate / 16000;
  const n = Math.floor(x.length / ratio);
  const out = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const a = i * ratio, b = a + ratio;
    const i0 = Math.floor(a), i1 = Math.min(x.length, Math.ceil(b));
    let sum = 0, w = 0;
    for (let k = i0; k < i1; k++) {
      const wt = Math.min(b, k + 1) - Math.max(a, k);
      sum += x[k] * wt;
      w += wt;
    }
    out[i] = w ? sum / w : 0;
  }
  return out;
}
