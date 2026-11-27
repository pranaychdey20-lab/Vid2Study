/**
 * "Fix formatting" and "Generate practice paper": the two tools that change a saved lecture's notes outside the editor. Shared by the
 * finished-notes page (results.html) and the library page (library-open.html), so there is one copy of the logic and of the two dialogs.
 * Both work on the lecture the notes view has open (`view.key`) and re-draw it through `view.update(next)`.
 */
import { getResult, putResult } from './db.js';
import { loadSettings } from './settings.js';
import { lectureLockName, PROCESSING_LOCK } from './common.js';
import { renderMath } from './notes-view.js';
import { buildStandaloneHtml } from './standalone-html.js';

const DIALOGS = `
<dialog id="paperDialog" aria-labelledby="paperTitle">
  <h2 id="paperTitle">Generate practice paper</h2>
  <form id="paperForm">
    <label for="useAssignments">Add assignment or sample questions?</label>
    <select id="useAssignments"><option value="no">No</option><option value="yes">Yes</option></select>
    <div id="assignmentInputs" hidden>
      <label for="assignmentText">Paste assignment or sample questions</label>
      <textarea id="assignmentText"></textarea>
      <label for="assignmentFiles">Upload question screenshots</label>
      <input id="assignmentFiles" type="file" accept="image/*" multiple>
      <p>OCR runs locally. Images are sent for questions that need visual interpretation or OCR verification.</p>
    </div>
    <div id="paperStatus" role="status" aria-live="polite"></div>
    <button type="submit" id="paperSubmit">Generate</button>
    <button type="button" id="paperCancel">Not now</button>
  </form>
</dialog>
<dialog id="repairDialog" aria-labelledby="repairTitle">
  <h2 id="repairTitle">Use Cheap AI to check formatting?</h2>
  <p id="repairDetails"></p>
  <form method="dialog"><button value="no" autofocus>No</button><button value="yes">Yes</button></form>
</dialog>`;

/**
 * @param {{ view: object, repair: HTMLElement, practice: HTMLElement, toast: (m: string) => void, host?: HTMLElement }} options
 * @returns {{ openPractice: () => void, abort: () => void, refreshPractice: () => Promise<void> }}
 */
