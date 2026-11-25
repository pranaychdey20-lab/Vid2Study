const normalize = text => String(text || '').normalize('NFKC').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

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
    const text = ` ${normalize(notesFor(item).replace(/^[ \t]*>[^\n]*(?:\n[ \t]*>[^\n]*)*/gm, block =>
      /^\s*>\s*\*\*Slide (?:definition|quote)\b/i.test(block) ? block : ''))} `;
    const first = ` ${item.anchors[0]} `;
    for (let at = text.indexOf(first); at >= 0; at = text.indexOf(first, at + 1)) {
      const window = text.slice(Math.max(0, at - 350), at + first.length + 350);
      if (item.anchors.every(anchor => window.includes(` ${anchor} `))) return false;
    }
    return true;
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
