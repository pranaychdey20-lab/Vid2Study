/**
 * Visual registry for the interactive textbook. The writer (or the notes assistant) emits a fenced ```visual block holding
 * ONE small JSON object; everything else is done here, by trusted code: validation, maths, layout, SVG, sliders.
 * Model data is never executed: formulas go through `compileExpr` (a tiny parser, no eval), every number is range-checked,
 * every string is escaped.
 *
 * This file is also embedded, as it is, in exported HTML (see `visualRuntime`), so it must stay free of imports and of
 * browser-only globals outside `bindVisuals`. Add a visual = one entry in REG (+ one line in GUIDE).
 *   REG[type] = { label, aliases?, read(input) -> spec|null, controls?(spec) -> [{name,label,min,max,step,value,unit?}],
 *                 body(spec, params, ctx) -> html (re-rendered on every slider move), foot?(spec, ctx) -> static html }
 */
const esc = value => String(value).replace(/[&<>"']/g, ch => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch]);
const finite = Number.isFinite;
const clamp = (value, lo, hi) => Math.min(hi, Math.max(lo, value));
const fmt = (value, digits = 2) => { const r = Math.round(value * 10 ** digits) / 10 ** digits; return String(Object.is(r, -0) ? 0 : r); };
const text = (value, max = 120) => (typeof value === 'string' && value.length <= max ? value : null);
const label = (value, max = 80) => text(value, max) ?? '';
const nums = (list, { min = 1, max = 200, lo = -1e6, hi = 1e6 } = {}) =>
  Array.isArray(list) && list.length >= min && list.length <= max && list.every(v => finite(v) && v >= lo && v <= hi);
const grid = (rows, { maxRows = 12, maxCols = 12, lo = -1e6, hi = 1e6 } = {}) =>
  Array.isArray(rows) && rows.length > 0 && rows.length <= maxRows && Array.isArray(rows[0]) && rows[0].length > 0 && rows[0].length <= maxCols &&
  rows.every(row => nums(row, { min: rows[0].length, max: rows[0].length, lo, hi }));
const byte = value => Number.isInteger(value) && value >= 0 && value <= 255;
const clampByte = value => clamp(Math.round(value), 0, 255);
const hex2 = value => clampByte(value).toString(16).padStart(2, '0');

// ---------------------------------------------------------------------------------------------------------------------
// Expressions: "a*sin(b*x)+c" -> a function of an environment. No eval, no property access, bounded size.
// ---------------------------------------------------------------------------------------------------------------------
const FUNCTIONS = {
  sin: Math.sin, cos: Math.cos, tan: Math.tan, asin: Math.asin, acos: Math.acos, atan: Math.atan, sinh: Math.sinh, cosh: Math.cosh,
  tanh: Math.tanh, exp: Math.exp, ln: Math.log, log: Math.log10, log2: Math.log2, sqrt: Math.sqrt, abs: Math.abs, floor: Math.floor,
  ceil: Math.ceil, round: Math.round, sign: Math.sign, min: Math.min, max: Math.max, pow: Math.pow, atan2: Math.atan2
};
const CONSTANTS = { pi: Math.PI, e: Math.E };

export function compileExpr(source, names = []) {
  const src = String(source ?? '').replace(/\s+/g, '').replace(/\*\*/g, '^').replace(/×|·/g, '*');
  if (!src || src.length > 160 || !/^[\w.+\-*/^(),]+$/.test(src)) return null;
  const vars = new Set(names);
  let i = 0, depth = 0;
  const fail = () => { throw new SyntaxError('bad expression'); };
  const peek = () => src[i];
  function expr() {
    let left = term();
    while (peek() === '+' || peek() === '-') { const op = src[i++], right = term(), l = left; left = op === '+' ? env => l(env) + right(env) : env => l(env) - right(env); }
    return left;
  }
  function term() {
    let left = unary();
    for (;;) {
      const c = peek();
      if (c === '*' || c === '/') {
        i++;
        const right = unary(), l = left;
        left = c === '*' ? env => l(env) * right(env) : env => l(env) / right(env);
      } else if (c && (/[A-Za-z(]/.test(c))) { const right = power(), l = left; left = env => l(env) * right(env); } // 2x, 3(x+1)
      else return left;
    }
  }
  function unary() {
    if (peek() === '-') { i++; const v = unary(); return env => -v(env); }
    if (peek() === '+') { i++; return unary(); }
    return power();
  }
  function power() {
    const base = atom();
    if (peek() === '^') { i++; const exponent = unary(); return env => base(env) ** exponent(env); }
    return base;
  }
  function atom() {
    if (++depth > 40) fail();
    try {
      const c = peek();
      if (c === '(') { i++; const v = expr(); if (src[i++] !== ')') fail(); return v; }
      let m = /^\d+(?:\.\d+)?(?:e[+-]?\d+)?/i.exec(src.slice(i));
      if (m && !/^e(?![+-]?\d)/i.test(m[0])) { i += m[0].length; const n = Number(m[0]); return () => n; }
      m = /^[A-Za-z_]\w*/.exec(src.slice(i));
      if (!m) fail();
      const name = m[0];
      i += name.length;
      if (peek() === '(' && Object.hasOwn(FUNCTIONS, name)) {
        i++;
        const args = [];
        if (peek() !== ')') for (;;) { args.push(expr()); if (peek() === ',') { i++; continue; } break; }
        if (src[i++] !== ')') fail();
        const fn = FUNCTIONS[name];
        return env => fn(...args.map(a => a(env)));
      }
      if (vars.has(name)) return env => env[name];
      if (Object.hasOwn(CONSTANTS, name)) { const k = CONSTANTS[name]; return () => k; }
      return fail();
    } finally { depth--; }
  }
  try { const fn = expr(); if (i !== src.length) return null; return fn; } catch { return null; }
}

// ---------------------------------------------------------------------------------------------------------------------
// Small drawing kit (SVG strings). Colours come from CSS variables so the same markup works in light, dark and print.
// ---------------------------------------------------------------------------------------------------------------------
const SERIES = i => 'var(--sv-' + (i % 6 + 1) + ')';
function niceTicks(lo, hi, count = 5) {
  const span = hi - lo || 1, raw = span / count, mag = 10 ** Math.floor(Math.log10(raw)), norm = raw / mag;
  const step = (norm < 1.5 ? 1 : norm < 3 ? 2 : norm < 7 ? 5 : 10) * mag, out = [];
  for (let v = Math.ceil(lo / step - 1e-9) * step; v <= hi + step * 1e-9 && out.length < 40; v += step) out.push(+v.toFixed(10));
  return out;
}
/** Axes + grid + labels around `draw(sx, sy)`. */
function plot({ xr, yr, xl = '', yl = '', w = 460, h = 280, xt, yt, draw, aria = 'Chart', cat }) {
  const m = { l: 50, r: 14, t: 12, b: xl ? 44 : 32 }, iw = w - m.l - m.r, ih = h - m.t - m.b;
  const sx = v => m.l + (v - xr[0]) / (xr[1] - xr[0] || 1) * iw, sy = v => m.t + ih - (v - yr[0]) / (yr[1] - yr[0] || 1) * ih;
  const xs = cat ? [] : xt || niceTicks(xr[0], xr[1], 6), ys = yt || niceTicks(yr[0], yr[1], 5);
  let s = '<svg class="sv-svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="' + esc(aria) + '">';
  for (const v of ys) s += '<line class="sv-grid" x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + sy(v).toFixed(1) + '" y2="' + sy(v).toFixed(1) + '"/><text class="sv-tick" x="' + (m.l - 6) + '" y="' + (sy(v) + 3.5).toFixed(1) + '" text-anchor="end">' + fmt(v, 3) + '</text>';
  for (const v of xs) s += '<line class="sv-grid" y1="' + m.t + '" y2="' + (h - m.b) + '" x1="' + sx(v).toFixed(1) + '" x2="' + sx(v).toFixed(1) + '"/><text class="sv-tick" y="' + (h - m.b + 15) + '" x="' + sx(v).toFixed(1) + '" text-anchor="middle">' + fmt(v, 3) + '</text>';
  if (xr[0] < 0 && xr[1] > 0) s += '<line class="sv-axis" y1="' + m.t + '" y2="' + (h - m.b) + '" x1="' + sx(0).toFixed(1) + '" x2="' + sx(0).toFixed(1) + '"/>';
  if (yr[0] < 0 && yr[1] > 0) s += '<line class="sv-axis" x1="' + m.l + '" x2="' + (w - m.r) + '" y1="' + sy(0).toFixed(1) + '" y2="' + sy(0).toFixed(1) + '"/>';
  s += '<rect class="sv-frame" x="' + m.l + '" y="' + m.t + '" width="' + iw + '" height="' + ih + '"/>';
  s += draw(sx, sy, { m, iw, ih, w, h });
  if (xl) s += '<text class="sv-label" x="' + (m.l + iw / 2) + '" y="' + (h - 6) + '" text-anchor="middle">' + esc(xl) + '</text>';
  if (yl) s += '<text class="sv-label" transform="translate(13 ' + (m.t + ih / 2) + ') rotate(-90)" text-anchor="middle">' + esc(yl) + '</text>';
  return s + '</svg>';
}
const polyline = (pts, color, extra = '') => '<polyline class="sv-line" fill="none" stroke="' + color + '" ' + extra + ' points="' + pts.map(p => p[0].toFixed(1) + ',' + p[1].toFixed(1)).join(' ') + '"/>';
const legend = items => items.length > 1 ? '<div class="sv-legend">' + items.map((name, i) => '<span><i style="background:' + SERIES(i) + '"></i>' + esc(name) + '</span>').join('') + '</div>' : '';
const readout = rows => '<dl class="sv-read">' + rows.map(([k, v]) => '<div><dt>' + esc(k) + '</dt><dd>' + esc(v) + '</dd></div>').join('') + '</dl>';
const matrixHtml = (rows, { name = '', mark = [] } = {}) => '<table class="study-matrix"' + (name ? ' aria-label="' + esc(name) + '"' : '') + '><tbody>' +
  rows.map((row, r) => '<tr>' + row.map((v, c) => '<td' + (mark.some(([a, b]) => a === r && b === c) ? ' class="sv-hit"' : '') + '>' + (typeof v === 'number' ? fmt(v, 3) : esc(v)) + '</td>').join('') + '</tr>').join('') + '</tbody></table>';
const shade = (value, max = 255) => { const v = clampByte(value / max * 255); return 'style="--shade:' + v + ';--ink:' + (v < 135 ? '#fff' : '#000') + '"'; };
const pixels = (list, width, { mark = [], numbers = true } = {}) => '<div class="study-pixels" style="--pixel-columns:' + width + '">' +
  list.map((v, i) => '<span ' + shade(v) + (mark.includes(i) ? ' class="sv-hit"' : '') + '>' + (numbers ? fmt(v, 1) : '') + '</span>').join('') + '</div>';
const math = (ctx, tex, display = false) => (ctx?.math?.(tex, display) ?? null) ?? esc(tex);

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}
const gaussian = rand => Math.sqrt(-2 * Math.log(1 - rand())) * Math.cos(2 * Math.PI * rand());
const erf = x => { const t = 1 / (1 + 0.3275911 * Math.abs(x)); const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-x * x); return x >= 0 ? y : -y; };
const normalCdf = (x, mu, sd) => 0.5 * (1 + erf((x - mu) / (sd * Math.SQRT2)));
const quantile = (sorted, q) => { const pos = (sorted.length - 1) * q, lo = Math.floor(pos), hi = Math.ceil(pos); return sorted[lo] + (sorted[hi] - sorted[lo]) * (pos - lo); };
const mean = list => list.reduce((a, b) => a + b, 0) / list.length;
const stdev = list => Math.sqrt(list.reduce((a, b) => a + (b - mean(list)) ** 2, 0) / Math.max(1, list.length - 1));

/** A control for a slider: [min, max, value] or {min,max,value,step,label,unit}. */
function readParams(input, { max = 6 } = {}) {
  if (input == null) return {};
  if (typeof input !== 'object' || Array.isArray(input)) return null;
  const out = {};
  for (const [name, def] of Object.entries(input).slice(0, max)) {
    if (!/^[A-Za-z]\w{0,11}$/.test(name) || name in Object.prototype || Object.hasOwn(CONSTANTS, name) || Object.hasOwn(FUNCTIONS, name) || name === 'x' || name === 'y') return null;
    const d = Array.isArray(def) ? { min: def[0], max: def[1], value: def[2] } : def;
    if (!d || !finite(d.min) || !finite(d.max) || d.max <= d.min || !finite(d.value ?? d.min) || Math.abs(d.min) > 1e6 || Math.abs(d.max) > 1e6) return null;
    const value = clamp(d.value ?? d.min, d.min, d.max);
    out[name] = { min: d.min, max: d.max, value, step: finite(d.step) && d.step > 0 ? d.step : (d.max - d.min) / 100, label: label(d.label, 40) || name, unit: label(d.unit, 10) };
  }
  return out;
}
const paramControls = params => Object.entries(params).map(([name, d]) => ({ name, ...d }));

// ---------------------------------------------------------------------------------------------------------------------
// The registry
// ---------------------------------------------------------------------------------------------------------------------
const REG = {};
const define = (type, def) => { REG[type] = { ...def, type }; for (const alias of def.aliases || []) REG[alias] = REG[type]; };

// ---- pixels (image processing) -----------------------------------------------------------------------------------
const PIXEL_PARAMS = {
  brightness_contrast: { alpha: [0, 3, 0.05, 1, 'Contrast multiplier'], beta: [-255, 255, 1, 0, 'Brightness offset'] },
  gamma_correction: { gamma: [0.1, 4, 0.05, 1, 'Gamma'] },
  laplacian_sharpening: { alpha: [0, 3, 0.05, 1, 'Sharpening strength'] }
};
export function transformedPixels(type, list, params) {
  const clampPixel = value => Math.max(0, Math.min(255, Math.round(value)));
  return list.map((pixel, i) => {
    if (type === 'brightness_contrast') return clampPixel(params.alpha * pixel + params.beta);
    if (type === 'gamma_correction') return clampPixel(255 * (pixel / 255) ** params.gamma);
    if (type === 'laplacian_sharpening') {
      const left = list[i - 1] ?? pixel, right = list[i + 1] ?? pixel;
      return clampPixel(pixel - params.alpha * (left - 2 * pixel + right));
    }
    return pixel;
  });
}
const readPixels = (type, input) => {
  if (!nums(input.pixels, { max: 256, lo: 0, hi: 255 }) || !input.pixels.every(Number.isInteger)) return null;
  const n = input.pixels.length;
  const width = input.width ?? (type === 'laplacian_sharpening' ? n : Math.min(n, 8));
  if (!Number.isInteger(width) || width < 1 || width > Math.min(n, 16) || (input.width != null && n % width) || (type === 'laplacian_sharpening' && width !== n)) return null;
  return { pixels: input.pixels, width };
};
for (const type of ['pixel_grid', 'brightness_contrast', 'gamma_correction', 'laplacian_sharpening']) {
  const rules = PIXEL_PARAMS[type] || {};
  define(type, {
    label: { pixel_grid: 'Pixel intensities', brightness_contrast: 'Brightness and contrast', gamma_correction: 'Gamma correction', laplacian_sharpening: 'Laplacian sharpening (one-dimensional example)' }[type],
    aliases: type === 'pixel_grid' ? ['grayscale_grid'] : [],
    read(input) {
      const base = readPixels(type, input);
      if (!base) return null;
      const params = {};
      for (const [name, [min, max, , initial]] of Object.entries(rules)) {
        const value = input[name] ?? initial;
        if (!finite(value) || value < min || value > max) return null;
        params[name] = value;
      }
      return { ...base, params };
    },
    controls: () => Object.entries(rules).map(([name, [min, max, step, , name_]]) => ({ name, label: name_, min, max, step, value: undefined })),
    body(spec, params) {
      if (!Object.keys(rules).length) return pixels(spec.pixels, spec.width);
      const out = transformedPixels(type, spec.pixels, params);
      return '<div class="study-compare"><div><strong>Input</strong>' + pixels(spec.pixels, spec.width) + '</div><div><strong>Output</strong>' +
        '<div data-pixel-output>' + pixels(out, spec.width) + '</div></div></div>' +
        '<p class="study-parameters" data-visual-parameters>' + Object.entries(rules).map(([name, rule]) => rule[4] + ' = ' + fmt(params[name], 3)).join(' · ') + '</p>';
    }
  });
}

define('histogram', {
  label: 'Histogram', aliases: ['image_histogram', 'frequency_distribution'],
  read(input) {
    const title = { xlabel: label(input.xlabel), ylabel: label(input.ylabel) };
    if (Array.isArray(input.frequencies)) {
      if (!nums(input.frequencies, { max: 64, lo: 0 }) || (input.values && (!nums(input.values, { max: 64 }) || input.values.length !== input.frequencies.length))) return null;
      return { labels: (input.values || input.frequencies.map((_, i) => i)).map(v => fmt(v, 3)), counts: input.frequencies, ...title };
    }
    const source = input.pixels || input.data;
    if (!nums(source, { max: 5000 })) return null;
    const bins = input.bins ?? (input.pixels ? 8 : 6);
    if (!Number.isInteger(bins) || bins < 2 || bins > 32) return null;
    const lo = input.pixels ? 0 : Math.min(...source), hi = input.pixels ? 256 : Math.max(...source) + 1e-9, width = (hi - lo) / bins;
    const counts = Array(bins).fill(0);
    for (const v of source) counts[clamp(Math.floor((v - lo) / width), 0, bins - 1)]++;
    return { labels: counts.map((_, i) => fmt(lo + i * width, 2) + '–' + fmt(lo + (i + 1) * width - (input.pixels ? 1 : 0), 2)), counts, ...title };
  },
  body: spec => {
    const peak = Math.max(...spec.counts, 1), n = spec.counts.length;
    return plot({
      xr: [0, n], yr: [0, peak * 1.1], cat: true, xl: spec.xlabel, yl: spec.ylabel || 'Count', aria: 'Histogram',
      draw: (sx, sy, { h, m }) => spec.counts.map((c, i) => '<rect class="sv-bar" fill="' + SERIES(0) + '" x="' + (sx(i) + 1.5).toFixed(1) + '" y="' + sy(c).toFixed(1) + '" width="' + Math.max(1, sx(1) - sx(0) - 3).toFixed(1) + '" height="' + Math.max(0, sy(0) - sy(c)).toFixed(1) + '"/>' +
        '<text class="sv-tick" x="' + (sx(i + 0.5)).toFixed(1) + '" y="' + (sy(c) - 4).toFixed(1) + '" text-anchor="middle">' + fmt(c, 2) + '</text>' +
        '<text class="sv-tick" x="' + sx(i + 0.5).toFixed(1) + '" y="' + (h - m.b + 14) + '" text-anchor="middle">' + esc(spec.labels[i]) + '</text>').join('')
    });
  }
});

// ---- comparisons --------------------------------------------------------------------------------------------------
define('comparison_grid', {
  label: 'Comparison', aliases: ['comparison_cards', 'comparison_card', 'mathematical_comparison', 'statistical_comparison'],
  read(input) {
    const list = input.columns || input.cards;
    if (!Array.isArray(list) || list.length < 2 || list.length > 4) return null;
    const columns = [];
    for (const item of list) {
      if (!item || typeof item.title !== 'string' || item.title.length > 80) return null;
      if (item.matrix != null && !grid(item.matrix, { maxRows: 8, maxCols: 8 })) return null;
      if (item.items != null && (!Array.isArray(item.items) || item.items.length > 8 || !item.items.every(v => text(v, 200)))) return null;
      if (item.formula != null && !text(item.formula, 240)) return null;
      if (item.text != null && !text(item.text, 400)) return null;
      columns.push({ title: item.title, matrix: item.matrix || null, items: item.items || [], formula: item.formula || '', text: item.text || '' });
    }
    return { columns };
  },
  body: (spec, params, ctx) => '<div class="study-compare">' + spec.columns.map(column => '<div class="sv-card"><strong>' + esc(column.title) + '</strong>' +
    (column.matrix ? matrixHtml(column.matrix, { name: column.title + ' matrix' }) : '') +
    (column.text ? '<p>' + esc(column.text) + '</p>' : '') +
    (column.items.length ? '<ul>' + column.items.map(v => '<li>' + esc(v) + '</li>').join('') + '</ul>' : '') +
    (column.formula ? '<p class="math">' + math(ctx, column.formula) + '</p>' : '') + '</div>').join('') + '</div>'
});

// ---- mathematics --------------------------------------------------------------------------------------------------
define('equation_steps', {
  label: 'Step by step', aliases: ['math_block', 'equation'],
  read(input) {
    const list = Array.isArray(input.steps) ? input.steps : input.tex ? [input.tex] : null;
    if (!list || !list.length || list.length > 12) return null;
    const steps = list.map(step => typeof step === 'string' ? { tex: step, note: '' } : { tex: step?.tex, note: step?.note || '' });
    return steps.every(s => text(s.tex, 300) && typeof s.note === 'string' && s.note.length <= 200) ? { steps } : null;
  },
  body: (spec, params, ctx) => '<ol class="sv-steps">' + spec.steps.map(step => '<li><div class="math katex-block">' + math(ctx, step.tex, true) + '</div>' + (step.note ? '<p>' + esc(step.note) + '</p>' : '') + '</li>').join('') + '</ol>'
});

define('matrix', {
  label: 'Matrix', aliases: ['matrix_grid', 'kernel_grid', 'kernel'],
  read: input => grid(input.matrix || input.kernel, { maxRows: 10, maxCols: 10 }) ? { matrix: input.matrix || input.kernel, mark: Array.isArray(input.highlight) ? input.highlight.filter(p => Array.isArray(p) && p.length === 2).slice(0, 20) : [] } : null,
  body: spec => matrixHtml(spec.matrix, { mark: spec.mark })
});

define('matrix_operation', {
  label: 'Matrix operation',
  read(input) {
    const op = ['add', 'subtract', 'multiply', 'hadamard', 'transpose', 'scale', 'determinant'].includes(input.op) ? input.op : null;
    if (!op || !grid(input.a, { maxRows: 5, maxCols: 5 })) return null;
    const a = input.a, needB = ['add', 'subtract', 'multiply', 'hadamard'].includes(op);
    if (needB && !grid(input.b, { maxRows: 5, maxCols: 5 })) return null;
    const b = input.b;
    if (['add', 'subtract', 'hadamard'].includes(op) && (a.length !== b.length || a[0].length !== b[0].length)) return null;
    if (op === 'multiply' && a[0].length !== b.length) return null;
    if (op === 'scale' && !finite(input.k)) return null;
    if (op === 'determinant' && (a.length !== a[0].length || a.length > 3)) return null;
    return { op, a, b: needB ? b : null, k: input.k };
  },
  body(spec) {
    const { op, a, b, k } = spec;
    const sign = { add: '+', subtract: '−', multiply: '×', hadamard: '⊙', transpose: 'ᵀ', scale: '·', determinant: 'det' }[op];
    let result, note = '';
    if (op === 'add') result = a.map((row, r) => row.map((v, c) => v + b[r][c]));
    else if (op === 'subtract') result = a.map((row, r) => row.map((v, c) => v - b[r][c]));
    else if (op === 'hadamard') result = a.map((row, r) => row.map((v, c) => v * b[r][c]));
    else if (op === 'transpose') result = a[0].map((_, c) => a.map(row => row[c]));
    else if (op === 'scale') result = a.map(row => row.map(v => v * k));
    else if (op === 'multiply') {
      result = a.map(row => b[0].map((_, c) => row.reduce((s, v, j) => s + v * b[j][c], 0)));
      note = 'First entry = ' + a[0].map((v, j) => '(' + fmt(v, 3) + ')(' + fmt(b[j][0], 3) + ')').join(' + ') + ' = ' + fmt(result[0][0], 3);
    } else {
      const m = a, det = m.length === 1 ? m[0][0] : m.length === 2 ? m[0][0] * m[1][1] - m[0][1] * m[1][0]
        : m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
      return '<div class="sv-eq">' + matrixHtml(a, { name: 'A' }) + '<span class="sv-op">→ det(A) = ' + fmt(det, 4) + '</span></div>';
    }
    return '<div class="sv-eq">' + matrixHtml(a, { name: 'A' }) + '<span class="sv-op">' + sign + '</span>' + (b ? matrixHtml(b, { name: 'B' }) : op === 'scale' ? '<span class="sv-op">' + fmt(k, 3) + '</span>' : '') +
      '<span class="sv-op">=</span>' + matrixHtml(result, { name: 'Result' }) + '</div>' + (note ? '<p class="study-parameters">' + esc(note) + '</p>' : '');
  }
});

define('function_plot', {
  label: 'Function plot', aliases: ['slider_demo', 'interactive_slider', 'coordinate_plane_function'],
  read(input) {
    const params = readParams(input.params);
    if (!params) return null;
    const fns = (Array.isArray(input.fns) ? input.fns : [input.fn]).filter(Boolean).slice(0, 4);
    if (!fns.length) return null;
    const names = ['x', ...Object.keys(params)];
    const compiled = fns.map(f => typeof f === 'string' ? f : f?.expr);
    if (!compiled.every(f => compileExpr(f, names))) return null;
    const x0 = input.xmin ?? -5, x1 = input.xmax ?? 5;
    if (![x0, x1].every(finite) || x1 <= x0 || Math.abs(x0) > 1e5 || Math.abs(x1) > 1e5) return null;
    if ([input.ymin, input.ymax].some(v => v != null && !finite(v))) return null;
    return { fns: compiled, params, x0, x1, ymin: input.ymin ?? null, ymax: input.ymax ?? null, xlabel: label(input.xlabel) || 'x', ylabel: label(input.ylabel) || 'y' };
  },
  controls: spec => paramControls(spec.params),
  body(spec, params) {
    const names = ['x', ...Object.keys(spec.params)], N = 160, series = [];
    let lo = Infinity, hi = -Infinity;
    for (const src of spec.fns) {
      const fn = compileExpr(src, names), pts = [];
      for (let i = 0; i <= N; i++) {
        const x = spec.x0 + (spec.x1 - spec.x0) * i / N, y = fn({ ...params, x });
        if (finite(y) && Math.abs(y) < 1e9) { pts.push([x, y]); lo = Math.min(lo, y); hi = Math.max(hi, y); } else pts.push(null);
      }
      series.push(pts);
    }
    if (!finite(lo)) { lo = -1; hi = 1; }
    const pad = (hi - lo || 1) * 0.08;
    const yr = [spec.ymin ?? lo - pad, spec.ymax ?? hi + pad];
    const svg = plot({
      xr: [spec.x0, spec.x1], yr, xl: spec.xlabel, yl: spec.ylabel, aria: 'Plot of ' + spec.fns.join(', '),
      draw: (sx, sy, { m, ih }) => series.map((pts, k) => {
        const runs = [];
        let run = [];
        for (const p of pts) { if (p && p[1] >= yr[0] - (yr[1] - yr[0]) && p[1] <= yr[1] + (yr[1] - yr[0])) run.push([sx(p[0]), clamp(sy(p[1]), m.t - 20, m.t + ih + 20)]); else { if (run.length) runs.push(run); run = []; } }
        if (run.length) runs.push(run);
        return runs.map(r => polyline(r, SERIES(k))).join('');
      }).join('')
    });
    return svg + legend(spec.fns.length > 1 ? spec.fns : []) + '<p class="study-parameters">' + spec.fns.map(f => esc(f)).join('   ·   ') + (Object.keys(params).length ? '   with   ' + Object.entries(params).map(([k, v]) => k + ' = ' + fmt(v, 3)).join(', ') : '') + '</p>';
  }
});

define('surface_plot', {
  label: 'Surface (colour map)', aliases: ['surface_plot_3d', 'heatmap'],
  read(input) {
    const params = readParams(input.params, { max: 4 });
    if (!params || !compileExpr(input.fn, ['x', 'y', ...Object.keys(params)])) return null;
    const r = (a, d) => Array.isArray(a) && a.length === 2 && a.every(finite) && a[1] > a[0] && a.every(v => Math.abs(v) < 1e5) ? a : d;
    return { fn: input.fn, params, xr: r(input.xr, [-3, 3]), yr: r(input.yr, [-3, 3]) };
  },
  controls: spec => paramControls(spec.params),
  body(spec, params) {
    const n = 24, fn = compileExpr(spec.fn, ['x', 'y', ...Object.keys(spec.params)]);
    const z = [];
    let lo = Infinity, hi = -Infinity;
    for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
      const v = fn({ ...params, x: spec.xr[0] + (spec.xr[1] - spec.xr[0]) * (i + .5) / n, y: spec.yr[1] - (spec.yr[1] - spec.yr[0]) * (j + .5) / n });
      z.push(finite(v) ? v : 0); if (finite(v)) { lo = Math.min(lo, v); hi = Math.max(hi, v); }
    }
    const cells = z.map((v, k) => { const t = (v - lo) / ((hi - lo) || 1); return '<rect x="' + (k % n) * 10 + '" y="' + Math.floor(k / n) * 10 + '" width="10.5" height="10.5" fill="hsl(' + Math.round(250 - 230 * t) + ' 70% ' + Math.round(30 + 35 * t) + '%)"/>'; }).join('');
    return '<svg class="sv-svg sv-square" viewBox="0 0 240 240" role="img" aria-label="Colour map of ' + esc(spec.fn) + '">' + cells + '</svg>' +
      '<p class="study-parameters">z = ' + esc(spec.fn) + ' · x from ' + fmt(spec.xr[0]) + ' to ' + fmt(spec.xr[1]) + ' · y from ' + fmt(spec.yr[0]) + ' to ' + fmt(spec.yr[1]) + ' · z from ' + fmt(lo, 3) + ' (blue) to ' + fmt(hi, 3) + ' (red)</p>';
  }
});

