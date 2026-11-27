/**
 * The library folder the user chose, remembered between visits so the library page (and the saved-notes page when it adds a lecture)
 * need no folder picker each time. A FileSystemDirectoryHandle can be stored in IndexedDB; the browser still asks the user to allow
 * access again after a restart, which `ensureAccess` does from a click. A tiny database of its own: the notes database is untouched.
 */
const DB = 'vid2study-library';
const STORE = 'handles';
const SLOT = 'root';

const open = (factory = globalThis.indexedDB) => new Promise((resolve, reject) => {
  const req = factory.open(DB, 1);
  req.onupgradeneeded = () => { if (!req.result.objectStoreNames.contains(STORE)) req.result.createObjectStore(STORE); };
  req.onsuccess = () => resolve(req.result);
  req.onerror = () => reject(req.error);
});

async function run(mode, work, factory) {
  const db = await open(factory);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(STORE, mode);
      const request = work(tx.objectStore(STORE));
      tx.oncomplete = () => resolve(request?.result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error('IndexedDB transaction aborted'));
    });
  } finally { db.close(); }
}

export const rememberLibrary = (handle, factory) => run('readwrite', store => store.put(handle, SLOT), factory);
export const recallLibrary = async (factory) => (await run('readonly', store => store.get(SLOT), factory)) || null;
export const forgetLibrary = (factory) => run('readwrite', store => store.delete(SLOT), factory);

/**
 * Make sure the handle can be read (and written). Call it from a click: the browser may show its permission prompt.
 * -> true when access is granted.
 */
export async function ensureAccess(handle, mode = 'readwrite') {
  if (!handle) return false;
  const options = { mode };
  if ((await handle.queryPermission?.(options)) === 'granted') return true;
  return (await handle.requestPermission?.(options)) === 'granted';
}
