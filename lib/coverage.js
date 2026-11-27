const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
const topicTime = /\s+\((\d{1,3}:\d{2}(?::\d{2})?)\)[ \t]*$/;
const topicSections = notes => notes.split(/^(?=#{1,3}[ \t])/m);

/** Only the lecture explanation counts as evidence of coverage. */
export function topicBody(text) {
  return text.replace(/<!--[\s\S]*?-->/g, '')
    .replace(/^[ \t]*(?:\x60{3}|~{3})[ \t]*visual[ \t]*\r?\n[\s\S]*?^[ \t]*(?:\x60{3}|~{3})[ \t]*$/gim, '')
    .replace(/^[ \t]*(?:#{1,6}[ \t]+|>[ \t]*|(?:\*{0,2})?(?:fig(?:ure)?\.?|slide sources?)\s*[:.)])[^\n]*/gim, '')
    .replace(/\[\[(?:FRAME|VISUAL):[^\]]*\]\]/gi, '')
    .replace(/^[ \t]*(?:[-*_]+|standard)[ \t]*$/gim, '').trim();
}

export function emptyTopics(notes) {
  return topicSections(notes).flatMap(section => {
    const [heading, ...lines] = section.split('\n');
    const at = topicTime.exec(heading)?.[1];
    if (!heading.startsWith('### ') || !at || topicBody(lines.join('\n'))) return [];
    return [{ at, time: at.split(':').reduce((total, n) => total * 60 + Number(n), 0),
      item: 'Explain ' + heading.slice(4).replace(topicTime, '') + ' from its transcript and slide evidence' }];
  });
}

/** A vision-identified teaching topic should occur in substantive notes, not just the roadmap. */
export function missingScreenTopics(items, notesFor) {
  return items.filter(item => {
    const name = normalize(item.title);
    const alias = /\(([A-Z][A-Z0-9-]{2,15})\)\s*$/.exec(item.title);
    const phrase = alias ? normalize(item.title.slice(0, alias.index)) : name;
    return !topicSections(notesFor(item)).some(section => {
      if (!section.startsWith('### ')) return false;
      const [heading] = section.split('\n', 1);
      const body = normalize(topicBody(section));
      if (!body) return false;
      const matches = text => (' ' + text + ' ').includes(' ' + phrase + ' ') ||
        (alias && (' ' + text + ' ').includes(' ' + normalize(alias[1]) + ' '));
      return matches(normalize(heading)) || matches(body);
    });
  });
}

// Accept older saved replies as well as the new visible footer and common Markdown variants.
const FOOTER = /^[ \t]*(?:<!--\s*|<|\*\*|\x60|\[)?[ \t]*MISSING_DETAILS[ \t]*:[ \t]*(?:\*\*[ \t]*)?(yes|no)[ \t]*(?:-->|>|\*\*|\x60|\])?[ \t]*\r?$/i;

export function takeWriterCoverage(text) {
  const lines = String(text || '').trim().split('\n');
  const found = [];
  const md = lines.filter((line, index) => {
    const match = FOOTER.exec(line);
    if (!match) return true;
    found.push({ index, value: match[1].toLowerCase() });
    return false;
  }).join('\n').trim();
  const last = found.length === 1 && found[0].index === lines.length - 1;
  return { md, marker: last ? found[0].value : 'unconfirmed', missing: found.some(item => item.value === 'yes') };
}

/** Preserve the valid prefix if the reply ends in an unfinished code, visual, or display-math block. */
export function completeWriterPrefix(markdown) {
  let open = null;
  let offset = 0;
  for (const line of markdown.split('\n')) {
    const body = line.replace(/^(?:[ \t]*>[ \t]?)+/, '').trim();
    if (open?.kind === '$$') {
      if (body.endsWith('$$')) open = null;
    } else if (open) {
      const close = /^(?:\x60{3,}|~{3,})$/.exec(body)?.[0];
      if (close?.startsWith(open.kind)) open = null;
    } else {
      const fence = /^(?:\x60{3,}|~{3,})/.exec(body)?.[0];
      if (fence) open = { kind: fence, offset };
      else if (body.startsWith('$$') && (body.length === 2 || !body.endsWith('$$'))) open = { kind: '$$', offset };
    }
    offset += line.length + 1;
  }
  return open ? { text: markdown.slice(0, open.offset).trimEnd(), incomplete: true } : { text: markdown, incomplete: false };
}

export function readCoverageChecklist(text) {
  let rows;
  try { rows = JSON.parse(text.trim().replace(/^```(?:json)?\s*|\s*```$/gi, '')); } catch { return []; }
  if (!Array.isArray(rows)) return [];
  return rows.slice(0, 80).flatMap(row => {
    if (!row || !/^\d{1,3}:\d{2}(?::\d{2})?$/.test(row.at) || typeof row.item !== 'string' || !row.item.trim()) return [];
    const anchors = Array.isArray(row.anchors) ? [...new Set(row.anchors.filter(anchor => typeof anchor === 'string').map(normalize).filter(anchor => anchor.length >= 2))].slice(0, 5) : [];
    if (anchors.length < 2) return [];
    return [{ video: Number(row.video), at: row.at, time: row.at.split(':').reduce((seconds, part) => seconds * 60 + Number(part), 0), item: row.item.trim().slice(0, 240), anchors }];
  });
}

/** A local check for nearby evidence anchors. Wording changes can leave an item unconfirmed. */
export function unmatchedCoverage(items, notesFor) {
  return items.filter(item => {
    const markdown = notesFor(item);
    const sections = topicSections(markdown);
    const bodies = sections.some(section => section.startsWith('### ')) ? sections.filter(section => section.startsWith('### ')) : sections;
    return !bodies.some(section => {
      const definitions = section.match(/^[ \t]*>[ \t]*\*\*Slide (?:definition|quote)\b[^\n]*/gim) || [];
      const text = ' ' + normalize([topicBody(section), ...definitions].join('\n')) + ' ';
      const first = ' ' + item.anchors[0] + ' ';
      for (let at = text.indexOf(first); at >= 0; at = text.indexOf(first, at + 1)) {
        const window = text.slice(Math.max(0, at - 350), at + first.length + 350);
        if (item.anchors.every(anchor => window.includes(' ' + anchor + ' '))) return true;
      }
      return false;
    });
  });
}

export function coverageLabel(reports) {
  if (!reports?.length) return '';
  const missing = reports.reduce((count, report) => count + report.unmatched.length, 0);
  if (missing) return `Coverage unconfirmed · ${missing} checklist ${missing === 1 ? 'item needs' : 'items need'} review`;
  if (reports.some(report => report.marker === 'yes' || report.truncated)) return 'Coverage unconfirmed · writer reported gaps or a cutoff';
  if (reports.some(report => report.marker !== 'no')) return 'Coverage unconfirmed · writer completion marker missing or invalid';
  if (reports.some(report => !report.checked || report.unlistedVideos?.length)) return 'Coverage unconfirmed · no usable checklist for some material';
  return `Coverage checked · ${reports.reduce((count, report) => count + report.checked, 0)} checklist items matched`;
}