define('numerical_calculator', {
  label: 'Calculator', aliases: ['calculator'],
  read(input) {
    const params = readParams(input.vars || input.params);
    if (!params || !Object.keys(params).length || !compileExpr(input.expr, Object.keys(params))) return null;
    return { expr: input.expr, params, result: label(input.result) || 'Result', unit: label(input.unit, 12) };
  },
  controls: spec => paramControls(spec.params),
  body(spec, params) {
    const value = compileExpr(spec.expr, Object.keys(spec.params))(params);
    return readout([...Object.entries(params).map(([k, v]) => [spec.params[k].label, fmt(v, 3) + (spec.params[k].unit ? ' ' + spec.params[k].unit : '')]), [spec.result + ' = ' + spec.expr, finite(value) ? fmt(value, 4) + (spec.unit ? ' ' + spec.unit : '') : 'undefined']]);
  }
});

define('coordinate_plane', {
  label: 'Coordinate plane', aliases: ['number_line_plane'],
  read(input) {
    const points = input.points ?? [], lines = input.lines ?? [];
    if (!Array.isArray(points) || points.length > 30 || !points.every(p => p && finite(p.x) && finite(p.y) && Math.abs(p.x) < 1e5 && Math.abs(p.y) < 1e5)) return null;
    if (!Array.isArray(lines) || lines.length > 12 || !lines.every(l => l && [l.x1, l.y1, l.x2, l.y2].every(finite))) return null;
    const xs = [...points.map(p => p.x), ...lines.flatMap(l => [l.x1, l.x2])], ys = [...points.map(p => p.y), ...lines.flatMap(l => [l.y1, l.y2])];
    if (!xs.length) return null;
    const range = (arr, given) => Array.isArray(given) && given.length === 2 && given.every(finite) && given[1] > given[0] ? given : [Math.min(0, ...arr) - 1, Math.max(0, ...arr) + 1];
    return { points: points.map(p => ({ x: p.x, y: p.y, label: label(p.label, 30) })), lines, xr: range(xs, input.xr), yr: range(ys, input.yr) };
  },
  body: spec => plot({
    xr: spec.xr, yr: spec.yr, xl: 'x', yl: 'y', aria: 'Coordinate plane',
    draw: (sx, sy) => spec.lines.map((l, i) => '<line class="sv-line" stroke="' + SERIES(i + 1) + '" x1="' + sx(l.x1).toFixed(1) + '" y1="' + sy(l.y1).toFixed(1) + '" x2="' + sx(l.x2).toFixed(1) + '" y2="' + sy(l.y2).toFixed(1) + '"/>').join('') +
      spec.points.map(p => '<circle cx="' + sx(p.x).toFixed(1) + '" cy="' + sy(p.y).toFixed(1) + '" r="4.5" fill="' + SERIES(0) + '"/>' + (p.label ? '<text class="sv-note" x="' + (sx(p.x) + 8).toFixed(1) + '" y="' + (sy(p.y) - 6).toFixed(1) + '">' + esc(p.label) + '</text>' : '')).join('')
  })
});

