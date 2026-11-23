/**
 * Download-first pipeline (ES module, runs in the offscreen document): the audio and video streams of a
 * YouTube lecture are downloaded first (in parallel, DASH adaptiveFormats from the page), then processed
 * at CPU speed instead of playback speed:
 *
 *   audio blob  -> openAudioSource()  -> Whisper windows   (10-50x real time)
 *   video blob  -> blobGrabber()      -> seek-based scene scan (~50 ms per sample)
 *
 * The blobs are handed to the normal runPipeline() as `getStreamAudio` / `getStreamVideo`, which the
 * local pipeline feeds into its usual stages (transcribe -> scan -> OCR -> notes). Falls back to the
 * page-player path per stream: a failed video download still lets the audio be transcribed from the
 * download, and a failed audio download sends the whole job back to listening.
 */
import { createSpool } from './spool.js';
const pctOf =(a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);
const mb = (n) => (n / 1024 / 1024).toFixed(0);

/** Download one stream into memory with progress. Signed YouTube URLs need the page's Referer,
 * which background.js injects with a declarativeNetRequest rule for this host. */
export async function downloadStream(url, signal, onProgress, init = {}) {
  const res = await fetch(url, { signal, credentials: 'omit', cache: 'no-store', ...init });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const type = res.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) throw new Error('The stream URL returned a web page (expired or blocked).');
  const total = Number(res.headers.get('content-length')) || 0;
  const reader = res.body.getReader();
  const spool = createSpool(`dl-${Math.random().toString(36).slice(2)}`); // spills to disk past ~768 MB
  let got = 0, last = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await spool.write(value);
      got += value.length;
      if (Date.now() - last > 400) { last = Date.now(); onProgress?.(pctOf(got, total), got); }
    }
    return await spool.finish();
  } catch (e) {
    await spool.abort();
    throw e;
  }
}

/**
 * Download both streams in parallel. The audio failure is fatal (nothing to transcribe without it);
 * a failed video download only means the slides are scanned from the page's player instead.
 * @param {{audioUrl:string, videoUrl?:string}} urls
 * @param {{signal:AbortSignal, progress:(stage:string, percent:number|null, text:string)=>void}} o
 * @returns {Promise<null | {audioBlob:Blob, videoBlob:Blob|null, getStreamAudio:()=>Promise<Blob>,
 *            getStreamVideo?:()=>Promise<Blob>}>} null when the fallback path should be used
 */
export async function downloadStreams(urls, { signal, progress, captions = false }) {
  progress('fetch', 0, 'Downloading audio and video streams in parallel');
  const st = { audio: { got: 0, total: 0 }, video: { got: 0, total: 0 } };
  const emit = () => {
    const got = st.audio.got + st.video.got;
    const total = st.audio.total + st.video.total;
    const p = pctOf(got, total);
    progress('fetch', p, p != null ? `Downloading streams ${p}% (${mb(got)} MB)` : `Downloading streams ${mb(got)} MB`);
  };
  const dl = (what, url, type) => downloadStream(url, signal, (p, got) => {
    st[what].got = got;
    emit();
  }).then((blob) => new Blob([blob], { type }));
  let audio, video;
  try {
    audio = await dl('audio', urls.audioUrl, 'audio/mp4');
  } catch (e) {
    if (e?.name === 'AbortError' || signal.aborted) throw e;
    console.warn('[Vid2Study] audio download failed, falling back to listening:', e?.message);
    progress('fetch', null, `Audio download failed (${e.message || 'network error'})${captions ? '' : '; trying another way'}`);
    return null;
  }
  if (urls.videoUrl) {
    video = await dl('video', urls.videoUrl, 'video/mp4').catch((e) => {
      if (e?.name === 'AbortError' || signal.aborted) throw e;
      console.warn('[Vid2Study] video download failed, scanning from the page instead:', e?.message);
      st.video.total = 0;
      return null;
    });
  }
  progress('fetch', 100, `Downloaded ${mb(audio.size + (video?.size || 0))} MB`);
  return {
    audioBlob: audio,
    videoBlob: video,
    getStreamAudio: () => audio,
    ...(video ? { getStreamVideo: () => video } : {})
  };
}
