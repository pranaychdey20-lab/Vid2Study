/** "Saved notes": every summary kept in the browser (IndexedDB), with open / delete. */
import { listResults, deleteResult } from './lib/db.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let all = [];

/** The page the video came from, when the key is a web address. */
const sourceUrl = (key) => (/^yt:/.test(key) ? `https://www.youtube.com/watch?v=${key.slice(3)}` : /^https?:/.test(key) ? key : '');

function draw() {
  const q = $('q').value.trim().toLowerCase();
  const rows = all.filter((r) => !q || `${r.title} ${r.course}`.toLowerCase().includes(q));
  $('list').innerHTML = rows.map((r) => `<div class="item" data-key="${esc(r.key)}">
      <h3>${esc(r.title || 'Untitled')}</h3>
      <div class="meta">${esc(r.course || '')}${r.course ? ' · ' : ''}${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''} · ${r.words} words · ${r.figures} figure${r.figures === 1 ? '' : 's'}${r.model ? ` · ${esc(r.model)}` : ''}</div>
      <div class="row"><button type="button" class="primary" data-a="open">Open notes</button>
        ${sourceUrl(r.key) ? `<button type="button" data-a="src">Open video page</button>` : ''}
        <button type="button" data-a="del">Delete</button></div>
    </div>`).join('') || `<div class="hint">${all.length ? 'No match.' : 'Nothing saved yet. Summarize a video and it will be listed here.'}</div>`;
}

$('list').addEventListener('click', async (e) => {
  const a = e.target.dataset.a, key = e.target.closest('.item')?.dataset.key;
  if (!a || !key) return;
  if (a === 'open') location.href = `results.html?key=${encodeURIComponent(key)}`;
  else if (a === 'src') window.open(sourceUrl(key), '_blank');
  else if (a === 'del' && confirm('Delete these notes and their images?')) { await deleteResult(key); all = all.filter((r) => r.key !== key); draw(); }
});
$('q').addEventListener('input', draw);
all = await listResults().catch(() => []);
draw();