define('number_line', {
  label: 'Number line',
  read(input) {
    if (![input.min, input.max].every(finite) || input.max <= input.min) return null;
    const points = input.points ?? [], intervals = input.intervals ?? [];
    if (!Array.isArray(points) || points.length > 20 || !points.every(p => p && finite(p.value))) return null;
    if (!Array.isArray(intervals) || intervals.length > 6 || !intervals.every(v => v && finite(v.from) && finite(v.to))) return null;
    return { min: input.min, max: input.max, points: points.map(p => ({ value: p.value, label: label(p.label, 30) })), intervals };
  },
  body(spec) {
    const w = 520, h = 90, x = v => 24 + (v - spec.min) / (spec.max - spec.min) * (w - 48);
    let s = '<svg class="sv-svg" viewBox="0 0 ' + w + ' ' + h + '" role="img" aria-label="Number line"><line class="sv-axis" x1="24" x2="' + (w - 24) + '" y1="52" y2="52"/>';
    for (const v of niceTicks(spec.min, spec.max, 10)) s += '<line class="sv-axis" x1="' + x(v) + '" x2="' + x(v) + '" y1="47" y2="57"/><text class="sv-tick" x="' + x(v) + '" y="73" text-anchor="middle">' + fmt(v, 3) + '</text>';
    spec.intervals.forEach((v, i) => { s += '<line class="sv-line" stroke="' + SERIES(i + 1) + '" stroke-width="6" x1="' + x(clamp(v.from, spec.min, spec.max)) + '" x2="' + x(clamp(v.to, spec.min, spec.max)) + '" y1="52" y2="52" opacity=".55"/>'; });
    for (const p of spec.points) s += '<circle cx="' + x(clamp(p.value, spec.min, spec.max)) + '" cy="52" r="5" fill="' + SERIES(0) + '"/><text class="sv-note" x="' + x(clamp(p.value, spec.min, spec.max)) + '" y="36" text-anchor="middle">' + esc(p.label || fmt(p.value, 3)) + '</text>';
    return s + '</svg>';
  }
});

define('vector_diagram', {
  label: 'Vectors', aliases: ['vector'],
  read(input) {
    const vectors = input.vectors;
    if (!Array.isArray(vectors) || !vectors.length || vectors.length > 6 || !vectors.every(v => v && finite(v.x) && finite(v.y) && Math.abs(v.x) < 1e5 && Math.abs(v.y) < 1e5)) return null;
    return { vectors: vectors.map(v => ({ x: v.x, y: v.y, label: label(v.label, 20) })), sum: input.sum === true || input.show_sum === true };
  },
  body(spec) {
    const all = spec.sum ? [...spec.vectors, { x: spec.vectors.reduce((a, v) => a + v.x, 0), y: spec.vectors.reduce((a, v) => a + v.y, 0), label: 'sum', dashed: true }] : spec.vectors;
    const ext = Math.max(1, ...all.flatMap(v => [Math.abs(v.x), Math.abs(v.y)])) * 1.2;
    return plot({
      xr: [-ext, ext], yr: [-ext, ext], aria: 'Vector diagram',
      draw: (sx, sy) => '<defs><marker id="sv-arrow" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>' +
        all.map((v, i) => '<line class="sv-line" ' + (v.dashed ? 'stroke-dasharray="6 4" ' : '') + 'stroke="' + SERIES(v.dashed ? 4 : i) + '" marker-end="url(#sv-arrow)" x1="' + sx(0).toFixed(1) + '" y1="' + sy(0).toFixed(1) + '" x2="' + sx(v.x).toFixed(1) + '" y2="' + sy(v.y).toFixed(1) + '"/>' +
          '<text class="sv-note" x="' + (sx(v.x) + 6).toFixed(1) + '" y="' + (sy(v.y) - 6).toFixed(1) + '">' + esc((v.label || 'v' + (i + 1)) + ' (' + fmt(v.x, 2) + ', ' + fmt(v.y, 2) + ')') + '</text>').join('')
    });
  }
});

define('vector_decomposition', {
  label: 'Vector components', aliases: ['force_components'],
  read: input => finite(input.magnitude) && input.magnitude > 0 && input.magnitude <= 1e5 && finite(input.angle ?? 30) ? { magnitude: input.magnitude, angle: input.angle ?? 30, unit: label(input.unit, 10), name: label(input.label, 12) || 'F' } : null,
  controls: spec => [{ name: 'magnitude', label: 'Magnitude', min: 0, max: spec.magnitude * 2, step: spec.magnitude / 50, value: spec.magnitude, unit: spec.unit }, { name: 'angle', label: 'Angle', min: 0, max: 360, step: 1, value: spec.angle, unit: '°' }],
  body(spec, params) {
    const rad = params.angle * Math.PI / 180, x = params.magnitude * Math.cos(rad), y = params.magnitude * Math.sin(rad), ext = spec.magnitude * 2.1;
    const svg = plot({
      xr: [-ext, ext], yr: [-ext, ext], aria: 'Vector components',
      draw: (sx, sy) => '<defs><marker id="sv-arrow2" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>' +
        '<line class="sv-line" stroke-dasharray="5 4" stroke="' + SERIES(2) + '" x1="' + sx(0) + '" y1="' + sy(0) + '" x2="' + sx(x) + '" y2="' + sy(0) + '"/><line class="sv-line" stroke-dasharray="5 4" stroke="' + SERIES(1) + '" x1="' + sx(x) + '" y1="' + sy(0) + '" x2="' + sx(x) + '" y2="' + sy(y) + '"/>' +
        '<line class="sv-line" stroke="' + SERIES(0) + '" marker-end="url(#sv-arrow2)" x1="' + sx(0) + '" y1="' + sy(0) + '" x2="' + sx(x) + '" y2="' + sy(y) + '"/>'
    });
    const u = spec.unit ? ' ' + spec.unit : '';
    return svg + readout([[spec.name + 'x = ' + spec.name + ' cos θ', fmt(x, 3) + u], [spec.name + 'y = ' + spec.name + ' sin θ', fmt(y, 3) + u], ['Check √(x²+y²)', fmt(Math.hypot(x, y), 3) + u]]);
  }
});

// ---- statistics ---------------------------------------------------------------------------------------------------
const readSeries = input => {
  const list = Array.isArray(input.series) ? input.series : Array.isArray(input.values) ? [{ name: label(input.name) || '', values: input.values }] : null;
  if (!list || !list.length || list.length > 4 || !list.every(s => s && nums(s.values, { max: 60 }) && s.values.length === list[0].values.length)) return null;
  return list.map(s => ({ name: label(s.name, 30), values: s.values }));
};
const categories = (input, n) => Array.isArray(input.labels) && input.labels.length === n && input.labels.every(v => text(String(v), 30) != null) ? input.labels.map(String) : Array.from({ length: n }, (_, i) => String(i + 1));

define('bar_chart', {
  label: 'Bar chart',
  read(input) {
    const series = readSeries(input);
    return series ? { series, labels: categories(input, series[0].values.length), xlabel: label(input.xlabel), ylabel: label(input.ylabel) } : null;
  },
  body(spec) {
    const n = spec.labels.length, k = spec.series.length, all = spec.series.flatMap(s => s.values);
    const lo = Math.min(0, ...all), hi = Math.max(0, ...all), pad = (hi - lo || 1) * 0.1;
    return plot({
      xr: [0, n], yr: [lo < 0 ? lo - pad : 0, hi + pad], cat: true, xl: spec.xlabel, yl: spec.ylabel, aria: 'Bar chart',
      draw: (sx, sy, { h, m }) => spec.labels.map((name, i) => '<text class="sv-tick" x="' + sx(i + 0.5).toFixed(1) + '" y="' + (h - m.b + 14) + '" text-anchor="middle">' + esc(name) + '</text>').join('') +
        spec.series.map((s, j) => s.values.map((v, i) => { const bw = (sx(1) - sx(0)) * 0.8 / k; return '<rect class="sv-bar" fill="' + SERIES(j) + '" x="' + (sx(i + 0.1) + j * bw).toFixed(1) + '" y="' + Math.min(sy(v), sy(0)).toFixed(1) + '" width="' + bw.toFixed(1) + '" height="' + Math.abs(sy(v) - sy(0)).toFixed(1) + '"/>'; }).join('')).join('')
    }) + legend(spec.series.map(s => s.name).filter(Boolean));
  }
});

