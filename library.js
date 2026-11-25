/** "Saved notes": every summary kept in the browser (IndexedDB), with open / delete. */
import { listResults, deleteResult } from './lib/db.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
let all = [];

const cleanup = {
  transcript: { label: 'Delete transcript', message: 'Delete the saved transcript, frame OCR, model replies, debug dump, and any unfinished processing draft for this lecture? Finished notes and their figures will stay.' },
  logs: { label: 'Delete logs', message: 'Delete the saved model replies, debug dump, and activity logs linked to this lecture?' },
  frames: { label: 'Delete frame images', message: 'Delete all saved frame images and any unfinished processing draft for this lecture? The note text and captions will stay. Future exports will omit the images.' }
};

function draw() {
  const q = $('q').value.trim().toLowerCase();
  const rows = all.filter((r) => !q || `${r.title} ${r.course}`.toLowerCase().includes(q));
  $('list').innerHTML = rows.map((r) => `<div class="item" data-key="${esc(r.key)}">
      <h3>${esc(r.title || 'Untitled')}</h3>
      <div class="meta">${esc(r.course || '')}${r.course ? ' · ' : ''}${r.createdAt ? new Date(r.createdAt).toLocaleString() : ''} · ${r.words} words · ${r.figures} figure${r.figures === 1 ? '' : 's'}${r.model ? ` · ${esc(r.model)}` : ''}</div>
      <div class="row"><button type="button" class="primary" data-a="open">Open notes</button>
        <button type="button" data-a="del">Delete</button></div>
      <div class="row">${Object.entries(cleanup).map(([kind, { label }]) => `<button type="button" data-a="${kind}">${label}</button>`).join('')}</div>
    </div>`).join('') || `<div class="hint">${all.length ? 'No match.' : 'Nothing saved yet. Summarize a video and it will be listed here.'}</div>`;
}

$('list').addEventListener('click', async (e) => {
  const a = e.target.dataset.a, key = e.target.closest('.item')?.dataset.key;
  if (!a || !key) return;
  if (a === 'open') location.href = `results.html?key=${encodeURIComponent(key)}`;
  else if (Object.hasOwn(cleanup, a) || a === 'del') {
    if (!confirm(cleanup[a]?.message || 'Delete these notes and their images?')) return;
    const buttons = e.target.closest('.item').querySelectorAll('button');
    buttons.forEach(button => { button.disabled = true; });
    try {
      if (a === 'del') await deleteResult(key);
      else {
        const reply = await chrome.runtime.sendMessage({ type: 'DELETE_LECTURE_ARTIFACTS', key, kind: a });
        if (!reply?.ok) throw new Error(reply?.error || 'Cleanup did not finish.');
      }
      all = await listResults();
      draw();
      $('status').textContent = ({ del: 'Notes deleted.', transcript: 'Transcript and processing data deleted.', logs: 'Linked logs deleted.', frames: 'Frame images deleted.' })[a];
    } catch (error) {
      $('status').textContent = error.message || String(error);
    } finally {
      buttons.forEach(button => { button.disabled = false; });
    }
  }
});
$('q').addEventListener('input', draw);
$('clearProcessing').addEventListener('click', async () => {
  const includeFigures = $('includeFigures').checked;
  const message = 'Delete the activity log, debug dumps, saved transcripts, unfinished processing drafts, and unused frames?' +
    (includeFigures ? ' This will also remove figures from saved notes.' : ' Saved notes and their figures will stay.');
  if (!confirm(message)) return;
  $('clearProcessing').disabled = true;
  $('status').textContent = 'Clearing processing files…';
  try {
    const reply = await chrome.runtime.sendMessage({ type: 'CLEAR_PROCESSING_FILES', includeFigures });
    if (!reply?.ok) throw new Error(reply?.error || 'Cleanup did not finish.');
    all = await listResults();
    draw();
    $('status').textContent = 'Processing files cleared.';
  } catch (error) {
    $('status').textContent = error.message;
  } finally {
    $('clearProcessing').disabled = false;
  }
});
all = await listResults().catch(() => []);
draw();
