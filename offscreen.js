/**
 * Offscreen document: does all heavy work for one job at a time.
 * Job modes: 'video' (resolve source: local file or fetch, then lib/pipeline.js), 'youtube'
 * (Gemini reads the URL, frames come from the page's own player), 'text' (captions only).
 * Offscreen documents only get chrome.runtime, so settings arrive inside the job.
 */
import { runPipeline, MAX_BYTES, mb, pct } from './lib/pipeline.js';
import { resolveSource } from './lib/source.js';
import { createLiveAudio } from './lib/asr.js';
import { downloadStreams } from './lib/download-pipeline.js';
import { downloadManifest, isManifestUrl } from './lib/segments.js';
import { clearSpool } from './lib/spool.js';
import { resolveYoutubeStreams } from './lib/ytstreams.js';
import { getBridge, bridgeSubs, bridgeMedia } from './lib/ytbridge.js';
import { getDraft } from './lib/db.js';
import { log, tapConsole, setJob } from './lib/log.js';

tapConsole('offscreen');

/** @type {{controller: AbortController, url: string} | null} */
let current = null;
/** Downloads being fetched, and finished blobs still waiting for Chrome to save them. */
let fetching = 0;
const pendingBlobs = new Set();
let dlAbort = null;
/** Receives the audio a YouTube page streams to us while its player is being heard (see youtubeAudio). */
let audioSink = null;
/**
 * Pictures the page took while it was being heard ({step, duration, list:[{t, blob}]}), so the slide scan
 * reads them instead of playing the video a second time. One job at a time, reset per job.
 */
let samples = null;

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.target !== 'offscreen') return false;
  if (msg.type === 'RUN_JOB') {
    if (current) {
      sendResponse({ ok: false, error: 'A job is already running.' });
    } else {
      runJob(msg.job);
      sendResponse({ ok: true });
    }
  } else if (msg.type === 'CANCEL') {
    current?.controller.abort();
    dlAbort?.abort();
    sendResponse({ ok: true });
  } else if (msg.type === 'RUN_DOWNLOAD') {
    runDownload(msg.job);
    sendResponse({ ok: true });
  } else if (msg.type === 'REVOKE') {
    URL.revokeObjectURL(msg.blobUrl);
    pendingBlobs.delete(msg.blobUrl);
    sendResponse({ ok: true });
  } else if (msg.type === 'AUDIO_CHUNK' || msg.type === 'AUDIO_PROGRESS' || msg.type === 'AUDIO_DONE' || msg.type === 'AUDIO_ERROR' || msg.type === 'FRAME_SAMPLE') {
    audioSink?.on(msg); // sent by the page's content script while it listens to a YouTube player
    sendResponse({ ok: true });
  } else if (msg.type === 'STATUS') {
    sendResponse({ idle: !current && !fetching && !pendingBlobs.size });
  }
  return false;
});

/**
 * Run one summary job end to end.
 * @param {{mode:'video'|'youtube'|'text', tabId:number, url:string, videoUrl?:string, youtubeId?:string,
 *          transcript?:string, title:string, course:string, regenerate:boolean, settings:object,
 *          withCookies?:boolean, local?:{path:string,size:number}|null, skipReason?:string}} job
 *   `url` is the cache key; `videoUrl` is where the bytes come from (video mode).
 */