define('line_chart', {
  label: 'Line chart',
  read(input) {
    const series = readSeries(input);
    if (!series) return null;
    const x = input.x ?? null;
    if (x && (!nums(x, { max: 60 }) || x.length !== series[0].values.length)) return null;
    return { series, x, labels: categories(input, series[0].values.length), xlabel: label(input.xlabel), ylabel: label(input.ylabel) };
  },
  body(spec) {
    const xs = spec.x || spec.series[0].values.map((_, i) => i), all = spec.series.flatMap(s => s.values);
    const lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo || 1) * 0.1;
    return plot({
      xr: [Math.min(...xs), Math.max(...xs) || 1], yr: [lo - pad, hi + pad], xl: spec.xlabel, yl: spec.ylabel, aria: 'Line chart', xt: spec.x ? undefined : xs,
      draw: (sx, sy) => spec.series.map((s, j) => polyline(s.values.map((v, i) => [sx(xs[i]), sy(v)]), SERIES(j)) + s.values.map((v, i) => '<circle cx="' + sx(xs[i]).toFixed(1) + '" cy="' + sy(v).toFixed(1) + '" r="3" fill="' + SERIES(j) + '"/>').join('')).join('')
    }) + legend(spec.series.map(s => s.name).filter(Boolean));
  }
});

define('scatter_plot', {
  label: 'Scatter plot', aliases: ['correlation_plot', 'scatter'],
  read(input) {
    if (input.r != null) { // generated cloud with a chosen correlation
      return finite(input.r) && Math.abs(input.r) <= 1 ? { generated: true, r: input.r, n: 40, xlabel: label(input.xlabel) || 'x', ylabel: label(input.ylabel) || 'y' } : null;
    }
    const points = input.points;
    if (!Array.isArray(points) || points.length < 2 || points.length > 200 || !points.every(p => Array.isArray(p) && p.length === 2 && p.every(finite) && p.every(v => Math.abs(v) < 1e6))) return null;
    return { points, fit: input.fit !== false, xlabel: label(input.xlabel) || 'x', ylabel: label(input.ylabel) || 'y' };
  },
  controls: spec => spec.generated ? [{ name: 'r', label: 'Correlation r', min: -1, max: 1, step: 0.05, value: spec.r }] : [],
  body(spec, params) {
    let pts = spec.points;
    if (spec.generated) {
      const rand = mulberry32(7), r = params.r;
      pts = Array.from({ length: spec.n }, () => { const a = gaussian(rand), b = gaussian(rand); return [a, r * a + Math.sqrt(1 - r * r) * b]; });
    }
    const xs = pts.map(p => p[0]), ys = pts.map(p => p[1]), mx = mean(xs), my = mean(ys);
    const sxx = xs.reduce((a, v) => a + (v - mx) ** 2, 0), syy = ys.reduce((a, v) => a + (v - my) ** 2, 0), sxy = xs.reduce((a, v, i) => a + (v - mx) * (ys[i] - my), 0);
    const slope = sxx ? sxy / sxx : 0, icpt = my - slope * mx, r = sxx && syy ? sxy / Math.sqrt(sxx * syy) : 0;
    const pad = a => { const lo = Math.min(...a), hi = Math.max(...a), p = (hi - lo || 1) * 0.1; return [lo - p, hi + p]; };
    const xr = pad(xs), yr = pad(ys);
    const svg = plot({
      xr, yr, xl: spec.xlabel, yl: spec.ylabel, aria: 'Scatter plot',
      draw: (sx, sy) => pts.map(p => '<circle cx="' + sx(p[0]).toFixed(1) + '" cy="' + sy(p[1]).toFixed(1) + '" r="3.6" fill="' + SERIES(0) + '" opacity=".8"/>').join('') +
        (spec.generated || spec.fit ? '<line class="sv-line" stroke="' + SERIES(1) + '" x1="' + sx(xr[0]).toFixed(1) + '" y1="' + sy(slope * xr[0] + icpt).toFixed(1) + '" x2="' + sx(xr[1]).toFixed(1) + '" y2="' + sy(slope * xr[1] + icpt).toFixed(1) + '"/>' : '')
    });
    return svg + readout([['Correlation r', fmt(r, 3)], ['Least-squares line', 'y = ' + fmt(slope, 3) + 'x ' + (icpt < 0 ? '− ' : '+ ') + fmt(Math.abs(icpt), 3)]]);
  }
});

define('box_plot', {
  label: 'Box plot', aliases: ['statistical_summary'],
  read(input) {
    const groups = input.groups;
    if (!Array.isArray(groups) || !groups.length || groups.length > 6 || !groups.every(g => g && nums(g.values, { min: 4, max: 200 }))) return null;
    return { groups: groups.map((g, i) => ({ name: label(g.name, 30) || 'Group ' + (i + 1), values: g.values })), ylabel: label(input.ylabel) };
  },
  body(spec) {
    const stats = spec.groups.map(g => { const s = [...g.values].sort((a, b) => a - b), q1 = quantile(s, .25), q3 = quantile(s, .75), iqr = q3 - q1; const lo = s.find(v => v >= q1 - 1.5 * iqr), hi = [...s].reverse().find(v => v <= q3 + 1.5 * iqr); return { name: g.name, q1, q3, med: quantile(s, .5), lo, hi, out: s.filter(v => v < lo || v > hi), mean: mean(s), sd: stdev(s), n: s.length }; });
    const all = spec.groups.flatMap(g => g.values), lo = Math.min(...all), hi = Math.max(...all), pad = (hi - lo || 1) * 0.1;
    const svg = plot({
      xr: [0, stats.length], yr: [lo - pad, hi + pad], cat: true, yl: spec.ylabel, aria: 'Box plot',
      draw: (sx, sy, { h, m }) => stats.map((s, i) => { const c = sx(i + .5), bw = (sx(1) - sx(0)) * 0.5; return '<text class="sv-tick" x="' + c + '" y="' + (h - m.b + 14) + '" text-anchor="middle">' + esc(s.name) + '</text>' +
        '<line class="sv-line" stroke="' + SERIES(i) + '" x1="' + c + '" x2="' + c + '" y1="' + sy(s.lo) + '" y2="' + sy(s.hi) + '"/><rect fill="' + SERIES(i) + '" fill-opacity=".25" stroke="' + SERIES(i) + '" stroke-width="2" x="' + (c - bw / 2) + '" y="' + sy(s.q3) + '" width="' + bw + '" height="' + Math.max(1, sy(s.q1) - sy(s.q3)) + '"/><line class="sv-line" stroke="' + SERIES(i) + '" stroke-width="3" x1="' + (c - bw / 2) + '" x2="' + (c + bw / 2) + '" y1="' + sy(s.med) + '" y2="' + sy(s.med) + '"/>' +
        s.out.map(v => '<circle cx="' + c + '" cy="' + sy(v) + '" r="3" fill="none" stroke="' + SERIES(i) + '" stroke-width="1.5"/>').join(''); }).join('')
    });
    return svg + '<table class="sv-table"><thead><tr><th></th><th>n</th><th>Mean</th><th>Std dev</th><th>Q1</th><th>Median</th><th>Q3</th></tr></thead><tbody>' +
      stats.map(s => '<tr><th>' + esc(s.name) + '</th><td>' + s.n + '</td><td>' + fmt(s.mean, 3) + '</td><td>' + fmt(s.sd, 3) + '</td><td>' + fmt(s.q1, 3) + '</td><td>' + fmt(s.med, 3) + '</td><td>' + fmt(s.q3, 3) + '</td></tr>').join('') + '</tbody></table>';
  }
});

define('normal_distribution', {
  label: 'Normal distribution', aliases: ['probability_distribution_normal', 'gaussian'],
  read: input => finite(input.mu ?? 0) && finite(input.sigma ?? 1) && (input.sigma ?? 1) > 0 && Math.abs(input.mu ?? 0) < 1e5 && (input.sigma ?? 1) < 1e5 &&
    (input.shade == null || (Array.isArray(input.shade) && input.shade.length === 2 && input.shade.every(finite))) ? { mu: input.mu ?? 0, sigma: input.sigma ?? 1, shade: input.shade || null } : null,
  controls: spec => [{ name: 'mu', label: 'Mean μ', min: spec.mu - 3 * spec.sigma, max: spec.mu + 3 * spec.sigma, step: spec.sigma / 20, value: spec.mu }, { name: 'sigma', label: 'Std dev σ', min: spec.sigma / 4, max: spec.sigma * 3, step: spec.sigma / 40, value: spec.sigma }],
  body(spec, params) {
    const { mu, sigma } = params, lo = spec.mu - 5 * spec.sigma, hi = spec.mu + 5 * spec.sigma, pdf = x => Math.exp(-0.5 * ((x - mu) / sigma) ** 2) / (sigma * Math.sqrt(2 * Math.PI));
    const top = pdf(mu) * 1.1, N = 120, pts = Array.from({ length: N + 1 }, (_, i) => { const x = lo + (hi - lo) * i / N; return [x, pdf(x)]; });
    const a = spec.shade ? clamp(spec.shade[0], lo, hi) : mu - sigma, b = spec.shade ? clamp(spec.shade[1], lo, hi) : mu + sigma;
    const svg = plot({
      xr: [lo, hi], yr: [0, Math.max(top, pdf(spec.mu) * 0.4)], xl: 'x', yl: 'Density', aria: 'Normal distribution',
      draw: (sx, sy) => { const area = pts.filter(p => p[0] >= a && p[0] <= b); return (area.length ? '<polygon fill="' + SERIES(0) + '" fill-opacity=".25" points="' + [[a, 0], ...area, [b, 0]].map(p => sx(p[0]).toFixed(1) + ',' + sy(p[1]).toFixed(1)).join(' ') + '"/>' : '') + polyline(pts.map(p => [sx(p[0]), sy(p[1])]), SERIES(0)) + '<line class="sv-axis" stroke-dasharray="4 3" x1="' + sx(mu) + '" x2="' + sx(mu) + '" y1="' + sy(0) + '" y2="' + sy(pdf(mu)) + '"/>'; }
    });
    return svg + readout([['μ, σ', fmt(mu, 3) + ', ' + fmt(sigma, 3)], ['P(' + fmt(a, 2) + ' ≤ X ≤ ' + fmt(b, 2) + ')', fmt(normalCdf(b, mu, sigma) - normalCdf(a, mu, sigma), 4)], ['Peak density', fmt(pdf(mu), 4)]]);
  }
});

define('probability_distribution', {
  label: 'Probability distribution', aliases: ['binomial', 'poisson', 'discrete_distribution'],
  read(input) {
    const kind = ['binomial', 'poisson', 'uniform'].includes(input.kind) ? input.kind : input.type === 'poisson' ? 'poisson' : 'binomial';
    if (kind === 'binomial' && !(Number.isInteger(input.n ?? 10) && (input.n ?? 10) >= 1 && (input.n ?? 10) <= 40 && finite(input.p ?? 0.5) && (input.p ?? 0.5) >= 0 && (input.p ?? 0.5) <= 1)) return null;
    if (kind === 'poisson' && !(finite(input.lambda ?? 3) && (input.lambda ?? 3) > 0 && (input.lambda ?? 3) <= 20)) return null;
    return { kind, n: input.n ?? 10, p: input.p ?? 0.5, lambda: input.lambda ?? 3 };
  },
  controls: spec => spec.kind === 'binomial' ? [{ name: 'p', label: 'Probability p', min: 0.01, max: 0.99, step: 0.01, value: spec.p }] : spec.kind === 'poisson' ? [{ name: 'lambda', label: 'Rate λ', min: 0.5, max: 20, step: 0.5, value: spec.lambda }] : [],
  body(spec, params) {
    const K = spec.kind === 'binomial' ? spec.n : spec.kind === 'poisson' ? Math.ceil(params.lambda * 2 + 6) : 6;
    const logFact = n => { let s = 0; for (let i = 2; i <= n; i++) s += Math.log(i); return s; };
    const pm = Array.from({ length: K + 1 }, (_, k) => spec.kind === 'binomial'
      ? (params.p === 0 || params.p === 1 ? Number((k === 0) === (params.p === 0)) : Math.exp(logFact(spec.n) - logFact(k) - logFact(spec.n - k) + k * Math.log(params.p) + (spec.n - k) * Math.log(1 - params.p)))
      : spec.kind === 'poisson' ? Math.exp(-params.lambda + k * Math.log(params.lambda) - logFact(k)) : 1 / (K + 1));
    const m = pm.reduce((a, v, k) => a + k * v, 0), v = pm.reduce((a, p, k) => a + (k - m) ** 2 * p, 0);
    return plot({
      xr: [0, K + 1], yr: [0, Math.max(...pm) * 1.15], cat: true, xl: 'k', yl: 'P(X = k)', aria: 'Probability mass function',
      draw: (sx, sy, { h, m: mg }) => pm.map((p, k) => '<rect class="sv-bar" fill="' + SERIES(0) + '" x="' + (sx(k) + 2).toFixed(1) + '" y="' + sy(p).toFixed(1) + '" width="' + Math.max(1, sx(1) - sx(0) - 4).toFixed(1) + '" height="' + (sy(0) - sy(p)).toFixed(1) + '"/><text class="sv-tick" x="' + sx(k + .5).toFixed(1) + '" y="' + (h - mg.b + 14) + '" text-anchor="middle">' + k + '</text>').join('')
    }) + readout([['Mean', fmt(m, 3)], ['Variance', fmt(v, 3)], ['Std dev', fmt(Math.sqrt(v), 3)]]);
  }
});