export function mountNotesTools({ view, repair, practice, toast, host = document.body }) {
  if (!document.getElementById('paperDialog')) host.insertAdjacentHTML('beforeend', DIALOGS);
  const $ = id => document.getElementById(id);
  let paperJob = null, repairJob = null;
  const openPractice = () => { $('paperStatus').textContent = ''; $('paperDialog').showModal(); };

  const refreshPractice = async () => { practice.hidden = !(await loadSettings()).practiceQuestions; };
  refreshPractice();

  repair.addEventListener('click', async () => {
    if (repairJob || !view.key) return;
    repairJob = new AbortController();
    const { signal } = repairJob;
    const key = view.key;
    repair.disabled = true;
    repair.textContent = 'Checking formatting…';
    const withNotesLock = work => navigator.locks.request(PROCESSING_LOCK, { mode: 'shared', signal }, () =>
      navigator.locks.request(lectureLockName(key), { signal }, work));
    try {
      if (!window.katex) throw new Error('The math renderer did not load.');
      const { repairFormatting, repairWithCheapAi, applyRawRepairs, AI_REPAIR_LIMIT } = await import('./repair-formatting.js');
      const validMath = (tex, display) => !!renderMath(tex, display);
      let review, raw, current;
      current = await withNotesLock(async () => {
        const saved = await getResult(key);
        if (!saved) throw new Error('These notes are no longer saved.');
        review = repairFormatting(saved.summary_markdown, validMath);
        raw = repairFormatting(saved.summary_raw ?? saved.summary_markdown, validMath);
        if (!review.repairs && !raw.repairs) return saved;
        const fixed = { ...saved, summary_markdown: review.markdown, summary_raw: raw.markdown };
        await putResult(fixed);
        return fixed;
      });
      view.update(current);
      if (!review.issues.length) {
        toast(review.repairs || raw.repairs ? 'Formatting fixes saved' : 'No formatting problems found');
        return;
      }
      const dialog = $('repairDialog');
      const count = review.issues.length;
      const sent = Math.min(count, AI_REPAIR_LIMIT);
      $('repairDetails').textContent = count + (count === 1 ? ' passage needs' : ' passages need') +
        ' review. Send ' + sent + (sent === 1 ? ' passage' : ' passages') + ' and nearby lines to your Cheap AI?';
      dialog.returnValue = 'no';
      const approved = await new Promise(resolve => {
        dialog.addEventListener('close', () => resolve(dialog.returnValue === 'yes'), { once: true });
        dialog.showModal();
      });
      if (!approved) { toast('Local scan complete. Unresolved passages were kept.'); return; }
      repair.textContent = 'Checking with Cheap AI…';
      current = await withNotesLock(async () => {
        const saved = await getResult(key);
        if (saved?.summary_markdown !== review.markdown || saved?.summary_raw !== current.summary_raw) {
          throw new Error('The notes changed. Run Fix formatting again.');
        }
        const { markdown: fixed, accepted } = await repairWithCheapAi(review, await loadSettings(), validMath, signal);
        signal.throwIfAborted();
        const changes = fixed !== review.markdown;
        const remaining = repairFormatting(fixed, validMath).issues.length;
        if (!changes) { toast('No safe AI formatting fixes were found.'); return saved; }
        const summary_raw = saved.summary_raw === saved.summary_markdown ? fixed : applyRawRepairs(saved.summary_raw, accepted);
        const updated = { ...saved, summary_markdown: fixed, summary_raw };
        if (!await getResult(key)) throw new Error('These notes are no longer saved.');
        await putResult(updated);
        toast(remaining ? remaining + ' passages still need review' : 'Formatting fixes saved');
        return updated;
      });
      view.update(current);
    } catch (error) {
      if (!signal.aborted) toast(error.message || String(error));
    } finally {
      repairJob = null;
      repair.disabled = false;
      repair.textContent = 'Fix formatting';
    }
  });

  practice.addEventListener('click', openPractice);
  $('useAssignments').addEventListener('change', () => { $('assignmentInputs').hidden = $('useAssignments').value !== 'yes'; });
  $('paperCancel').addEventListener('click', () => {
    if (paperJob) paperJob.abort();
    else $('paperDialog').close();
  });
  $('paperDialog').addEventListener('cancel', event => { if (paperJob) { event.preventDefault(); paperJob.abort(); } });
  $('paperForm').addEventListener('submit', async event => {
    event.preventDefault();
    if (paperJob || !view.key) return;
    const key = view.key;
    const withAssignments = $('useAssignments').value === 'yes';
    const text = withAssignments ? $('assignmentText').value : '';
    const files = withAssignments ? [...$('assignmentFiles').files] : [];
    const status = $('paperStatus');
    if (withAssignments && !text.trim() && !files.length) {
      status.textContent = 'Paste questions or attach at least one screenshot.';
      return;
    }
    paperJob = new AbortController();
    const { signal } = paperJob;
    $('paperSubmit').disabled = true;
    $('paperCancel').textContent = 'Cancel generation';
    status.textContent = 'Preparing the practice paper';
    try {
      const { writePracticePaper, appendPracticePaper } = await import('./practice-paper.js');
      const updated = await navigator.locks.request(PROCESSING_LOCK, { mode: 'shared', signal }, () =>
        navigator.locks.request(lectureLockName(key), { signal }, async () => {
          const saved = await getResult(key);
          if (!saved) throw new Error('These notes are no longer saved.');
          const paper = await writePracticePaper(saved, await loadSettings(), {
            text, files, signal, onWait: value => { status.textContent = value; },
            prepareNotesPdf: markdown => {
              status.textContent = 'Preparing the combined notes for PDF attachment';
              return buildStandaloneHtml({ result: saved, images: view.images, markdown });
            }
          });
          signal.throwIfAborted();
          const addPaper = markdown => appendPracticePaper(markdown, paper);
          const next = { ...saved, summary_markdown: addPaper(saved.summary_markdown), summary_raw: addPaper(saved.summary_raw) };
          // Full deletion can happen from a second Saved notes tab during generation.
          if (!await getResult(key)) throw new Error('These notes are no longer saved.');
          await putResult(next);
          return next;
        }));
      view.update(updated);
      $('paperDialog').close();
      $('paperForm').reset();
      $('assignmentInputs').hidden = true;
      toast('Practice paper saved');
    } catch (error) {
      status.textContent = signal.aborted ? 'Practice paper cancelled.' : error.message || String(error);
    } finally {
      paperJob = null;
      $('paperSubmit').disabled = false;
      $('paperCancel').textContent = 'Not now';
    }
  });

  return { openPractice, abort: () => { paperJob?.abort(); repairJob?.abort(); }, refreshPractice };
}
