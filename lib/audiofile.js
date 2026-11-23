/**
 * Open the audio of a video / audio file as a 16 kHz mono sample source, WITHOUT decoding the whole file:
 *   { length, slice(a, b) -> Promise<Float32Array> }   (a, b are sample positions at 16 kHz)
 * so a 12-hour lecture is transcribed a few minutes at a time, at CPU speed (not playback speed), with
 * memory use that does not grow with the length of the video.
 *
 *   MP4 / M4A (AAC)  sample table read from the header, audio bytes fetched by offset, decoded with WebCodecs
 *   WAV (PCM)        samples read straight from the file
 *   anything else    decoded whole with decodeAudioData (fine up to roughly 1 GB)
 */
import { parseMp4Audio, sampleAt, resampleTo16k } from './mp4audio.js';
import { decodeMono16k } from './asr.js';

const SR = 16000;
const blobReader = (blob) => async (a, b) => new Uint8Array(await blob.slice(a, b).arrayBuffer());

/** Decode AAC / MP3 samples [first, last) of an MP4 track to 16 kHz mono. */
async function decodeMp4Range(blob, tr, first, last) {
  // a few frames before the range prime the decoder (AAC frames overlap); their output is dropped
  const prime = Math.min(first, 3);
  const from = first - prime;
  const parts = [];
  let failure = null;
  const out = [];
  const dec = new AudioDecoder({
    output: (ad) => {
      const n = ad.numberOfFrames, ch = ad.numberOfChannels;
      const mono = new Float32Array(n);
      const tmp = new Float32Array(n);
      for (let c = 0; c < ch; c++) {
        ad.copyTo(tmp, { planeIndex: c, format: 'f32-planar' });
        for (let i = 0; i < n; i++) mono[i] += tmp[i] / ch;
      }
      out.push({ mono, rate: ad.sampleRate, ts: ad.timestamp });
      ad.close();
    },
    error: (e) => { failure = e; }
  });
  dec.configure({ codec: tr.codec, sampleRate: tr.sampleRate, numberOfChannels: tr.channels, ...(tr.description ? { description: tr.description } : {}) });

  // fetch the sample bytes: contiguous samples are one read
  const read = blobReader(blob);
  const jobs = [];
  for (let i = from; i < last;) {
    let j = i + 1;
    while (j < last && tr.offsets[j] === tr.offsets[j - 1] + tr.sizes[j - 1]) j++;
    jobs.push({ i, j, start: tr.offsets[i], end: tr.offsets[j - 1] + tr.sizes[j - 1] });
    i = j;
  }
  const bytes = new Array(jobs.length);
  for (let k = 0; k < jobs.length; k += 24) {
    await Promise.all(jobs.slice(k, k + 24).map(async (jb, q) => { bytes[k + q] = await read(jb.start, jb.end); }));
  }
  for (let k = 0; k < jobs.length; k++) {
    const { i, j } = jobs[k];
    let p = 0;
    for (let s = i; s < j; s++) {
      dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: Math.round(tr.times[s] * 1e6), data: bytes[k].subarray(p, p + tr.sizes[s]) }));
      p += tr.sizes[s];
    }
    if (dec.decodeQueueSize > 400) await dec.flush(); // keep the queue small
    bytes[k] = null;
  }
  await dec.flush();
  dec.close();
  if (failure) throw new Error(`Could not decode the audio (${failure.message}).`);
  const startTs = Math.round(tr.times[first] * 1e6) - 1000;
  for (const o of out) if (o.ts >= startTs) parts.push(resampleTo16k(o.mono, o.rate));
  const total = parts.reduce((n, p) => n + p.length, 0);
  const res = new Float32Array(total);
  let at = 0;
  for (const p of parts) { res.set(p, at); at += p.length; }
  return res;
}

/** @returns {Promise<null | {length:number, slice:(a:number,b:number)=>Promise<Float32Array>}>} */
async function openMp4(blob) {
  if (typeof AudioDecoder === 'undefined') return null;
  const tr = await parseMp4Audio(blobReader(blob), blob.size);
  if (!tr || !tr.count) return null;
  const sup = await AudioDecoder.isConfigSupported({ codec: tr.codec, sampleRate: tr.sampleRate, numberOfChannels: tr.channels, ...(tr.description ? { description: tr.description } : {}) }).catch(() => null);
  if (!sup?.supported) return null;
  return {
    length: Math.floor(tr.duration * SR),
    async slice(a, b) {
      const first = sampleAt(tr.times, a / SR), last = Math.min(tr.count, sampleAt(tr.times, b / SR));
      return first >= last ? new Float32Array(0) : decodeMp4Range(blob, tr, first, last);
    }
  };
}

/** PCM WAV: find the fmt and data chunks, then read samples by offset. */
async function openWav(blob) {
  const head = new Uint8Array(await blob.slice(0, 4096).arrayBuffer());
  const dv = new DataView(head.buffer);
  const tag = (p) => String.fromCharCode(head[p], head[p + 1], head[p + 2], head[p + 3]);
  if (head.length < 44 || tag(0) !== 'RIFF' || tag(8) !== 'WAVE') return null;
  let p = 12, fmt = null, data = null;
  while (p + 8 <= head.length) {
    const id = tag(p), len = dv.getUint32(p + 4);
    if (id === 'fmt ') fmt = { format: dv.getUint16(p + 8), ch: dv.getUint16(p + 10), rate: dv.getUint32(p + 12), bits: dv.getUint16(p + 22) };
    if (id === 'data') { data = { at: p + 8, len: Math.min(len, blob.size - (p + 8)) }; break; }
    p += 8 + len + (len & 1);
  }
  if (!fmt || !data || fmt.format !== 1 || fmt.bits !== 16) return null;
  const frame = fmt.ch * 2;
  const frames = Math.floor(data.len / frame);
  return {
    length: Math.floor((frames / fmt.rate) * SR),
    async slice(a, b) {
      const f0 = Math.floor((a / SR) * fmt.rate), f1 = Math.min(frames, Math.ceil((b / SR) * fmt.rate));
      if (f1 <= f0) return new Float32Array(0);
      const buf = await blob.slice(data.at + f0 * frame, data.at + f1 * frame).arrayBuffer();
      const v = new DataView(buf);
      const mono = new Float32Array(f1 - f0);
      for (let i = 0; i < mono.length; i++) {
        let s = 0;
        for (let c = 0; c < fmt.ch; c++) s += v.getInt16((i * fmt.ch + c) * 2, true);
        mono[i] = s / fmt.ch / 32768;
      }
      return resampleTo16k(mono, fmt.rate);
    }
  };
}

/**
 * @param {Blob} blob
 * @param {Function} progress
 * @param {{maxWholeBytes?:number}} [o] refuse the whole-file decode above this size (caller has a fallback)
 */
export async function openAudioSource(blob, progress, o = {}) {
  progress('transcribe', null, 'Opening the audio');
  try {
    const s = (await openMp4(blob)) || (await openWav(blob));
    if (s) return s;
  } catch (e) {
    console.warn('[Vid2Study] streaming audio failed, decoding the whole file instead:', e?.message);
  }
  if (o.maxWholeBytes && blob.size > o.maxWholeBytes) {
    const err = new Error(`the ${Math.round(blob.size / 1048576)} MB audio cannot be read in pieces and is too big to decode at once`);
    err.code = 'TOO_BIG';
    throw err;
  }
  progress('transcribe', null, 'Reading the whole audio track (large files may fail; use captions)');
  const f32 = await decodeMono16k(blob);
  return { length: f32.length, slice: async (a, b) => f32.subarray(a, b) };
}