// ---- image processing ---------------------------------------------------------------------------------------------
define('convolution', {
  label: 'Convolution', aliases: ['convolution_simulator'],
  read(input) {
    if (!grid(input.image, { maxRows: 10, maxCols: 10, lo: -1e4, hi: 1e4 }) || !grid(input.kernel, { maxRows: 5, maxCols: 5, lo: -1e3, hi: 1e3 })) return null;
    const kh = input.kernel.length, kw = input.kernel[0].length;
    if (kh % 2 === 0 || kw % 2 === 0) return null;
    return { image: input.image, kernel: input.kernel, scale: finite(input.scale) && input.scale !== 0 ? input.scale : 1 };
  },
  controls(spec) { const n = spec.image.length * spec.image[0].length; return [{ name: 'cell', label: 'Output cell', min: 1, max: n, step: 1, value: 1 }]; },
  body(spec, params) {
    const H = spec.image.length, W = spec.image[0].length, kh = spec.kernel.length, kw = spec.kernel[0].length, ry = (kh - 1) / 2, rx = (kw - 1) / 2;
    const at = (y, x) => y < 0 || x < 0 || y >= H || x >= W ? 0 : spec.image[y][x];
    const out = spec.image.map((row, y) => row.map((_, x) => { let s = 0; for (let j = 0; j < kh; j++) for (let i = 0; i < kw; i++) s += spec.kernel[j][i] * at(y + j - ry, x + i - rx); return s / spec.scale; }));
    const cell = clamp(Math.round(params.cell) - 1, 0, H * W - 1), cy = Math.floor(cell / W), cx = cell % W;
    const marks = []; for (let j = 0; j < kh; j++) for (let i = 0; i < kw; i++) { const y = cy + j - ry, x = cx + i - rx; if (y >= 0 && x >= 0 && y < H && x < W) marks.push([y, x]); }
    const terms = []; for (let j = 0; j < kh; j++) for (let i = 0; i < kw; i++) terms.push('(' + fmt(spec.kernel[j][i], 3) + ')(' + fmt(at(cy + j - ry, cx + i - rx), 3) + ')');
    return '<div class="study-compare"><div><strong>Image</strong>' + matrixHtml(spec.image, { mark: marks }) + '</div><div><strong>Kernel</strong>' + matrixHtml(spec.kernel) + '</div><div><strong>Output</strong>' + matrixHtml(out, { mark: [[cy, cx]] }) + '</div></div>' +
      '<p class="study-parameters">Output[' + (cy + 1) + ', ' + (cx + 1) + '] = ' + (spec.scale !== 1 ? '(' : '') + terms.join(' + ') + (spec.scale !== 1 ? ') / ' + fmt(spec.scale, 3) : '') + ' = ' + fmt(out[cy][cx], 3) + '. Outside pixels count as 0.</p>';
  }
});

define('colour_mixer', {
  label: 'Colour mixer', aliases: ['color_mixer', 'rgb_channels', 'rgb_channel_viewer', 'colour_space_converter', 'color_space_converter'],
  read(input) {
    const rgb = input.rgb ?? [200, 120, 40];
    return Array.isArray(rgb) && rgb.length === 3 && rgb.every(byte) ? { rgb } : null;
  },
  controls: spec => ['Red', 'Green', 'Blue'].map((name, i) => ({ name: 'c' + i, label: name, min: 0, max: 255, step: 1, value: spec.rgb[i] })),
  body(spec, params) {
    const [r, g, b] = [params.c0, params.c1, params.c2].map(Math.round), R = r / 255, G = g / 255, B = b / 255;
    const max = Math.max(R, G, B), min = Math.min(R, G, B), d = max - min;
    let hue = d === 0 ? 0 : max === R ? ((G - B) / d + 6) % 6 : max === G ? (B - R) / d + 2 : (R - G) / d + 4;
    hue *= 60;
    const L = (max + min) / 2, Sv = max === 0 ? 0 : d / max, Sl = d === 0 ? 0 : d / (1 - Math.abs(2 * L - 1)), K = 1 - max;
    const chan = (v, c) => '<div class="sv-chan"><span class="sv-swatch" style="background:' + c + '"></span>' + v + '</div>';
    return '<div class="sv-mix"><span class="sv-swatch sv-big" style="background:rgb(' + r + ',' + g + ',' + b + ')"></span><div class="sv-chans">' +
      chan('R ' + r, 'rgb(' + r + ',0,0)') + chan('G ' + g, 'rgb(0,' + g + ',0)') + chan('B ' + b, 'rgb(0,0,' + b + ')') + chan('Gray ' + Math.round(0.299 * r + 0.587 * g + 0.114 * b), 'rgb(' + [0, 1, 2].map(() => Math.round(0.299 * r + 0.587 * g + 0.114 * b)).join(',') + ')') + '</div></div>' +
      readout([['Hex', '#' + hex2(r) + hex2(g) + hex2(b)], ['HSV', fmt(hue, 0) + '°, ' + fmt(Sv * 100, 0) + '%, ' + fmt(max * 100, 0) + '%'], ['HSL', fmt(hue, 0) + '°, ' + fmt(Sl * 100, 0) + '%, ' + fmt(L * 100, 0) + '%'], ['CMYK', [1 - R - K, 1 - G - K, 1 - B - K].map(v => fmt(K >= 1 ? 0 : v / (1 - K) * 100, 0) + '%').join(' ') + ' ' + fmt(K * 100, 0) + '%']]);
  }
});

define('noise_simulator', {
  label: 'Image noise', aliases: ['image_noise_simulator'],
  read(input) {
    const base = readPixels('pixel_grid', input);
    return base ? { ...base, kind: input.kind === 'salt_pepper' ? 'salt_pepper' : 'gaussian' } : null;
  },
  controls: spec => [{ name: 'amount', label: spec.kind === 'gaussian' ? 'Noise std dev' : 'Noise fraction', min: 0, max: spec.kind === 'gaussian' ? 80 : 0.5, step: spec.kind === 'gaussian' ? 1 : 0.01, value: 0 }],
  body(spec, params) {
    const rand = mulberry32(11);
    const noisy = spec.pixels.map(v => spec.kind === 'gaussian' ? clampByte(v + gaussian(rand) * params.amount) : rand() < params.amount ? (rand() < .5 ? 0 : 255) : v);
    const mse = noisy.reduce((a, v, i) => a + (v - spec.pixels[i]) ** 2, 0) / noisy.length;
    return '<div class="study-compare"><div><strong>Original</strong>' + pixels(spec.pixels, spec.width) + '</div><div><strong>With noise</strong>' + pixels(noisy, spec.width) + '</div></div>' +
      readout([['Mean squared error', fmt(mse, 2)], ['PSNR', mse ? fmt(10 * Math.log10(255 ** 2 / mse), 1) + ' dB' : '∞ (no change)']]);
  }
});

define('frequency_filter', {
  label: 'Frequency filter', aliases: ['frequency_filter_visualizer', 'low_pass_filter'],
  read(input) {
    const parts = input.components ?? [{ f: 2, a: 1 }, { f: 12, a: 0.5 }];
    if (!Array.isArray(parts) || !parts.length || parts.length > 5 || !parts.every(p => p && finite(p.f) && p.f > 0 && p.f <= 50 && finite(p.a) && Math.abs(p.a) <= 100)) return null;
    return { parts, mode: input.mode === 'highpass' ? 'highpass' : 'lowpass' };
  },
  controls: spec => [{ name: 'cutoff', label: 'Cut-off frequency', min: 0, max: 50, step: 0.5, value: Math.min(50, Math.max(...spec.parts.map(p => p.f)) / 2 + 1), unit: 'Hz' }],
  body(spec, params) {
    const keep = p => spec.mode === 'lowpass' ? p.f <= params.cutoff : p.f >= params.cutoff, N = 200;
    const sig = (t, filter) => spec.parts.reduce((s, p) => s + (filter && !keep(p) ? 0 : p.a * Math.sin(2 * Math.PI * p.f * t)), 0);
    const top = Math.max(1, spec.parts.reduce((s, p) => s + Math.abs(p.a), 0)) * 1.1;
    const time = plot({
      xr: [0, 1], yr: [-top, top], xl: 'Time (s)', yl: 'Signal', aria: 'Signal before and after filtering', h: 230,
      draw: (sx, sy) => polyline(Array.from({ length: N + 1 }, (_, i) => [sx(i / N), sy(sig(i / N, false))]), SERIES(5), 'opacity=".7"') + polyline(Array.from({ length: N + 1 }, (_, i) => [sx(i / N), sy(sig(i / N, true))]), SERIES(0))
    });
    const maxF = Math.max(20, ...spec.parts.map(p => p.f * 1.2)), maxA = Math.max(...spec.parts.map(p => Math.abs(p.a)), 1) * 1.15;
    const spectrum = plot({
      xr: [0, maxF], yr: [0, maxA], xl: 'Frequency (Hz)', yl: 'Amplitude', aria: 'Spectrum with cut-off', h: 200,
      draw: (sx, sy) => spec.parts.map(p => '<line class="sv-line" stroke-width="5" stroke="' + (keep(p) ? SERIES(0) : SERIES(5)) + '" x1="' + sx(p.f) + '" x2="' + sx(p.f) + '" y1="' + sy(0) + '" y2="' + sy(Math.abs(p.a)) + '"/>').join('') + '<line class="sv-line" stroke-dasharray="5 4" stroke="' + SERIES(4) + '" x1="' + sx(Math.min(params.cutoff, maxF)) + '" x2="' + sx(Math.min(params.cutoff, maxF)) + '" y1="' + sy(0) + '" y2="' + sy(maxA) + '"/>'
    });
    return '<div class="study-compare">' + spectrum + time + '</div><p class="study-parameters">Ideal ' + (spec.mode === 'lowpass' ? 'low-pass' : 'high-pass') + ' filter: grey = removed. The filter is calculated on the sine components, not on a measurement.</p>';
  }
});

// ---- engineering --------------------------------------------------------------------------------------------------
define('robot_arm', {
  label: 'Planar robot arm', aliases: ['robot_arm_diagram', 'kinematics_simulator', 'forward_kinematics'],
  read(input) {
    const links = input.links ?? [1, 1], angles = input.angles ?? links.map(() => 30);
    return nums(links, { min: 2, max: 3, lo: 0.01, hi: 1000 }) && nums(angles, { min: links.length, max: links.length, lo: -360, hi: 360 }) ? { links, angles } : null;
  },
  controls: spec => spec.links.map((_, i) => ({ name: 'q' + i, label: 'Joint ' + (i + 1) + ' angle θ' + (i + 1), min: -180, max: 180, step: 1, value: clamp(spec.angles[i], -180, 180), unit: '°' })),
  body(spec, params) {
    const reach = spec.links.reduce((a, b) => a + b, 0), pts = [[0, 0]];
    let ang = 0;
    spec.links.forEach((l, i) => { ang += params['q' + i] * Math.PI / 180; const p = pts[i]; pts.push([p[0] + l * Math.cos(ang), p[1] + l * Math.sin(ang)]); });
    const e = pts.at(-1), ext = reach * 1.15;
    const svg = plot({
      xr: [-ext, ext], yr: [-ext, ext], xl: 'x', yl: 'y', aria: 'Robot arm',
      draw: (sx, sy) => '<circle cx="' + sx(0) + '" cy="' + sy(0) + '" r="' + (sx(reach) - sx(0)).toFixed(1) + '" fill="none" stroke="' + SERIES(5) + '" stroke-dasharray="5 5"/>' +
        polyline(pts.map(p => [sx(p[0]), sy(p[1])]), SERIES(0), 'stroke-width="6" stroke-linecap="round" stroke-linejoin="round"') +
        pts.map((p, i) => '<circle cx="' + sx(p[0]).toFixed(1) + '" cy="' + sy(p[1]).toFixed(1) + '" r="' + (i === pts.length - 1 ? 6 : 5) + '" fill="' + (i === pts.length - 1 ? SERIES(1) : 'var(--sv-paper,#fff)') + '" stroke="' + SERIES(0) + '" stroke-width="2.5"/>').join('')
    });
    return svg + readout([['End effector', '(' + fmt(e[0], 3) + ', ' + fmt(e[1], 3) + ')'], ['Reach', fmt(Math.hypot(e[0], e[1]), 3) + ' of ' + fmt(reach, 3)], ['Orientation Σθ', fmt(ang * 180 / Math.PI, 1) + '°']]);
  }
});

define('free_body_diagram', {
  label: 'Free-body diagram', aliases: ['force_diagram'],
  read(input) {
    const forces = input.forces;
    return Array.isArray(forces) && forces.length >= 1 && forces.length <= 6 && forces.every(f => f && finite(f.magnitude) && f.magnitude >= 0 && f.magnitude <= 1e6 && finite(f.angle ?? 0) && text(f.label ?? '', 20) != null)
      ? { forces: forces.map(f => ({ label: f.label || 'F', magnitude: f.magnitude, angle: f.angle ?? 0 })), unit: label(input.unit, 8) || 'N' } : null;
  },
  controls: spec => spec.forces.map((f, i) => ({ name: 'f' + i, label: f.label, min: 0, max: Math.max(1, f.magnitude * 2), step: Math.max(0.1, f.magnitude / 50), value: f.magnitude, unit: spec.unit })),
  body(spec, params) {
    const mags = spec.forces.map((_, i) => params['f' + i]), top = Math.max(...mags, 1e-9), R = 100;
    const fx = spec.forces.map((f, i) => mags[i] * Math.cos(f.angle * Math.PI / 180)), fy = spec.forces.map((f, i) => mags[i] * Math.sin(f.angle * Math.PI / 180));
    const rx = fx.reduce((a, b) => a + b, 0), ry = fy.reduce((a, b) => a + b, 0), k = R / top;
    const arrows = spec.forces.map((f, i) => { const x = 160 + fx[i] * k, y = 110 - fy[i] * k; return '<line class="sv-line" stroke="' + SERIES(i) + '" marker-end="url(#sv-arrow3)" x1="160" y1="110" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><text class="sv-note" x="' + (x + (fx[i] >= 0 ? 6 : -6)).toFixed(1) + '" y="' + (y - 5).toFixed(1) + '" text-anchor="' + (fx[i] >= 0 ? 'start' : 'end') + '">' + esc(f.label) + ' = ' + fmt(mags[i], 2) + '</text>'; }).join('');
    return '<svg class="sv-svg" viewBox="0 0 320 220" role="img" aria-label="Free-body diagram"><defs><marker id="sv-arrow3" viewBox="0 0 10 10" refX="8" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>' +
      '<rect x="144" y="94" width="32" height="32" fill="var(--sv-paper,#fff)" stroke="currentColor" stroke-width="2"/>' + arrows + '</svg>' +
      readout([['ΣFx', fmt(rx, 3) + ' ' + spec.unit], ['ΣFy', fmt(ry, 3) + ' ' + spec.unit], ['Resultant', fmt(Math.hypot(rx, ry), 3) + ' ' + spec.unit + ' at ' + fmt(Math.atan2(ry, rx) * 180 / Math.PI, 1) + '°'], ['Equilibrium', Math.hypot(rx, ry) < 1e-6 ? 'yes (ΣF = 0)' : 'no']]);
  }
});

