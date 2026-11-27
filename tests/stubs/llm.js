/**
 * Test stub for lib/llm.js (copied over the real file inside the sandbox by tests/run.mjs).
 * `generate` answers each prompt by its [TASK:...] tag; `gfetch` records requests in `posts` and
 * returns a fake Whisper `verbose_json` reply. `calls` lists every generate() call.
 */
export const calls = [];
export const posts = [];
export const sleep = () => {};
export const readGemini = null;
export const thinkingFor = null;
export const parseJsonLoose = (t) => JSON.parse(t);
export const searchTool = p => ['codexcli', 'claudecli'].includes(p.type) ? 'bridge' : null;

export async function gfetch(url, opts) {
  posts.push({ url, form: opts.body });
  // a fake service ("notturbo") that lacks some speech models, like Groq lacks whisper-1
  const m = opts.body?.get?.('model');
  if (/notturbo/.test(url) && /^(missing.*|whisper-large-v3-turbo)$/.test(m)) throw new Error(`Not found (404): The model \`${m}\` does not exist or you do not have access to it.`);
  // a service like OpenRouter that only answers plain json
  if (/plainonly/.test(url) && opts.body?.get?.('response_format') === 'verbose_json') throw new Error('OpenRouter rejected the request (400): The selected model does not support response_format "verbose_json". Use "json" instead.');
  if (/plainonly/.test(url)) return { json: async () => ({ text: `piece ${posts.length}` }) };
  return { json: async () => ({ segments: [{ start: 1, end: 2, text: `hello ${posts.length}` }] }) };
}

/** Make matching calls fail: push { model?, task?, status?, message? } (status undefined = an unreadable reply, no HTTP error). */
export const failures = [];

