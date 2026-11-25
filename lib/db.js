/**
 * IndexedDB storage (extension origin, shared by service worker, offscreen, options and results pages).
 * Stores:
 *   results: { key (clean video URL), title, course, summary_markdown, summary_raw, frames[], createdAt, model }
 *   frames:  { id: `${key}/${filename}`, blob }
 *   drafts:  { key, extract, frames, notes{}, usage }  partial work of an unfinished job, so a retry resumes
 */
const DB_NAME = 'iitg-lecture-helper';
const DB_VERSION = 2;
let dbPromise = null;

/** @returns {Promise<IDBDatabase>} */
export function openDb() {
  if (!dbPromise) {
    dbPromise = new Promise((resolve, reject) => {
      const req = indexedDB.open(DB_NAME, DB_VERSION);
      req.onupgradeneeded = () => {
        const db = req.result;
        if (!db.objectStoreNames.contains('results')) db.createObjectStore('results', { keyPath: 'key' });
        if (!db.objectStoreNames.contains('frames')) db.createObjectStore('frames', { keyPath: 'id' });
        if (!db.objectStoreNames.contains('drafts')) db.createObjectStore('drafts', { keyPath: 'key' });
      };
      req.onsuccess = () => resolve(req.result);
      req.onerror = () => reject(req.error);
    });
  }
  return dbPromise;
}

async function run(stores, mode, fn) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(stores, mode);
    const value = fn(tx); // must queue requests synchronously
    tx.oncomplete = () => resolve(value instanceof IDBRequest ? value.result : value);
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
  });
}

const prefixRange = (key) => IDBKeyRange.bound(`${key}/`, `${key}/￿`);

export const getResult = (key) => run('results', 'readonly', (tx) => tx.objectStore('results').get(key));
export const putResult = (obj) => run('results', 'readwrite', (tx) => { tx.objectStore('results').put(obj); });
export const putFrame = (id, blob) => run('frames', 'readwrite', (tx) => { tx.objectStore('frames').put({ id, blob }); });
export const getFrame = async (id) => (await run('frames', 'readonly', (tx) => tx.objectStore('frames').get(id)))?.blob || null;

/** Delete every stored frame image under a key (used before a re-scan and to drop unused scene frames). */
export const deleteFrames = (key) => run('frames', 'readwrite', (tx) => { tx.objectStore('frames').delete(prefixRange(key)); });
export const deleteFrame = (id) => run('frames', 'readwrite', (tx) => { tx.objectStore('frames').delete(id); });

/** Delete a cached result and all of its frame images. */
export const deleteResult = (key) =>
  run(['results', 'frames'], 'readwrite', (tx) => {
    tx.objectStore('results').delete(key);
    tx.objectStore('frames').delete(prefixRange(key));
  });

/** Wipe everything. */
export const clearAll = () =>
  run(['results', 'frames', 'drafts'], 'readwrite', (tx) => {
    tx.objectStore('results').clear();
    tx.objectStore('frames').clear();
    tx.objectStore('drafts').clear();
  });

export const countResults = () => run('results', 'readonly', (tx) => tx.objectStore('results').count());

/** True when a summary is cached for this key (does not load the result). */
export const hasResult = async (key) => (await run('results', 'readonly', (tx) => tx.objectStore('results').count(key))) > 0;

// ---------- drafts (resume an unfinished job without redoing the video) ----------
export const getDraft = (key) => run('drafts', 'readonly', (tx) => tx.objectStore('drafts').get(key));
export const putDraft = (obj) => run('drafts', 'readwrite', (tx) => { tx.objectStore('drafts').put(obj); });
export const deleteDraft = (key) => run('drafts', 'readwrite', (tx) => { tx.objectStore('drafts').delete(key); });

function removeFigures(result) {
  result.frames = [];
  result.summary_markdown = String(result.summary_markdown || '').replace(/^!\[[^\n]*\]\(images\/[^\n]+\)[ \t]*(?:\r?\n|$)/gm, '');
}

/** Clear drafts, debug data and unreferenced frames in one transaction. */
export const clearProcessingArtifacts = (includeFigures) =>
  run(['results', 'frames', 'drafts'], 'readwrite', tx => {
    const results = tx.objectStore('results');
    const frames = tx.objectStore('frames');
    const retained = new Set();
    tx.objectStore('drafts').clear();
    if (includeFigures) frames.clear();
    const scan = results.openCursor();
    scan.onsuccess = () => {
      const item = scan.result;
      if (item) {
        const result = item.value;
        if (result.internal) item.delete();
        else {
          delete result.sourceRecord;
          delete result.debug;
          delete result.writerReplies;
          if (includeFigures) removeFigures(result);
          else for (const frame of result.frames || []) if (frame.filename) retained.add(`${result.key}/${frame.filename}`);
          item.update(result);
        }
        item.continue();
      } else if (!includeFigures) {
        const images = frames.openKeyCursor();
        images.onsuccess = () => {
          const frame = images.result;
          if (!frame) return;
          if (!retained.has(frame.primaryKey)) frames.delete(frame.primaryKey);
          frame.continue();
        };
      }
    };
  });

/** Remove saved processing data while keeping the finished notes. */
export const deleteLectureArtifacts = (key, kind) =>
  run(['results', 'frames', 'drafts'], 'readwrite', (tx) => {
    const results = tx.objectStore('results');
    const request = results.get(key);
    request.onsuccess = () => {
      const result = request.result;
      if (!result) return;
      if (kind === 'transcript') {
        delete result.sourceRecord;
        const kept = new Set((result.frames || []).map(frame => `${key}/${frame.filename}`));
        const cursor = tx.objectStore('frames').openKeyCursor(prefixRange(key));
        cursor.onsuccess = () => {
          const frame = cursor.result;
          if (!frame) return;
          if (!kept.has(frame.primaryKey)) tx.objectStore('frames').delete(frame.primaryKey);
          frame.continue();
        };
      }
      if (kind === 'transcript' || kind === 'logs') { delete result.debug; delete result.writerReplies; }
      if (kind === 'frames') {
        removeFigures(result);
        tx.objectStore('frames').delete(prefixRange(key));
      }
      if (kind !== 'logs') tx.objectStore('drafts').delete(key);
      results.put(result);
    };
  });

/** Every saved result, newest first, without the heavy fields (for the "Saved notes" list). */
export const listResults = async () => {
  const all = await run('results', 'readonly', (tx) => tx.objectStore('results').getAll());
  return all
    .filter(r => !r.internal)
    .map((r) => ({ key: r.key, title: r.title, course: r.course, createdAt: r.createdAt || 0, model: r.model, figures: (r.frames || []).length, words: String(r.summary_markdown || '').split(/\s+/).length }))
    .sort((a, b) => b.createdAt - a.createdAt);
};
