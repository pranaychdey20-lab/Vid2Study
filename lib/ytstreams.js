/**
 * Find the direct audio / video stream URLs of a YouTube video (ES module, runs in the offscreen page).
 * Content scripts cannot read the page's own `ytInitialPlayerResponse` (isolated world), so the watch page
 * is fetched here and the JSON is parsed out of its HTML, as util.youtubeCaptions does for captions.
 * When YouTube only offers encrypted (signatureCipher) streams, nothing usable is returned and `reason`
 * says why, so the caller can log it and listen to the page player instead.
 */

/** The `ytInitialPlayerResponse = {...};` object inside a watch page's HTML, or null. */
export function extractPlayerResponse(html) {
  const m = /ytInitialPlayerResponse\s*=\s*/.exec(String(html));
  if (!m) return null;
  const start = m.index + m[0].length;
  if (html[start] !== '{') return null;
  let depth = 0, inStr = false, esc = false;
  for (let i = start; i < html.length; i++) {
    const c = html[i];
    if (inStr) {
      if (esc) esc = false; else if (c === '\\') esc = true; else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === '{') depth++;
    else if (c === '}' && --depth === 0) {
      try { return JSON.parse(html.slice(start, i + 1)); } catch { return null; }
    }
  }
  return null;
}

/**
 * Choose one audio stream (best mp4 audio) and one small video stream (lowest height >= 360, no AV1: the
 * slides need little resolution) from a player response.
 * @returns {{audioUrl:string|null, videoUrl:string|null, reason:string}} reason is '' when audioUrl is set
 */
export function pickStreams(pr) {
  const none = (reason) => ({ audioUrl: null, videoUrl: null, reason });
  if (!pr) return none('no player data in the page');
  const status = pr.playabilityStatus?.status;
  if (status && status !== 'OK') return none(`YouTube says the video is not playable (${status}${pr.playabilityStatus.reason ? `: ${pr.playabilityStatus.reason}` : ''})`);
  const fmts = pr.streamingData?.adaptiveFormats;
  if (!Array.isArray(fmts) || !fmts.length) return none('YouTube returned no stream list');
  const audioAll = fmts.filter((f) => /^audio\//.test(f?.mimeType || ''));
  const plain = audioAll.filter((f) => f.url);
  if (!plain.length) return none(audioAll.some((f) => f.signatureCipher || f.cipher) ? 'the streams are encrypted (signatureCipher)' : 'no audio stream in the list');
  const byBitrate = (a, b) => (b.bitrate || 0) - (a.bitrate || 0);
  const audio = plain.filter((f) => /mp4/.test(f.mimeType)).sort(byBitrate)[0] || [...plain].sort(byBitrate)[0];
  const videoAll = fmts.filter((f) => f?.url && /^video\//.test(f.mimeType || '') && !/av01/.test(f.mimeType));
  const byHeight = (a, b) => (a.height || 9999) - (b.height || 9999) || (a.bitrate || 0) - (b.bitrate || 0);
  const video = videoAll.filter((f) => (f.height || 0) >= 360).sort(byHeight)[0] || [...videoAll].sort(byHeight)[0] || null;
  return { audioUrl: audio.url, videoUrl: video?.url || null, reason: '' };
}

const withTimeout = (signal, ms) => {
  const t = typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : null;
  if (signal && t && AbortSignal.any) return AbortSignal.any([signal, t]);
  return signal || t || undefined;
};

/**
 * @param {string} videoId
 * @param {AbortSignal} [signal]
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<{audioUrl:string|null, videoUrl:string|null, reason:string, via:string}>}
 */
export async function resolveYoutubeStreams(videoId, signal, fetchFn = fetch) {
  const id = encodeURIComponent(videoId);
  const reasons = [];
  // 1. the watch page (same data the player uses)
  try {
    const res = await fetchFn(`https://www.youtube.com/watch?v=${id}`, { credentials: 'include', signal: withTimeout(signal, 15000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const got = pickStreams(extractPlayerResponse(await res.text()));
    if (got.audioUrl) return { ...got, via: 'watch page' };
    reasons.push(`watch page: ${got.reason}`);
  } catch (e) {
    if (signal?.aborted) throw e;
    reasons.push(`watch page: ${e.message}`);
  }
  // 2. the app (ANDROID) player endpoint, which more often returns plain URLs
  try {
    const res = await fetchFn('https://www.youtube.com/youtubei/v1/player?prettyPrint=false', {
      method: 'POST',
      credentials: 'omit',
      signal: withTimeout(signal, 15000),
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ videoId, contentCheckOk: true, racyCheckOk: true, context: { client: { clientName: 'ANDROID', clientVersion: '20.10.38', androidSdkVersion: 30, hl: 'en', gl: 'US' } } })
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const got = pickStreams(await res.json());
    if (got.audioUrl) return { ...got, via: 'app player endpoint' };
    reasons.push(`app endpoint: ${got.reason}`);
  } catch (e) {
    if (signal?.aborted) throw e;
    reasons.push(`app endpoint: ${e.message}`);
  }
  return { audioUrl: null, videoUrl: null, reason: reasons.join('; '), via: '' };
}
