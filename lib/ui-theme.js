/**
 * The look of the notes page, changeable by the assistant ("UI changes").
 *
 * The AI never writes code. It answers with a small JSON object (a PATCH of the look); this module VALIDATES every field against closed
 * lists and strict value patterns, merges it into the saved look and turns the result into one <style> element. Nothing here touches the
 * notes text, the pipeline, the bridge or any stored data: only this page's colours, type, spacing, orb and motion. Unknown or unsafe
 * fields are dropped and reported, never applied. Pure functions + a few DOM helpers at the end (the tests run the pure part).
 */
export const LOOK_KEY = 'vid2study:look';

const HEX = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6})$/;
const num = (v, lo, hi) => (typeof v === 'number' && Number.isFinite(v) ? Math.min(hi, Math.max(lo, v)) : null);
const word = (v, list) => (typeof v === 'string' && list.includes(v.toLowerCase()) ? v.toLowerCase() : null);

export const FONTS = {
  serif: '"Iowan Old Style","Palatino Linotype",Palatino,"Book Antiqua",Georgia,serif',
  sans: '"Segoe UI Variable Text","Segoe UI",system-ui,-apple-system,"Helvetica Neue",Arial,sans-serif',
  mono: 'ui-monospace,"Cascadia Mono",Consolas,monospace',
  rounded: 'ui-rounded,"Nunito","Segoe UI",system-ui,sans-serif',
  humanist: 'Candara,Optima,Calibri,"Segoe UI",sans-serif',
  slab: 'Rockwell,"Roboto Slab","Courier New",Georgia,serif',
  classic: 'Georgia,"Times New Roman",Times,serif',
  condensed: 'Bahnschrift,"Arial Narrow","Helvetica Neue",sans-serif',
  handwriting: '"Segoe Print","Bradley Hand","Comic Sans MS",cursive'
};
export const HEADING_STYLES = ['plain', 'underline', 'bar', 'boxed', 'caps', 'side'];
export const ANIMATIONS = ['spin', 'pulse', 'bounce', 'float', 'wiggle', 'shake', 'tilt', 'beat', 'fade', 'rise', 'slide', 'glow', 'shimmer', 'flip', 'swing'];
export const WHEN = ['hover', 'always', 'load'];
export const EASES = ['linear', 'ease', 'ease-in', 'ease-out', 'ease-in-out'];
/** What a "target" means: the parts of the page the assistant may restyle. */
export const TARGETS = {
  page: ['body'], notes: ['#out'], title: ['#out h1'], sections: ['#out h2'], subheadings: ['#out h3'], headings: ['#out h1', '#out h2', '#out h3'],
  text: ['#out p', '#out li'], links: ['#out a'], figures: ['#out img'], captions: ['#out img + br + em'], tables: ['#out table'],
  cells: ['#out th', '#out td'], code: ['#out pre', '#out code'], quotes: ['#out blockquote'], formulas: ['#out div.math'], visuals: ['#out .study-visual'],
  toolbar: ['.bar2'], buttons: ['.bar2 button'], panel: ['.ask-panel'], orb: ['.ask-orb']
};
const PROPS = ['color', 'background', 'background-color', 'border', 'border-color', 'border-width', 'border-style', 'border-radius', 'border-left', 'border-right',
  'border-top', 'border-bottom', 'box-shadow', 'text-shadow', 'padding', 'margin', 'gap', 'font-size', 'font-weight', 'font-style', 'letter-spacing', 'text-transform',
  'text-align', 'line-height', 'opacity', 'text-decoration', 'max-width', 'width', 'filter', 'transform', 'transition', 'outline', 'backdrop-filter'];
const FUNCTIONS = ['rgb', 'rgba', 'hsl', 'hsla', 'calc', 'linear-gradient', 'radial-gradient', 'conic-gradient', 'blur', 'brightness', 'contrast', 'saturate', 'drop-shadow',
  'rotate', 'scale', 'translate', 'translatex', 'translatey', 'skew', 'min', 'max', 'clamp', 'hue-rotate', 'grayscale', 'sepia'];