async function runJob(job) {
  const controller = new AbortController();
  const { signal } = controller;
  current = { controller, url: job.url };
  samples = null;
  let lastStage = '';
  const progress = (stage, percent, text) => {
    if (stage !== lastStage) { // one log line per stage change, not per progress tick
      lastStage = stage;
      log.info('stage', `${stage}${text ? `: ${text}` : ''}`);
    }
    return chrome.runtime.sendMessage({ type: 'PROGRESS', tabId: job.tabId, url: job.url, stage, percent, text }).catch(() => {});
  };
  let done;
  const started = Date.now();
  // everything this page logs until the job ends belongs to it (grouped on the Activity log page)
  setJob({ id: job.jobId, title: job.title || job.url, kind: job.mode === 'youtube' ? 'youtube summary' : 'summary' });
  log.info('job', `Started ${job.mode} job: ${job.title || job.url}`, { hours: job.durationSec ? +(job.durationSec / 3600).toFixed(2) : undefined, regenerate: !!job.regenerate, engine: job.settings?.engine, asr: job.settings?.asrModel, provider: job.settings?.strong?.provider });
  try {
    // Download-first (YouTube): audio + video streams fetched in parallel, then parsed at CPU speed.
    // Falls back to the normal page-player path when the streams cannot be downloaded.
    let streams = null;
    // very long videos (e.g. a 12 h stream) are heard + scanned through the page player instead: memory stays small
    const maxH = Number(job.settings?.downloadMaxHours) || 0;
    const tooLong = maxH > 0 && job.durationSec > maxH * 3600;
    // a job resumed after a model failure already has its transcript and slide scan in the saved draft: no need to fetch the video again
    const saved = job.resume && !job.regenerate ? await getDraft(job.url).catch(() => null) : null;
    const mediaDone = !!(saved?.segments && saved?.scan);
    if (mediaDone) log.info('job', 'Resuming: the transcript and slide scan are already saved, the video is not fetched again');
    const ytLocal = !mediaDone && job.mode === 'youtube' && job.settings?.engine !== 'gemini' && !!job.youtubeId;
    const ytDownload = ytLocal && job.settings?.downloadFirst !== false;
    // Captions the page's player could not give: ask yt-dlp in the local bridge (seconds, no listening).
    // Order for a YouTube transcript: page player captions (content.js) -> yt-dlp captions -> downloaded audio
    // (the extension's own download, else yt-dlp's) -> listening to the page player (last resort).
    let transcript = job.transcript;
    let bridge = null;
    const bridgeOnce = async () => {
      if (!bridge) {
        bridge = await getBridge();
        if (bridge.error) log.info('download', `yt-dlp (local bridge) not available: ${bridge.error}`);
      }
      return bridge.error ? null : bridge;
    };
    if (ytLocal && !transcript) {
      progress('fetch', null, 'Looking for captions with yt-dlp');
      const b = await bridgeOnce();
      if (b) {
        try {
          const r = await bridgeSubs(b, job.youtubeId, signal);
          transcript = r.text;
          log.info('download', `Captions found with yt-dlp (${r.lang || 'unknown language'}): no listening needed`, { lines: r.text.split(String.fromCharCode(10)).length });
        } catch (e) {
          if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
          log.info('download', `yt-dlp found no captions: ${e.message}`);
        }
      }
    }
    if (tooLong && ytDownload) {
      progress('fetch', null, `Long video (${(job.durationSec / 3600).toFixed(1)} h, over the ${maxH} h download limit): listening and grabbing slides through the page player`);
      log.alert('download', `Download skipped: video is longer than the ${maxH} h limit, using the page player`, { hours: +(job.durationSec / 3600).toFixed(1), limit_h: maxH });
    }
    // what happens when the extension's own stream download fails: with captions nothing is listened to
    const instead = () => (transcript ? 'the captions are used for the text; the slides are fetched with yt-dlp (else scanned through the page player)' : 'trying yt-dlp next, else listening to the page player');
    if (!tooLong && ytDownload) {
      try {
        progress('fetch', null, 'Looking for the video streams');
        const urls = await resolveYoutubeStreams(job.youtubeId, signal);
        if (!urls.audioUrl) {
          log.alert('download', `The extension's own stream download is blocked by YouTube (${urls.reason}); ${instead()}`);
          progress('fetch', null, transcript ? 'Captions found; fetching the video for the slides' : 'No downloadable stream; trying yt-dlp');
        } else {
          log.info('download', `Downloading the audio and video streams in parallel (found via ${urls.via})`, { has_video: !!urls.videoUrl });
          streams = await downloadStreams(urls, { signal, progress, captions: !!transcript });
          if (!streams) log.alert('download', `The extension's own stream download failed; ${instead()}`);
        }
      } catch (e) {
        if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
        log.alert('download', `The extension's own stream download stopped (${e?.message}); ${instead()}`);
        streams = null;
      }
    }
    // The extension's own download failed or gave no video: let yt-dlp fetch what is missing (audio only when
    // there is still no transcript; video for the fast slide scan). Without the bridge nothing changes.
    if (!tooLong && ytDownload && (!streams?.videoBlob || (!streams?.audioBlob && !transcript))) {
      const b = await bridgeOnce();
      if (b) {
        const want = { audio: !transcript && !streams?.audioBlob, video: !streams?.videoBlob, maxHeight: Number(job.settings?.maxWidth) >= 1600 ? 1080 : 720 };
        log.info('download', `Fetching with yt-dlp: ${[want.audio && 'audio', want.video && 'video'].filter(Boolean).join(' + ')}`);
        const got = await bridgeMedia(b, job.youtubeId, want, { signal, progress, onError: (kind, e) => log.alert('download', `yt-dlp could not get the ${kind}: ${e.message}`) });
        const audioBlob = streams?.audioBlob || got.audioBlob || null;
        const videoBlob = streams?.videoBlob || got.videoBlob || null;
        if (audioBlob || videoBlob) streams = { audioBlob, videoBlob };
        if (got.audioBlob || got.videoBlob) log.info('download', 'yt-dlp download done', { audio_mb: got.audioBlob ? Math.round(got.audioBlob.size / 1048576) : 0, video_mb: got.videoBlob ? Math.round(got.videoBlob.size / 1048576) : 0 });
      }
    }
    // HLS / DASH page videos: download the segments, then process the result like any downloaded file
    const srcUrl = job.videoUrl || job.url;
    if (!streams && !mediaDone && job.mode === 'video' && job.settings?.engine !== 'gemini' && !job.local && isManifestUrl(srcUrl)) {
      log.info('download', 'Downloading the HLS/DASH segments', { url: srcUrl });
      const m = await downloadManifest(srcUrl, { signal, progress });
      streams = { audioBlob: m.audioBlob, videoBlob: m.videoBlob };
      log.info('download', 'Segments downloaded', { audio_mb: m.audioBlob ? Math.round(m.audioBlob.size / 1048576) : 0, video_mb: m.videoBlob ? Math.round(m.videoBlob.size / 1048576) : 0 });
    }
    const { title } = await runPipeline({
      mode: job.mode,
      key: job.url,
      videoUrl: job.videoUrl,
      youtubeId: job.youtubeId,
      transcript,
      title: job.title,
      course: job.course,
      settings: job.settings,
      signal,
      onProgress: progress,
      regenerate: job.regenerate,
      skipStages: job.skipStages,
      ...(streams?.audioBlob ? { getStreamAudio: () => streams.audioBlob } : {}),
      ...(streams?.videoBlob ? { getStreamVideo: () => streams.videoBlob } : {}),
      getSource: async () => (await resolveSource({
        url: job.videoUrl || job.url,
        local: job.local,
        skipReason: job.skipReason,
        signal,
        progress,
        headSize: (u) => headSize(u, job.withCookies),
        readFile: async (fileUrl) => {
          const res = await fetch(fileUrl, { signal });
          if (!res.ok) throw new Error(`HTTP ${res.status}`);
          return res.blob();
        },
        fetchRemote: () => fetchVideo(job.videoUrl || job.url, signal, progress, job.settings.engine === 'gemini', job.withCookies)
      })).blob,
      // download mode: the scan never asks for this (it seeks the downloaded video); the fallback path does
      makeGrabber: () => youtubeGrabber(job),
      getAudio: (p) => youtubeAudio(job, signal, p)
    });
    streams = null; // free the downloaded blobs
    done = { type: 'JOB_DONE', title };
    log.info('job', `Finished "${title || job.url}" in ${Math.round((Date.now() - started) / 1000)} s`);
  } catch (e) {
    audioSink?.stop(); // a failure while the page is still listening must not leave the player running
    const message = signal.aborted ? 'Cancelled.' : e?.message || String(e);
    if (e?.name === 'StageError' && !signal.aborted) {
      // an AI model failed in one stage: the job pauses (its progress is saved) and the user picks another model or skips the stage
      log.alert('job', `Paused at "${e.info.label}": the ${e.info.slotLabel} (${e.info.model || 'none'}) failed. Waiting for the user to change the model.`, { status: e.info.status });
      done = { type: 'JOB_PAUSED', info: e.info };
    } else {
      if (signal.aborted) log.alert('job', `Cancelled during "${lastStage || 'start'}" after ${Math.round((Date.now() - started) / 1000)} s`);
      else log.error('job', `Could not complete the job at stage "${lastStage || 'start'}": ${message}`, { after_s: Math.round((Date.now() - started) / 1000) });
      console.error('[Vid2Study] job failed:', message);
      done = { type: 'JOB_ERROR', message };
    }
  }
  samples = null; // free the pictures
  if (!fetching && !pendingBlobs.size) await clearSpool(); // delete spilled stream files from the disk cache
  setJob(null);
  // Free the worker BEFORE reporting: the service worker starts the next queued job as soon as it hears this.
  current = null;
  await chrome.runtime.sendMessage({ tabId: job.tabId, url: job.url, ...done }).catch(() => {});
}