export async function generate(p, model, o) {
  const task = /\[TASK:(\w+)\]/.exec(o.prompt)[1];
  calls.push({ model, task, prompt: o.prompt, attachments: o.attachments || [], history: o.history || [], all: o.prompt + '\n' + (o.attachments || []).map((a) => a.text).join('\n'), attached: (o.attachments || []).map((a) => a.text).join('\n\n'), maxTokens: o.maxTokens, images: o.images?.length || 0, labels: (o.images || []).map((i) => i.label), session: o.session, search: o.search });
  if (o.singleRequest) Object.assign(calls.at(-1), { singleRequest: true, notesHtml: o.notesHtml });
  const f = failures.find((x) => (!x.model || x.model === model) && (!x.task || x.task === task));
  if (f?.reply) return { text: f.reply, session: f.session, truncated: f.truncated, usage: { in: 1, out: 1 } };
  if (f) throw Object.assign(new Error(f.message || `Not found (404): The model \`${model}\` does not exist.`), 'status' in f ? { status: f.status } : {});
  if (task === 'SCREEN' || task === 'DESCRIBE') {
    // a fake vision model: SCREEN keeps every 3rd frame (the others are "dup"), DESCRIBE ranks by id and describes
    const ids = [...o.prompt.matchAll(/Image \d+ = F(\d+) at/g)].map((m) => Number(m[1]));
    if (task === 'SCREEN') {
      const keep = ids.filter((_, i) => i % 3 === 0);
      return { text: JSON.stringify({ keep: keep.map((n) => ({ id: 'F' + n, kind: 'painting', info: 6, label: 'deity ' + n })), drop: ids.filter((n) => !keep.includes(n)).map((n) => (n % 5 === 0 ? 'F' + n + ':title' : 'F' + n + ':dup>F' + keep.filter((k) => k < n).pop())).join(' ') }), usage: { in: 1000, out: 100 } };
    }
    return { text: JSON.stringify({ frames: ids.map((n) => ({ id: 'F' + n, keep: true, kind: /video "QUOTE/.test(o.prompt) && n === ids[0] ? 'quote' : 'illustration', info: Math.min(10, 1 + (n % 10)), caption: 'cap ' + n, text: /video "QUOTE/.test(o.prompt) && n === ids[0] ? 'Forget not the tyranny of this wall ... nor the love of freedom that made it fall ...\n- Unknown, Graffiti on the Berlin Wall' : '', detail: 'detail of ' + n })) }), usage: { in: 2000, out: 500 } };
  }
  if (task === 'DIGEST') {
    const lines = (o.attachments?.[0]?.text || o.prompt).split('\n\n').pop();
    const type = o.prompt.includes('=== TYPE ===') ? '\n=== TYPE ===\n{"technical": false, "kind": "religion", "subject": "hindu gods"}' : '';
    const refs = '\n=== REFERENCES ===\n[{"kind":"document","title":"Basic Treaty of 1972","author":"FRG and GDR","at":"00:40","why":"West Germany recognised East Germany"},{"kind":"book","title":"The Berlin Wall: A World Divided","author":"Frederick Taylor","at":"01:00","why":"cited for the building of the wall"}]';
    return { text: '=== BRIEF ===\nBRIEF-LINE about gods\n=== TIMELINE ===\n' + lines.replace(/story goes on and on/g, 'SUMMARY-LINE') + refs + type, usage: { in: 100, out: 100 } };
  }
  if (task === 'CHUNK') return { text: '## [00:00] Topic\n- point (F1)\n- another', usage: { in: 100, out: 50 } };
  if (task === 'FINAL') return { text: '## Overview\n- ov\n\n## Exam hints\n- eh', usage: { in: 10, out: 10 } };
  if (task === 'QUESTIONS') return { text: '## Practice questions\n### Topic 1\n**Q1.** Why?\n\n**Answer:** 1. because $x=1$', usage: { in: 50, out: 50 } };
  if (task === 'CLASSIFY') return { text: '{"technical": true, "kind": "lecture", "subject": "test"}', usage: { in: 50, out: 10 } };
  if (task === 'OUTPUTS') return { text: '{"1": "4"}', usage: { in: 5, out: 5 } };
  if (task === 'WRITE' && /Lecture: FIGSTEST/.test(o.prompt)) {
    // a writer that places ONE attached picture inline and picks TWO extras (frames without a picture) in its figure list
    const attached = [...(/PICTURES \(attached[^\n]*/.exec(o.prompt)?.[0] || '').matchAll(/= F(\d+) at/g)].map((m) => Number(m[1]));
    const offered = [...(/Frames you may use: ([^\n]*)/.exec(o.prompt)?.[1] || '').matchAll(/F(\d+)/g)].map((m) => Number(m[1]));
    const extras = offered.filter((n) => !attached.includes(n));
    return { text: `## Overview\n- o\n\n## Detailed notes\n### Topic A (00:10)\n- **Big idea:** big idea of a\n- **Key points:**\n  - first point here\n    - a sub bullet\n  - second point\n[[FRAME:${attached[0]}]]\n> **Example:** e\n### Topic B (10:00)\n- **Big idea:** second idea\n<!--FIGS ${extras[0]}@1|first point here;${extras[1]}@2-->\nMISSING_DETAILS: NO`, usage: { in: 10, out: 10 } };
  }
  if (task === 'WRITE' && /Lecture: CODEDEMO/.test(o.prompt)) {
    // a writer that forgot the output of its code example
    return { text: '## Overview\n- o\n\n## Detailed notes\n### Adding (00:10)\n- **Big idea:** add\n```python\nprint(2 + 2)\n```\nMISSING_DETAILS: NO', usage: { in: 10, out: 10 } };
  }
  if (task === 'WRITE' && /Lecture: CUTOFF/.test(o.prompt)) {
    return { text: '## Overview\n- o\n\n## Detailed notes\n### Start (00:10)\n- **Big idea:** half', truncated: true, usage: { in: 10, out: 10 } };
  }
  if (task === 'WRITE_CONTINUE' && /\*\*Big idea:\*\* half/.test(o.prompt)) {
    return { text: '### End (01:00)\n- **Big idea:** the end\n[[FRAME:F3]]\n<!--MISSING_DETAILS: no-->', usage: { in: 10, out: 10 } };
  }
  if (task === 'WRITE') {
    const full = /## Overview/.test(o.prompt.split('\nOUTPUT (')[1] || '');
    const n = (o.prompt.match(/part (\d+) of/) || [, '1'])[1];
    const body = `### Topic ${n} (00:10)\n- **Big idea:** big ${n}\n> **[EXTRA]:** e\n>\n> Supplemental explanation continues here.\n[[VISUAL: Sine | shows sine | amplitude slider]]\n$$x=1$$\n`;
    const notes = full ? `## Overview\n- o\n\n## Detailed notes\n${body}\n## Exam hints\n- h` : body;
    return { text: `${notes}\nMISSING_DETAILS: NO`, usage: { in: 1000, out: 500 } };
  }
  return { text: 'x', usage: { in: 1, out: 1 } };
}
