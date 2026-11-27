// The remembered library folder: stored in a database of its own, and access is asked for only from a click.
import assert from 'node:assert/strict';
import { rememberLibrary, recallLibrary, forgetLibrary, ensureAccess } from './lib/library-handle.js';

function fakeIdb() {
  const data = new Map();
  return {
    open() {
      const req = {};
      const db = {
        objectStoreNames: { contains: () => true }, createObjectStore() {}, close() {},
        transaction() {
          const tx = {};
          const store = { put: (v, k) => { data.set(k, v); return {}; }, get: k => ({ get result() { return data.get(k); } }), delete: k => { data.delete(k); return {}; } };
          tx.objectStore = () => store;
          setTimeout(() => tx.oncomplete?.(), 0);
          return tx;
        }
      };
      req.result = db;
      setTimeout(() => { req.onupgradeneeded?.(); req.onsuccess?.(); }, 0);
      return req;
    }
  };
}

const idb = fakeIdb();
assert.equal(await recallLibrary(idb), null, 'nothing remembered yet');
await rememberLibrary({ name: 'My library' }, idb);
assert.deepEqual(await recallLibrary(idb), { name: 'My library' });
await forgetLibrary(idb);
assert.equal(await recallLibrary(idb), null);

const calls = [];
const handle = (query, request) => ({ queryPermission: async o => { calls.push('query:' + o.mode); return query; }, requestPermission: async o => { calls.push('request:' + o.mode); return request; } });
assert.equal(await ensureAccess(handle('granted', 'denied')), true);
assert.deepEqual(calls, ['query:readwrite'], 'no prompt when access is already allowed');
assert.equal(await ensureAccess(handle('prompt', 'granted')), true);
assert.equal(await ensureAccess(handle('prompt', 'denied')), false);
assert.equal(await ensureAccess(null), false);
assert.equal(await ensureAccess({}), false, 'a handle without permission methods is refused');
console.log('library handle ok');
