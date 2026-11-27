/**
 * Web search done BY THE EXTENSION, for writer models that cannot search by themselves (Groq, OpenAI,
 * DeepSeek, Ollama, ...). No API key: DuckDuckGo's plain HTML page plus the Wikipedia API (the manifest
 * grants <all_urls>, so extension pages can fetch both without CORS trouble). The few snippets found are
 * handed to the writer as background; native search (Gemini / Anthropic / OpenRouter) is used when available.
 * Parsers are pure (tested); `webContext` never throws: no results simply means no background.
 */

const clean = (s) => String(s || '')
  .replace(/<[^>]+>/g, ' ')
  .replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#x27;|&#39;/g, "'").replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&nbsp;/g, ' ')
  .replace(/\s+/g, ' ').trim();

/** DuckDuckGo wraps result links as //duckduckgo.com/l/?uddg=<encoded real url>. */
function realUrl(href) {
  const m = /[?&]uddg=([^&]+)/.exec(href);
  if (m) { try { return decodeURIComponent(m[1]); } catch { return ''; } }
  return /^https?:/.test(href) ? href : '';
}

/** html.duckduckgo.com/html results -> [{title, url, snippet}] */
export function parseDuckDuckGo(html) {
  const out = [];
  const s = String(html || '');
  const heads = [...s.matchAll(/<a[^>]+class="result__a"[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g)];
  heads.forEach((m, i) => {
    const url = realUrl(m[1].replace(/&amp;/g, '&'));
    const title = clean(m[2]);
    // the snippet is the first one between this link and the next result's link
    const between = s.slice(m.index + m[0].length, heads[i + 1]?.index ?? s.length);
    const sn = /class="result__snippet"[^>]*>([\s\S]*?)<\/(?:a|div|td)>/.exec(between);
    // a video site's page holds the video's own description and comments: not background about the topic
    const videoSite = /^https?:\/\/([^/]+\.)?(youtube\.com|youtu\.be|vimeo\.com|dailymotion\.com)\//i.test(url);
    if (url && title && !videoSite && !/duckduckgo\.com\/y\.js/.test(url)) out.push({ title, url, snippet: clean(sn?.[1]) });
  });
  return out;
}

/** Wikipedia action=query&list=search reply -> [{title, url, snippet}] */
export function parseWikipedia(json) {
  return (json?.query?.search || []).map((r) => ({
    title: clean(r.title),
    url: `https://en.wikipedia.org/wiki/${encodeURIComponent(String(r.title).replace(/ /g, '_'))}`,
    snippet: clean(r.snippet)
  }));
}

/** A search query from a video title: "Name: Part (Song) | Cast | Music" -> "Name: Part". */
export function queryFromTitle(title, course = '') {
  let q = String(title || '').split(/[|·]/)[0].replace(/\([^)]*\)|\[[^\]]*\]/g, ' ').replace(/\s+/g, ' ').trim();
  if (q.length < 4) q = `${q} ${course}`.trim();
  return q.slice(0, 120);
}

