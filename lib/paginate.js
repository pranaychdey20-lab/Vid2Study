/** Lay out the standalone document before saving it so page references survive offline and PDF printing. */
export async function paginate(html) {
  const frame = document.createElement('iframe');
  frame.style.cssText = 'position:fixed;left:-200vw;top:0;width:210mm;height:297mm;border:0';
  const ready = new Promise((resolve, reject) => {
    frame.onload = resolve;
    frame.onerror = () => reject(new Error("Could not open the print renderer"));
  });
  frame.src = chrome.runtime.getURL('pager.html');
  document.body.append(frame);
  try {
    await ready;
    const doc = frame.contentDocument;
    const engine = frame.contentWindow.PagedModule;
    if (!engine) throw new Error('Could not load the pagination engine');
    const source = new DOMParser().parseFromString(html, 'text/html');
    doc.title = source.title;
    for (const style of source.querySelectorAll('style')) doc.head.append(doc.importNode(style, true));
    doc.body.replaceChildren(...[...source.body.childNodes].map(node => doc.importNode(node, true)));
    await doc.fonts.ready;
    const preview = new engine.Previewer();
    await preview.preview();
    const pages = [...doc.querySelectorAll('.pagedjs_page')].filter(page => {
      // Forced section breaks can leave an empty fragment, even with no text to print.
      const content = page.querySelector('.pagedjs_page_content');
      if (content?.textContent.trim() || content?.querySelector('img, svg, canvas, hr')) return true;
      page.remove();
      return false;
    });
    for (const page of pages) {
      const callouts = page.querySelectorAll('.slide-ocr,.watch-out,.quick-check,.extra-context');
      for (const item of [...callouts].slice(2)) {
        item.style.background = 'transparent';
        item.style.borderColor = 'transparent';
      }
    }
    for (const ref of doc.querySelectorAll('.page-ref')) {
      const id = ref.getAttribute('href').split('#').pop();
      const page = pages.findIndex(p => p.querySelector('[id="'+CSS.escape(id)+'"]'));
      if (page < 0) throw new Error('Cannot resolve page reference '+id);
      ref.append(String(page+1));
    }
    doc.querySelector('script')?.remove();
    for (const sheet of [...doc.styleSheets]) {
      const css = [...sheet.cssRules].map(r => r.cssText).join('\n');
      const style = doc.createElement('style');
      style.textContent = css;
      sheet.ownerNode.replaceWith(style);
    }
    return '<!doctype html>'+doc.documentElement.outerHTML;
  } finally { frame.remove(); }
}
