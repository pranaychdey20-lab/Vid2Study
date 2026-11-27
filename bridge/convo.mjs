/**
 * Shared request shaping for the CLI backends (Claude CLI, Codex CLI), which are stateless per call.
 * `history` = earlier turns { role:'user', prompt, images?, attachments? } | { role:'assistant', text }.
 * Files and pictures of earlier turns are lifted out (once each), and the turns themselves are written as a short
 * transcript ahead of the new prompt, so a continuation ("carry on from where you stopped") works without a session id.
 */
const clean = (name) => String(name || 'file.txt').replace(/[^\w. -]/g, '').slice(0, 60) || 'file.txt';

export function prepare({ prompt, images = [], attachments = [], history = [] }) {
  const files = new Map(), pics = [];
  const addFile = (a) => { if (a && typeof a.text === 'string' && a.text) files.set(clean(a.name) + '\0' + a.text.length + a.text.slice(0, 64), { name: clean(a.name), text: a.text }); };
  const addPic = (im) => { if (im && typeof im.b64 === 'string' && !pics.some((p) => p.b64 === im.b64)) pics.push(im); };
  const turns = [];
  for (const turn of Array.isArray(history) ? history : []) {
    if (turn?.role === 'assistant') turns.push(`YOUR EARLIER REPLY:\n${String(turn.text ?? '')}`);
    else if (turn) { (turn.attachments || []).forEach(addFile); (turn.images || []).forEach(addPic); turns.push(`EARLIER REQUEST:\n${String(turn.prompt ?? '')}`); }
  }
  attachments.forEach(addFile);
  images.forEach(addPic);
  const text = turns.length ? `${turns.join('\n\n')}\n\nNEW REQUEST:\n${prompt}` : prompt;
  return { prompt: text, images: pics, attachments: [...files.values()] };
}

export const attachmentBlock = (a) => `<attachment name="${clean(a.name)}">\n${a.text}\n</attachment>`;
