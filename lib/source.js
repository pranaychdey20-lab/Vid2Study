/** Video source resolver (ES module): local file saved by this extension, else the CDN. */

/**
 * Build a file:// URL from an absolute OS path (Windows, macOS, Linux), encoding each segment.
 * "C:\Users\me\My Videos\a.mp4" -> "file:///C:/Users/me/My%20Videos/a.mp4"
 */
export function fileUrl(path) {
  const p = String(path).replaceAll('\\', '/');
  const m = /^([A-Za-z]:)(\/.*)?$/.exec(p);
  const drive = m ? m[1] : '';
  const rest = m ? m[2] || '/' : p;
  const enc = rest.split('/').map((s) => encodeURIComponent(s)).join('/');
  return `file://${drive ? `/${drive}` : ''}${enc.startsWith('/') ? '' : '/'}${enc}`;
}

/**
 * Pick where the video bytes come from. Order: local copy -> CDN fetch.
 * Never fails silently: a rejected local copy is reported through `progress` before falling back.
 * @param {{url:string, local?:{path:string,size:number}|null, skipReason?:string,
 *          signal:AbortSignal, progress:Function,
 *          headSize:(url:string)=>Promise<number>, readFile:(url:string)=>Promise<Blob>,
 *          fetchRemote:()=>Promise<Blob>}} o
 * @returns {Promise<{blob: Blob, via: 'local'|'server'}>}
 */
export async function resolveSource({ url, local, skipReason, progress, headSize, readFile, fetchRemote }) {
  if (local) {
    try {
      progress('source', null, 'Checking local file…');
      const remote = await headSize(url).catch(() => 0);
      if (remote && remote !== local.size) throw new Error(`size ${local.size} differs from server ${remote}`);
      const blob = await readFile(fileUrl(local.path));
      if (blob.size !== local.size) throw new Error('file changed on disk');
      progress('source', 100, 'Using local file');
      return { blob, via: 'local' };
    } catch (e) {
      if (e?.name === 'AbortError') throw e;
      progress('source', null, `Local file unusable (${e.message}). Fetching from server`);
    }
  } else if (skipReason) {
    progress('source', null, `${skipReason} Fetching from server`);
  } else {
    progress('source', null, 'Fetching from server');
  }
  return { blob: await fetchRemote(), via: 'server' };
}