async function get(url, signal, asJson) {
  const ctl = new AbortController();
  const stop = () => ctl.abort();
  signal?.addEventListener('abort', stop, { once: true });
  const timer = setTimeout(stop, 8000);
  try {
    const res = await fetch(url, { signal: ctl.signal, credentials: 'omit', cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return asJson ? await res.json() : await res.text();
  } finally { clearTimeout(timer); signal?.removeEventListener('abort', stop); }
}

/** @returns {Promise<{title:string,url:string,snippet:string}[]>} up to `max` results, [] on any failure */
export async function searchWeb(query, { signal, max = 5 } = {}) {
  if (!query) return [];
  const seen = new Set();
  const all = [];
  const add = (list) => { for (const r of list) if (!seen.has(r.url)) { seen.add(r.url); all.push(r); } };
  const tasks = [
    get(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, signal, false).then((h) => add(parseDuckDuckGo(h))),
    get(`https://en.wikipedia.org/w/api.php?action=query&list=search&srlimit=3&format=json&origin=*&srsearch=${encodeURIComponent(query)}`, signal, true).then((j) => add(parseWikipedia(j)))
  ];
  await Promise.allSettled(tasks);
  return all.slice(0, max);
}

/**
 * Real exam / interview question styles for the practice-questions writer: a few searches over the main
 * topics (IIT / NPTEL / GATE for theory, LeetCode for code). '' when nothing was found; never throws.
 */
/** The words (4+ letters, lower case, no filler) that say what a subject is about. Pure. */
export function relevantWords(text) {
  const skip = new Set(['the', 'this', 'that', 'with', 'from', 'about', 'and', 'for', 'of', 'in', 'on', 'part', 'lesson', 'intro', 'introduction', 'basics', 'basic', 'general', 'history', 'overview']);
  return [...new Set(String(text || '').toLowerCase().match(/[a-z][a-z'-]{3,}/g) || [])].filter((w) => !skip.has(w));
}

export async function practiceContext(topics, { course = '', code = false, style = null, subject = null, iit = false, signal } = {}) {
  try {
    const main = (topics || []).filter(Boolean).slice(0, 3);
    if (!main.length) return '';
    const kind = style || (code ? 'code' : 'general');
    const tail = iit ? 'IIT NPTEL GATE official question paper assignment'
      : { code: 'leetcode problem', maths: 'JEE GATE problems with solutions', physics: 'JEE Advanced physics problems with solutions', chemistry: 'JEE NEET questions with solutions', biology: 'NEET questions with answers', engineering: 'GATE questions with solutions' }[kind] || 'important questions and answers';
    const qs = main.map((t) => `${t} ${kind === 'general' ? subject || course : ''} ${tail}`.replace(/\s+/g, ' ').trim());
    const all = (await Promise.all(qs.map((q) => searchWeb(q, { signal, max: 3 })))).flat();
    const seen = new Set();
    // only results that are about THIS subject: a search for "Diplomacy, Bureaucracy and Growing Pressure ... questions" also
    // returns pages on unrelated wars and genocides (seen in a Berlin Wall run). A hit must share a key word with the subject.
    const keys = relevantWords([subject || course, ...(iit ? main : [])].join(' '));
    const about = (h) => !keys.length || keys.some((k) => `${h.title} ${h.snippet || ''}`.toLowerCase().includes(k));
    return all.filter((h) => !seen.has(h.url) && seen.add(h.url) && about(h))
      .map((h) => `- ${h.title} (${h.url})${h.snippet ? `: ${h.snippet.slice(0, 200)}` : ''}`).join('\n').slice(0, 2000);
  } catch { return ''; }
}

/** Find source-specific leads for the practice paper, with a bounded number of searches. */
export async function practiceReferenceContext(refs, subject, { signal } = {}) {
  const normalize = text => String(text || '').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
  const candidates = refs.filter(ref => ['book', 'paper', 'document', 'website', 'other'].includes(ref.kind) && normalize(ref.title).length >= 8);
  const preferred = [...candidates.filter(ref => ref.kind !== 'other'), ...candidates.filter(ref => ref.kind === 'other')];
  const groups = await Promise.all(preferred.slice(0, 4).map(async ref => {
    const query = [`"${ref.title.replaceAll('"', '')}"`, ref.author, subject].filter(Boolean).join(' ');
    const title = normalize(ref.title);
    const hits = await searchWeb(query, { signal, max: 3 });
    return hits.filter(hit => normalize(`${hit.title} ${hit.snippet}`).includes(title)).slice(0, 2)
      .map(hit => `- ${ref.title} | ${hit.title} (${hit.url}): ${String(hit.snippet || '').slice(0, 180)}`);
  }));
  return [...new Set(groups.flat())].join('\n');
}

/** Look up only terms nominated as gaps in the lecture evidence. */
export async function lectureTopicContext(lines, subject, { signal } = {}) {
  const topics = [...new Set(lines.map(line => line.replace(/\s+/g, ' ').trim().split(' ').slice(0, 14).join(' ')))]
    .filter(topic => relevantWords(topic).length >= 1);
  const count = Math.min(4, topics.length);
  const queries = Array.from({ length: count }, (_, i) => topics[Math.floor((i + 0.5) * topics.length / count)]);
  const results = await Promise.all(queries.map(async topic => {
    const terms = relevantWords(topic);
    const hits = await searchWeb(`${subject || ''} ${topic}`.trim(), { signal, max: 3 });
    const relevant = hits.filter(hit => {
      const words = new Set(relevantWords(`${hit.title} ${hit.snippet || ''}`));
      return terms.filter(term => words.has(term)).length >= Math.min(2, terms.length);
    });
    return relevant.slice(0, 2).map(hit => `- ${hit.title} (${hit.url}): ${String(hit.snippet || '').slice(0, 180)}`);
  }));
  return [...new Set(results.flat())].join('\n');
}

/** Plain-text background for the writer's prompt ('' when nothing was found). Short: it is paid for on every call. */
export async function webContext(title, course, { signal } = {}) {
  try {
    const hits = await searchWeb(queryFromTitle(title, course), { signal });
    return hits.map((h) => `- ${h.title} (${h.url})${h.snippet ? `: ${h.snippet.slice(0, 220)}` : ''}`).join('\n').slice(0, 1600);
  } catch { return ''; }
}