/** A CSS value is allowed when it is short, made of plain characters and calls only known functions. No url(), no braces, no escapes. */
export function safeValue(v) {
  if (typeof v === 'number' && Number.isFinite(v)) return String(v);
  if (typeof v !== 'string' || !v.trim() || v.length > 120) return null;
  const s = v.trim();
  if (!/^[A-Za-z0-9 .,#%()+*/-]+$/.test(s) || s.includes('//') || s.includes('/*')) return null;
  for (const m of s.matchAll(/([A-Za-z-]+)\(/g)) if (!FUNCTIONS.includes(m[1].toLowerCase())) return null;
  if (/(^|[^A-Za-z])(url|image-set|attr|var|expression|javascript|import)([^A-Za-z]|$)/i.test(s)) return null;
  return s;
}

// ---- orb icons -------------------------------------------------------------------------------------------------------
const disc = (a, b, c) => `<defs><radialGradient id="ask-orb-g" cx="36%" cy="30%" r="78%"><stop offset="0" stop-color="${a}"/><stop offset=".55" stop-color="${b}"/><stop offset="1" stop-color="${c}"/></radialGradient></defs><circle cx="32" cy="32" r="30" fill="url(#ask-orb-g)"/><ellipse cx="22.5" cy="17.5" rx="10" ry="5.5" fill="#fff" opacity=".45" transform="rotate(-30 22.5 17.5)"/>`;
const star5 = (x, y, r, r2) => [0, 1, 2, 3, 4].map(i => { const a = -Math.PI / 2 + i * 2 * Math.PI / 5, b = a + Math.PI / 5; return `${(x + Math.cos(a) * r).toFixed(1)},${(y + Math.sin(a) * r).toFixed(1)} ${(x + Math.cos(b) * r2).toFixed(1)},${(y + Math.sin(b) * r2).toFixed(1)}`; }).join(' ');
const svg = (inner) => `<svg viewBox="0 0 64 64" aria-hidden="true">${inner}</svg>`;
export const ORB_ICONS = {
  dragonball: svg(disc('#fff1bf', '#f08a1c', '#a8400b') + [[32, 22.5], [22.5, 32], [41.5, 32], [32, 41.5]].map(([x, y]) => `<polygon fill="#c2301a" points="${star5(x, y, 4.6, 1.9)}"/>`).join('')),
  star: svg(disc('#fff7c2', '#f5b400', '#9a5b00') + `<polygon fill="#fff" points="${star5(32, 33, 17, 7)}"/>`),
  spark: svg(disc('#8be0d6', '#0e6a64', '#07312f') + '<path fill="#fff" d="M32 12c1.6 11 4.2 14.4 15 16-10.8 1.6-13.4 5-15 16-1.6-11-4.2-14.4-15-16 10.8-1.6 13.4-5 15-16z"/>'),
  bolt: svg(disc('#d6e4ff', '#3d6bff', '#10206b') + '<path fill="#ffe14d" d="M36 10L18 35h11l-4 19 21-27H34z"/>'),
  flame: svg(disc('#ffd9a0', '#e8431c', '#6b1403') + '<path fill="#ffe08a" d="M32 12c3 8 11 12 11 22a11 11 0 01-22 0c0-5 3-8 5-11 1 4 3 5 4 5-1-6 0-11 2-16z"/>'),
  heart: svg(disc('#ffd0dc', '#e23b6a', '#6e0f2c') + '<path fill="#fff" d="M32 47C16 36 16 22 25 19c4-1 7 1 7 4 0-3 3-5 7-4 9 3 9 17-7 28z"/>'),
  bulb: svg(disc('#fff5c2', '#ffc928', '#9a6a00') + '<path fill="#fff" d="M32 14a12 12 0 00-6 22c1 1 2 3 2 5h8c0-2 1-4 2-5a12 12 0 00-6-22z"/><rect x="27" y="44" width="10" height="4" rx="2" fill="#fff"/>'),
  planet: svg(disc('#d9d2ff', '#6a4fe0', '#241269') + '<ellipse cx="32" cy="34" rx="26" ry="8" fill="none" stroke="#fff" stroke-width="3" opacity=".85" transform="rotate(-18 32 34)"/>'),
  book: svg(disc('#c9efe9', '#16897f', '#073f3b') + '<path fill="#fff" d="M14 20c7-2 13-1 18 3 5-4 11-5 18-3v26c-7-2-13-1-18 3-5-4-11-5-18-3z"/><path stroke="#16897f" stroke-width="2" d="M32 23v26"/>'),
  atom: svg(disc('#c8f3ff', '#0f8fc7', '#05324a') + '<g fill="none" stroke="#fff" stroke-width="2.6"><ellipse cx="32" cy="32" rx="20" ry="8"/><ellipse cx="32" cy="32" rx="20" ry="8" transform="rotate(60 32 32)"/><ellipse cx="32" cy="32" rx="20" ry="8" transform="rotate(120 32 32)"/></g><circle cx="32" cy="32" r="4" fill="#fff"/>')
};
const SVG_TAGS = ['svg', 'g', 'path', 'circle', 'ellipse', 'rect', 'line', 'polyline', 'polygon', 'defs', 'lineargradient', 'radialgradient', 'stop'];
const SVG_ATTRS = ['viewbox', 'd', 'cx', 'cy', 'r', 'rx', 'ry', 'x', 'y', 'x1', 'y1', 'x2', 'y2', 'width', 'height', 'fill', 'stroke', 'stroke-width', 'stroke-linecap', 'stroke-linejoin',
  'opacity', 'fill-opacity', 'stroke-opacity', 'points', 'transform', 'offset', 'stop-color', 'stop-opacity', 'id', 'fill-rule', 'gradienttransform', 'fx', 'fy'];
const CAMEL = { viewbox: 'viewBox', lineargradient: 'linearGradient', radialgradient: 'radialGradient', gradienttransform: 'gradientTransform' };

/** Rebuild an SVG from a whitelist of tags and attributes (no scripts, links, styles, text or external references). Null when unusable. */
export function cleanSvg(source) {
  if (typeof source !== 'string' || source.length > 5000) return null;
  const tag = new RegExp('<(/?)([a-zA-Z][a-zA-Z0-9]*)([^<>]*?)(/?)>', 'g');
  const attr = new RegExp('([a-zA-Z][a-zA-Z0-9:-]*)[ ]*=[ ]*"([^"]*)"', 'g');
  let out = '', depth = 0, sawRoot = false;
  for (const m of source.matchAll(tag)) {
    const name = m[2].toLowerCase();
    if (!SVG_TAGS.includes(name)) return null;
    if (m[1]) { depth--; if (depth < 0) return null; out += `</${CAMEL[name] || name}>`; continue; }
    let attrs = '', box = false;
    for (const a of m[3].matchAll(attr)) {
      const k = a[1].toLowerCase(), v = a[2];
      if (!SVG_ATTRS.includes(k) || !/^[A-Za-z0-9 .,#%()+:_-]*$/.test(v)) return null;
      if (/url\(/i.test(v) && !/^url\(#[A-Za-z0-9_-]+\)$/.test(v)) return null;
      if (name === 'svg' && (k === 'width' || k === 'height')) continue;
      if (k === 'viewbox') box = true;
      attrs += ` ${CAMEL[k] || k}="${v}"`;
    }
    if (name === 'svg') { sawRoot = true; if (!box) attrs += ' viewBox="0 0 64 64"'; attrs += ' aria-hidden="true"'; }
    else if (!sawRoot) return null;
    const self = !!m[4];
    out += `<${CAMEL[name] || name}${attrs}${self ? '/' : ''}>`;
    if (!self) depth++;
  }
  return sawRoot && depth === 0 && out.startsWith('<svg') ? out : null;
}

const GLYPH = /^[\p{L}\p{N}\p{Extended_Pictographic}‍️\u{1f3fb}-\u{1f3ff}]{1,8}$/u;
/** icon -> { html } (preset or cleaned svg) | { glyph } (emoji or up to three characters) | null */
export function orbIcon(icon) {
  if (typeof icon !== 'string') return null;
  const s = icon.trim();
  if (ORB_ICONS[s.toLowerCase()]) return { preset: s.toLowerCase(), html: ORB_ICONS[s.toLowerCase()] };
  if (s.startsWith('<')) { const html = cleanSvg(s); return html ? { html, custom: true } : null; }
  return GLYPH.test(s) && [...s].length <= 8 ? { glyph: s } : null;
}

// ---- reading a reply and validating it ----------------------------------------------------------------------------
/** The JSON object in a model reply (fenced or not). Null when there is none. */
export function readLookReply(text) {
  const raw = String(text || '').trim().replace(/^[`]{3}(?:json)?[ ]*\n?/i, '').replace(/[`]{3}[ ]*$/, '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  for (let end = raw.lastIndexOf('}'); end > start; end = raw.lastIndexOf('}', end - 1)) {
    try { const v = JSON.parse(raw.slice(start, end + 1)); if (v && typeof v === 'object' && !Array.isArray(v)) return v; } catch { /* try a shorter slice */ }
  }
  return null;
}

function cleanTargets(input, dropped) {
  const out = {};
  for (const [name, spec] of Object.entries(input && typeof input === 'object' ? input : {})) {
    if (!TARGETS[name]) { dropped.push(`target "${name}"`); continue; }
    const block = {};
    for (const [state, rules] of Object.entries(spec && typeof spec === 'object' ? spec : {})) {
      // rules directly on the target ({"color": "#fff"}) or under "hover" ({"hover": {...}})
      const isHover = state === 'hover';
      const list = isHover ? rules : { [state]: rules };
      const bucket = isHover ? (block.hover ||= {}) : block;
      for (const [prop, value] of Object.entries(list && typeof list === 'object' ? list : {})) {
        const p = prop.toLowerCase(), v = safeValue(value);
        if (!PROPS.includes(p) || v == null) { dropped.push(`${name}.${prop}`); continue; }
        bucket[p] = v;
      }
    }
    if (Object.keys(block).length) out[name] = block;
  }
  return out;
}

/** Validate a model's patch. Returns { patch, dropped }: only fields that passed, in the canonical shape. */
export function sanitizeLook(input) {
  const dropped = [], patch = {};
  const src = input && typeof input === 'object' && !Array.isArray(input) ? input : {};
  if (src.reset === true) patch.reset = true;
  else if (Array.isArray(src.reset)) patch.reset = src.reset.filter(k => ['mode', 'colors', 'font', 'orb', 'targets', 'animate', 'layout'].includes(k));
  const mode = word(src.mode, ['light', 'dark', 'auto']);
  if (src.mode != null) mode ? patch.mode = mode : dropped.push('mode');
  if (src.colors && typeof src.colors === 'object') {
    const colors = {};
    for (const k of ['accent', 'paper', 'ink', 'muted', 'line', 'surface', 'heading', 'bar']) {
      if (src.colors[k] == null) continue;
      HEX.test(src.colors[k]) ? colors[k] = src.colors[k].toLowerCase() : dropped.push('colors.' + k);
    }
    if (Object.keys(colors).length) patch.colors = colors;
  }
  const font = {};
  for (const k of ['body', 'heading', 'code']) {
    if (src.font?.[k] == null) continue;
    const f = word(src.font[k], Object.keys(FONTS));
    f ? font[k] = f : dropped.push('font.' + k);
  }
  const size = num(src.font?.size ?? src.size, 12, 24), lh = num(src.font?.lineHeight ?? src.lineHeight, 1.2, 2.4);
  if (size != null) font.size = size;
  if (lh != null) font.lineHeight = lh;
  if (Object.keys(font).length) patch.font = font;
  const layout = {};
  const width = num(src.layout?.width ?? src.width, 480, 1400), radius = num(src.layout?.radius ?? src.radius, 0, 28), space = num(src.layout?.spacing ?? src.spacing, 0.6, 1.8);
  if (width != null) layout.width = Math.round(width);
  if (radius != null) layout.radius = Math.round(radius);
  if (space != null) layout.spacing = space;
  const heads = word(src.layout?.headings ?? src.headings, HEADING_STYLES);
  if ((src.layout?.headings ?? src.headings) != null) heads ? layout.headings = heads : dropped.push('headings');
  if (Object.keys(layout).length) patch.layout = layout;
  if (src.orb && typeof src.orb === 'object') {
    const orb = {};
    if (src.orb.icon != null) { const i = orbIcon(src.orb.icon); i ? orb.icon = i.glyph ? i.glyph : i.custom ? cleanSvg(src.orb.icon) : i.preset : dropped.push('orb.icon'); }
    const px = num(src.orb.size, 28, 84); if (px != null) orb.size = Math.round(px);
    if (src.orb.color != null) HEX.test(src.orb.color) ? orb.color = src.orb.color.toLowerCase() : dropped.push('orb.color');
    if (typeof src.orb.glow === 'boolean') orb.glow = src.orb.glow;
    if (typeof src.orb.label === 'string' && src.orb.label.trim()) orb.label = src.orb.label.trim().slice(0, 28).replace(/[^\p{L}\p{N} .,!?'-]/gu, '');
    if (src.orb.corner != null) { const c = word(src.orb.corner, ['bottom-right', 'bottom-left', 'top-right', 'top-left']); c ? orb.corner = c : dropped.push('orb.corner'); }
    if (Object.keys(orb).length) patch.orb = orb;
  }
  if (src.targets) { const t = cleanTargets(src.targets, dropped); if (Object.keys(t).length) patch.targets = t; }
  if (Array.isArray(src.animate)) {
    const list = [];
    for (const a of src.animate.slice(0, 12)) {
      const target = word(a?.target, Object.keys(TARGETS)), name = word(a?.name, ANIMATIONS);
      if (!target || !name) { dropped.push('animation ' + (a?.name || '?')); continue; }
      const when = word(a.when, WHEN) || 'hover', seconds = num(a.seconds, 0.15, 20) ?? 1.2;
      const count = a.count === 'infinite' || a.count === 'loop' ? 'infinite' : String(Math.round(num(a.count, 1, 20) ?? (when === 'always' ? 99 : 1)));
      list.push({ target, name, when, seconds, count: count === '99' ? 'infinite' : count, ease: word(a.ease, EASES) || (name === 'spin' ? 'linear' : 'ease-in-out') });
    }
    patch.animate = list;
  }
  return { patch, dropped };
}

/** Merge a validated patch into the saved look. `reset` clears (all, or the named parts) before the rest is applied. */
export function mergeLook(base, patch) {
  let look = JSON.parse(JSON.stringify(base || {}));
  if (patch.reset === true) look = {};
  else for (const k of patch.reset || []) delete look[k];
  for (const k of ['mode']) if (patch[k] != null) look[k] = patch[k];
  for (const k of ['colors', 'font', 'layout', 'orb']) if (patch[k]) look[k] = { ...(look[k] || {}), ...patch[k] };
  if (patch.targets) {
    look.targets ||= {};
    for (const [name, block] of Object.entries(patch.targets)) look.targets[name] = { ...(look.targets[name] || {}), ...block, ...(block.hover || look.targets[name]?.hover ? { hover: { ...(look.targets[name]?.hover || {}), ...(block.hover || {}) } } : {}) };
  }
  if (patch.animate) look.animate = patch.animate;
  return look;
}

/** One line per change, for the review card. */
export function describeLook(patch) {
  const out = [];
  if (patch.reset) out.push(patch.reset === true ? 'Reset the whole look to the original' : 'Reset: ' + patch.reset.join(', '));
  if (patch.mode) out.push({ dark: 'Dark mode', light: 'Light mode', auto: 'Follow the system light / dark setting' }[patch.mode]);
  if (patch.colors) out.push('Colours: ' + Object.entries(patch.colors).map(([k, v]) => `${k} ${v}`).join(', '));
  if (patch.font) out.push('Type: ' + Object.entries(patch.font).map(([k, v]) => `${k} ${v}`).join(', '));
  if (patch.layout) out.push('Layout: ' + Object.entries(patch.layout).map(([k, v]) => `${k} ${v}`).join(', '));
  if (patch.orb) out.push('Orb: ' + Object.entries(patch.orb).map(([k, v]) => k === 'icon' && String(v).startsWith('<') ? 'icon (custom drawing)' : `${k} ${v}`).join(', '));
  for (const [name, block] of Object.entries(patch.targets || {})) out.push(`Style ${name}: ` + Object.entries(block).map(([k, v]) => k === 'hover' ? `on hover ${Object.keys(v).join(', ')}` : k).join(', '));
  for (const a of patch.animate || []) out.push(`Animate ${a.target}: ${a.name}, ${a.when === 'hover' ? 'on hover' : a.when === 'load' ? 'once on load' : 'always'}, ${a.seconds}s`);
  if (patch.animate && !patch.animate.length) out.push('Remove all animations');
  return out;
}

// ---- CSS -----------------------------------------------------------------------------------------------------------------
const DARK = { paper: '#14181b', ink: '#e8eeec', muted: '#9fb0ad', line: '#34403f', surface: '#1e2629', accent: '#4fd1c5', bar: '#0d1012' };
/** Black or white text, whichever reads better on this colour. */
const onColor = (hex) => { const h = hex.length === 4 ? [...hex.slice(1)].map(x => x + x).join('') : hex.slice(1); const [r, g, b] = [0, 2, 4].map(i => parseInt(h.slice(i, i + 2), 16) / 255).map(v => v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4); return 0.2126 * r + 0.7152 * g + 0.0722 * b > 0.4 ? '#0b1213' : '#fff'; };
const tokenCss = (c) => {
  const v = (k, d) => c[k] || d;
  const ink = v('ink', '#000'), paper = v('paper', '#fff'), surface = v('surface', '#f2f2f2'), line = v('line', '#d9d9d9'), accent = v('accent', '#FFE500');
  return `--k:${ink};--w:${paper};--g1:${surface};--g2:${line};--y:${accent};--v-muted:${v('muted', '#444')};--v-bar:${v('bar', ink)};--v-heading:${v('heading', ink)};` +
    `--ink:${ink};--paper:${paper};--wash:${surface};--tint:${surface};--line:${line};--muted:${v('muted', '#55686f')};--teal:${accent};--teal-deep:${accent};`;
};
const keyframes = '@keyframes v2s-spin{to{transform:rotate(360deg)}}@keyframes v2s-pulse{50%{transform:scale(1.14)}}@keyframes v2s-bounce{0%,100%{transform:translateY(0)}40%{transform:translateY(-22%)}60%{transform:translateY(-8%)}}' +
  '@keyframes v2s-float{0%,100%{transform:translateY(0)}50%{transform:translateY(-14%)}}@keyframes v2s-wiggle{0%,100%{transform:rotate(0)}25%{transform:rotate(-12deg)}75%{transform:rotate(12deg)}}' +
  '@keyframes v2s-shake{0%,100%{transform:translateX(0)}20%,60%{transform:translateX(-6%)}40%,80%{transform:translateX(6%)}}@keyframes v2s-tilt{50%{transform:rotate(-14deg) scale(1.06)}}' +
  '@keyframes v2s-beat{0%,40%,100%{transform:scale(1)}20%{transform:scale(1.2)}60%{transform:scale(1.12)}}@keyframes v2s-fade{from{opacity:0}to{opacity:1}}@keyframes v2s-rise{from{opacity:0;transform:translateY(14px)}to{opacity:1;transform:none}}' +
  '@keyframes v2s-slide{from{opacity:0;transform:translateX(-18px)}to{opacity:1;transform:none}}@keyframes v2s-glow{50%{filter:brightness(1.35) drop-shadow(0 0 8px currentColor)}}' +
  '@keyframes v2s-shimmer{0%,100%{filter:brightness(1)}50%{filter:brightness(1.3) saturate(1.3)}}@keyframes v2s-flip{to{transform:rotateY(360deg)}}@keyframes v2s-swing{0%,100%{transform:rotate(-10deg)}50%{transform:rotate(10deg)}}';
const HEADS = {
  plain: '#out h2{border-top:0;padding-top:0;text-transform:none;letter-spacing:0}',
  underline: '#out h2{border-top:0;padding-top:0;border-bottom:2px solid var(--y);padding-bottom:4px;text-transform:none;letter-spacing:0}',
  bar: '#out h2{border-top:0;padding:6px 12px;background:var(--v-bar);color:var(--w);text-transform:none;letter-spacing:0}',
  boxed: '#out h2{border:2px solid var(--k);padding:6px 12px;text-transform:none;letter-spacing:0}',
  caps: '#out h2{text-transform:uppercase;letter-spacing:.08em;border-top:0;padding-top:0}',
  side: '#out h2{border-top:0;padding:2px 0 2px 12px;border-left:5px solid var(--y);text-transform:none;letter-spacing:0}'
};
const rule = (sel, props) => sel + '{' + Object.entries(props).map(([k, v]) => `${k}:${v}`).join(';') + '}';
const selectors = (name, suffix = '') => TARGETS[name].map(s => (name === 'page' ? 'html[data-look] body' : name === 'toolbar' || name === 'buttons' || name === 'panel' || name === 'orb' ? s : 'html[data-look] ' + s) + suffix).join(',');
const animSel = (a) => {
  if (a.target === 'orb') return a.when === 'hover' ? '.ask-orb:hover .ask-face' : '.ask-orb .ask-face';
  return selectors(a.target, a.when === 'hover' ? ':hover' : '');
};

/** The whole look as CSS. Everything is scoped under html[data-look], so removing the attribute restores the original page. */
export function lookCss(look) {
  if (!look || !Object.keys(look).length) return '';
  const out = [], c = look.colors || {}, f = look.font || {}, l = look.layout || {};
  const base = Object.keys(c).length ? c : {};
  const tokenRules = (c, extra = '') => `html[data-look]{${tokenCss(c)}${extra}}html[data-look] .ask-panel,html[data-look] .ask-orb{${tokenCss(c)}}`;
  const accentText = onColor((c.accent || (look.mode === 'dark' || look.mode === 'auto' ? DARK.accent : '#FFE500')));
  if (look.mode === 'dark') out.push(tokenRules({ ...DARK, ...base }, 'color-scheme:dark;'));
  else if (look.mode === 'auto') out.push(`@media (prefers-color-scheme:dark){${tokenRules({ ...DARK, ...base }, 'color-scheme:dark;')}}`, Object.keys(base).length ? tokenRules(base) : '');
  else if (Object.keys(base).length) out.push(tokenRules(base));
  if (look.mode || Object.keys(base).length) out.push(`html[data-look] .ask-panel .ask-btn.primary,html[data-look] .ask-panel .ask-send,html[data-look] .ask-panel .ask-seg [aria-pressed=true]{color:${accentText}}`);
  // the page's own black-and-white parts follow the tokens
  // only when colours or a mode were chosen: an orb animation alone must not recolour the page
  if (look.mode || Object.keys(base).length) out.push('html[data-look] body{background:var(--w);color:var(--k)}html[data-look] .bar2{background:var(--v-bar,var(--k))}html[data-look] .bar2 button{background:var(--w);color:var(--k);border-color:var(--w)}' +
    'html[data-look] .bar2 button:hover{background:var(--y);color:#000}html[data-look] .meta,html[data-look] .hint{color:var(--v-muted,#444)}html[data-look] #out h1,html[data-look] #out h2,html[data-look] #out h3{color:var(--v-heading,var(--k))}' +
    'html[data-look] #out code,html[data-look] #out pre,html[data-look] #out div.math,html[data-look] #out th{background:var(--g1);color:var(--k)}' +
    'html[data-look] .ask-panel .ask-box,html[data-look] .ask-panel .ask-review,html[data-look] .ask-panel .ask-btn,html[data-look] .ask-panel .ask-chips button,html[data-look] .ask-panel select,html[data-look] .ask-panel input[type=text]{background:var(--g1);color:var(--k)}' +
    'html[data-look] .ask-panel .ask-msg.you{background:var(--g1)}html[data-look] .ask-panel textarea{color:var(--k)}');
  if (f.body || f.size || f.lineHeight || l.width || l.spacing) {
    out.push(`html[data-look] body{${f.body ? `font-family:${FONTS[f.body]};` : ''}${f.size ? `font-size:${f.size}px;` : ''}${f.lineHeight ? `line-height:${f.lineHeight};` : ''}}`);
    if (l.width) out.push(`html[data-look] #out,html[data-look] .meta{max-width:${l.width}px}`);
    if (l.spacing) out.push(`html[data-look] #out p,html[data-look] #out ul,html[data-look] #out ol{margin:${(8 * l.spacing).toFixed(1)}px 0}html[data-look] #out h2{margin-top:${Math.round(32 * l.spacing)}px}`);
  }
  if (f.heading) out.push(`html[data-look] #out h1,html[data-look] #out h2,html[data-look] #out h3{font-family:${FONTS[f.heading]}}`);
  if (f.code) out.push(`html[data-look] #out code,html[data-look] #out pre{font-family:${FONTS[f.code]}}`);
  if (l.headings) out.push(HEADS[l.headings].split('}').filter(Boolean).map(r => 'html[data-look] ' + r + '}').join(''));
  if (l.radius != null) out.push(`html[data-look] #out img,html[data-look] #out pre,html[data-look] #out table,html[data-look] #out blockquote,html[data-look] #out div.math,html[data-look] #out code,html[data-look] .bar2 button,html[data-look] #out .study-visual{border-radius:${l.radius}px}html[data-look] .ask-panel.floating{border-radius:${l.radius + 6}px}`);
  const o = look.orb || {};
  const corner = o.corner || 'bottom-right';
  out.push(`html[data-look] .ask-orb{${o.size ? `width:${o.size}px;height:${o.size}px;` : ''}${corner.includes('left') ? 'left:14px;right:auto;' : ''}${corner.includes('top') ? 'top:14px;bottom:auto;' : ''}${o.color ? `--orb-glow:${o.color};` : ''}}`);
  if (o.size) out.push(`html[data-look] .ask-face.glyph{font-size:${Math.round(o.size * 0.52)}px}`);
  if (o.glow === false) out.push('html[data-look] .ask-orb::before{display:none}');
  if (corner.includes('left')) out.push('html[data-look] .ask-orb::after{right:auto;left:calc(100% + 10px)}');
  for (const [name, block] of Object.entries(look.targets || {})) {
    const { hover, ...rest } = block;
    if (Object.keys(rest).length) out.push(rule(selectors(name), rest));
    if (hover && Object.keys(hover).length) out.push(rule(selectors(name, ':hover'), hover));
  }
  const used = new Set();
  for (const a of look.animate || []) {
    used.add(a.name);
    out.push(`${animSel(a)}{animation:v2s-${a.name} ${a.seconds}s ${a.ease} ${a.when === 'load' ? '1' : a.count === 'infinite' || a.when === 'always' ? 'infinite' : a.count} both;${a.target === 'orb' ? '' : 'transform-origin:center;'}}`);
  }
  if (used.size) out.push(keyframes, '@media (prefers-reduced-motion:reduce){html[data-look] *{animation:none!important}}');
  return out.filter(Boolean).join('\n');
}

/** Short summary of the saved look for the model (so it edits rather than starts again). */
export function lookSummary(look) {
  const s = JSON.stringify(look || {});
  return s === '{}' ? '(nothing changed yet: the original black-and-white look)' : s.slice(0, 1800);
}

// ---- the AI's instructions -----------------------------------------------------------------------------------------------
export const LOOK_GUIDE = `[TASK:UI_LOOK]
You restyle the notes page for the student. You never write code or CSS: reply with ONE JSON object (no other text) holding ONLY the keys that should change. {"reset":true} (or {"reset":["orb","colors"]}) goes back to the original look.
Keys (every value is checked; anything else is dropped):
- "mode": "light" | "dark" | "auto"
- "colors": {accent, paper, ink, muted, line, surface, heading, bar} as #rgb / #rrggbb. paper = page background, surface = code / table / formula background, bar = toolbar.
- "font": {body, heading, code: ${Object.keys(FONTS).join(' | ')}; size: 12-24 (px); lineHeight: 1.2-2.4}
- "layout": {width: 480-1400 (px, reading column), radius: 0-28, spacing: 0.6-1.8, headings: ${HEADING_STYLES.join(' | ')}}
- "orb": {icon, size: 28-84, color: #hex (glow), glow: true | false, label: hover text, corner: bottom-right | bottom-left | top-right | top-left}. icon is a preset (${Object.keys(ORB_ICONS).join(', ')}), OR any emoji or up to 3 characters ("🦉", "AI"), OR your own drawing as an inline <svg viewBox="0 0 64 64"> using only path, circle, ellipse, rect, line, polyline, polygon, g, defs, linearGradient, radialGradient, stop with plain attributes (no text, images, links, styles or scripts), under 3000 characters.
- "targets": {<part>: {<css property>: value, "hover": {<css property>: value}}}. Parts: ${Object.keys(TARGETS).join(', ')}. Properties: ${PROPS.join(', ')}. Values are plain CSS (colours, lengths, gradients, shadows, transforms); url(), var(), quotes and braces are refused.
- "animate": [{target: any part (the orb moves its icon), name: ${ANIMATIONS.join(' | ')}, when: hover | always | load, seconds: 0.15-20, count: 1-20 | "infinite", ease}]. This list REPLACES the current animations; send [] to stop them all.
Rules: change only what was asked; keep text readable (strong contrast, never tiny); keep animations calm unless asked; never hide the toolbar or the assistant. Reply {} if the request is not about the look.`;

// ---- DOM helpers ---------------------------------------------------------------------------------------------------------
export function loadLook() {
  try { const v = JSON.parse(localStorage.getItem(LOOK_KEY) || '{}'); return sanitizeStored(v); } catch { return {}; }
}
/** Stored looks pass the same checks again, so a hand-edited or corrupt value can never inject anything. */
export function sanitizeStored(v) { return mergeLook({}, sanitizeLook(v).patch); }
export function saveLook(look) { try { Object.keys(look).length ? localStorage.setItem(LOOK_KEY, JSON.stringify(look)) : localStorage.removeItem(LOOK_KEY); } catch { /* storage off: the look lasts until reload */ } }

/** Put a look on the page (or take it off) and update the orb. `orb` is the button element, when it exists. */
export function applyLook(look, orb) {
  const doc = document, root = doc.documentElement;
  let style = doc.getElementById('v2s-look');
  const css = lookCss(look);
  if (!css) { style?.remove(); root.removeAttribute('data-look'); }
  else {
    if (!style) { style = doc.createElement('style'); style.id = 'v2s-look'; doc.head.append(style); }
    style.textContent = css; root.setAttribute('data-look', look.mode || 'custom');
  }
  if (orb) paintOrb(orb, look?.orb || {});
}
export function paintOrb(orb, spec) {
  const face = orb.querySelector('.ask-face') || orb.appendChild(Object.assign(document.createElement('span'), { className: 'ask-face' }));
  const icon = orbIcon(spec.icon ?? 'dragonball') || orbIcon('dragonball');
  face.className = 'ask-face' + (icon.glyph ? ' glyph' : '');
  if (icon.glyph) face.textContent = icon.glyph; else face.innerHTML = icon.html; // html here is a preset or a rebuilt, whitelisted svg
  orb.dataset.label = spec.label || 'Ask this lecture';
  if (spec.color) orb.style.setProperty('--orb-glow', spec.color); else orb.style.removeProperty('--orb-glow');
}