/**
 * Frames from a YouTube page: the content script pauses the page's own player, seeks, and returns
 * PNGs (relayed through the service worker). The player is restored afterwards.
 */
function youtubeGrabber(job) {
  const call = (type, extra) => chrome.runtime.sendMessage({ type, tabId: job.tabId, ...extra });
  const pre = usableSamples();
  let live = null; // opened only when a picture is missing from the listening pass
  const openLive = async () => (live ||= liveOpen());
  const liveOpen = async () => {
    const r = await call('PAGE_CAPTURE_BEGIN', { videoId: job.youtubeId });
    if (!r?.ok) throw new Error(r?.error || 'The page player could not be captured.');
    return r;
  };
  const nearest = (t) => {
    let best = null;
    for (const s of pre.list) if (!best || Math.abs(s.t - t) < Math.abs(best.t - t)) best = s;
    return best && Math.abs(best.t - t) <= pre.step * 0.6 ? best : null;
  };
  const paint = async (blob, canvas) => {
    const bmp = await createImageBitmap(blob);
    canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
    bmp.close?.();
  };
  return {
    keepMissing: true, // a frame we cannot capture still gets a timestamp link
    async open() {
      if (pre) {
        // the pictures were taken while listening: no second playback
        const bmp = await createImageBitmap(pre.list[0].blob);
        const info = { duration: pre.duration, width: bmp.width, height: bmp.height, step: pre.step };
        bmp.close?.();
        return info;
      }
      const r = await openLive();
      if (!r?.ok) throw new Error(r?.error || 'The page player could not be captured.');
      const scale = Math.min(1, (Number(job.settings.maxWidth) || 1600) / r.width);
      // Infinity (live / unknown length) travels as null through extension messages
      return { duration: Number.isFinite(r.duration) ? r.duration : Infinity, width: Math.round(r.width * scale), height: Math.round(r.height * scale) };
    },
    times: (t) => [t],
    async draw(t, canvas) {
      const s = pre && nearest(t);
      if (s) return paint(s.blob, canvas);
      await openLive();
      const r = await call('PAGE_CAPTURE_FRAME', { t, maxWidth: canvas.width });
      if (!r?.ok) throw new Error(r?.error || 'capture failed');
      const bmp = await createImageBitmap(await (await fetch(`data:image/png;base64,${r.b64}`)).blob());
      canvas.getContext('2d').drawImage(bmp, 0, 0, canvas.width, canvas.height);
      bmp.close?.();
    },
    close() { call('PAGE_CAPTURE_END', { closeHelper: true }).catch(() => {}); } // last use of the player: close the background window
  };
}