define('control_block', {
  label: 'Control block diagram', aliases: ['control_block_diagram', 'feedback_system'],
  read(input) {
    const blocks = input.blocks ?? ['Controller', 'Plant'];
    return Array.isArray(blocks) && blocks.length >= 1 && blocks.length <= 5 && blocks.every(b => text(b, 30)) && text(input.sensor ?? '', 30) != null
      ? { blocks, sensor: input.sensor || '', input: label(input.input, 12) || 'r(t)', output: label(input.output, 12) || 'y(t)', feedback: input.feedback !== false } : null;
  },
  body(spec) {
    const bw = 104, bh = 44, gap = 40, sumX = 96, y = 54, mid = y + bh / 2, n = spec.blocks.length;
    const x1 = sumX + 14, end = x1 + n * (bw + gap) + gap * 0.5, W = end + 70, fy = y + 104, H = spec.feedback ? fy + 30 : y + 80;
    const wire = (pts, arrow = false) => '<polyline fill="none" stroke="currentColor" stroke-width="1.8"' + (arrow ? ' marker-end="url(#sv-arrow4)"' : '') + ' points="' + pts.map(p => p.join(',')).join(' ') + '"/>';
    const box = (x, yy, w, text_, k) => '<rect x="' + x + '" y="' + yy + '" width="' + w + '" height="' + bh + '" rx="5" fill="var(--sv-paper,#fff)" stroke="' + SERIES(k) + '" stroke-width="2.2"/><text class="sv-note" x="' + (x + w / 2) + '" y="' + (yy + bh / 2 + 4) + '" text-anchor="middle">' + esc(text_) + '</text>';
    let s = '<svg class="sv-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Block diagram"><defs><marker id="sv-arrow4" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>';
    s += '<text class="sv-note" x="6" y="' + (mid - 8) + '">' + esc(spec.input) + '</text>' + wire([[6, mid], [sumX - 14, mid]], true);
    s += '<circle cx="' + sumX + '" cy="' + mid + '" r="14" fill="var(--sv-paper,#fff)" stroke="currentColor" stroke-width="1.8"/><text class="sv-note" x="' + sumX + '" y="' + (mid + 4) + '" text-anchor="middle">Σ</text><text class="sv-tick" x="' + (sumX - 24) + '" y="' + (mid - 6) + '">+</text>';
    if (spec.feedback) s += '<text class="sv-tick" x="' + (sumX + 6) + '" y="' + (mid + 30) + '">−</text>';
    let x = x1;
    spec.blocks.forEach((name, i) => { s += wire([[i ? x - gap : sumX + 14, mid], [x, mid]], true) + box(x, y, bw, name, i); x += bw + gap; });
    s += wire([[x - gap, mid], [end + 40, mid]], true) + '<text class="sv-note" x="' + (end + 6) + '" y="' + (mid - 8) + '">' + esc(spec.output) + '</text>';
    if (spec.feedback) {
      const tap = end - 6;
      if (spec.sensor) {
        const sw = 104, sx = (sumX + tap) / 2 - sw / 2;
        s += wire([[tap, mid], [tap, fy], [sx + sw, fy]]) + box(sx, fy - bh / 2, sw, spec.sensor, 4) + wire([[sx, fy], [sumX, fy], [sumX, mid + 14]], true);
      } else s += wire([[tap, mid], [tap, fy], [sumX, fy], [sumX, mid + 14]], true);
    }
    return s + '</svg>';
  }
});

define('signal_plot', {
  label: 'Signal', aliases: ['waveform', 'signal'],
  read(input) {
    const kind = ['sine', 'square', 'sawtooth', 'triangle'].includes(input.kind) ? input.kind : 'sine';
    const a = input.amplitude ?? 1, f = input.frequency ?? 2, ph = input.phase ?? 0;
    return [a, f, ph].every(finite) && a > 0 && a <= 1e4 && f > 0 && f <= 20 && Math.abs(ph) <= 360 ? { kind, amplitude: a, frequency: f, phase: ph, window: finite(input.window) && input.window > 0 && input.window <= 100 ? input.window : 1 } : null;
  },
  controls: spec => [{ name: 'amplitude', label: 'Amplitude', min: spec.amplitude / 4, max: spec.amplitude * 3, step: spec.amplitude / 20, value: spec.amplitude }, { name: 'frequency', label: 'Frequency', min: 0.5, max: 20, step: 0.5, value: spec.frequency, unit: 'Hz' }, { name: 'phase', label: 'Phase', min: -180, max: 180, step: 5, value: spec.phase, unit: '°' }],
  body(spec, params) {
    const wave = t => { const u = (((params.frequency * t + params.phase / 360) % 1) + 1) % 1; return params.amplitude * (spec.kind === 'sine' ? Math.sin(2 * Math.PI * u) : spec.kind === 'square' ? (u < .5 ? 1 : -1) : spec.kind === 'sawtooth' ? 2 * u - 1 : 1 - 4 * Math.abs(u - .5)); };
    const N = 400, top = spec.amplitude * 3.2;
    return plot({ xr: [0, spec.window], yr: [-top, top], xl: 'Time (s)', yl: 'Amplitude', aria: 'Signal', draw: (sx, sy) => polyline(Array.from({ length: N + 1 }, (_, i) => { const t = spec.window * i / N; return [sx(t), sy(wave(t))]; }), SERIES(0)) }) +
      readout([['Period T = 1/f', fmt(1 / params.frequency, 4) + ' s'], ['Peak-to-peak', fmt(2 * params.amplitude, 3)], ['RMS', fmt(params.amplitude * (spec.kind === 'sine' ? Math.SQRT1_2 : spec.kind === 'square' ? 1 : Math.sqrt(1 / 3)), 3)]]);
  }
});

define('circuit_diagram', {
  label: 'Circuit', aliases: ['circuit'],
  read(input) {
    const parts = input.elements;
    const ok = Array.isArray(parts) && parts.length >= 1 && parts.length <= 5 && parts.every(p => p && ['R', 'C', 'L'].includes(p.type) && finite(p.value) && p.value > 0 && p.value < 1e12 && text(p.label ?? '', 12) != null);
    return ok && finite(input.voltage ?? 0) ? { topology: input.topology === 'parallel' ? 'parallel' : 'series', parts: parts.map((p, i) => ({ type: p.type, value: p.value, label: p.label || p.type + (i + 1) })), voltage: input.voltage ?? null } : null;
  },
  body(spec) {
    const n = spec.parts.length, par = spec.topology === 'parallel';
    const W = par ? 90 + n * 110 : 100 + n * 110, H = par ? 150 : 120, wires = [], comps = [];
    const label_ = (p, x, y, anchor = 'middle') => '<text class="sv-note" x="' + x + '" y="' + y + '" text-anchor="' + anchor + '">' + esc(p.label + ' = ' + fmt(p.value, 3)) + '</text>';
    if (par) {
      const left = 40, right = W - 40, top = 30, bottom = H - 30;
      wires.push([[left, top], [right, top]], [[left, bottom], [right, bottom]], [[left, top], [left, bottom]]);
      spec.parts.forEach((p, i) => { const x = 90 + i * 110; wires.push([[x, top], [x, H / 2 - 20]], [[x, H / 2 + 20], [x, bottom]]); comps.push('<rect x="' + (x - 11) + '" y="' + (H / 2 - 20) + '" width="22" height="40" fill="var(--sv-paper,#fff)" stroke="' + SERIES(i) + '" stroke-width="2.2"/>' + label_(p, x + 16, H / 2 + 4, 'start')); });
    } else {
      const left = 36, right = W - 36, top = 40, bottom = H - 24;
      wires.push([[left, top], [right, top], [right, bottom], [left, bottom], [left, top]]);
      spec.parts.forEach((p, i) => { const x = 90 + i * 110; comps.push('<rect x="' + (x - 22) + '" y="' + (top - 12) + '" width="44" height="24" fill="var(--sv-paper,#fff)" stroke="' + SERIES(i) + '" stroke-width="2.2"/>' + label_(p, x, top - 20)); });
    }
    let s = '<svg class="sv-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Circuit">' + wires.map(w => '<polyline fill="none" stroke="currentColor" stroke-width="1.8" points="' + w.map(p => p.join(',')).join(' ') + '"/>').join('') + comps.join('');
    if (spec.voltage != null) s += '<circle cx="' + (par ? 40 : 36) + '" cy="' + (par ? H / 2 : (H + 16) / 2) + '" r="13" fill="var(--sv-paper,#fff)" stroke="currentColor" stroke-width="2"/><text class="sv-note" x="' + (par ? 40 : 36) + '" y="' + ((par ? H / 2 : (H + 16) / 2) + 4) + '" text-anchor="middle">V</text>';
    s += '</svg>';
    const rows = [], kinds = new Set(spec.parts.map(p => p.type)), eq = {};
    for (const k of kinds) {
      const v = spec.parts.filter(p => p.type === k).map(p => p.value), additive = (par && k === 'C') || (!par && k !== 'C');
      eq[k] = additive ? v.reduce((a, b) => a + b, 0) : 1 / v.reduce((a, b) => a + 1 / b, 0);
      rows.push([{ R: 'Equivalent resistance', C: 'Equivalent capacitance', L: 'Equivalent inductance' }[k], fmt(eq[k], 4)]);
    }
    if (kinds.size === 1 && kinds.has('R') && spec.voltage != null) rows.push(['Source current I = V / R', fmt(spec.voltage / eq.R, 4) + ' A']);
    return s + readout(rows);
  }
});

define('mass_spring_damper', {
  label: 'Mass-spring-damper', aliases: ['mechanical_system_diagram', 'mechanical_system'],
  read: input => [input.m ?? 1, input.k ?? 20, input.c ?? 2].every(v => finite(v) && v > 0 && v < 1e6) ? { m: input.m ?? 1, k: input.k ?? 20, c: input.c ?? 2 } : null,
  controls: spec => [{ name: 'm', label: 'Mass m', min: spec.m / 4, max: spec.m * 4, step: spec.m / 20, value: spec.m, unit: 'kg' }, { name: 'k', label: 'Spring k', min: spec.k / 4, max: spec.k * 4, step: spec.k / 20, value: spec.k, unit: 'N/m' }, { name: 'c', label: 'Damping c', min: 0, max: spec.c * 6, step: spec.c / 20, value: spec.c, unit: 'N·s/m' }],
  body(spec, params) {
    const wn = Math.sqrt(params.k / params.m), zeta = params.c / (2 * Math.sqrt(params.k * params.m)), wd = wn * Math.sqrt(Math.max(0, 1 - zeta * zeta)), T = 6 / Math.max(0.2, zeta * wn || wn / 2);
    const x = t => zeta < 1 ? Math.exp(-zeta * wn * t) * (Math.cos(wd * t) + (zeta * wn / (wd || 1)) * Math.sin(wd * t)) : zeta === 1 ? (1 + wn * t) * Math.exp(-wn * t) : (() => { const s = Math.sqrt(zeta * zeta - 1), a = -wn * (zeta - s), b = -wn * (zeta + s); return (b * Math.exp(a * t) - a * Math.exp(b * t)) / (b - a); })();
    const N = 240, tmax = Math.min(T, 20);
    return plot({ xr: [0, tmax], yr: [-1.1, 1.1], xl: 'Time (s)', yl: 'Displacement (initial = 1)', aria: 'Free response', draw: (sx, sy) => polyline(Array.from({ length: N + 1 }, (_, i) => { const t = tmax * i / N; return [sx(t), sy(x(t))]; }), SERIES(0)) }) +
      readout([['Natural frequency ωₙ = √(k/m)', fmt(wn, 3) + ' rad/s'], ['Damping ratio ζ = c / 2√(km)', fmt(zeta, 3)], ['Behaviour', zeta === 0 ? 'undamped oscillation' : zeta < 1 ? 'underdamped (oscillates and decays)' : zeta === 1 ? 'critically damped' : 'overdamped (no oscillation)']]);
  }
});

// ---- general educational layouts ---------------------------------------------------------------------------------
define('process_flow', {
  label: 'Process', aliases: ['process', 'pipeline'],
  read(input) {
    const steps = input.steps;
    return Array.isArray(steps) && steps.length >= 2 && steps.length <= 10 && steps.every(s => typeof s === 'string' ? s.length <= 80 : s && text(s.title, 60) && text(s.text ?? '', 200) != null)
      ? { steps: steps.map(s => typeof s === 'string' ? { title: s, text: '' } : { title: s.title, text: s.text || '' }) } : null;
  },
  body: spec => '<ol class="sv-flow">' + spec.steps.map(s => '<li><strong>' + esc(s.title) + '</strong>' + (s.text ? '<span>' + esc(s.text) + '</span>' : '') + '</li>').join('') + '</ol>'
});

