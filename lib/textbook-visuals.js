const PARAMETERS = {
  brightness_contrast: { alpha: [0, 3, 0.05, 1, 'Contrast multiplier'], beta: [-255, 255, 1, 0, 'Brightness offset'] },
  gamma_correction: { gamma: [0.1, 4, 0.05, 1, 'Gamma'] },
  laplacian_sharpening: { alpha: [0, 3, 0.05, 1, 'Sharpening strength'] }
};
const pixelTypes = new Set(['pixel_grid', 'histogram', ...Object.keys(PARAMETERS)]);
const escape = value => String(value).replace(/[&<>"']/g, char => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[char]);

export function readVisual(json) {
  if (json.length > 10000) return null;
  let input;
  try { input = JSON.parse(json); } catch { return null; }
  if (input?.type === 'comparison_grid') {
    if (!Array.isArray(input.columns) || input.columns.length < 2 || input.columns.length > 4) return null;
    const columns = [];
    for (const item of input.columns) {
      if (!item || typeof item.title !== 'string' || item.title.length > 80 ||
          !Array.isArray(item.matrix) || !item.matrix.length || item.matrix.length > 8 ||
          !item.matrix.every(row => Array.isArray(row) && row.length && row.length <= 8 && row.length === item.matrix[0].length &&
            row.every(value => Number.isFinite(value) && Math.abs(value) <= 1e6)) ||
          (item.formula != null && (typeof item.formula !== 'string' || item.formula.length > 240))) return null;
      columns.push({ title: item.title, matrix: item.matrix, formula: item.formula || '' });
    }
    return { type: input.type, columns };
  }
  if (!input || !pixelTypes.has(input.type) || !Array.isArray(input.pixels) ||
      !input.pixels.length || input.pixels.length > 256 ||
      !input.pixels.every(value => Number.isInteger(value) && value >= 0 && value <= 255)) return null;
  const type = input.type;
  const width = input.width ?? (type === 'laplacian_sharpening' ? input.pixels.length : Math.min(input.pixels.length, 8));
  if (!Number.isInteger(width) || width < 1 || width > Math.min(input.pixels.length, 16) ||
      (input.width != null && input.pixels.length % width) || (type === 'laplacian_sharpening' && width !== input.pixels.length)) return null;
  const params = {};
  for (const [name, [min, max, , initial]] of Object.entries(PARAMETERS[type] || {})) {
    const value = input[name] ?? initial;
    if (!Number.isFinite(value) || value < min || value > max) return null;
    params[name] = value;
  }
  return { type, width, pixels: input.pixels, params, interactive: input.interactive !== false };
}

export function transformedPixels(type, pixels, params) {
  const clamp = value => Math.max(0, Math.min(255, Math.round(value)));
  return pixels.map((pixel, i) => {
    if (type === 'brightness_contrast') return clamp(params.alpha * pixel + params.beta);
    if (type === 'gamma_correction') return clamp(255 * (pixel / 255) ** params.gamma);
    if (type === 'laplacian_sharpening') {
      const left = pixels[i - 1] ?? pixel, right = pixels[i + 1] ?? pixel;
      return clamp(pixel - params.alpha * (left - 2 * pixel + right));
    }
    return pixel;
  });
}

const LABELS = {
  pixel_grid: 'Pixel intensities', histogram: 'Intensity histogram', brightness_contrast: 'Brightness and contrast',
  gamma_correction: 'Gamma correction', laplacian_sharpening: 'Laplacian sharpening (one-dimensional example)'
};
const grid = (pixels, width, output = false) => '<div class="study-pixels"' + (output ? ' data-pixel-output' : '') +
  ' style="--pixel-columns:' + width + '">' + pixels.map(value => '<span style="--shade:' + value +
    ';--ink:' + (value < 135 ? '#fff' : '#000') + '">' + value + '</span>').join('') + '</div>';

export function renderVisual(json, interactive = true, math) {
  const spec = readVisual(json);
  if (!spec) return '<p class="study-visual-unavailable">This visual could not be rendered. Its explanation appears in the notes.</p>';
  if (spec.type === 'comparison_grid') {
    const cards = spec.columns.map(column => '<div><strong>' + escape(column.title) + '</strong><table class="study-matrix" aria-label="' +
      escape(column.title) + ' matrix"><tbody>' + column.matrix.map(row =>
        '<tr>' + row.map(value => '<td>' + value + '</td>').join('') + '</tr>').join('') + '</tbody></table>' +
      (column.formula ? '<p class="math">' + (math?.(column.formula, false) || escape(column.formula)) + '</p>' : '') + '</div>');
    return '<figure class="study-visual"><figcaption>Comparison</figcaption><div class="study-compare">' + cards.join('') + '</div></figure>';
  }
  const { type, pixels, width, params } = spec;
  const controls = Object.entries(PARAMETERS[type] || {});
  const active = interactive && spec.interactive && controls.length > 0;
  let body = grid(pixels, width);
  if (type === 'histogram') {
    const bins = Array(8).fill(0);
    for (const value of pixels) bins[Math.floor(value / 32)]++;
    const peak = Math.max(...bins);
    body = '<div class="study-histogram" aria-label="Pixel counts by intensity range">' + bins.map((count, i) =>
      '<div><span class="study-bar" style="--bar-height:' + (100 * count / peak) + '%">' + count +
      '</span><span>' + (i * 32) + '–' + (i * 32 + 31) + '</span></div>').join('') + '</div>';
  } else if (controls.length) {
    body = '<div class="study-compare"><div><strong>Input</strong>' + body + '</div><div><strong>Output</strong>' +
      grid(transformedPixels(type, pixels, params), width, true) + '</div></div>';
    body += '<p class="study-parameters" data-visual-parameters>' +
      controls.map(([name, rule]) => rule[4] + ' = ' + params[name]).join(' · ') + '</p>';
  }
  const form = active ? '<div class="study-controls">' + controls.map(([name, [min, max, step, , label]]) =>
    '<label>' + label + ' <input type="range" name="' + name + '" min="' + min + '" max="' + max +
    '" step="' + step + '" value="' + params[name] + '"></label>').join('') + '<button type="button">Reset</button></div>' : '';
  return '<figure class="study-visual"' + (active ? ' data-study-visual="' + escape(JSON.stringify(spec)) + '"' : '') +
    '><figcaption>' + LABELS[type] + '</figcaption>' + form + body + '</figure>';
}

export function bindVisuals(root) {
  for (const figure of root.querySelectorAll('[data-study-visual]')) {
    if (figure.dataset.bound) continue;
    figure.dataset.bound = 'true';
    const { type, pixels } = JSON.parse(figure.dataset.studyVisual);
    const controls = [...figure.querySelectorAll('input[type=range]')];
    const output = [...figure.querySelectorAll('[data-pixel-output] span')];
    const update = () => {
      const params = Object.fromEntries(controls.map(input => [input.name, Number(input.value)]));
      transformedPixels(type, pixels, params).forEach((value, i) => {
        output[i].textContent = value;
        output[i].style.setProperty('--shade', value);
        output[i].style.setProperty('--ink', value < 135 ? '#fff' : '#000');
      });
      figure.querySelector('[data-visual-parameters]').textContent = controls.map(input =>
        input.parentElement.textContent.trim() + ' = ' + input.value).join(' · ');
    };
    figure.addEventListener('input', update);
    figure.querySelector('button').addEventListener('click', () => {
      for (const input of controls) input.value = input.defaultValue;
      update();
    });
  }
}

// Only this bundled application code is embedded in offline HTML. Model data remains inert.
export const visualRuntime = () => transformedPixels.toString() + '\n' + bindVisuals.toString() + '\nbindVisuals(document);';

export const VISUAL_CSS = `
.study-visual { margin: 1rem 0; padding: .8rem; border: 1px solid #81939c; color: #132632; background: #f7fafb; }
.study-visual figcaption { margin: 0 0 .65rem; font-size: 1em; font-weight: 700; color: inherit; }
.study-controls, .study-compare { display: flex; gap: .7rem 1rem; flex-wrap: wrap; align-items: start; margin-bottom: .7rem; }
.study-controls label { display: grid; font-size: .9em; gap: .15rem; }
.study-pixels { display: grid; grid-template-columns: repeat(var(--pixel-columns), minmax(1.6rem, 2.4rem)); gap: 2px; overflow-x: auto; }
.study-pixels span { color: var(--ink); background: rgb(var(--shade) var(--shade) var(--shade)); padding: .25rem 0; text-align: center; font-size: .8em; }
.study-parameters { margin: .5rem 0 0; font-size: .85em; }
.study-compare .study-matrix { display: table; width: auto; margin: .35rem 0; background: white; }
.study-compare .study-matrix td { min-width: 2ch; text-align: center; padding: .2rem .5rem; }
.study-histogram { display: grid; grid-template-columns: repeat(8, minmax(2.1rem, 1fr)); overflow-x: auto; gap: 2px; }
.study-histogram > div { position: relative; display: flex; flex-direction: column; justify-content: end; align-items: center; height: 6rem; font-size: .72em; }
.study-histogram .study-bar { height: var(--bar-height); min-height: 1em; max-height: calc(100% - 1.2em); width: 100%; background: #256079; color: white; text-align: center; }
@media print { .study-controls { display: none; } .study-visual { break-inside: avoid; print-color-adjust: exact; } }
`;