/** The listening pass's pictures, when they cover the video well enough to replace a scan (else null). */
function usableSamples() {
  if (!samples?.step || !samples.list.length) return null;
  const expected = Math.max(1, Math.floor(samples.duration / samples.step));
  if (samples.list.length < expected * 0.8) return null; // blank frames (minimized window): scan the normal way
  return samples;
}

/**
 * No captions on a YouTube page: the page plays its own player muted at ~2-4x and streams the audio to us
 * as 16 kHz PCM blocks, each stamped with the video time it came from. Returns AT ONCE with a live
 * sample source (transcription starts on the first full window while the video is still playing),
 * a function mapping positions in the recording back to video time, and `finished`, a promise that
 * settles when listening ends (and rejects if it failed). The player is given back at the end.
 */
async function youtubeAudio(job, signal, progress) {
  const call = (type, extra) => chrome.runtime.sendMessage({ type, tabId: job.tabId, ...extra });
  const rate = Number(job.settings.listenSpeed) || 2;
  const live = createLiveAudio();
  let finish, fail;
  const done = new Promise((res, rej) => { finish = res; fail = rej; });
  const stop = () => { call('PAGE_CAPTURE_AUDIO_STOP').catch(() => {}); fail(new DOMException('Aborted', 'AbortError')); };
  audioSink = {
    stop,
    on(m) {
      if (m.type === 'AUDIO_CHUNK') live.push(m);
      else if (m.type === 'FRAME_SAMPLE') {
        if (samples) samples.list.push({ t: m.t, blob: new Blob([Uint8Array.from(atob(m.b64), (c) => c.charCodeAt(0))], { type: 'image/jpeg' }) });
      } else if (m.type === 'AUDIO_PROGRESS') {
        const left = Math.max(0, (m.duration - m.t) / rate);
        progress('transcribe', pct(m.t, m.duration), m.ad ? 'Waiting for an ad to finish...' : `Listening ${m.bg ? 'in a separate minimized window (you can keep watching here) ' : ''}${fmtT(m.t)} / ${fmtT(m.duration)} (${rate}x, about ${Math.ceil(left / 60)} min left)${m.note ? ` - ${m.note}` : ''}`);
      } else if (m.type === 'AUDIO_DONE') finish();
      else fail(new Error(m.message || 'Could not listen to the video.'));
    }
  };
  signal.addEventListener('abort', stop, { once: true });
  const cleanup = async () => {
    signal.removeEventListener('abort', stop);
    audioSink = null;
    await call('PAGE_CAPTURE_END').catch(() => {}); // give the player back (position, speed, sound)
  };
  let duration = 0;
  try {
    progress('transcribe', null, 'Starting to listen to the video');
    // the same pass also takes the slide pictures: about one per second (so a chart on screen for 3 s is not
    // missed and its settled moment can be picked), at most 600 per video (longer videos get a wider grid)
    const wantFrames = true; // only the local engine listens, and it always scans for slides afterwards
    const sampleEvery = Math.max(1, Math.min(5, Number(job.settings.sampleSeconds) || 1));
    samples = wantFrames ? { step: 0, duration: 0, list: [] } : null;
    const r = await call('PAGE_CAPTURE_AUDIO_BEGIN', { rate, videoId: job.youtubeId, ...(wantFrames ? { sampleEvery, maxWidth: Number(job.settings.maxWidth) || 1600, maxSamples: 600 } : {}) });
    if (!r?.ok) throw new Error(r?.error || 'The page player could not be heard.');
    duration = r.duration;
    if (samples) { samples.step = r.sampleStep || 0; samples.duration = r.duration; }
  } catch (e) { await cleanup(); throw e; }
  const finished = done
    .then(() => {
      if (live.length < 16000 * 3) throw new Error('No sound came from the video player. It may be protected, or silent.');
      live.finish();
    })
    .catch((e) => { live.fail(e); throw e; })
    .finally(cleanup);
  finished.catch(() => {}); // the pipeline awaits it; this only prevents a stray unhandled rejection
  return { audio: live.audio, mapTime: live.mapTime, duration, finished };
}
const fmtT = (s) => `${Math.floor(s / 60)}:${String(Math.floor(s % 60)).padStart(2, '0')}`;

