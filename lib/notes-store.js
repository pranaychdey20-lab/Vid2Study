/**
 * The one place where edits to saved notes are written: the assistant's approved edits and the author's own edits both go through
 * `commit`, so undo / redo covers both. Every write is checked against what is stored (another tab may have changed the notes),
 * runs under the same locks as generation, and keeps the Markdown, the raw notes and the figure list consistent.
 */
import { getResult, putResult } from './db.js';
import { lectureLockName, PROCESSING_LOCK } from './common.js';

const LIMIT = 30;

export function createNotesStore({ key, read, redraw, locks = globalThis.navigator?.locks }) {
  let past = [], future = [];
  const listeners = new Set();
  const emit = () => { for (const fn of listeners) fn(); };
  const snapshot = (r) => ({ raw: r.summary_raw, rich: r.summary_markdown, frames: r.frames });
  const run = (work) => locks
    ? locks.request(PROCESSING_LOCK, { mode: 'shared' }, () => locks.request(lectureLockName(key), work))
    : work();

  /** Load the stored notes, and refuse to write over something this page has not seen. */
  async function current() {
    const stored = await getResult(key);
    if (!stored) throw new Error('These notes are no longer saved.');
    const shown = read();
    if (stored.summary_raw !== shown.summary_raw || stored.summary_markdown !== shown.summary_markdown) {
      throw new Error('The saved notes changed in another tab. Reload this page before editing.');
    }
    return stored;
  }

  return {
    /** `change(stored)` returns the fields to replace ({ summary_raw, summary_markdown, frames? }). */
    commit: (change) => run(async () => {
      const stored = await current();
      const patch = change(stored);
      const next = { ...stored, ...patch };
      if (next.summary_raw === stored.summary_raw && next.summary_markdown === stored.summary_markdown && next.frames === stored.frames) return stored;
      await putResult(next);
      past = [...past.slice(-(LIMIT - 1)), snapshot(stored)];
      future = [];
      redraw(next);
      emit();
      return next;
    }),
    undo: () => step(past, future),
    redo: () => step(future, past),
    canUndo: () => past.length > 0,
    canRedo: () => future.length > 0,
    subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn); }
  };

  function step(from, to) {
    return run(async () => {
      if (!from.length) return null;
      const stored = await current();
      const target = from.at(-1);
      const next = { ...stored, summary_raw: target.raw, summary_markdown: target.rich, ...(target.frames ? { frames: target.frames } : {}) };
      await putResult(next);
      from.pop();
      to.push(snapshot(stored));
      redraw(next);
      emit();
      return next;
    });
  }
}
