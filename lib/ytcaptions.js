/**
 * YouTube captions without listening (ES module, no DOM at load; also imported by bridge/youtube.mjs in Node).
 *
 * Since 2026 YouTube's caption files need a proof-of-origin token ("pot") that only its own player makes, so a
 * plain fetch of the caption URL returns an empty body. `pagePlayerCaptions` runs IN THE PAGE (MAIN world, via
 * chrome.scripting) next to the real player: it lets the player load the captions itself (turning them on for a
 * moment if needed, then back off) and keeps the reply, token and all. `json3ToLines` turns YouTube's json3
 * caption format into the extension's "[mm:ss] text" lines.
 */

/** mm:ss (minutes may pass 59, like parseCaptions; parseTimestamped reads both). */
const stamp = (sec) => `[${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}]`;

/**
 * YouTube json3 captions -> "[mm:ss] text" lines of about `every` seconds (fewer, fuller lines = fewer tokens).
 * Events without words (window setup, bare line breaks) are skipped; auto captions in json3 do not repeat
 * themselves the way their VTT export does. Pure.
 * @param {object|string} j  parsed json3 (or its text)
 */
export function json3ToLines(j, every = 20) {
  if (typeof j === 'string') { try { j = JSON.parse(j); } catch { return ''; } }
  const cues = [];
  for (const e of j?.events || []) {
    if (!Array.isArray(e.segs)) continue;
    const txt = e.segs.map((s) => s.utf8 || '').join('').replace(/\s+/g, ' ').trim();
    if (!txt || txt === '[Music]' && cues.at(-1)?.txt === '[Music]') continue;
    cues.push({ sec: Math.floor((Number(e.tStartMs) || 0) / 1000), txt });
  }
  const out = [];
  let start = -999, buf = [];
  const flush = () => { if (buf.length) out.push(`${stamp(start)} ${buf.join(' ')}`); buf = []; };
  for (const c of cues) { if (c.sec - start >= every) { flush(); start = c.sec; } buf.push(c.txt); }
  flush();
  return out.join('\n');
}

/**
 * Which caption track to use: hand-made English, else auto English, else any hand-made track (the writer
 * translates), else the first (usually the auto track in the spoken language). Pure.
 * @param {{languageCode?:string, kind?:string}[]} tracks
 */
export function pickTrack(tracks) {
  const en = (t) => /^en/i.test(t?.languageCode || '');
  const asr = (t) => t?.kind === 'asr';
  return tracks.find((t) => en(t) && !asr(t)) || tracks.find(en) || tracks.find((t) => !asr(t)) || tracks[0] || null;
}

/**
 * Runs in the YouTube page's MAIN world (chrome.scripting.executeScript, world 'MAIN'), so it must be fully
 * self-contained: no imports, no outer variables. Returns { json, lang, kind, via } or { error }.
 * 1. If the player already loaded captions for this video (the viewer has CC on), fetch that same URL again
 *    as json3 (it already carries the player's token).
 * 2. Else listen to the page's own requests, turn captions on in the player for the chosen track, keep the
 *    caption reply the player receives, then put the captions back the way they were.
 */
export async function pagePlayerCaptions(videoId, waitMs = 8000) {
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const isCap = (u) => typeof u === 'string' && u.includes('/api/timedtext') && u.includes(videoId);
  const asJson3 = async (url) => {
    const u = new URL(url, location.href);
    u.searchParams.set('fmt', 'json3');
    const r = await fetch(u.toString(), { credentials: 'include' });
    const t = r.ok ? await r.text() : '';
    return t.trim().startsWith('{') ? t : '';
  };
  const p = document.getElementById('movie_player');
  if (!p || typeof p.getPlayerResponse !== 'function') return { error: 'the YouTube player was not found on the page' };
  const vd = p.getVideoData?.() || {};
  if (vd.video_id && vd.video_id !== videoId) return { error: 'the page is showing another video' };
  const tracks = p.getPlayerResponse()?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
  if (!tracks.length) return { error: 'this video has no captions' };

  // 1. captions already loaded by the player (with its token)
  const seen = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => isCap(u) && /[?&]pot=/.test(u));
  if (seen.length) {
    try { const json = await asJson3(seen[seen.length - 1]); if (json) return { json, via: 'already loaded' }; } catch { /* try the player */ }
  }

  // 2. let the player load them, and keep what it receives
  let body = '', url = '';
  const keep = (u, text) => { if (isCap(u) && !body && text && text.trim()) { url = u; body = text; } };
  const origFetch = window.fetch;
  const origOpen = XMLHttpRequest.prototype.open;
  window.fetch = function (input, init) {
    const u = typeof input === 'string' ? input : input?.url;
    const res = origFetch.call(this, input, init);
    if (isCap(u)) res.then((r) => r.clone().text()).then((t) => keep(u, t)).catch(() => {});
    return res;
  };
  XMLHttpRequest.prototype.open = function (method, u, ...rest) {
    if (isCap(String(u))) this.addEventListener('load', () => { try { keep(String(u), this.responseText); } catch { /* binary reply */ } });
    return origOpen.call(this, method, u, ...rest);
  };
  const before = (() => { try { return p.getOption?.('captions', 'track') || null; } catch { return null; } })();
  let chosen = null;
  try {
    p.loadModule?.('captions');
    let list = [];
    for (let i = 0; i < 20 && !list.length; i++) { try { list = p.getOption?.('captions', 'tracklist') || []; } catch { list = []; } if (!list.length) await sleep(100); }
    const en = (t) => /^en/i.test(t?.languageCode || '');
    const asr = (t) => t?.kind === 'asr';
    const pool = list.length ? list : tracks;
    chosen = pool.find((t) => en(t) && !asr(t)) || pool.find(en) || pool.find((t) => !asr(t)) || pool[0];
    p.setOption?.('captions', 'track', list.length ? chosen : { languageCode: chosen.languageCode });
    for (let waited = 0; waited < waitMs && !body; waited += 150) await sleep(150);
  } finally {
    window.fetch = origFetch;
    XMLHttpRequest.prototype.open = origOpen;
    // put the viewer's captions back as they were (off, or their own track)
    try {
      if (before && before.languageCode) p.setOption?.('captions', 'track', before);
      else { p.setOption?.('captions', 'track', {}); p.unloadModule?.('captions'); }
    } catch { /* the player API changed: captions may stay on */ }
  }
  if (!body && !url) {
    const late = performance.getEntriesByType('resource').map((e) => e.name).filter((u) => isCap(u) && /[?&]pot=/.test(u));
    if (late.length) url = late[late.length - 1];
  }
  if (!body && !url) return { error: 'the player did not load any captions' };
  let json = body.trim().startsWith('{') ? body : '';
  if (!json && url) { try { json = await asJson3(url); } catch { json = ''; } }
  if (!json) return { error: 'the caption reply was empty or not json3' };
  return { json, lang: chosen?.languageCode || '', kind: chosen?.kind || '', via: 'player' };
}
