/**
 * Manual editing of the notes shown on the results page.
 *  - "Edit text" on a section opens that section's Markdown (figures are [[FRAME:n]] lines: move or delete the line to rearrange).
 *  - Every figure gets Up / Down / Remove, so a picture can be put right next to the paragraph it explains. A heading counts as a
 *    step, so a picture can also move into the neighbouring topic.
 * Writes go through the notes store: one undo / redo history shared with the assistant, both copies of the notes kept consistent.
 */
import { parseSections, sectionText, setSectionText, visualProblem, figureBlock, moveFigure, removeFigure, renumberFigures, listFigures } from './notes-edit.js';

const el = (tag, cls, text) => { const n = document.createElement(tag); if (cls) n.className = cls; if (text != null) n.textContent = text; return n; };
const button = (label, title, onClick, cls = '') => { const b = el('button', 'ed-btn ' + cls, label); b.type = 'button'; b.title = title; b.setAttribute('aria-label', title); b.addEventListener('click', onClick); return b; };

export function mountEditor({ root, read, store, fileOf, toast }) {
  let on = false;

  const run = async (work) => { try { await work(); } catch (error) { toast(error.message || String(error)); } };

  /** Raw notes are the editing copy; notes saved without one fall back to the saved Markdown. */
  const rawOf = (r) => r.summary_raw ?? r.summary_markdown;

  function renumber(rich, frames) {
    const fixed = renumberFigures(rich);
    const order = new Map(listFigures(fixed).map((f, i) => [f.key, i + 1]));
    return { rich: fixed, frames: frames.map(f => f.filename && order.has('images/' + f.filename) ? { ...f, figure: order.get('images/' + f.filename) } : f) };
  }

  async function moveBy(img, direction) {
    const file = fileOf(img);
    await run(() => store.commit(stored => {
      const frame = stored.frames.find(f => f.filename === file);
      if (!frame) throw new Error('This picture is not one of the lecture figures.');
      const raw = moveFigure(rawOf(stored), 'F' + frame.index, direction), rich = moveFigure(stored.summary_markdown, 'images/' + file, direction);
      if (!rich) throw new Error(direction < 0 ? 'This figure is already at the top.' : 'This figure is already at the bottom.');
      const next = renumber(rich, stored.frames);
      return { summary_raw: raw ?? stored.summary_raw, summary_markdown: next.rich, frames: next.frames };
    }));
  }

  async function removeBy(img) {
    const file = fileOf(img);
    await run(() => store.commit(stored => {
      const frame = stored.frames.find(f => f.filename === file);
      if (!frame) throw new Error('This picture is not one of the lecture figures.');
      const rich = removeFigure(stored.summary_markdown, 'images/' + file);
      if (rich == null) throw new Error('The figure was not found in the notes.');
      const next = renumber(rich, stored.frames.filter(f => f.filename !== file));
      return { summary_raw: removeFigure(rawOf(stored), 'F' + frame.index) ?? stored.summary_raw, summary_markdown: next.rich, frames: next.frames };
    }));
    toast('Figure removed. Undo brings it back.');
  }

  function decorateFigure(figure) {
    const img = figure.querySelector('img');
    if (!img || figure.querySelector('.ed-fig')) return;
    const bar = el('div', 'ed-fig');
    bar.append(button('↑', 'Move this figure up', () => moveBy(img, -1)), button('↓', 'Move this figure down', () => moveBy(img, +1)), button('Remove', 'Remove this figure from the notes', () => removeBy(img), 'danger'));
    figure.classList.add('ed-has-fig');
    figure.prepend(bar);
  }

  function openSection(heading, wrap) {
    const n = Number(heading.id.slice(4));
    const stored = read();
    const section = parseSections(rawOf(stored)).sections[n - 1];
    if (!section) { toast('This section could not be found in the saved notes.'); return; }
    const card = el('div', 'ed-card');
    const area = el('textarea', 'ed-area');
    area.value = sectionText(rawOf(stored), section.heading);
    area.spellcheck = true;
    area.setAttribute('aria-label', 'Section text: ' + section.title);
    const hint = el('p', 'ed-hint', 'Markdown and LaTeX ($x^2$). A line like [[FRAME:12]] is a figure: move the line to place the picture, delete it to remove the picture. A block starting with three backticks and the word visual is an interactive visual.');
    const error = el('p', 'ed-error');
    error.setAttribute('role', 'alert');
    const save = button('Save section', 'Save this section (Ctrl+Enter)', () => commit(), 'primary');
    const cancel = button('Cancel', 'Discard changes to this section (Esc)', () => close());
    const close = () => { card.remove(); wrap.hidden = false; };
    const commit = () => run(async () => {
      const problem = visualProblem(area.value);
      if (problem) { error.textContent = problem; area.focus(); return; }
      save.disabled = true;
      try {
        await store.commit(current => {
          const rawNow = rawOf(current), sec = parseSections(rawNow).sections[n - 1];
          if (!sec || sec.title !== section.title) throw new Error('The notes changed while you were editing. Reload and try again.');
          const allowed = new Set([...sectionText(rawNow, sec.heading).matchAll(/\[\[FRAME:(\d+)\]\]/g)].map(m => Number(m[1])));
          const raw = setSectionText(rawNow, sec.heading, area.value, { allowedFrames: allowed });
          // the saved copy gets the same text, with each figure marker turned back into its picture block
          const richSec = parseSections(current.summary_markdown).sections.find(s => s.heading === sec.heading) || parseSections(current.summary_markdown).sections[n - 1];
          if (!richSec) throw new Error('The formatted copy of this section could not be found.');
          const richBody = sectionText(current.summary_markdown, richSec.heading);
          const blocks = new Map();
          for (const index of allowed) { const frame = current.frames.find(f => f.index === index); const block = frame?.filename && figureBlock(richBody, 'images/' + frame.filename); if (block) blocks.set(index, block); }
          const expanded = area.value.replace(/^[ \t]*\[\[FRAME:(\d+)\]\][ \t]*$/gm, (m, i) => blocks.has(Number(i)) ? '\n\n' + blocks.get(Number(i)) + '\n\n' : '');
          const next = renumber(setSectionText(current.summary_markdown, richSec.heading, expanded), current.frames);
          return { summary_raw: current.summary_raw == null ? current.summary_raw : raw, summary_markdown: next.rich, frames: next.frames };
        });
        toast('Section saved');
      } catch (e) { error.textContent = e.message; save.disabled = false; }
    });
    area.addEventListener('keydown', e => {
      if (e.key === 'Escape') { e.preventDefault(); close(); }
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); commit(); }
    });
    area.addEventListener('input', () => { area.style.height = 'auto'; area.style.height = Math.min(area.scrollHeight + 4, 640) + 'px'; });
    card.append(hint, area, error, (() => { const row = el('div', 'ed-row'); row.append(save, cancel); return row; })());
    wrap.hidden = true;
    wrap.after(card);
    area.dispatchEvent(new Event('input'));
    area.focus();
  }

  function decorateSection(heading) {
    if (heading.nextElementSibling?.classList.contains('ed-tools')) return;
    const tools = el('div', 'ed-tools');
    // everything between this heading and the next one is "the section": hidden while its editor is open
    const wrap = el('div', 'ed-body');
    tools.append(button('Edit text', 'Edit the text of this section', () => openSection(heading, wrap)));
    heading.after(tools);
    let node = tools.nextSibling;
    const members = [];
    while (node) { members.push(node); node = node.nextSibling; }
    wrap.append(...members);
    tools.after(wrap);
  }

  /** Call after every redraw. */
  function refresh() {
    document.body.classList.toggle('editing', on);
    if (!on) return;
    for (const heading of root.querySelectorAll('h2[id^=sec-]')) decorateSection(heading);
    for (const figure of root.querySelectorAll('figure')) if (!figure.classList.contains('study-visual')) decorateFigure(figure);
  }

  return {
    refresh,
    toggle(value = !on) { on = value; refresh(); return on; },
    get active() { return on; }
  };
}