/** Size of the video on the server (HEAD through this page, so the Referer rule applies). */
async function headSize(url, withCookies) {
  const res = await fetch(url, { method: 'HEAD', credentials: withCookies ? 'include' : 'omit', cache: 'no-store' });
  return res.ok ? Number(res.headers.get('content-length')) || 0 : 0;
}

// ---------- fetch video ----------
/**
 * Download the video into memory with progress.
 * Many hosts reject requests without the page's Referer (403 + an HTML page). background.js adds it
 * with a declarativeNetRequest rule, which applies to fetch() here but NOT to chrome.downloads,
 * so downloads also go through this function.
 */
async function fetchVideo(url, signal, progress, checkLimit = true, withCookies = false) {
  progress('fetch', 0, 'Fetching video...');
  let res;
  try {
    res = await fetch(url, { signal, credentials: withCookies ? 'include' : 'omit', cache: 'no-store' });
  } catch (e) {
    if (signal.aborted) throw e;
    if (withCookies) return fetchVideo(url, signal, progress, checkLimit, false); // cookies can trip CORS; retry without
    throw new Error(`Could not download the video (network error: ${e.message}). The site may block other pages from reading it; use "Summarize from a file...".`);
  }
  if (!res.ok) throw new Error(`Could not download the video (HTTP ${res.status}).`);
  const total = Number(res.headers.get('content-length')) || 0;
  if (checkLimit && total > MAX_BYTES) throw new Error(`Video is ${mb(total)} MB. Gemini's File API accepts up to 2 GB.`);
  const type = res.headers.get('content-type') || '';
  if (/text\/html/i.test(type)) throw new Error('The server returned a web page instead of the video (access denied).');

  const reader = res.body.getReader();
  const chunks = [];
  let got = 0;
  let last = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    got += value.length;
    if (Date.now() - last > 400) {
      last = Date.now();
      const p = pct(got, total);
      progress('fetch', p, p != null ? `Fetching video ${p}%` : `Fetching video ${mb(got)} MB`);
    }
  }
  return new Blob(chunks, { type: 'video/mp4' });
}

