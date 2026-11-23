/** Shared helpers (ES module). Used by background, offscreen, options and results pages. */

const LEVELS = ['low', 'medium', 'high'];

/** Selectable Gemini models. `levels` are the allowed thinking levels; `level` is the default. */
export const MODELS = [
  { id: 'gemini-4-argon', name: 'Gemini 4 Argon', level: 'medium', levels: LEVELS },
  { id: 'gemini-4-carbon', name: 'Gemini 4 Carbon', level: 'medium', levels: LEVELS },
  { id: 'gemini-3.8-flash', name: 'Gemini 3.8 Flash', level: 'medium', levels: LEVELS },
  { id: 'gemini-3.7-flash', name: 'Gemini 3.7 Flash', level: 'medium', levels: LEVELS },
  { id: 'gemini-3.6-flash', name: 'Gemini 3.6 Flash', level: 'medium', levels: ['minimal', ...LEVELS] },
  { id: 'gemini-3.5-flash-lite', name: 'Gemini 3.5 Flash-Lite', level: 'minimal', levels: ['minimal', ...LEVELS] },
  { id: 'gemini-2.5-pro', name: 'Gemini 2.5 Pro', level: 'medium', levels: LEVELS },
  { id: 'gemini-2.5-flash', name: 'Gemini 2.5 Flash', level: 'medium', levels: LEVELS }
];

/** Files injected as the content script, in order (adapters first, then content.js). */
export const CONTENT_FILES = ['adapters/util.js', 'adapters/iitg.js', 'adapters/youtube.js', 'adapters/generic.js', 'content.js'];

/** Strip query string / hash so the same lecture always maps to one cache key. */
export function cleanUrl(u) {
  try {
    const x = new URL(u);
    x.search = '';
    x.hash = '';
    return x.toString();
  } catch {
    return u;
  }
}

/** Seconds -> "mm:ss" (or "h:mm:ss"). `sep` lets filenames use "-" instead of ":". */
export function fmtTime(sec, sep = ':') {
  sec = Math.max(0, Math.floor(sec || 0));
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const p = (n) => String(n).padStart(2, '0');
  return h ? `${h}${sep}${p(m)}${sep}${p(s)}` : `${p(m)}${sep}${p(s)}`;
}

const CLOCK = '\\d{1,3}:\\d{2}(?::\\d{2})?';
/**
 * The notes without video times, for the printed / exported page (the times stay in the stored notes
 * for the AI and for "copy"). Removes: "(mm:ss)" after headings, the "mm:ss —" before topics, the
 * "Watch at mm:ss" link lines, and the times inside figure titles and captions. Pure.
 * @param {string} md
 */
export function stripTimestamps(md) {
  return String(md || '')
    .replace(new RegExp(`^[ \\t]*\\[Watch at ${CLOCK}\\]\\([^)]*\\)[ \\t]*\\n?`, 'gim'), '')
    .replace(new RegExp(`^(#{2,4}[^\\n]*?)[ \\t]*\\(${CLOCK}\\)[ \\t]*$`, 'gm'), '$1')
    .replace(new RegExp(`^([ \\t]*[-*+][ \\t]+)\\**${CLOCK}\\**[ \\t]*[—–-][ \\t]*`, 'gm'), '$1')
    .replace(new RegExp(`\\*FIG (\\d+) · ${CLOCK} — `, 'g'), '*Fig $1 — ')
    .replace(new RegExp(`\\*\\*FIG (\\d+) · ${CLOCK}\\*\\* — `, 'g'), '**Fig $1** — ')
    .replace(new RegExp(`Narration at ${CLOCK}: `, 'g'), '')
    .replace(new RegExp(`On screen at ${CLOCK}\\.`, 'g'), 'On screen.')
    .replace(new RegExp(`\\b(Code|Table|Equations|Diagram|Chart|Schematic|Patent drawing|Map|Slide|Photo|Document|Scene) at ${CLOCK}\\b`, 'g'), '$1')
    .replace(new RegExp(`\\s*\\(\\[watch at ${CLOCK}\\]\\([^)]*\\)\\)`, 'gi'), '')
    .replace(/\n{3,}/g, '\n\n');
}

/** Make a string safe to use as a file or folder name. */
export function sanitizeName(s, fallback = 'untitled') {
  const out = String(s || '')
    .replace(/[\\/:*?"<>|\x00-\x1f]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.\s]+|[.\s]+$/g, '')
    .slice(0, 120);
  return out || fallback;
}

/**
 * Plain-text version of the summary for pasting into another AI.
 * Frame markers become "[Figure N: title @ mm:ss — description]".
 */
export function toCopyText(result) {
  const byIndex = new Map(result.frames.map((f) => [f.index, f]));
  const used = new Set();
  let text = (result.summary_raw || '').replace(/\[\[FRAME:(\d+)\]\]/g, (_, n) => {
    const f = byIndex.get(Number(n));
    if (!f) return '';
    used.add(f.index);
    return `[Figure ${f.figure}: ${f.title} @ ${fmtTime(f.timestamp_seconds)} — ${f.description}]`;
  });
  text = text.replace(/\[\[VISUAL:\d+\]\]/g, ''); // notes saved before visuals were removed
  const rest = result.frames.filter((f) => !used.has(f.index));
  if (rest.length) {
    text += '\n\n## Figures\n' + rest
      .map((f) => `- [Figure ${f.figure}: ${f.title} @ ${fmtTime(f.timestamp_seconds)} — ${f.description}]`)
      .join('\n');
  }
  return text.replace(/\n{3,}/g, '\n\n').trim();
}
