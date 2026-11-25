/**
 * IITG LMS adapter (elearn.iitg.ac.in): course API lecture list, DOM title guesses, CDN Referer.
 * Classic script; registers itself in window.__lhAdapters (see util.js).
 */
(() => {
  const U = window.__lhUtil;
  const CDN = 'https://media-content-iitglms.b-cdn.net/';
  const COURSE_RE = /\/sessions\/([^/]+)\/courses\/([^/?#]+)/;

  /** "mm:ss", "hh:mm:ss" or seconds (number/string) -> display string, or ''. */
  function fmtDuration(d) {
    if (d == null || d === '') return '';
    if (typeof d === 'string' && d.includes(':')) return d;
    const s = Math.round(Number(d));
    if (!Number.isFinite(s) || s <= 0) return '';
    const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), p = (n) => String(n).padStart(2, '0');
    return h ? `${h}:${p(m)}:${p(s % 60)}` : `${p(m)}:${p(s % 60)}`;
  }

  /**
   * Parse the course API response into a flat, ordered lecture list.
   * Only lessons with an .mp4 file key are kept; the key is used verbatim (it may contain typos).
   * @param {object} json
   * @returns {{name:string, lectures:Array<{url:string,title:string,duration:string,module:string,chapter:string,filename:string}>}}
   */
  function parseCourse(json) {
    const name = json?.name || json?.title || 'Course';
    const lectures = [];
    for (const mod of json?.modules?.length ? json.modules : [{ lessons: json?.lessons }]) {
      const modName = mod.title || mod.name || 'Module';
      let n = 0;
      for (const ch of mod.chapters?.length ? mod.chapters : [{ lessons: mod.lessons }]) {
        const chName = ch.title || ch.name || '';
        for (const ls of ch.lessons || []) {
          const key = ls?.file?.key;
          if (typeof key !== 'string' || !/\.mp4$/i.test(key)) continue;
          n++;
          const base = decodeURIComponent(key.split('/').pop()).replace(/\.mp4$/i, '');
          const title = String(ls.title || ls.name || ls.lessonName || '').trim() || base;
          lectures.push({
            url: CDN + key,
            title,
            duration: fmtDuration(ls.duration ?? ls.file?.duration ?? ls.video?.duration ?? ls.length),
            module: modName,
            chapter: chName,
            filename: `Lectures/${U.sanitize(name, 'Course')}/${U.sanitize(modName, 'Module')}/${String(n).padStart(2, '0')} - ${U.sanitize(title, base)}.mp4`
          });
        }
      }
    }
    return { name, lectures };
  }

  let course = null;

  /** Fetch (or read from the session cache) the lecture list of the current course page. */
  async function listLectures(force) {
    const m = COURSE_RE.exec(location.pathname);
    if (!m) return null;
    const [, sessionId, courseId] = m;
    const cacheKey = `course_${courseId}`;
    // Some content-script contexts cannot access extension storage.
    const cache = globalThis.chrome?.storage?.session;
    if (!force) {
      try {
        const cached = await cache?.get(cacheKey);
        if (cached?.[cacheKey]) return (course = cached[cacheKey]);
      } catch { /* fetch the course directly if the cache is unavailable */ }
    }
    const res = await fetch(`/api/courses/student/${encodeURIComponent(courseId)}?sessionId=${encodeURIComponent(sessionId)}`, { credentials: 'include' });
    if (!res.ok) throw new Error(`Course list failed (HTTP ${res.status}). Are you signed in?`);
    const parsed = { id: courseId, ...parseCourse(await res.json()) };
    try { await cache?.set({ [cacheKey]: parsed }); } catch { /* the fetched list is still usable */ }
    return (course = parsed);
  }

  window.__iitgParseCourse = parseCourse; // for tests (isolated world: not visible to the LMS page)

  window.__lhAdapters.push({
    id: 'iitg',
    match: (loc) => loc.hostname === 'elearn.iitg.ac.in',
    refererFor: () => 'https://elearn.iitg.ac.in/',
    hasList: (loc) => COURSE_RE.test(loc.pathname),
    listLectures,
    forgetCourse: (id) => { if (course && course.id !== id) course = null; },
    getVideos() {
      return [...document.querySelectorAll('video')].flatMap((v) => [v.currentSrc, v.src, ...[...v.querySelectorAll('source')].map((s) => s.src)])
        .filter(U.isFile).map((u) => ({ id: U.cleanUrl(u), kind: 'file', url: U.cleanUrl(u), title: '', tracks: [] }));
    },
    /** Course name from the course list, else the page's big H1. */
    getContext() {
      if (course?.name) return { course: course.name };
      const h = [...document.querySelectorAll('h1')].map(U.text).find((t) => t && !/^iitg\s*lms$/i.test(t));
      return { course: h || 'Course' };
    },
    /** Title from the course list when known, else DOM guesses, else the file name. */
    getTitle(src) {
      const known = course?.lectures.find((l) => l.url === src.url);
      if (known) return known.title;
      const active = document.querySelector('[aria-current="page"], [aria-current="true"], [aria-selected="true"][role="tab"] ~ *, [data-active="true"], .active');
      const candidates = [...[...document.querySelectorAll('h2')].map(U.text), U.text(active)]
        .filter((t) => t && t.length > 3 && t.length < 120 && !/^(your progress|course content|my notes)$/i.test(t));
      return candidates[0] || U.fileBase(src.url);
    },
    /** Download name for a known lecture. */
    filenameFor: (src) => course?.lectures.find((l) => l.url === src.url)?.filename || null
  });
})();
