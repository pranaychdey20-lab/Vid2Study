/**
 * YouTube through the local bridge's yt-dlp (ES module, offscreen document). Used when the page's own player
 * gave no captions, or the extension's own stream download failed: captions first (seconds), then the audio
 * and/or the video as files. Every call fails soft (null) so the job can still listen to the page as before.
 * The bridge's address + token come from the service worker (BRIDGE_INFO: a bridge provider in Options, else
 * the native host, which also starts the bridge).
 */
import { downloadStream } from './download-pipeline.js';

const mb = (n) => (n / 1048576).toFixed(0);

/** { url, token } of a running bridge, or null (with the reason logged by the caller). */
export async function getBridge() {
  const r = await chrome.runtime.sendMessage({ type: 'BRIDGE_INFO', start: true }).catch((e) => ({ ok: false, error: e.message }));
  return r?.ok && r.url && r.token ? { url: r.url, token: r.token } : { error: r?.error || 'the bridge is not running' };
}

const headers = (b) => ({ 'Content-Type': 'application/json', 'x-bridge-token': b.token });

/** Captions as "[mm:ss] text" lines, or throws with the bridge's reason. */
export async function bridgeSubs(b, id, signal) {
  const res = await fetch(`${b.url}/youtube/subs`, { method: 'POST', headers: headers(b), body: JSON.stringify({ id }), signal });
  const j = await res.json().catch(() => ({}));
  if (!res.ok || !j.text) throw new Error(j.error?.message || `HTTP ${res.status}`);
  return j;
}

/**
 * Audio and/or video files through yt-dlp, in parallel. Returns { audioBlob, videoBlob } (either may be null).
 * @param {{audio:boolean, video:boolean, maxHeight?:number}} want
 */
export async function bridgeMedia(b, id, want, { signal, progress, onError }) {
  const st = { audio: 0, video: 0 };
  const emit = () => progress('fetch', null, `Downloading with yt-dlp: ${mb(st.audio + st.video)} MB`);
  const get = (kind) => downloadStream(`${b.url}/youtube/media`, signal, (_p, got) => { st[kind] = got; emit(); },
    { method: 'POST', headers: headers(b), body: JSON.stringify({ id, kind, maxHeight: want.maxHeight || 720 }) })
    .then((blob) => new Blob([blob], { type: kind === 'audio' ? 'audio/mp4' : 'video/mp4' }))
    .catch((e) => { if (e?.name === 'AbortError' || signal.aborted) throw e; onError?.(kind, e); return null; });
  progress('fetch', null, `yt-dlp is fetching the ${[want.audio && 'audio', want.video && 'video'].filter(Boolean).join(' and ')}`);
  const [audioBlob, videoBlob] = await Promise.all([want.audio ? get('audio') : null, want.video ? get('video') : null]);
  return { audioBlob, videoBlob };
}