define('flowchart', {
  label: 'Flowchart', aliases: ['mermaid'],
  read(input) {
    const nodes = input.nodes, edges = input.edges;
    if (!Array.isArray(nodes) || nodes.length < 2 || nodes.length > 14 || !Array.isArray(edges) || edges.length > 30) return null;
    const ids = new Set();
    for (const n of nodes) { if (!n || !/^\w{1,12}$/.test(String(n.id)) || ids.has(String(n.id)) || !text(n.label, 40)) return null; ids.add(String(n.id)); }
    const list = edges.map(e => Array.isArray(e) ? { from: String(e[0]), to: String(e[1]), label: String(e[2] ?? '') } : { from: String(e?.from), to: String(e?.to), label: String(e?.label ?? '') });
    return list.every(e => ids.has(e.from) && ids.has(e.to) && e.label.length <= 24) ? { nodes: nodes.map(n => ({ id: String(n.id), label: n.label, shape: n.shape === 'decision' ? 'decision' : 'box' })), edges: list } : null;
  },
  body(spec) {
    const layer = new Map(spec.nodes.map(n => [n.id, 0]));
    for (let pass = 0; pass < spec.nodes.length; pass++) for (const e of spec.edges) if (e.from !== e.to && layer.get(e.to) <= layer.get(e.from) && layer.get(e.from) < spec.nodes.length) layer.set(e.to, layer.get(e.from) + 1);
    const rows = [];
    for (const n of spec.nodes) (rows[layer.get(n.id)] ||= []).push(n);
    const W = 560, rowH = 82, bw = 124, bh = 40, H = rows.length * rowH + 20, pos = new Map();
    rows.forEach((row, r) => row.forEach((n, i) => pos.set(n.id, [W * (i + 1) / (row.length + 1), 28 + r * rowH + bh / 2])));
    let s = '<svg class="sv-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Flowchart"><defs><marker id="sv-arrow5" viewBox="0 0 10 10" refX="9" refY="5" markerWidth="7" markerHeight="7" orient="auto"><path d="M0,0 L10,5 L0,10 z" fill="context-stroke"/></marker></defs>';
    for (const e of spec.edges) {
      const [x1, y1] = pos.get(e.from), [x2, y2] = pos.get(e.to), down = y2 > y1, back = y2 <= y1;
      const sy = back ? y1 : y1 + (down ? bh / 2 : 0), ty = back ? y2 : y2 - bh / 2;
      s += back ? '<path fill="none" stroke="currentColor" stroke-width="1.6" marker-end="url(#sv-arrow5)" d="M' + (x1 + bw / 2) + ' ' + y1 + ' C' + (x1 + bw / 2 + 60) + ' ' + y1 + ' ' + (x2 + bw / 2 + 60) + ' ' + y2 + ' ' + (x2 + bw / 2) + ' ' + y2 + '"/>'
        : '<line stroke="currentColor" stroke-width="1.6" marker-end="url(#sv-arrow5)" x1="' + x1.toFixed(1) + '" y1="' + sy + '" x2="' + x2.toFixed(1) + '" y2="' + (ty - 2) + '"/>';
      if (e.label) s += '<text class="sv-tick" x="' + ((x1 + x2) / 2 + 6).toFixed(1) + '" y="' + ((sy + ty) / 2).toFixed(1) + '">' + esc(e.label) + '</text>';
    }
    for (const n of spec.nodes) {
      const [x, y] = pos.get(n.id);
      s += n.shape === 'decision' ? '<polygon fill="var(--sv-paper,#fff)" stroke="' + SERIES(1) + '" stroke-width="2.2" points="' + [[x, y - bh / 2 - 4], [x + bw / 2, y], [x, y + bh / 2 + 4], [x - bw / 2, y]].map(p => p.join(',')).join(' ') + '"/>'
        : '<rect x="' + (x - bw / 2).toFixed(1) + '" y="' + (y - bh / 2) + '" width="' + bw + '" height="' + bh + '" rx="6" fill="var(--sv-paper,#fff)" stroke="' + SERIES(0) + '" stroke-width="2.2"/>';
      s += '<text class="sv-note" x="' + x.toFixed(1) + '" y="' + (y + 4) + '" text-anchor="middle">' + esc(n.label.length > 20 ? n.label.slice(0, 19) + '…' : n.label) + '</text>';
    }
    return s + '</svg>';
  }
});

define('timeline', {
  label: 'Timeline',
  read(input) {
    const events = input.events;
    return Array.isArray(events) && events.length >= 2 && events.length <= 12 && events.every(e => e && text(String(e.when), 30) && text(e.title, 80) && text(e.text ?? '', 240) != null) ? { events: events.map(e => ({ when: String(e.when), title: e.title, text: e.text || '' })) } : null;
  },
  body: spec => '<ol class="sv-timeline">' + spec.events.map(e => '<li><time>' + esc(e.when) + '</time><div><strong>' + esc(e.title) + '</strong>' + (e.text ? '<span>' + esc(e.text) + '</span>' : '') + '</div></li>').join('') + '</ol>'
});

define('concept_diagram', {
  label: 'Concept map', aliases: ['concept_map'],
  read(input) {
    return text(input.center, 40) && Array.isArray(input.nodes) && input.nodes.length >= 2 && input.nodes.length <= 8 && input.nodes.every(n => n && text(n.label, 30) && text(n.note ?? '', 80) != null)
      ? { center: input.center, nodes: input.nodes.map(n => ({ label: n.label, note: n.note || '' })) } : null;
  },
  body(spec) {
    const W = 560, H = 330, cx = W / 2, cy = H / 2, n = spec.nodes.length;
    let s = '<svg class="sv-svg" viewBox="0 0 ' + W + ' ' + H + '" role="img" aria-label="Concept map">';
    spec.nodes.forEach((node, i) => { const a = -Math.PI / 2 + 2 * Math.PI * i / n, x = cx + Math.cos(a) * 210, y = cy + Math.sin(a) * 120; s += '<line stroke="' + SERIES(i) + '" stroke-width="1.8" x1="' + cx + '" y1="' + cy + '" x2="' + x.toFixed(1) + '" y2="' + y.toFixed(1) + '"/><rect x="' + (x - 62).toFixed(1) + '" y="' + (y - 20).toFixed(1) + '" width="124" height="' + (node.note ? 44 : 34) + '" rx="8" fill="var(--sv-paper,#fff)" stroke="' + SERIES(i) + '" stroke-width="2"/><text class="sv-note" x="' + x.toFixed(1) + '" y="' + (y - 3).toFixed(1) + '" text-anchor="middle">' + esc(node.label) + '</text>' + (node.note ? '<text class="sv-tick" x="' + x.toFixed(1) + '" y="' + (y + 13).toFixed(1) + '" text-anchor="middle">' + esc(node.note.slice(0, 22)) + '</text>' : ''); });
    return s + '<ellipse cx="' + cx + '" cy="' + cy + '" rx="76" ry="34" fill="' + SERIES(0) + '"/><text x="' + cx + '" y="' + (cy + 5) + '" text-anchor="middle" fill="#fff" font-weight="700" font-size="14">' + esc(spec.center) + '</text></svg>';
  }
});

define('data_table', {
  label: 'Table', aliases: ['table'],
  read(input) {
    const cols = input.columns, rows = input.rows;
    return Array.isArray(cols) && cols.length >= 1 && cols.length <= 8 && cols.every(c => text(String(c), 40)) && Array.isArray(rows) && rows.length >= 1 && rows.length <= 30 && rows.every(r => Array.isArray(r) && r.length === cols.length && r.every(v => (typeof v === 'number' && finite(v)) || text(String(v), 120)))
      ? { columns: cols.map(String), rows } : null;
  },
  body: spec => '<table class="sv-table"><thead><tr>' + spec.columns.map(c => '<th>' + esc(c) + '</th>').join('') + '</tr></thead><tbody>' + spec.rows.map(r => '<tr>' + r.map(v => '<td>' + esc(v) + '</td>').join('') + '</tr>').join('') + '</tbody></table>'
});

define('before_after', {
  label: 'Before and after', aliases: ['before_after_comparison', 'image_comparison'],
  read(input) {
    return nums(input.before, { max: 256, lo: 0, hi: 255 }) && nums(input.after, { max: 256, lo: 0, hi: 255 }) && input.before.length === input.after.length && (input.width == null || (Number.isInteger(input.width) && input.width >= 1 && input.width <= 16 && input.before.length % input.width === 0))
      ? { before: input.before, after: input.after, width: input.width ?? Math.min(input.before.length, 8), cap: [label(input.beforeLabel) || 'Before', label(input.afterLabel) || 'After'] } : null;
  },
  body: spec => '<div class="study-compare"><div><strong>' + esc(spec.cap[0]) + '</strong>' + pixels(spec.before, spec.width) + '</div><div><strong>' + esc(spec.cap[1]) + '</strong>' + pixels(spec.after, spec.width) + '</div></div>' +
    readout([['Mean change', fmt(mean(spec.after.map((v, i) => v - spec.before[i])), 2)], ['Largest change', fmt(Math.max(...spec.after.map((v, i) => Math.abs(v - spec.before[i]))), 0)]])
});

define('stepper', {
  label: 'Step by step', aliases: ['step_by_step_simulation', 'step_simulation'],
  read(input) {
    const steps = input.steps;
    return Array.isArray(steps) && steps.length >= 2 && steps.length <= 12 && steps.every(s => s && text(s.title, 80) && text(s.text ?? '', 400) != null) ? { steps: steps.map(s => ({ title: s.title, text: s.text || '' })) } : null;
  },
  controls: spec => [{ name: 'step', label: 'Step', min: 1, max: spec.steps.length, step: 1, value: 1 }],
  body(spec, params) {
    const at = clamp(Math.round(params.step), 1, spec.steps.length);
    return '<ol class="sv-stepper">' + spec.steps.map((s, i) => '<li class="' + (i + 1 === at ? 'now' : i + 1 < at ? 'done' : 'todo') + '"><strong>' + esc(s.title) + '</strong>' + (i + 1 === at && s.text ? '<span>' + esc(s.text) + '</span>' : '') + '</li>').join('') + '</ol>';
  }
});

define('quiz', {
  label: 'Quick check', aliases: ['interactive_quiz'],
  read(input) {
    return text(input.question, 300) && Array.isArray(input.options) && input.options.length >= 2 && input.options.length <= 5 && input.options.every(o => text(o, 160)) && Number.isInteger(input.answer) && input.answer >= 0 && input.answer < input.options.length && text(input.explain ?? '', 400) != null
      ? { question: input.question, options: input.options, answer: input.answer, explain: input.explain || '' } : null;
  },
  body: (spec, params, ctx) => '<p class="sv-q">' + esc(spec.question) + '</p><div class="sv-opts" data-answer="' + spec.answer + '">' + spec.options.map((o, i) => '<button type="button" class="sv-opt' + (!ctx?.live && i === spec.answer ? ' right' : '') + '" data-i="' + i + '">' + esc(o) + '</button>').join('') + '</div><p class="sv-feedback" data-feedback' + (ctx?.live ? ' hidden' : '') + '>' + (!ctx?.live ? 'Answer: ' + esc(spec.options[spec.answer]) + '. ' : '') + esc(spec.explain) + '</p>'
});

define('reveal', {
  label: 'Try it', aliases: ['reveal_answer', 'expandable', 'expandable_explanation'],
  read(input) {
    const q = input.question ?? input.title, a = input.answer ?? input.text;
    return text(q, 300) && text(a, 1200) ? { question: q, answer: a } : null;
  },
  body: (spec, params, ctx) => '<p class="sv-q">' + esc(spec.question) + '</p><details class="sv-details"' + (ctx?.live ? '' : ' open') + '><summary>Show the answer</summary><p>' + esc(spec.answer) + '</p></details>'
});

// ---------------------------------------------------------------------------------------------------------------------
// Reading, rendering, running
// ---------------------------------------------------------------------------------------------------------------------
const norm = type => String(type ?? '').trim().replace(/([a-z])([A-Z])/g, '$1_$2').toLowerCase().replace(/[\s-]+/g, '_');

export function readVisual(json) {
  if (typeof json !== 'string' || json.length > 12000) return null;
  let input;
  try { input = JSON.parse(json); } catch { return null; }
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const def = Object.hasOwn(REG, norm(input.type)) ? REG[norm(input.type)] : null;
  if (!def) return null;
  let spec;
  try { spec = def.read(input); } catch { spec = null; }
  if (!spec) return null;
  return { ...spec, type: def.type, title: label(input.title, 120), caption: label(input.caption, 300), interactive: input.interactive !== false };
}

const controlsOf = spec => (REG[spec.type].controls?.(spec) ?? []).map(c => c.value === undefined ? { ...c, value: spec.params?.[c.name] } : c);
const initial = (spec, controls) => Object.fromEntries(controls.map(c => [c.name, clamp(c.value ?? c.min, c.min, c.max)]));

export function renderVisual(json, interactive = true, math) {
  const spec = readVisual(json);
  if (!spec) return '<p class="study-visual-unavailable">This visual could not be drawn. The explanation above it still holds.</p>';
  const def = REG[spec.type], controls = controlsOf(spec), params = initial(spec, controls);
  const live = interactive && spec.interactive && (controls.length > 0 || ['quiz', 'reveal'].includes(def.type));
  const form = live && controls.length ? '<div class="study-controls">' + controls.map(c => '<label>' + esc(c.label) + (c.unit ? ' (' + esc(c.unit) + ')' : '') + '<span class="sv-val" data-val>' + fmt(c.value ?? c.min, 3) + '</span><input type="range" name="' + esc(c.name) + '" min="' + c.min + '" max="' + c.max + '" step="' + c.step + '" value="' + clamp(c.value ?? c.min, c.min, c.max) + '"></label>').join('') + '<button type="button" data-reset>Reset</button></div>' : '';
  const stored = live ? ' data-study-visual="' + esc(JSON.stringify({ ...spec })) + '"' : '';
  return '<figure class="study-visual sv-' + esc(def.type) + '"' + stored + '><figcaption>' + esc(spec.title || def.label) + '</figcaption>' + form +
    '<div class="sv-body" data-sv-body>' + def.body(spec, params, { math, live }) + '</div>' + (spec.caption ? '<p class="sv-caption">' + esc(spec.caption) + '</p>' : '') + '</figure>';
}