/**
 * Fetch the video here (where the Referer rule applies), then hand a blob: URL to the
 * service worker, which gives it to chrome.downloads. The blob is kept until the save ends.
 * @param {{tabId:number,url:string,filename:string,withCookies?:boolean}} job
 */
async function runDownload(job) {
  fetching++;
  dlAbort = new AbortController();
  const { signal } = dlAbort;
  const send = (m) => chrome.runtime.sendMessage({ tabId: job.tabId, url: job.url, ...m }).catch(() => {});
  let done;
  setJob({ id: job.jobId, title: job.title || job.url, kind: 'download' });
  log.info('download', 'Downloading the video', { url: job.url });
  try {
    const blob = await fetchVideo(job.url, signal, (_stage, p, text) =>
      send({ type: 'PROGRESS', stage: 'download', percent: p, text: p != null ? `Downloading ${p}%` : text }), false, job.withCookies);
    const blobUrl = URL.createObjectURL(blob);
    pendingBlobs.add(blobUrl);
    done = { type: 'DOWNLOAD_READY', blobUrl, filename: job.filename };
    log.info('download', `Video downloaded (${Math.round(blob.size / 1048576)} MB), handing it to Chrome to save`);
  } catch (e) {
    console.error('[Vid2Study] download failed:', e?.message);
    if (signal.aborted) log.alert('download', 'Download cancelled');
    else log.error('download', `Could not download the video: ${e?.message}`, { url: job.url });
    done = { type: 'DOWNLOAD_FAILED', message: signal.aborted ? 'Cancelled.' : e?.message || String(e) };
  }
  // Free the worker BEFORE reporting (the next queued item may start right away).
  setJob(null);
  dlAbort = null;
  fetching--;
  await send(done);
}
