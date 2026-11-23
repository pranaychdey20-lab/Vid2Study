/**
 * Generic adapter: any page. Finds <video>/<source> files, resource-timing media, YouTube embeds
 * and unreadable streams (blob:, HLS/DASH). Registered last so site adapters win.
 * Classic script; registers itself in window.__lhAdapters.
 */
(() => {
  const U = window.__lhUtil;

  window.__lhAdapters.push({
    id: 'generic',
    match: () => true,
    refererFor: (url) => `${location.origin}/`, // the page that embeds the video
    getContext: () => ({ course: location.hostname.replace(/^www\./, '') }),
    getTitle(src) {
      return src.title || U.text(document.querySelector('h1')) || document.title || U.fileBase(src.url);
    },
    getVideos() {
      const out = new Map();
      const add = (r) => { if (r.id && !out.has(r.id)) out.set(r.id, { tracks: [], title: '', ...r }); };
      for (const v of document.querySelectorAll('video')) {
        const label = v.getAttribute('aria-label') || v.title || '';
        const tracks = U.tracksOf(v);
        const srcs = [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)].filter(Boolean);
        const file = srcs.find(U.isFile);
        if (file) add({ id: U.cleanUrl(file), kind: 'file', url: U.cleanUrl(file), title: label, tracks });
        else if (srcs.length || tracks.length) {
          const s = srcs[0] || location.href;
          add({ id: `stream:${U.cleanUrl(s)}`, kind: 'stream', url: s, title: label, tracks, pageKey: `text:${U.cleanUrl(location.href)}` });
        }
      }
      for (const f of document.querySelectorAll('iframe[src]')) {
        const id = U.ytId(f.src);
        if (id) add({ id: `yt:${id}`, kind: 'youtube', url: `https://www.youtube.com/watch?v=${id}`, youtubeId: id, title: f.title || '', embed: true });
      }
      for (const e of performance.getEntriesByType('resource')) {
        if (U.isFile(e.name)) add({ id: U.cleanUrl(e.name), kind: 'file', url: U.cleanUrl(e.name), title: '' });
        else if (U.isStream(e.name)) add({ id: `stream:${U.cleanUrl(e.name)}`, kind: 'stream', url: e.name, title: '', pageKey: `text:${U.cleanUrl(location.href)}` });
      }
      return [...out.values()];
    }
  });
})();