/** Wire sliders, resets, quizzes. Safe to call twice. Runs in the page, also in exported HTML. */
export function bindVisuals(root) {
  for (const figure of root.querySelectorAll('[data-study-visual]')) {
    if (figure.dataset.bound) continue;
    figure.dataset.bound = 'true';
    let spec;
    try { spec = JSON.parse(figure.dataset.studyVisual); } catch { continue; }
    const def = REG[spec.type];
    if (!def) continue;
    const sliders = [...figure.querySelectorAll('input[type=range]')], target = figure.querySelector('[data-sv-body]');
    const update = () => {
      const params = Object.fromEntries(sliders.map(input => [input.name, Number(input.value)]));
      sliders.forEach(input => { const v = input.parentElement.querySelector('[data-val]'); if (v) v.textContent = String(Math.round(Number(input.value) * 1000) / 1000); });
      target.innerHTML = def.body(spec, params, { live: true });
    };
    if (sliders.length) {
      figure.addEventListener('input', update);
      figure.querySelector('[data-reset]')?.addEventListener('click', () => { for (const input of sliders) input.value = input.defaultValue; update(); });
      update();
    }
    figure.addEventListener('click', event => {
      const option = event.target.closest?.('.sv-opt');
      if (!option) return;
      const group = option.parentElement, answer = Number(group.dataset.answer), feedback = figure.querySelector('[data-feedback]');
      for (const button of group.children) button.classList.remove('right', 'wrong');
      option.classList.add(Number(option.dataset.i) === answer ? 'right' : 'wrong');
      if (feedback) { feedback.hidden = false; feedback.textContent = (Number(option.dataset.i) === answer ? 'Correct. ' : 'Not quite. ') + (spec.explain || ''); }
    });
  }
}

/**
 * The code embedded in an exported page: this whole file, as a module, plus the call that wires every visual.
 * (The module source is read from where it was loaded from; tests pass it in.)
 */
export async function visualRuntime(source) {
  const code = source ?? await (await fetch(import.meta.url)).text();
  // a classic script (a module cannot load from file://), wrapped so it leaves no globals; one copy is shared by a whole library
  return '(function(){\n' + code.replace(/^export (async )?(function|const|class)/gm, '$1$2').replace(/import\.meta\.url/g, "''").replace(/<\/script/gi, '<\\/script') + '\nbindVisuals(document);\n})();';
}

/** Compact list of what a ```visual block may hold, for prompts (keep short: it is paid for on every request). */
export const VISUAL_GUIDE = `VISUAL BLOCKS. Put a fenced block tagged visual, holding ONE JSON object, right after the sentence it explains. The extension validates, calculates, draws and makes it interactive: give only parameters, never arrays the app can compute, never HTML, SVG or code. Add "title" (short) and optionally "caption" (what to notice). Use the lecture's own values when known; call invented values illustrative.
Maths: equation_steps{steps:["tex",{tex,note}]} | matrix{matrix} | matrix_operation{op:add|subtract|multiply|hadamard|transpose|scale|determinant,a,b,k} | function_plot{fn:"a*sin(b*x)",params:{a:[min,max,start],b:[..]},xmin,xmax,fns:[..]} | surface_plot{fn:"x^2+y^2",xr,yr} | numerical_calculator{expr:"m*a",vars:{m:[min,max,start,"unit"]},result:"F"} | vector_diagram{vectors:[{x,y,label}],sum} | vector_decomposition{magnitude,angle} | coordinate_plane{points:[{x,y,label}],lines:[{x1,y1,x2,y2}]} | number_line{min,max,points:[{value,label}],intervals:[{from,to}]}
Statistics: histogram{values,frequencies} or {data,bins} or {pixels} | bar_chart{labels,values|series:[{name,values}]} | line_chart{labels|x,series} | scatter_plot{points:[[x,y]]} or {r:0.8} | box_plot{groups:[{name,values}]} | normal_distribution{mu,sigma,shade:[a,b]} | probability_distribution{kind:binomial|poisson,n,p,lambda}
Images: pixel_grid{pixels,width} | brightness_contrast{pixels,alpha,beta} | gamma_correction{pixels,gamma} | laplacian_sharpening{pixels,alpha} | convolution{image:[[..]],kernel:[[..]],scale} | before_after{before,after,width} | noise_simulator{pixels,width,kind:gaussian|salt_pepper} | colour_mixer{rgb:[r,g,b]} | frequency_filter{components:[{f,a}],mode:lowpass|highpass}   (pixels are integers 0-255)
Engineering: robot_arm{links:[l1,l2],angles:[a1,a2]} | free_body_diagram{forces:[{label,magnitude,angle}]} | control_block{blocks:["Controller","Plant"],sensor:"Sensor",input:"r(t)",output:"y(t)"} | signal_plot{kind:sine|square|sawtooth|triangle,amplitude,frequency,phase} | circuit_diagram{topology:series|parallel,elements:[{type:R|C|L,value,label}],voltage} | mass_spring_damper{m,k,c}
General: comparison_grid{columns:[{title,matrix|items|text,formula}]} (2-4 columns) | process_flow{steps:["..",{title,text}]} | flowchart{nodes:[{id,label,shape:decision}],edges:[[from,to,label]]} | timeline{events:[{when,title,text}]} | concept_diagram{center,nodes:[{label,note}]} | data_table{columns,rows} | stepper{steps:[{title,text}]} | quiz{question,options,answer:index,explain} | reveal{question,answer}
Example: {"type":"gamma_correction","pixels":[30,90,160,230],"gamma":0.6,"title":"Gamma 0.6 lifts the shadows"}`;

/** Types the app can draw, for validation messages and tests. */
export const VISUAL_TYPES = Object.keys(REG);
export const VISUAL_CANONICAL = [...new Set(Object.values(REG).map(def => def.type))];

export const VISUAL_CSS = `
.study-visual { --sv-1:#2f6db5; --sv-2:#d9731a; --sv-3:#3c8d5a; --sv-4:#8a5bb5; --sv-5:#c2415b; --sv-6:#7b8a94; --sv-paper:#fff; margin: 1.1rem 0; padding: .85rem 1rem 1rem; border: 1px solid #b9c5cb; border-top: 4px solid var(--sv-1); border-radius: 6px; color: #15222c; background: #f8fafb; break-inside: avoid; }
.study-visual figcaption { margin: 0 0 .6rem; font-weight: 700; font-size: 1em; color: inherit; }
.study-visual .sv-caption { margin: .6rem 0 0; font-size: .88em; color: #44545e; }
.study-controls { display: flex; flex-wrap: wrap; gap: .5rem 1.2rem; align-items: end; margin-bottom: .75rem; padding-bottom: .65rem; border-bottom: 1px dashed #b9c5cb; }
.study-controls label { text-transform: none; letter-spacing: 0; display: grid; grid-template-columns: 1fr auto; gap: .1rem .6rem; min-width: 11rem; font-size: .86em; font-weight: 600; }
.study-controls label input { grid-column: 1 / -1; width: 100%; accent-color: var(--sv-1); }
.study-controls .sv-val { font-variant-numeric: tabular-nums; font-weight: 500; color: #44545e; }
.study-controls button { font: inherit; font-size: .82em; padding: .25rem .7rem; border: 1px solid #81939c; border-radius: 4px; background: #fff; color: inherit; cursor: pointer; }
.study-controls button:hover { background: #e8eef1; }
.study-compare { display: flex; flex-wrap: wrap; gap: .7rem 1.2rem; align-items: start; margin-bottom: .5rem; }
.study-compare > div { min-width: 0; }
.sv-card { flex: 1 1 11rem; padding: .5rem .7rem; border: 1px solid #cfd8dc; border-radius: 5px; background: #fff; }
.sv-card ul { margin: .3rem 0 0; padding-left: 1.1rem; }
.study-pixels { display: grid; grid-template-columns: repeat(var(--pixel-columns), minmax(1.7rem, 2.5rem)); gap: 2px; overflow-x: auto; margin-top: .25rem; }
.study-pixels span { color: var(--ink); background: rgb(var(--shade) var(--shade) var(--shade)); padding: .3rem 0; text-align: center; font-size: .78em; font-variant-numeric: tabular-nums; }
.study-pixels span.sv-hit, .study-matrix td.sv-hit { outline: 2px solid var(--sv-2); outline-offset: -2px; }
.study-matrix { display: table; width: auto; margin: .3rem 0; border-collapse: collapse; border-left: 2px solid currentColor; border-right: 2px solid currentColor; border-radius: 4px; background: #fff; }
.study-matrix td { min-width: 2.2ch; text-align: center; padding: .2rem .55rem; border: 0; font-variant-numeric: tabular-nums; }
.study-matrix td.sv-hit { background: #fdecd2; font-weight: 700; }
.study-parameters { margin: .5rem 0 0; font-size: .86em; color: #33444e; overflow-wrap: anywhere; }
.sv-svg { display: block; width: 100%; max-width: 620px; height: auto; color: #15222c; }
.sv-svg.sv-square { max-width: 320px; }
.sv-grid { stroke: #dde4e8; stroke-width: 1; } .sv-axis { stroke: #51636d; stroke-width: 1.3; } .sv-frame { fill: none; stroke: #8a9ba4; stroke-width: 1; }
.sv-tick { font: 11px/1 ui-sans-serif, system-ui, sans-serif; fill: #51636d; } .sv-label { font: 600 12px ui-sans-serif, system-ui, sans-serif; fill: #33444e; } .sv-note { font: 600 12.5px ui-sans-serif, system-ui, sans-serif; fill: currentColor; }
.sv-line { stroke-width: 2.4; stroke-linejoin: round; }
.sv-legend { display: flex; flex-wrap: wrap; gap: .3rem 1rem; margin: .4rem 0 0; font-size: .84em; } .sv-legend i { display: inline-block; width: .8em; height: .8em; margin-right: .35em; border-radius: 2px; }
.sv-read { display: flex; flex-wrap: wrap; gap: .3rem 1.6rem; margin: .6rem 0 0; font-size: .88em; } .sv-read > div { display: flex; gap: .5rem; } .sv-read dt { color: #44545e; } .sv-read dd { margin: 0; font-weight: 700; font-variant-numeric: tabular-nums; }
.sv-eq { display: flex; flex-wrap: wrap; align-items: center; gap: .4rem .8rem; } .sv-op { font-size: 1.3em; font-weight: 600; }
.sv-steps { margin: 0; padding-left: 1.3rem; } .sv-steps li { margin: .35rem 0; } .sv-steps p { margin: .1rem 0 0; font-size: .9em; color: #44545e; }
.sv-table { width: auto; margin: .5rem 0 0; border-collapse: collapse; font-size: .9em; } .sv-table th, .sv-table td { border: 1px solid #b9c5cb; padding: .25rem .6rem; text-align: left; } .sv-table thead th { background: #eaf0f2; }
.sv-mix { display: flex; flex-wrap: wrap; gap: 1rem; align-items: center; } .sv-swatch { display: inline-block; width: 1.3rem; height: 1.3rem; border: 1px solid #51636d; border-radius: 3px; vertical-align: middle; } .sv-swatch.sv-big { width: 6rem; height: 6rem; border-radius: 8px; }
.sv-chans { display: grid; grid-template-columns: repeat(2, auto); gap: .3rem 1.2rem; font-variant-numeric: tabular-nums; } .sv-chan { display: flex; align-items: center; gap: .4rem; }
.sv-flow { display: flex; flex-wrap: wrap; gap: .5rem; list-style: none; margin: 0; padding: 0; counter-reset: flow; }
.sv-flow li { counter-increment: flow; position: relative; flex: 1 1 9rem; padding: .55rem .7rem .55rem 2rem; border: 1px solid #b9c5cb; border-radius: 5px; background: #fff; }
.sv-flow li::before { content: counter(flow); position: absolute; left: .55rem; top: .55rem; width: 1.1rem; height: 1.1rem; border-radius: 50%; background: var(--sv-1); color: #fff; font-size: .72em; display: grid; place-items: center; }
.sv-flow li span, .sv-timeline span, .sv-stepper span { display: block; font-size: .88em; color: #44545e; }
.sv-timeline { list-style: none; margin: 0; padding: 0 0 0 .3rem; border-left: 2px solid var(--sv-1); } .sv-timeline li { display: grid; grid-template-columns: 6.5rem 1fr; gap: .8rem; padding: .35rem 0 .35rem .9rem; } .sv-timeline time { font-weight: 700; font-variant-numeric: tabular-nums; color: var(--sv-1); }
.sv-stepper { margin: 0; padding-left: 1.3rem; } .sv-stepper li { margin: .3rem 0; } .sv-stepper .todo { color: #7b8a94; } .sv-stepper .now { color: inherit; background: #fdecd2; border-radius: 4px; padding: .3rem .5rem; margin-left: -.5rem; } .sv-stepper .done { text-decoration: none; opacity: .75; }
.sv-q { margin: 0 0 .5rem; font-weight: 600; } .sv-opts { display: grid; gap: .4rem; } .sv-opt { text-align: left; font: inherit; padding: .45rem .7rem; border: 1px solid #81939c; border-radius: 5px; background: #fff; color: inherit; cursor: pointer; } .sv-opt:hover { background: #eaf0f2; } .sv-opt.right { background: #d9f0e0; border-color: #3c8d5a; } .sv-opt.wrong { background: #f8dcdc; border-color: #c2415b; }
.sv-feedback { margin: .5rem 0 0; font-size: .92em; } .sv-details summary { cursor: pointer; font-weight: 600; color: var(--sv-1); }
.study-visual-unavailable { padding: .5rem .8rem; border: 1px dashed #81939c; color: #44545e; }
.study-visual :focus-visible { outline: 3px solid #e0a526; outline-offset: 2px; }
@media (prefers-reduced-motion: no-preference) { .sv-opt, .study-controls button { transition: background .15s; } }
@media print { .study-controls, .sv-opts button:not(.right) { } .study-controls { display: none; } .study-visual { break-inside: avoid; print-color-adjust: exact; -webkit-print-color-adjust: exact; } }
`;
