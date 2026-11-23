/**
 * HLS (.m3u8) and DASH (.mpd) download (ES module). A manifest is turned into a list of byte requests
 * (init segment + media segments), which are fetched in parallel (bounded) and written in order to a spool,
 * giving a plain fragmented-MP4 / WebM file the rest of the pipeline can read like any other download.
 *
 * Supported: HLS with fMP4 segments (EXT-X-MAP) and byte ranges; DASH (static, first Period) with
 * SegmentTemplate ($Number$/$Time$, SegmentTimeline), SegmentList and a single-file BaseURL.
 * Not supported (reported with a clear error): MPEG-TS HLS (Chrome cannot play or decode it from a file),
 * encrypted streams (AES-128 / DRM), live streams.
 */
import { createSpool } from './spool.js';

export const isManifestUrl = (u) => /\.(m3u8|mpd)(\?|#|$)/i.test(String(u || ''));
const abs = (rel, base) => new URL(rel, base).href;

// ---------- HLS ----------
const attrs = (s) => {
  const o = {};
  for (const m of s.matchAll(/([A-Z0-9-]+)=("([^"]*)"|[^,]*)/g)) o[m[1]] = m[3] ?? m[2];
  return o;
};
const rangeOf = (s, prevEnd) => {
  const [len, off] = String(s).split('@');
  const offset = off != null ? Number(off) : prevEnd;
  return { offset, length: Number(len) };
};

/**
 * Parse a playlist. Master -> { type:'master', variants:[{url,bandwidth,height,audio}], audio:{group:[{url,def}]} }
 * Media -> { type:'media', init, segments:[{url,range?}], encrypted, ts, live }
 */
export function parseHls(text, baseUrl) {
  const lines = String(text).split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  if (lines[0] !== '#EXTM3U') throw new Error('Not an HLS playlist.');
  if (lines.some((l) => l.startsWith('#EXT-X-STREAM-INF'))) {
    const variants = [], audio = {};
    for (let i = 0; i < lines.length; i++) {
      const l = lines[i];
      if (l.startsWith('#EXT-X-STREAM-INF:')) {
        const a = attrs(l.slice(18));
        const next = lines[i + 1];
        if (next && !next.startsWith('#')) {
          variants.push({ url: abs(next, baseUrl), bandwidth: Number(a.BANDWIDTH) || 0, height: Number((a.RESOLUTION || '').split('x')[1]) || 0, audio: a.AUDIO || null });
        }
      } else if (l.startsWith('#EXT-X-MEDIA:')) {
        const a = attrs(l.slice(13));
        if (a.TYPE === 'AUDIO' && a.URI) (audio[a['GROUP-ID']] ||= []).push({ url: abs(a.URI, baseUrl), def: a.DEFAULT === 'YES' });
      }
    }
    return { type: 'master', variants, audio };
  }
  let init = null, encrypted = false, live = true, prevEnd = 0, pendingRange = null;
  const segments = [];
  for (const l of lines) {
    if (l.startsWith('#EXT-X-MAP:')) {
      const a = attrs(l.slice(11));
      init = { url: abs(a.URI, baseUrl), ...(a.BYTERANGE ? { range: rangeOf(a.BYTERANGE, 0) } : {}) };
    } else if (l.startsWith('#EXT-X-KEY:')) {
      if (attrs(l.slice(11)).METHOD !== 'NONE') encrypted = true;
    } else if (l.startsWith('#EXT-X-BYTERANGE:')) {
      pendingRange = rangeOf(l.slice(17), prevEnd);
    } else if (l === '#EXT-X-ENDLIST') {
      live = false;
    } else if (!l.startsWith('#')) {
      const seg = { url: abs(l, baseUrl) };
      if (pendingRange) { seg.range = pendingRange; prevEnd = pendingRange.offset + pendingRange.length; pendingRange = null; }
      segments.push(seg);
    }
  }
  const ts = !init && segments.length > 0 && !/\.(m4s|mp4|m4a|m4v|cmfa|cmfv|webm)(\?|#|$)/i.test(segments[0].url);
  return { type: 'media', init, segments, encrypted, ts, live };
}

// ---------- DASH ----------
const secs = (iso) => {
  const m = /^P(?:(\d+)D)?T?(?:(\d+(?:\.\d+)?)H)?(?:(\d+(?:\.\d+)?)M)?(?:(\d+(?:\.\d+)?)S)?$/.exec(iso || '');
  return m ? (+(m[1] || 0)) * 86400 + (+(m[2] || 0)) * 3600 + (+(m[3] || 0)) * 60 + (+(m[4] || 0)) : 0;
};
const fill = (tpl, v) => tpl.replace(/\$(RepresentationID|Number|Bandwidth|Time)(?:%0(\d+)d)?\$/g, (_, k, w) => {
  const s = String(v[k] ?? '');
  return w ? s.padStart(Number(w), '0') : s;
}).replace(/\$\$/g, '$');
const child = (el, name) => [...el.children].find((c) => c.localName === name) || null;
const kids = (el, name) => [...el.children].filter((c) => c.localName === name);

/** The first of `el`, its parents (up to the Period) that carries `name`. */
const inherit = (chain, name) => chain.map((e) => child(e, name)).find(Boolean) || null;

function representationPlan(rep, aset, period, mpdBase, totalSec) {
  const chain = [rep, aset, period];
  const baseOf = (el) => child(el, 'BaseURL')?.textContent.trim();
  let base = mpdBase;
  for (const el of [period, aset, rep]) { const b = baseOf(el); if (b) base = abs(b, base); }
  const vars = { RepresentationID: rep.getAttribute('id'), Bandwidth: rep.getAttribute('bandwidth') };
  const tpl = inherit(chain, 'SegmentTemplate');
  const list = inherit(chain, 'SegmentList');
  let init = null;
  const segments = [];
  if (tpl) {
    const ts = Number(tpl.getAttribute('timescale')) || 1;
    if (tpl.getAttribute('initialization')) init = { url: abs(fill(tpl.getAttribute('initialization'), vars), base) };
    const media = tpl.getAttribute('media');
    const timeline = child(tpl, 'SegmentTimeline');
    let n = Number(tpl.getAttribute('startNumber') ?? 1);
    if (timeline) {
      let t = 0;
      for (const s of kids(timeline, 'S')) {
        if (s.getAttribute('t') != null) t = Number(s.getAttribute('t'));
        const d = Number(s.getAttribute('d'));
        for (let r = 0; r <= (Number(s.getAttribute('r')) || 0); r++) {
          segments.push({ url: abs(fill(media, { ...vars, Number: n++, Time: t }), base) });
          t += d;
        }
      }
    } else {
      const d = Number(tpl.getAttribute('duration')) / ts;
      if (!d || !totalSec) throw new Error('The DASH manifest has no segment timeline or duration.');
      const count = Math.ceil(totalSec / d);
      for (let i = 0; i < count; i++) segments.push({ url: abs(fill(media, { ...vars, Number: n + i, Time: i * d * ts }), base) });
    }
  } else if (list) {
    const i = child(list, 'Initialization');
    if (i) init = { url: abs(i.getAttribute('sourceURL'), base) };
    for (const s of kids(list, 'SegmentURL')) segments.push({ url: abs(s.getAttribute('media'), base) });
  } else {
    // one file for the whole stream (SegmentBase / plain BaseURL): download it as is
    if (!baseOf(rep) && base === mpdBase) throw new Error('The DASH manifest has no media location.');
    segments.push({ url: base });
  }
  return { init, segments, mime: rep.getAttribute('mimeType') || aset.getAttribute('mimeType') || '', codecs: rep.getAttribute('codecs') || aset.getAttribute('codecs') || '' };
}

/**
 * Pick one audio and one video representation from a DASH manifest (DOM needed: DOMParser).
 * Audio = smallest bandwidth, video = smallest height (slides only need a small picture).
 * @returns {{audio: object|null, video: object|null}} each { init, segments, mime }
 */
export function parseMpd(text, baseUrl) {
  const doc = new DOMParser().parseFromString(text, 'application/xml');
  const mpd = doc.documentElement;
  if (!mpd || mpd.localName !== 'MPD' || doc.querySelector('parsererror')) throw new Error('Not a DASH manifest.');
  if (mpd.getAttribute('type') === 'dynamic') throw new Error('Live DASH streams cannot be downloaded.');
  if (doc.querySelector('ContentProtection')) throw new Error('This stream is DRM-protected and cannot be downloaded.');
  let base = baseUrl;
  const top = child(mpd, 'BaseURL')?.textContent.trim();
  if (top) base = abs(top, base);
  const period = kids(mpd, 'Period')[0];
  if (!period) throw new Error('The DASH manifest has no Period.');
  const total = secs(period.getAttribute('duration')) || secs(mpd.getAttribute('mediaPresentationDuration'));
  const pick = (kind, key, smallest) => {
    const reps = [];
    for (const a of kids(period, 'AdaptationSet')) {
      const mime = a.getAttribute('mimeType') || a.getAttribute('contentType') || '';
      for (const r of kids(a, 'Representation')) {
        const m = r.getAttribute('mimeType') || mime;
        if (m.startsWith(kind) || a.getAttribute('contentType') === kind) reps.push({ r, a, v: Number(r.getAttribute(key)) || 0 });
      }
    }
    if (!reps.length) return null;
    reps.sort((x, y) => (smallest ? x.v - y.v : y.v - x.v));
    const best = reps.find((x) => x.v > 0) || reps[0];
    return representationPlan(best.r, best.a, period, base, total);
  };
  return { audio: pick('audio', 'bandwidth', true), video: pick('video', 'height', true) };
}

// ---------- downloading ----------
async function fetchPart(req, signal) {
  for (let attempt = 0; ; attempt++) {
    try {
      const headers = req.range ? { Range: `bytes=${req.range.offset}-${req.range.offset + req.range.length - 1}` } : undefined;
      const res = await fetch(req.url, { signal, credentials: 'omit', cache: 'no-store', headers });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      if (/text\/html/i.test(res.headers.get('content-type') || '')) throw new Error('got a web page (expired or blocked)');
      return new Uint8Array(await res.arrayBuffer());
    } catch (e) {
      if (signal?.aborted || e?.name === 'AbortError' || attempt >= 2) throw e;
      await new Promise((r) => setTimeout(r, 400 * (attempt + 1)));
    }
  }
}

/**
 * Fetch `parts` (init first) with up to `concurrency` requests in flight and append them IN ORDER to a spool.
 * @param {{url:string, range?:{offset:number,length:number}}[]} parts
 * @returns {Promise<Blob>}
 */
export async function downloadParts(parts, { signal, onProgress, type = '', name = 'stream', concurrency = 6 }) {
  const spool = createSpool(name);
  const inflight = new Map();
  let next = 0;
  const launch = () => { while (next < parts.length && inflight.size < concurrency) { const i = next++; inflight.set(i, fetchPart(parts[i], signal)); } };
  try {
    launch();
    for (let i = 0; i < parts.length; i++) {
      await spool.write(await inflight.get(i));
      inflight.delete(i);
      onProgress?.(i + 1, parts.length, spool.size);
      launch();
    }
    return await spool.finish(type);
  } catch (e) {
    for (const p of inflight.values()) p.catch(() => {});
    await spool.abort();
    throw e;
  }
}

const textOf = async (url, signal) => {
  const res = await fetch(url, { signal, credentials: 'omit', cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.text();
};

async function hlsMedia(url, signal) {
  const pl = parseHls(await textOf(url, signal), url);
  if (pl.type !== 'media') throw new Error('Unexpected HLS master playlist.');
  if (pl.encrypted) throw new Error('This HLS stream is encrypted and cannot be downloaded.');
  if (pl.live) throw new Error('Live streams cannot be downloaded.');
  if (pl.ts) throw new Error('This HLS stream uses MPEG-TS segments, which the browser cannot read from a file. Use "Summarize from a file..." with a downloaded copy.');
  if (!pl.segments.length) throw new Error('The playlist has no segments.');
  return { parts: [...(pl.init ? [pl.init] : []), ...pl.segments], mime: 'video/mp4' };
}

/**
 * Download an HLS or DASH stream.
 * @returns {Promise<{audioBlob:Blob|null, videoBlob:Blob|null}>} when the stream is muxed, both are the same blob
 */
export async function downloadManifest(url, { signal, progress }) {
  progress('fetch', null, 'Reading the stream manifest');
  const text = await textOf(url, signal);
  const track = async (label, plan) => {
    let last = 0;
    return downloadParts(plan.parts, {
      signal, name: label, type: plan.mime,
      onProgress: (i, n, bytes) => {
        if (Date.now() - last < 400 && i < n) return;
        last = Date.now();
        progress('fetch', Math.round((i / n) * 100), `Downloading ${label} segments ${i}/${n} (${(bytes / 1048576).toFixed(0)} MB)`);
      }
    });
  };
  if (/^\s*#EXTM3U/.test(text)) {
    const pl = parseHls(text, url);
    if (pl.type === 'media') {
      const blob = await track('video', await hlsMedia(url, signal));
      return { audioBlob: blob, videoBlob: blob };
    }
    const v = [...pl.variants].sort((a, b) => (a.height || 9999) - (b.height || 9999) || a.bandwidth - b.bandwidth)[0];
    if (!v) throw new Error('The HLS playlist lists no streams.');
    const aud = v.audio && (pl.audio[v.audio] || []).find((a) => a.def) || (v.audio && pl.audio[v.audio]?.[0]);
    const [vp, ap] = await Promise.all([hlsMedia(v.url, signal), aud ? hlsMedia(aud.url, signal) : null]);
    if (!ap) { const blob = await track('video', vp); return { audioBlob: blob, videoBlob: blob }; }
    const [videoBlob, audioBlob] = [await track('video', vp), await track('audio', ap)];
    return { audioBlob, videoBlob };
  }
  const m = parseMpd(text, url);
  if (!m.audio && !m.video) throw new Error('The DASH manifest lists no streams.');
  const plan = (p) => p && { parts: [...(p.init ? [p.init] : []), ...p.segments], mime: p.mime };
  const audioBlob = m.audio ? await track('audio', plan(m.audio)) : null;
  const videoBlob = m.video ? await track('video', plan(m.video)) : null;
  return { audioBlob: audioBlob || videoBlob, videoBlob: videoBlob || null };
}
