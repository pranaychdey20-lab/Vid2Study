import { renderMarkdown } from './md.js';
import { coverageLabel } from './coverage.js';

const element = (tag, text, cls) => {
  const node = document.createElement(tag);
  if (text) node.textContent = text;
  if (cls) node.className = cls;
  return node;
};
const titleOf = text => text.replace(/\s*\(\d+(?::\d+){1,2}\)\s*$/, '').trim();

export function writerLabel(result) {
  if (result.writers?.length) return result.writers.join(', ');
  const successful = [...(result.debug || '').matchAll(/^#\d+ WRITE \| (.+?) \| (?![^\n]* \| ERROR:)[^\n]*$/gm)].map(m => m[1]);
  return [...new Set(successful)].join(', ') || result.model || 'AI';
}

export function lectureHtml(result, markdown, opts, forExport = false) {
  const root = element('article');
  const normalized = markdown.split(/(^\s*```[^\n]*\n[\s\S]*?^\s*```[^\n]*$)/gm).map((part, i) => i % 2 ? part : part
    .replace(/\\\[([\s\S]*?)\\\]/g, (_, t) => '\n$$'+t+'$$\n')
    .replace(/\\\((.*?)\\\)/g, (_, t) => '$'+t+'$')
    .replace(/^\s*[-*] \*\*Big idea:\*\*\s*/gm, '')
    .replace(/^\s*[-*] \*\*Key points:\*\*\s*$/gm, '')
    .replace(/^\s*(?:>\s*)?\[EXTRA\]\s*:?[ \t]*/gm, '> **Extra Context:** ')
    .replace(/\*\*\[EXTRA\]:\*\*/g, '**Extra Context:**')).join('');
  const clean = normalized.replace(/^## Practice questions\s*\n+I seem to be encountering an error[^\n]*(?:\n|$)/gim, '');
  root.innerHTML = renderMarkdown(clean, opts);
  const intro = element('header', '', 'contents');
  const title = root.querySelector('h1') || element('h1', result.title);
  intro.append(title);
  const meta = result.lectureMeta || {};
  intro.append(element('p', [result.course, meta.code, meta.instructor, meta.institution, writerLabel(result), result.pipeline?.scenes != null ? result.pipeline.scenes+' captured frames' : '', result.frames.length+' figures'].filter(Boolean).join(' · '), 'banner-meta'));
  const coverage = coverageLabel(result.coverage);
  if (coverage) {
    const report = element('div', '', 'banner-meta');
    report.append(element('p', coverage));
    const items = result.coverage.flatMap(part => part.unmatched);
    if (items.length) {
      const list = element('ul');
      for (const entry of items) list.append(element('li', `${entry.video} · ${entry.at} — ${entry.item}`));
      report.append(list);
    }
    intro.append(report);
  }
  if (result.source === 'combined' && result.pipeline?.warnings?.length) {
    intro.append(element('p', result.pipeline.warnings.join(' '), 'watch-out'));
  }
  const snapshot = element('div', '', 'snapshot');
  const outcomes = element('div');
  const overview = [...root.querySelectorAll('h2')].find(h => /^overview$/i.test(h.textContent.trim()));
  if (overview) {
    outcomes.append(element('h2','What You Will Master'));
    while (overview.nextElementSibling && !/^H[123]$/.test(overview.nextElementSibling.tagName)) outcomes.append(overview.nextElementSibling);
    overview.remove();
  }
  const nav = element('nav');
  nav.append(element('h2','Lecture Roadmap'));
  const list = element('ol');
  nav.append(list);
  snapshot.append(outcomes, nav);
  intro.append(snapshot);
  const sections = [];
  let section, group, practiceTopic, chapterList;
  let chapterCount = 0;
  const sources = new Set();
  const credits = new Map();
  for (const node of [...root.children]) {
    if (node.tagName === 'H2') {
      if (result.source === 'combined' && /^Chapter:\s*/i.test(node.textContent)) {
        node.textContent = node.textContent.replace(/^Chapter:\s*/i, '');
        node.id = 'chapter-' + ++chapterCount;
        const a = element('a', node.textContent);
        a.href = '#' + node.id;
        const item = element('li');
        chapterList = element('ol');
        item.append(a, chapterList);
        list.append(item);
        group = 'detailed notes';
        section = null;
        continue;
      }
      group = node.textContent.trim().toLowerCase();
      section = null;
      if (['topics','detailed notes'].includes(group)) node.remove();
      continue;
    }
    if (group === 'topics') { node.remove(); continue; }
    if (result.source === 'combined' && node.tagName === 'H4' && /^Video:\s*/i.test(node.textContent)) { section = null; continue; }
    if (node.tagName === 'H3' && (group === 'detailed notes' || !group)) {
      const name = titleOf(node.textContent);
      section = element('section');
      node.before(section);
      node.id = 'sec-'+(sections.length+1);
      const heading = element('h2');
      heading.id = node.id;
      heading.textContent = (sections.length+1)+'. '+(result.source === 'combined' ? node.textContent : name);
      section.append(heading);
      node.remove();
      const a = element('a', name);
      a.href = '#'+heading.id;
      const li = element('li'); li.append(a); (chapterList || list).append(li);
      sections.push({name, section, heading});
      continue;
    }
    if (section) section.append(node);
    if (node.matches('blockquote.c-source')) {
      const credit = node.textContent.replace(/^Source:\s*/i,'').trim();
      sources.add(credit);
      if (section) {
        if (!credits.has(section)) credits.set(section, new Set());
        credits.get(section).add(credit);
      }
      node.remove();
    } else if (node.matches('blockquote')) {
      const label = node.querySelector('strong');
      const kind = label?.textContent.replace(/:$/, '').toLowerCase();
      if (['slide definition','slide quote'].includes(kind)) {
        node.className = 'slide-ocr';
        node.dataset.type = kind === 'slide definition' ? 'definition' : 'quote';
        label.textContent = kind.toUpperCase()+' · VERBATIM FROM LECTURE FRAME';
      } else if (/^(extra|analogy|background)/i.test(kind || '')) {
        const aside = element('aside','','extra-context'); label.textContent = 'Extra Context (Not Taught in Lecture)';
        aside.append(...node.childNodes); node.replaceWith(aside);
      } else if (kind === 'explanation') {
        const aside = element('aside', '', 'inline-explanation');
        aside.append(...node.childNodes);
        node.replaceWith(aside);
      } else if (kind === 'watch out' || kind === 'unclear') node.className = 'watch-out';
      else if (kind === 'quick check') node.className = 'quick-check';
      else node.replaceWith(...node.childNodes);
    } else if (result.technical !== false && node.matches('p') && /^\[note\]/i.test(node.textContent) && node.previousElementSibling?.matches('.katex-block')) {
      node.firstChild.textContent = node.firstChild.textContent.replace(/^\[note\]\s*/i, '');
      const math = node.previousElementSibling;
      const row = element('div','','math-note-row'); math.before(row); row.append(math,node);
    }
    if (group === 'practice questions') {
      if (node.tagName === 'H3') practiceTopic = sections.find(s => s.name === titleOf(node.textContent));
      if (practiceTopic) {
        for (const label of node.querySelectorAll('strong')) {
          if (label.textContent.trim().toLowerCase() !== 'answer:') continue;
          const number = practiceTopic.heading.id.slice(4);
          const ref = element('a', 'Ref: Section '+number+' ('+practiceTopic.name+')'+(forExport && opts.pageNumbers !== false ? ', Page ' : ''), 'page-ref');
          ref.setAttribute('href','#'+practiceTopic.heading.id);
          label.replaceWith(ref, document.createTextNode(' | '));
        }
      }
    }
  }
  for (const {section, heading} of sections) {
    const withExplanation = node => node.nextElementSibling?.matches('.inline-explanation')
      ? [node, node.nextElementSibling] : [node];
    heading.after(...[...section.querySelectorAll('.slide-ocr[data-type="definition"]')].flatMap(withExplanation));
    section.append(...[...section.querySelectorAll('.slide-ocr[data-type="quote"]')].flatMap(withExplanation));
  }
  for (const [topic, items] of credits) {
    const strip = element('p','','topic-ref');
    const link = element('a','Slide Sources: '+[...items].join(' · ')); link.href = '#references';
    strip.append(link); topic.append(strip);
  }
  let refs = [...root.querySelectorAll('h2')].find(h => /^references$/i.test(h.textContent));
  if (sources.size && !refs) {
    refs = element('h2','References');
    root.insertBefore(refs, [...root.children].find(n => n.textContent === 'Practice questions') || null);
  }
  if (refs) {
    refs.id = 'references';
    const table = element('table'), seen = new Set();
    let category = 'Lecture sources';
    const add = (kind, content) => {
      const key = content.textContent.trim().toLowerCase();
      if (!key || seen.has(key)) return;
      seen.add(key);
      const row = table.insertRow();
      row.insertCell().textContent = kind;
      row.insertCell().append(...content.childNodes);
    };
    let next = refs.nextElementSibling;
    while (next && next.tagName !== 'H2') {
      const current = next; next = next.nextElementSibling;
      if (/^H[34]$/.test(current.tagName) || (current.matches('p') && current.firstElementChild?.textContent === current.textContent)) category = current.textContent;
      else if (current.matches('ul,ol')) for (const item of [...current.children]) add(category,item);
      else add(category,current);
      current.remove();
    }
    for (const source of sources) add('Slide source', element('span',source));
    refs.after(table);
  }
  for (const img of root.querySelectorAll('p > img:only-of-type')) {
    const p = img.parentElement, caption = p.querySelector('em');
    if (!caption || !/^fig/i.test(caption.textContent)) continue;
    const fig = element('figure');
    p.before(fig);
    const fc = element('figcaption');
    fc.append(...caption.childNodes); caption.remove();
    fig.append(img,fc);
    if (!p.textContent.trim() && !p.querySelector('a,img')) p.remove();
    if (fig.previousElementSibling?.tagName === 'FIGURE') {
      const pair = element('div','','figure-pair');
      fig.previousElementSibling.before(pair); pair.append(pair.nextElementSibling,fig);
    }
  }
  if (result.technical !== false) {
    for (const math of root.querySelectorAll('.katex-block')) {
      if (math.closest('.math-note-row,.extra-context')) continue;
      const row = element('div','','math-note-row'); math.before(row);
      row.append(math,element('p','Symbol definitions were not supplied for this equation.'));
    }
  }
  for (const block of root.querySelectorAll('p,li,blockquote')) {
    if (block.closest('.extra-context') || !/\[EXTRA\]/i.test(block.textContent)) continue;
    // Move the whole marked passage so a multiline explanation stays with its label.
    const aside = element('aside','','extra-context');
    const badge = element('strong','Extra Context (Not Taught in Lecture) ');
    block.before(aside); aside.append(badge,block);
    const walker = document.createTreeWalker(block,NodeFilter.SHOW_TEXT);
    while (walker.nextNode()) walker.currentNode.data = walker.currentNode.data.replace(/\[EXTRA\]\s*:?/gi,'');
  }
  root.prepend(intro);
  if (forExport) {
    let failures = 0;
    const placeholder = () => {
      failures++;
      return element('span', '[Formula could not be typeset. See the saved notes.]', 'math-unavailable');
    };
    for (const node of root.querySelectorAll('.math')) {
      if (!node.querySelector('.katex')) node.replaceWith(placeholder());
    }
    const rawMath = /\\[()[\]]|\$\$|\\(?:frac|mathrm|boxed)\b(?:\{[^{}\n]*\}){0,2}/g;
    const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
    const unparsed = [];
    while (walker.nextNode()) {
      if (walker.currentNode.parentElement.closest('.katex, code')) continue;
      if ([...walker.currentNode.data.matchAll(rawMath)].length) unparsed.push(walker.currentNode);
    }
    for (const node of unparsed) {
      const parts = node.data.split(rawMath);
      node.replaceWith(...parts.flatMap((part, i) => i ? [placeholder(), part] : [part]));
    }
    if (failures) intro.append(element('p', failures === 1
      ? 'One formula could not be typeset for this export. Its source is in the saved notes.'
      : failures + ' formulas could not be typeset for this export. Their source is in the saved notes.', 'watch-out'));
  }
  return root.innerHTML;
}
