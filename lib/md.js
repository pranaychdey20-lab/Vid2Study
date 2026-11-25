/**
 * Small, safe Markdown -> HTML renderer (no dependencies).
 * Supports: headings, paragraphs, nested lists, fenced code, blockquotes, tables, hr,
 * images, links, bold, italic, inline code, callouts (blockquotes that start with **Label:**),
 * ```algo blocks (a real run of a known algorithm, every step drawn: lib/algoviz.js), ```steps blocks (any other
 * process, drawn as rows of boxes) and $...$ / $$...$$ math (rendered by opts.math, else kept as text).
 * All text is HTML-escaped; raw HTML in the input is shown as text, never executed.
 */
import { renderAlgo } from './algoviz.js';

/** ```algo JSON -> the drawn walkthrough; a bad spec shows its problem and the JSON instead of breaking the page. */
function algoBlock(src) {
  try { return renderAlgo(src); } catch (e) {
    return `<div style="border:2px dashed #c00;padding:6px 10px;margin:10px 0;font-size:13px">Could not draw this walkthrough: ${esc(e.message)}</div><pre><code>${esc(src)}</code></pre>`;
  }
}

const esc = (s) =>
  String(s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const unesc = (s) =>
  String(s).replace(/&quot;/g, '"').replace(/&gt;/g, '>').replace(/&lt;/g, '<').replace(/&amp;/g, '&');

function safeUrl(u, isImage) {
  u = String(u || '').trim();
  if (/^(https?:|blob:|images\/)/i.test(u)) return u;
  if (isImage && /^data:image\//i.test(u)) return u;
  return '#';
}

const LI = /^(\s*)([-*+]|\d+[.)])\s+(.*)$/;
const TABLE_SEP = /^\s*\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)*\|?\s*$/;
const isBlank = (l) => !l.trim();
const isBlockStart = (l) => /^(#{1,6}\s|\s*```|\s*~~~|\s*>|\s*\$\$)/.test(l) || LI.test(l);

/**
 * @param {string} md
 * @param {{imageSrc?: (src: string) => string,
 *          math?: (tex: string, display: boolean) => string|null,
 *          }} [opts] imageSrc rewrites image sources (blob:/data: URLs);
 *   math renders LaTeX to HTML (return null to show the formula as plain text).
 * @returns {string} HTML
 */
/**
 * A ```steps block -> a picture of each phase as a row of boxes (an array, a stack, a queue...), not text.
 * Lines: "# caption", or cells separated by spaces then "| what happened". x* = active (compared / moved),
 * x! = done (final place), _ = empty. Inline styles: the same HTML works in the viewer, the export and print.
 */
export function renderSteps(src) {
  const BOX = 'display:inline-flex;align-items:center;justify-content:center;min-width:30px;height:30px;padding:0 6px;border:2px solid #000;margin:0 -2px 0 0;font:600 13px ui-monospace,Consolas,monospace;box-sizing:border-box;';
  // same colours as the algorithm walkthroughs (lib/algoviz.js): green processing, red changed, blue done, grey untouched
  const LOOK = { act: 'background:#7fd88f;', changed: 'background:#ff8a8a;', done: 'background:#8db6ff;', empty: 'background:#fff;border-style:dashed;color:transparent;', plain: 'background:#e4e4e4;' };
  const rows = [];
  for (const raw of String(src || '').split('\n')) {
    const line = raw.trim();
    if (!line) continue;
    if (line.startsWith('#')) { rows.push(`<div style="font-weight:800;margin:8px 0 4px">${esc(line.replace(/^#+\s*/, ''))}</div>`); continue; }
    const bar = line.indexOf('|');
    const cells = (bar >= 0 ? line.slice(0, bar) : line).trim().split(/\s+/).filter(Boolean);
    const note = bar >= 0 ? line.slice(bar + 1).trim() : '';
    const boxes = cells.map((c) => {
      const kind = c === '_' ? 'empty' : /\*$/.test(c) ? 'act' : /~$/.test(c) ? 'changed' : /!$/.test(c) ? 'done' : 'plain';
      const label = c === '_' ? '·' : c.replace(/[*!~]+$/, '');
      return `<span style="${BOX}${LOOK[kind]}">${esc(label)}</span>`;
    }).join('');
    rows.push(`<div style="display:flex;flex-wrap:wrap;align-items:center;gap:10px;margin:4px 0"><span style="display:inline-flex">${boxes}</span>${note ? `<span style="font-size:12.5px">${esc(note)}</span>` : ''}</div>`);
  }
  const key = [['#7fd88f', 'processing'], ['#ff8a8a', 'changed'], ['#8db6ff', 'done'], ['#e4e4e4', 'untouched']]
    .map(([c, t]) => `<span style="display:inline-flex;align-items:center;gap:4px"><span style="display:inline-block;width:12px;height:12px;border:1.5px solid #000;background:${c}"></span>${t}</span>`).join('');
  return `<div class="steps" style="border:2px solid #000;padding:6px 10px 8px;margin:10px 0;-webkit-print-color-adjust:exact;print-color-adjust:exact;page-break-inside:avoid"><div style="display:flex;flex-wrap:wrap;gap:4px 12px;font-size:11.5px;margin-bottom:4px">${key}</div>${rows.join('')}</div>`;
}

export function renderMarkdown(md, opts = {}) {
  /** LaTeX (with its $ delimiters) -> HTML. One bad formula never breaks the page. */
  const mathHtml = (m, block) => {
    const display = m.startsWith('$$');
    const tex = m.replace(/^\$\$?|\$\$?$/g, '').trim();
    let html = null;
    try { html = opts.math?.(tex, display || block) ?? null; } catch { html = null; }
    if (html == null) return `<span class="math">${esc(m)}</span>`;
    return display || block ? `<div class="math katex-block">${html}</div>` : `<span class="math">${html}</span>`;
  };
  const inline = (text) => {
    const keep = [];
    const hold = (html) => `\u0000${keep.push(html) - 1}\u0000`;
    text = text.replace(/`([^`]+)`/g, (_, c) => hold(`<code>${esc(c)}</code>`));
    text = text.replace(/\\\$/g, () => hold('$')); // \$ is a dollar sign, not maths
    // a price ("$50,000", "$10 on top of his $18") is not maths: a $ + number with no maths up to the next $
    text = text.replace(/\$(?=\d)(\d[\d,]*(?:\.\d+)?)(?=([^\n]*))/g, (m, num, rest) => {
      const until = rest.split('$')[0];
      const mathy = /[=+^_\\{}<>]|\s[-*/]\s/.test(`${num}${until}`) || (!/\s/.test(until) && rest.includes('$') && until.length < 3);
      return mathy ? m : hold('$') + num;
    });
    text = text.replace(/\$\$[^$]+\$\$|\$[^$\n]+\$/g, (m) => hold(mathHtml(m, false)));
    text = esc(text);
    text = text.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (_, alt, src) => {
      let s = unesc(src);
      if (opts.imageSrc) s = opts.imageSrc(s);
      return hold(`<img alt="${alt}" src="${esc(safeUrl(s, true))}">`);
    });
    text = text.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (_, t, href) =>
      `<a href="${esc(safeUrl(unesc(href), false))}" target="_blank" rel="noopener noreferrer">${t}</a>`);
    text = text.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>').replace(/__(.+?)__/g, '<strong>$1</strong>');
    text = text.replace(/(^|[^*\w])\*(?!\s)([^*\n]+?)\*(?!\*)/g, '$1<em>$2</em>');
    text = text.replace(/(^|\s)_(?!\s)([^_\n]+?)_(?=\s|$|[.,;:!?)])/g, '$1<em>$2</em>');
    return text.replace(/\u0000(\d+)\u0000/g, (_, n) => keep[+n]);
  };

  const lines = String(md || '').replace(/\r\n?/g, '\n').split('\n');
  let i = 0;
  const out = [];

  const parseList = () => {
    const first = lines[i].match(LI);
    const indent = first[1].length;
    const ordered = /\d/.test(first[2]);
    const items = [];
    while (i < lines.length) {
      const l = lines[i];
      if (isBlank(l)) {
        let j = i + 1;
        while (j < lines.length && isBlank(lines[j])) j++;
        const next = j < lines.length && lines[j].match(LI);
        if (next && next[1].length >= indent) { i = j; continue; }
        break;
      }
      const m = l.match(LI);
      if (m && m[1].length === indent && /\d/.test(m[2]) !== ordered) break; // ul <-> ol switch
      if (m && m[1].length === indent) { items.push({ text: m[3], children: '' }); i++; continue; }
      if (m && m[1].length > indent && items.length) { items[items.length - 1].children += parseList(); continue; }
      if (m) break; // less indented: parent list continues
      if (/^\s+\S/.test(l) && items.length && !isBlockStart(l.trim())) {
        items[items.length - 1].text += ' ' + l.trim();
        i++;
        continue;
      }
      break;
    }
    const tag = ordered ? 'ol' : 'ul';
    return `<${tag}>${items.map((it) => `<li>${inline(it.text)}${it.children}</li>`).join('')}</${tag}>`;
  };

  const row = (l) => l.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((c) => c.trim());

  while (i < lines.length) {
    const line = lines[i];
    let m;
    if (isBlank(line)) { i++; continue; }

    if ((m = line.match(/^\s*(```|~~~)\s*([\w+#.-]*)/))) {
      const fence = m[1];
      const buf = [];
      i++;
      while (i < lines.length && !lines[i].trim().startsWith(fence)) buf.push(lines[i++]);
      i++;
      const lang = m[2].toLowerCase();
      out.push(lang === 'steps' ? renderSteps(buf.join('\n')) : lang === 'algo' ? algoBlock(buf.join('\n')) : `<pre><code>${esc(buf.join('\n'))}</code></pre>`);
      continue;
    }
    if (line.trim().startsWith('$$')) {
      const t = line.trim();
      let end = i;
      if (!(t.length > 2 && t.endsWith('$$'))) {
        end = i + 1;
        while (end < lines.length && !lines[end].trim().endsWith('$$') &&
          !/^\s*(?:#{1,6}\s|[\x60~]{3}|\$\$)/.test(lines[end])) end++;
        if (end >= lines.length || !lines[end].trim().endsWith('$$') ||
          /^\s*\$\$.+\$\$\s*$/.test(lines[end])) {
          out.push('<p>' + inline(line) + '</p>');
          i++;
          continue;
        }
      }
      const raw = lines.slice(i, end + 1).join('\n').trim();
      i = end + 1;
      out.push(opts.math ? mathHtml(raw, true) : `<div class="math">${esc(raw)}</div>`);
      continue;
    }
    if ((m = line.match(/^\s*@@VISUAL:([\w-]+)@@\s*$/))) {
      // a widget marker in notes saved before interactive visuals were removed: show nothing
      i++;
      continue;
    }
    if ((m = line.match(/^(#{1,6})\s+(.*?)\s*#*\s*$/))) {
      const n = m[1].length;
      out.push(`<h${n}>${inline(m[2])}</h${n}>`);
      i++;
      continue;
    }
    if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    if (/^\s*>/.test(line)) {
      const buf = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
      const label = /^\*\*([A-Za-z][A-Za-z ()]*?):\*\*/.exec(buf[0] || '');
      const cls = label ? ` class="callout c-${label[1].toLowerCase().split(/[ (]/)[0]}"` : '';
      out.push(`<blockquote${cls}>${renderMarkdown(buf.join('\n'), opts)}</blockquote>`);
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
      const head = row(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) rows.push(row(lines[i++]));
      out.push(
        `<table><thead><tr>${head.map((c) => `<th>${inline(c)}</th>`).join('')}</tr></thead><tbody>` +
        rows.map((r) => `<tr>${r.map((c) => `<td>${inline(c)}</td>`).join('')}</tr>`).join('') +
        '</tbody></table>'
      );
      continue;
    }
    if (LI.test(line)) { out.push(parseList()); continue; }

    const buf = [line.trim()];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) buf.push(lines[i++].trim());
    out.push(`<p>${inline(buf.join('\n')).replace(/\n/g, '<br>')}</p>`);
  }
  return out.join('\n');
}
