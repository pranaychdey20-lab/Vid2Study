/** Keep Markdown structure when collecting Gemini's rendered browser reply. */
export function readGeminiMarkdown(body) {
  return body.evaluate(root => {
    const render = node => {
      if (node.nodeType === Node.TEXT_NODE) return node.nodeValue || '';
      if (node.nodeType !== Node.ELEMENT_NODE) return '';
      const tag = node.tagName;
      if (node.matches('button, script, style, [hidden]')) return '';
      if (node.matches('.katex-display, .katex, mjx-container')) {
        const tex = node.querySelector('annotation[encoding="application/x-tex"]')?.textContent || node.getAttribute('data-tex');
        if (tex) return node.matches('.katex-display, [display="true"]') ? '\n\n$$\n' + tex + '\n$$\n\n' : '$' + tex + '$';
        return node.innerText || node.textContent;
      }
      const children = () => [...node.childNodes].map(render).join('');
      if (/^H[1-6]$/.test(tag)) return '\n\n' + '#'.repeat(Number(tag[1])) + ' ' + children().trim() + '\n\n';
      if (tag === 'BR') return '\n';
      if (tag === 'HR') return '\n\n---\n\n';
      if (tag === 'P') return '\n\n' + children().trim() + '\n\n';
      if (tag === 'STRONG' || tag === 'B') return '**' + children() + '**';
      if (tag === 'EM' || tag === 'I') return '*' + children() + '*';
      if (tag === 'CODE') return '`' + node.textContent + '`';
      if (tag === 'PRE') {
        const code = node.querySelector('code') || node;
        const lang = /(?:^|\s)language-([\w+-]+)/.exec(code.className)?.[1] || '';
        const text = code.textContent.trimEnd();
        const fence = '`'.repeat(Math.max(3, ...[...text.matchAll(/`+/g)].map(match => match[0].length + 1)));
        return '\n\n' + fence + lang + '\n' + text + '\n' + fence + '\n\n';
      }
      if (tag === 'BLOCKQUOTE') return '\n\n' + children().trim().split('\n').map(line => '> ' + line).join('\n') + '\n\n';
      if (tag === 'OL' || tag === 'UL') {
        const start = Number(node.getAttribute('start')) || 1;
        return '\n\n' + [...node.children].filter(li => li.tagName === 'LI').map((li, i) => {
          const prefix = tag === 'OL' ? (start + i) + '. ' : '- ';
          return prefix + render(li).trim().replaceAll('\n', '\n' + ' '.repeat(prefix.length));
        }).join('\n') + '\n\n';
      }
      if (tag === 'A') {
        const label = children();
        const href = node.getAttribute('href') || '';
        return /^https?:\/\//i.test(href) ? '[' + label + '](' + href + ')' : label;
      }
      if (tag === 'TABLE') {
        const rows = [...node.rows].map(row => [...row.cells].map(cell => render(cell).trim().replace(/\s*\n\s*/g, ' ').replaceAll('|', '\\|')));
        if (!rows.length) return '';
        const width = Math.max(...rows.map(row => row.length));
        rows.splice(1, 0, Array(width).fill('---'));
        return '\n\n' + rows.map(row => '| ' + row.join(' | ') + ' |').join('\n') + '\n\n';
      }
      return children();
    };
    return render(root).trim();
  });
}
