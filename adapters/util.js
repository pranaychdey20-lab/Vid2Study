/**
 * Shared helpers for the content script and the site adapters (classic script, loaded first).
 * Adapters register themselves in window.__lhAdapters; content.js picks the first whose match() is true.
 * Adapter shape: { id, match(loc), getVideos(), getTitle(src), getContext(), refererFor(url),
 *                  hasList?(loc), listLectures?(force), capture? }
 * A video record: { id, kind: 'file'|'youtube'|'stream', url, title, tracks: [{src, label}], embed? }
 */
(() => {
  if (window.__lhUtil) return;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  window.__lhAdapters = window.__lhAdapters || [];
  window.__lhUtil = {
    sleep,
    text: (el) => (el?.textContent || '').replace(/\s+/g, ' ').trim(),
    cleanUrl(u) { try { const x = new URL(u, location.href); x.search = ''; x.hash = ''; return x.toString(); } catch { return u; } },
    isFile: (u) => /^https?:/.test(u || '') && /\.(mp4|webm|mov|m4v)(\?|#|$)/i.test(u),
    isStream: (u) => /\.(m3u8|mpd)(\?|#|$)/i.test(u || ''),
    fileBase(u) { try { return decodeURIComponent(new URL(u).pathname.split('/').pop()).replace(/\.\w+$/, ''); } catch { return 'lecture'; } },
    ext(u) { const m = /\.(mp4|webm|mov|m4v)(\?|#|$)/i.exec(u || ''); return m ? m[1].toLowerCase() : 'mp4'; },
    sanitize: (s, fb) => (String(s || '').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/\s+/g, ' ').trim().replace(/^[.\s]+|[.\s]+$/g, '').slice(0, 120)) || fb,
    /** YouTube video id from a watch / shorts / embed / youtu.be URL, or null. */
    ytId(u) {
      try {
        const x = new URL(u, location.href);
        if (/(^|\.)youtu\.be$/.test(x.hostname)) return x.pathname.slice(1, 12) || null;
        if (!/(^|\.)youtube(-nocookie)?\.com$/.test(x.hostname)) return null;
        const v = x.searchParams.get('v');
        if (v) return v;
        const m = /^\/(?:embed|shorts|live)\/([\w-]{11})/.exec(x.pathname);
        return m ? m[1] : null;
      } catch { return null; }
    },
    /**
     * WebVTT / SRT -> compact "[mm:ss] text" lines of about 20 s (fewer tokens than one line per cue).
     * Auto-generated captions repeat each cue inside the next one; only the new words are kept.
     */
    parseCaptions(raw) {
      let cues = [];
      for (const block of String(raw).replace(/\r/g, '').split(/\n\n+/)) {
        const lines = block.split('\n');
        const i = lines.findIndex((l) => l.includes('-->'));
        if (i < 0) continue;
        const m = /(?:(\d+):)?(\d+):(\d+)[.,]\d+/.exec(lines[i]);
        if (!m) continue;
        const sec = (Number(m[1]) || 0) * 3600 + Number(m[2]) * 60 + Number(m[3]);
        const txt = lines.slice(i + 1).join(' ').replace(/<[^>]+>/g, '').replace(/&amp;/g, '&').replace(/&#39;/g, "'").replace(/&quot;/g, '"').replace(/\s+/g, ' ').trim();
        if (txt) cues.push({ sec, txt });
      }
      const dedup = [];
      for (const c of cues) {
        const prev = dedup[dedup.length - 1];
        if (prev) {
          if (c.txt === prev.txt || prev.txt.endsWith(c.txt)) continue;
          if (c.txt.startsWith(prev.txt)) { prev.txt = c.txt; continue; }
          let k = Math.min(prev.txt.length, c.txt.length);
          for (; k > 8; k--) if (prev.txt.endsWith(c.txt.slice(0, k))) break;
          if (k > 8) { prev.txt += c.txt.slice(k); continue; }
        }
        dedup.push({ ...c });
      }
      cues = dedup;
      const out = [];
      let start = -99, buf = [];
      const flush = () => { if (buf.length) out.push(`[${String(Math.floor(start / 60)).padStart(2, '0')}:${String(start % 60).padStart(2, '0')}] ${buf.join(' ')}`); buf = []; };
      for (const c of cues) { if (c.sec - start >= 20) { flush(); start = c.sec; } buf.push(c.txt); }
      flush();
      return out.join('\n');
    },
    /** Captions of a YouTube video from its watch page (best effort; '' when there are none or YouTube refuses). */
    async youtubeCaptions(id) {
      const html = await (await fetch(`https://www.youtube.com/watch?v=${encodeURIComponent(id)}`, { credentials: 'include' })).text();
      const m = /"captionTracks":(\[.*?\}\])/.exec(html);
      if (!m) return '';
      const tracks = JSON.parse(m[1]);
      const en = (t) => /^en/i.test(t.languageCode || '');
      const pick = tracks.find((t) => en(t) && t.kind !== 'asr') || tracks.find(en) || tracks.find((t) => t.kind !== 'asr') || tracks[0];
      if (!pick?.baseUrl) return '';
      const res = await fetch(`${pick.baseUrl}&fmt=vtt`, { credentials: 'include' });
      return res.ok ? window.__lhUtil.parseCaptions(await res.text()) : '';
    },
    /** Caption/subtitle tracks of a <video>. */
    tracksOf: (v) => [...v.querySelectorAll('track')]
      .filter((t) => /captions|subtitles/i.test(t.kind || 'subtitles') && t.src)
      .map((t) => ({ src: t.src, label: t.label || t.srclang || 'captions' })),
    /**
     * Seek a <video> to t, wait for the frame, draw it, return {b64} (PNG) or throw.
     * Used for YouTube pages; refuses blank frames (DRM) and tainted canvases.
     */
    async grabFrame(v, t, maxWidth) {
      await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { v.removeEventListener('seeked', ok); reject(new Error('seek timeout')); }, 10000);
        const ok = () => { clearTimeout(timer); resolve(); };
        v.addEventListener('seeked', ok, { once: true });
        v.currentTime = t;
      });
      await new Promise((r) => { if ('requestVideoFrameCallback' in v) v.requestVideoFrameCallback(() => r()); setTimeout(r, 400); });
      const scale = Math.min(1, maxWidth / v.videoWidth);
      const c = document.createElement('canvas');
      c.width = Math.round(v.videoWidth * scale);
      c.height = Math.round(v.videoHeight * scale);
      const ctx = c.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(v, 0, 0, c.width, c.height);
      const px = ctx.getImageData(0, 0, Math.min(64, c.width), Math.min(36, c.height)).data; // throws if tainted
      let lit = 0;
      for (let i = 0; i < px.length; i += 4) if (px[i] + px[i + 1] + px[i + 2] > 24) lit++;
      if (!lit) throw new Error('blank frame (protected video?)');
      const blob = await new Promise((r) => c.toBlob(r, 'image/png'));
      const buf = new Uint8Array(await blob.arrayBuffer());
      let s = '';
      for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
      return { b64: btoa(s) };
    }
  };
})();
