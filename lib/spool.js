/**
 * Byte spool (ES module): collects downloaded chunks in memory and, once they pass `limit`, moves everything
 * to a file in the origin-private file system (OPFS) so a 12-24 h download does not have to fit in RAM.
 * `finish()` returns a Blob (a File backed by the disk when spilled). Falls back to memory when OPFS is
 * unavailable. Spilled files are removed by `clearSpool()` (call it when the job no longer needs the blob).
 */
const DIR = 'lh-spool';
const LIMIT = 768 * 1024 * 1024;

const opfsRoot = async () => (typeof navigator !== 'undefined' && navigator.storage?.getDirectory ? navigator.storage.getDirectory() : null);

export async function clearSpool() {
  try {
    const root = await opfsRoot();
    if (root) await root.removeEntry(DIR, { recursive: true });
  } catch { /* nothing there */ }
}

/** @param {string} name unique file name  @param {number} [limit] bytes kept in memory before spilling */
export function createSpool(name, limit = LIMIT) {
  let chunks = [];
  let size = 0;
  let writer = null, handle = null, spillFailed = false;
  const spill = async () => {
    try {
      const root = await opfsRoot();
      if (!root) throw new Error('no OPFS');
      const dir = await root.getDirectoryHandle(DIR, { create: true });
      handle = await dir.getFileHandle(`${Date.now()}-${name}`, { create: true });
      writer = await handle.createWritable();
      for (const c of chunks) await writer.write(c);
      chunks = [];
    } catch (e) {
      console.warn('[Vid2Study] could not spool to disk, keeping the download in memory:', e?.message);
      spillFailed = true; writer = null; handle = null;
    }
  };
  return {
    get size() { return size; },
    get onDisk() { return !!writer; },
    /** @param {Uint8Array} chunk */
    async write(chunk) {
      size += chunk.byteLength;
      if (writer) { await writer.write(chunk); return; }
      chunks.push(chunk);
      if (size > limit && !spillFailed) await spill();
    },
    /** @returns {Promise<Blob>} */
    async finish(type = '') {
      if (writer) {
        await writer.close();
        const f = await handle.getFile();
        return type ? new Blob([f], { type }) : f; // a Blob over a File still reads from disk
      }
      return new Blob(chunks, { type });
    },
    async abort() {
      chunks = [];
      try { await writer?.abort(); } catch { /* ignore */ }
    }
  };
}
