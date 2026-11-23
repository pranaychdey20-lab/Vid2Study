/**
 * Service worker: video detection, downloads, job orchestration and message routing.
 * Heavy work happens in offscreen.html. This worker keeps no important in-memory state
 * (MV3 can stop it at any time), so the queue lives in chrome.storage.session and the
 * "already downloaded" map (url -> file on disk) in chrome.storage.local.
 */
import { cleanUrl, CONTENT_FILES } from './lib/common.js';
import { loadSettings, settingsProblem, DEFAULT_SITES } from './lib/settings.js';
import { getResult, hasResult } from './lib/db.js';
import { log, tapConsole, useLocalStore, appendLog } from './lib/log.js';
import { pagePlayerCaptions, json3ToLines } from './lib/ytcaptions.js';

tapConsole('service-worker');
useLocalStore();

const OFFSCREEN_URL = 'offscreen.html';

// ---------- Referer header for CDN requests made by the extension itself ----------
// Bunny CDN may use hotlink protection; extension fetches/downloads have no page referer.
async function setupRules() {
  await chrome.declarativeNetRequest.updateSessionRules({
    removeRuleIds: [1],
    addRules: [{
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [{ header: 'referer', operation: 'set', value: 'https://elearn.iitg.ac.in/' }]
      },
      condition: {
        urlFilter: '||b-cdn.net/',
        tabIds: [chrome.tabs.TAB_ID_NONE],
        resourceTypes: ['xmlhttprequest', 'media', 'other']
      }
    }]
  });
}
chrome.runtime.onInstalled.addListener(setupRules);
chrome.runtime.onStartup.addListener(setupRules);
setupRules().catch(() => {});

// The drawer (content script) caches the course list in chrome.storage.session.
chrome.storage.session.setAccessLevel({ accessLevel: 'TRUSTED_AND_UNTRUSTED_CONTEXTS' }).catch(() => {});

// ---------- Which sites get the content script ----------
/** Register the content script for the enabled sites only (never injected everywhere by default). */
async function syncScripts() {
  const { enabled = true, sites = DEFAULT_SITES } = await chrome.storage.local.get({ enabled: true, sites: DEFAULT_SITES });
  try { await chrome.scripting.unregisterContentScripts({ ids: ['lh'] }); } catch { /* none registered */ }
  if (!enabled || !sites.length) return;
  await chrome.scripting.registerContentScripts([{
    id: 'lh',
    matches: sites.flatMap((h) => [`https://${h}/*`, `http://${h}/*`]),
    js: CONTENT_FILES,
    runAt: 'document_idle',
    persistAcrossSessions: true
  }]);
  log.info('setup', `Content script enabled for ${sites.length} site(s)`);
}
chrome.runtime.onInstalled.addListener(syncScripts);
chrome.runtime.onStartup.addListener(syncScripts);
chrome.storage.onChanged.addListener((ch, area) => { if (area === 'local' && (ch.sites || ch.enabled)) syncScripts().catch(() => {}); });


// ---------- Detection via network ----------
const videosKey = (tabId) => `videos_${tabId}`;

async function rememberVideo(tabId, url) {
  const key = videosKey(tabId);
  const { [key]: list = [] } = await chrome.storage.session.get(key);
  if (!list.includes(url)) {
    list.push(url);
    await chrome.storage.session.set({ [key]: list });
  }
  chrome.tabs.sendMessage(tabId, { type: 'VIDEO_FOUND', url }).catch(() => {});
}

const MEDIA_URL = /\.(mp4|webm|mov|m4v|m3u8|mpd)(\?|#|$)/i;
chrome.webRequest.onBeforeRequest.addListener(
  (d) => {
    if (d.tabId < 0 || !MEDIA_URL.test(d.url)) return; // our own fetches / not media
    rememberVideo(d.tabId, cleanUrl(d.url));
  },
  { urls: ['http://*/*', 'https://*/*'], types: ['media', 'xmlhttprequest', 'other'] }
);

chrome.tabs.onRemoved.addListener((tabId) => chrome.storage.session.remove(videosKey(tabId)));

// ---------- Offscreen document ----------
async function ensureOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_URL)]
  });
  if (contexts.length) return;
  await chrome.offscreen.createDocument({
    url: OFFSCREEN_URL,
    reasons: ['BLOBS', 'DOM_SCRAPING'],
    justification: 'Hold large lecture video blobs, transcribe audio, scan frames and read slide text locally, and capture video frames with canvas.'
  });
}

/** Close the worker page, unless a summary job or a download still needs it. */
async function closeOffscreen() {
  await new Promise((r) => setTimeout(r, 1500)); // let a finishing job clear its own state
  try {
    const res = await sendToOffscreen({ type: 'STATUS' });
    if (res && !res.idle) return;
    await chrome.offscreen.closeDocument();
  } catch { /* not open */ }
}

/** Send to the offscreen doc, retrying briefly while it finishes loading. */
async function sendToOffscreen(msg) {
  for (let attempt = 0; attempt < 10; attempt++) {
    try {
      return await chrome.runtime.sendMessage({ ...msg, target: 'offscreen' });
    } catch (e) {
      if (!/Receiving end does not exist/i.test(e.message)) throw e;
      await new Promise((r) => setTimeout(r, 200));
    }
  }
  throw new Error('Could not reach the background worker page.');
}

// ---------- Queue ----------
// One heavy job at a time (the worker page holds a whole video in memory).
// item: { id, url, kind: 'download'|'summary', title, course, filename, regenerate, tabId,
//         status: 'queued'|'running'|'done'|'error'|'cancelled', message, startedAt }
let chain = Promise.resolve();

/** Read-modify-write the queue under a lock so concurrent messages cannot lose updates. */
function mutate(fn) {
  const run = chain.then(async () => {
    const { queue = { items: [], tabId: null } } = await chrome.storage.session.get('queue');
    const result = await fn(queue);
    if (queue.items.length > 300) queue.items = queue.items.slice(-300);
    await chrome.storage.session.set({ queue });
    if (queue.tabId != null) chrome.tabs.sendMessage(queue.tabId, { type: 'QUEUE_CHANGED' }).catch(() => {});
    return result;
  });
  chain = run.catch(() => {});
  return run;
}
const getQueue = async () => (await chrome.storage.session.get('queue')).queue || { items: [], tabId: null };
const isActive = (i) => i.status === 'queued' || i.status === 'running';

/** Add items (skipping ones already queued/running), then start the queue. */
async function enqueue(items, tabId) {
  const added = await mutate((q) => {
    const added = [];
    q.tabId = tabId ?? q.tabId;
    for (const it of items) {
      if (it.transcript) { chrome.storage.session.set({ [`tx_${it.url}`]: it.transcript }); delete it.transcript; }
      if (q.items.some((x) => isActive(x) && x.url === it.url && x.kind === it.kind)) continue;
      q.items = q.items.filter((x) => isActive(x) || x.url !== it.url || x.kind !== it.kind);
      const item = { ...it, tabId, id: crypto.randomUUID(), status: 'queued' };
      q.items.push(item);
      added.push({ id: item.id, title: item.title, url: item.url, kind: item.kind, mode: item.mode, course: item.course });
    }
    return added;
  });
  for (const it of added) jobLog(it).info('queue', `Queued ${it.kind === 'download' ? 'download' : `${it.mode || 'video'} summary`}`, { course: it.course, url: it.url });
  await pump();
}

/** The logger for one queue item: everything it logs is grouped under that job on the Activity log page. */
const jobLog = (item) => log.job({ id: item.id, title: item.title || item.url, kind: item.kind === 'download' ? 'download' : item.mode === 'youtube' ? 'youtube summary' : 'summary' });

/** Start the next queued item if nothing is running. */
async function pump() {
  const next = await mutate((q) => {
    if (q.items.some((i) => i.status === 'running')) return null;
    const item = q.items.find((i) => i.status === 'queued');
    if (item) { item.status = 'running'; item.startedAt = Date.now(); }
    return item ? { ...item } : null;
  });
  if (next) await start(next);
}

/** Mark the running item that matches `where` as finished, start the next one, close the worker when idle. */
async function finish(where, status, message = '') {
  const item = await mutate((q) => {
    const it = q.items.find((i) => i.status === 'running' && (where.id ? i.id === where.id : i.url === where.url && i.kind === where.kind));
    if (!it) return null;
    it.status = message === 'Cancelled.' ? 'cancelled' : status;
    it.message = message;
    return { ...it };
  });
  if (item) {
    const secs = item.startedAt ? Math.round((Date.now() - item.startedAt) / 1000) : null;
    const what = `${item.kind === 'download' ? 'Download' : 'Summary'} "${item.title || item.url}"`;
    const jl = jobLog(item);
    if (status === 'done') jl.info('queue', `${what} finished in ${secs ?? '?'} s`, { status: 'done' });
    else if (item.status === 'cancelled') jl.alert('queue', `${what} was cancelled`, { status: 'cancelled', after_s: secs });
    else jl.error('queue', `${what} could not be completed: ${message}`, { status: 'failed', after_s: secs });
    chrome.storage.session.remove(`tx_${item.url}`);
    closeHelper(item.tabId).catch(() => {});
  }
  if (item?.kind === 'summary') {
    chrome.tabs.sendMessage(item.tabId, status === 'done'
      ? { type: 'SUMMARY_DONE', url: item.url, cacheKey: item.url, title: item.title }
      : { type: 'SUMMARY_ERROR', url: item.url, message }).catch(() => {});
  } else if (item) {
    chrome.tabs.sendMessage(item.tabId, { type: 'DOWNLOAD_STATUS', url: item.url, state: status === 'done' ? 'done' : 'error', message }).catch(() => {});
  }
  await pump();
  const q = await getQueue();
  if (!q.items.some(isActive)) closeOffscreen();
}

// ---------- Paused jobs: an AI model failed in one stage ----------
// The job is not failed and not skipped past the stage: it waits (status 'paused', its progress is in the
// IndexedDB draft) while a pop-up window lets the user change the model, skip the stage, or cancel the job.
const FIX_PAGE = 'modelfix.html';

/** Toolbar badge: "!" while any job waits for a model decision. */
async function syncBadge() {
  const q = await getQueue();
  const n = q.items.filter((i) => i.status === 'paused').length;
  chrome.action.setBadgeText({ text: n ? '!' : '' }).catch(() => {});
  if (n) chrome.action.setBadgeBackgroundColor({ color: '#d93025' }).catch(() => {});
  chrome.action.setTitle({ title: n ? `Vid2Study: ${n} job${n > 1 ? 's' : ''} waiting for a model decision` : 'Lecture Notes Helper' }).catch(() => {});
}

/** Open the "model failed" window for a paused item, or bring the one that is already open to the front. */
async function openFixWindow(item) {
  const { fixWindows = {} } = await chrome.storage.session.get('fixWindows');
  const old = fixWindows[item.id];
  if (old != null) {
    const w = await chrome.windows.get(old).catch(() => null);
    if (w) { await chrome.windows.update(old, { focused: true, drawAttention: true }).catch(() => {}); return; }
  }
  const w = await chrome.windows.create({ url: chrome.runtime.getURL(`${FIX_PAGE}?id=${encodeURIComponent(item.id)}`), type: 'popup', width: 580, height: 760, focused: true }).catch(() => null);
  if (w?.id != null) { fixWindows[item.id] = w.id; await chrome.storage.session.set({ fixWindows }); }
}
chrome.windows.onRemoved.addListener(async (windowId) => {
  const { fixWindows = {} } = await chrome.storage.session.get('fixWindows');
  const id = Object.keys(fixWindows).find((k) => fixWindows[k] === windowId);
  if (id) { delete fixWindows[id]; await chrome.storage.session.set({ fixWindows }); }
});
async function closeFixWindow(itemId) {
  const { fixWindows = {} } = await chrome.storage.session.get('fixWindows');
  if (fixWindows[itemId] != null) chrome.windows.remove(fixWindows[itemId]).catch(() => {});
}

/** The running summary stopped at a failed model call: park it as 'paused', tell the tab, open the window. */
async function pauseItem(url, info) {
  const item = await mutate((q) => {
    const it = q.items.find((i) => i.status === 'running' && i.kind === 'summary' && i.url === url);
    if (!it) return null;
    it.status = 'paused';
    it.pause = { ...info, at: Date.now() };
    it.message = `Paused: ${info.label}. The ${info.slotLabel} (${info.model || 'none'}) failed: ${info.reason}`;
    return { ...it };
  });
  if (!item) return;
  jobLog(item).alert('queue', `Paused at "${info.label}": ${info.slotLabel} (${info.model || 'none'}) failed`, { status: 'paused', http: info.status, reason: info.reason });
  closeHelper(item.tabId).catch(() => {}); // the YouTube helper window is not needed while we wait
  chrome.tabs.sendMessage(item.tabId, { type: 'SUMMARY_PAUSED', url: item.url, id: item.id, title: item.title, info }).catch(() => {});
  await syncBadge();
  await openFixWindow(item);
  await pump(); // other queued items are not held up by a paused one
  const q = await getQueue();
  if (!q.items.some(isActive)) closeOffscreen();
}

/** Put a paused item back in the queue; it resumes from its saved draft with the (possibly changed) settings. */
async function resumeItem(id, skip) {
  const item = await mutate((q) => {
    const it = q.items.find((i) => i.id === id && i.status === 'paused');
    if (!it) return null;
    it.status = 'queued';
    it.resume = true;
    it.regenerate = false; // never throw the saved progress away
    if (skip) it.skip = [...new Set([...(it.skip || []), skip])];
    delete it.pause;
    delete it.message;
    return { ...it };
  });
  if (!item) return { error: 'This job is no longer waiting.' };
  jobLog(item).info('queue', skip ? `Resumed with "${skip}" skipped` : 'Resumed with the changed model');
  await closeFixWindow(id);
  await syncBadge();
  chrome.tabs.sendMessage(item.tabId, { type: 'SUMMARY_RESUMED', url: item.url }).catch(() => {});
  await pump();
  return { ok: true };
}

async function cancelPaused(id) {
  const item = await mutate((q) => {
    const it = q.items.find((i) => i.id === id && i.status === 'paused');
    if (!it) return null;
    it.status = 'cancelled';
    it.message = 'Cancelled.';
    delete it.pause;
    return { ...it };
  });
  if (!item) return { error: 'This job is no longer waiting.' };
  chrome.storage.session.remove(`tx_${item.url}`);
  jobLog(item).alert('queue', `Summary "${item.title || item.url}" was cancelled while paused`, { status: 'cancelled' });
  await closeFixWindow(id);
  await syncBadge();
  chrome.tabs.sendMessage(item.tabId, { type: 'SUMMARY_ERROR', url: item.url, message: 'Cancelled.' }).catch(() => {});
  return { ok: true };
}

/**
 * Many hosts only serve a video to the page that embeds it. The worker page's fetches have no such
 * page, so install a Referer rule for this item's host (one job at a time, so one rule id is enough).
 */
async function setJobReferer(url, referer, origin) {
  const addRules = [];
  try {
    const u = new URL(url);
    if (referer && /^https?:$/.test(u.protocol)) {
      addRules.push({
        id: 10, priority: 1,
        action: {
          type: 'modifyHeaders',
          requestHeaders: [{ header: 'referer', operation: 'set', value: referer }, ...(origin ? [{ header: 'origin', operation: 'set', value: origin }] : [])]
        },
        condition: { urlFilter: `||${u.host}/`, tabIds: [chrome.tabs.TAB_ID_NONE], resourceTypes: ['xmlhttprequest', 'media', 'other'] }
      });
    }
  } catch { /* not a URL (yt:..., text:...) */ }
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds: [10], addRules });
}

/** Send one item to the worker page. */
async function start(item) {
  try {
    jobLog(item).info('queue', `Starting ${item.kind === 'download' ? 'download' : 'summary'}`);
    await ensureOffscreen();
    const from = item.videoUrl || item.url;
    if (item.kind === 'download') {
      // chrome.downloads cannot add the Referer the host requires, so fetch the file in the
      // worker page first and save the resulting blob (see DOWNLOAD_READY below).
      await setJobReferer(from, item.referer);
      const res = await sendToOffscreen({ type: 'RUN_DOWNLOAD', job: { jobId: item.id, title: item.title, tabId: item.tabId, url: item.url, filename: item.filename, withCookies: !!item.withCookies } });
      if (!res?.ok) throw new Error('Could not start the download.');
    } else {
      const mode = item.mode || 'video';
      const settings = await loadSettings();
      const problem = settingsProblem(settings, mode);
      if (problem) throw new Error(problem);
      let local = null, skipReason;
      if (mode === 'video') {
        await setJobReferer(from, item.referer);
        ({ local, skipReason } = await findLocal(item.url));
      }
      // Download-first streams (YouTube) come from googlevideo.com hosts (the exact host varies per request)
      // and need YouTube's Referer and Origin; one domain-wide rule covers audio and video.
      if (mode === 'youtube') await setJobReferer('https://googlevideo.com/', 'https://www.youtube.com/', 'https://www.youtube.com');
      const txKey = `tx_${item.url}`;
      // captions travel with every mode: 'text' needs them, the others use them instead of speech recognition when present
      const transcript = (await chrome.storage.session.get(txKey))[txKey];
      const res = await sendToOffscreen({
        type: 'RUN_JOB',
        job: {
          resume: !!item.resume, skipStages: item.skip || [],
          jobId: item.id, mode, tabId: item.tabId, url: item.url, videoUrl: from, youtubeId: item.youtubeId, transcript, title: item.title, course: item.course,
          regenerate: !!item.regenerate, settings, local, skipReason, withCookies: !!item.withCookies,
          durationSec: item.durationSec || 0
        }
      });
      if (!res?.ok) throw new Error(res?.error || 'Worker is busy.');
    }
  } catch (e) {
    jobLog(item).error('queue', `Could not start "${item.title || item.url}": ${e.message || e}`);
    await finish({ id: item.id }, 'error', e.message || String(e));
  }
}

/** Cancel queued items and abort the running one. */
async function cancelQueue() {
  const hadRunning = await mutate((q) => {
    for (const i of q.items) if (i.status === 'queued') { i.status = 'cancelled'; i.message = 'Cancelled.'; }
    return q.items.some((i) => i.status === 'running');
  });
  if (!hadRunning) return;
  const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
  if (contexts.length) {
    await sendToOffscreen({ type: 'CANCEL' }).catch(() => {});
  } else {
    // Nothing is actually running (e.g. the worker page crashed): clear the stale item.
    const q = await getQueue();
    for (const i of q.items.filter((x) => x.status === 'running')) await finish({ id: i.id }, 'error', 'Cancelled.');
  }
}

/** Running items older than 20 s whose worker page is idle were lost (browser restart, crash). */
async function recoverStale() {
  const q = await getQueue();
  const stale = q.items.filter((i) => i.status === 'running' && Date.now() - (i.startedAt || 0) > 20000);
  if (stale.length) {
    for (const i of stale) jobLog(i).alert('queue', 'Left running (browser restart or crash), checking it');
    const contexts = await chrome.runtime.getContexts({ contextTypes: ['OFFSCREEN_DOCUMENT'] });
    const res = contexts.length ? await sendToOffscreen({ type: 'STATUS' }).catch(() => null) : null;
    if (!res || res.idle) for (const i of stale) await finish({ id: i.id }, 'error', 'Interrupted. Try again.');
  }
  await pump();
}
chrome.runtime.onStartup.addListener(() => recoverStale().catch(() => {}));

// ---------- Local copies of downloaded lectures ----------
/** Look up a file this extension saved earlier. Returns {local} or {local:null, skipReason}. */
async function findLocal(url) {
  const { downloads = {} } = await chrome.storage.local.get('downloads');
  const rec = downloads[url];
  if (!rec) return { local: null };
  const [d] = await chrome.downloads.search({ id: rec.downloadId });
  if (!d || !d.exists || d.state !== 'complete') return { local: null, skipReason: 'Saved file is gone.' };
  if (!(await chrome.extension.isAllowedFileSchemeAccess())) {
    return { local: null, skipReason: 'Local file access is off (enable it in extension details).' };
  }
  return { local: { path: d.filename, size: rec.size } };
}

/** Per-lecture state for the drawer: file on disk? summary cached? queue item? */
async function getStates(urls) {
  const { downloads = {} } = await chrome.storage.local.get('downloads');
  const q = await getQueue();
  const states = {};
  for (const url of urls) {
    let saved = false;
    if (downloads[url]) {
      const [d] = await chrome.downloads.search({ id: downloads[url].downloadId });
      saved = !!(d && d.exists && d.state === 'complete');
    }
    const items = q.items.filter((i) => i.url === url);
    states[url] = { saved, summary: await hasResult(url), item: items[items.length - 1] || null };
  }
  return states;
}

// When Chrome finishes saving a downloaded blob, record the file and let the worker page free it.
chrome.downloads.onChanged.addListener(async (delta) => {
  const state = delta.state?.current;
  if (state !== 'complete' && state !== 'interrupted') return;
  const key = `dl_${delta.id}`;
  const { [key]: dl } = await chrome.storage.session.get(key);
  if (!dl) return; // not one of ours
  await chrome.storage.session.remove(key);
  if (state === 'complete') {
    const [d] = await chrome.downloads.search({ id: delta.id });
    if (d) {
      const { downloads = {} } = await chrome.storage.local.get('downloads');
      downloads[dl.url] = { downloadId: d.id, path: d.filename, size: d.fileSize, savedAt: Date.now() };
      await chrome.storage.local.set({ downloads });
    }
  }
  await sendToOffscreen({ type: 'REVOKE', blobUrl: dl.blobUrl }).catch(() => {});
  await finish({ url: dl.url, kind: 'download' }, state === 'complete' ? 'done' : 'error', state === 'complete' ? '' : delta.error?.current || 'interrupted');
});

// ---------- Message router ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'offscreen') return false;
  handle(msg, sender).then(sendResponse, (e) => sendResponse({ error: e.message || String(e) }));
  return true;
});

/** Refuse jobs early when the AI settings are incomplete (and show the Options page). Returns the problem or null. */
async function problemFor(mode) {
  const problem = settingsProblem(await loadSettings(), mode);
  if (problem) chrome.runtime.openOptionsPage();
  return problem;
}

// ---------- Helper window ----------
// Listening to / scanning a YouTube video needs a player running at 2x. The viewer's own player cannot do that
// while they watch, so the same watch page is opened in a minimized, muted window and the capture runs there.
// Normal watch pages play everything the viewer can play (an embedded player does not).
const helperKey = (tabId) => `helper_${tabId}`;

/** Open (or reuse) the helper window for the job running for `jobTabId`. Resolves to {tabId, windowId} or null. */
async function openHelper(jobTabId, videoId) {
  const stored = (await chrome.storage.session.get(helperKey(jobTabId)))[helperKey(jobTabId)];
  if (stored) {
    try {
      const tab = await chrome.tabs.get(stored.tabId);
      // YouTube autoplay may have moved the helper to the next video: bring it back to the job's video.
      if (stored.videoId && !String(tab.url || '').includes(`v=${stored.videoId}`)) {
        await chrome.tabs.update(stored.tabId, { url: `https://www.youtube.com/watch?v=${encodeURIComponent(stored.videoId)}` });
        await new Promise((res) => setTimeout(res, 1500));
        for (let i = 0; i < 60; i++) {
          const r = await chrome.tabs.sendMessage(stored.tabId, { type: 'CAPTURE_PING' }).catch(() => null);
          if (r?.ok) break;
          await new Promise((res) => setTimeout(res, 500));
        }
      }
      return stored;
    } catch { await chrome.storage.session.remove(helperKey(jobTabId)); }
  }
  if (!videoId) return null;
  let win;
  try {
    win = await chrome.windows.create({ url: 'about:blank', state: 'minimized', focused: false });
    const tabId = win.tabs[0].id;
    await chrome.tabs.update(tabId, { muted: true }); // mute before the page can make a sound
    await chrome.tabs.update(tabId, { url: `https://www.youtube.com/watch?v=${encodeURIComponent(videoId)}` });
    const helper = { tabId, windowId: win.id, videoId };
    for (let i = 0; i < 80; i++) { // wait until the content script in that window answers (up to 40 s)
      const r = await chrome.tabs.sendMessage(tabId, { type: 'CAPTURE_PING' }).catch(() => null);
      if (r?.ok) { await chrome.storage.session.set({ [helperKey(jobTabId)]: helper }); return helper; }
      await new Promise((res) => setTimeout(res, 500));
    }
  } catch (e) { console.warn('[Vid2Study] helper window failed:', e?.message); }
  if (win?.id != null) chrome.windows.remove(win.id).catch(() => {});
  return null;
}

async function closeHelper(jobTabId) {
  const stored = (await chrome.storage.session.get(helperKey(jobTabId)))[helperKey(jobTabId)];
  await chrome.storage.session.remove(helperKey(jobTabId));
  if (stored) chrome.windows.remove(stored.windowId).catch(() => {});
}

/** Send a PAGE_CAPTURE_* request to the helper window (opened on first use) or, failing that, the viewer's own tab. */
async function relayCapture(msg) {
  const starts = msg.type === 'PAGE_CAPTURE_BEGIN' || msg.type === 'PAGE_CAPTURE_AUDIO_BEGIN';
  const helper = await openHelper(msg.tabId, starts ? msg.videoId : null);
  const target = helper ? helper.tabId : msg.tabId;
  const out = await chrome.tabs.sendMessage(target, { ...msg, type: msg.type.replace('PAGE_', ''), helper: !!helper }).catch((e) => ({ ok: false, error: e.message }));
  // The slide scan (the last step that needs the player) is over: close the background window at once,
  // so YouTube autoplay cannot start the next video in it. Listening keeps it open for the scan that follows;
  // if no scan follows, it closes when the job ends.
  if (helper && msg.type === 'PAGE_CAPTURE_END' && msg.closeHelper) await closeHelper(msg.tabId).catch(() => {});
  return out || { ok: false, error: 'no answer from the page' };
}

/**
 * Address + token of the local bridge. A bridge provider set up in Options wins; otherwise the native host
 * (registered by bridge/setup.mjs) is asked for the token and, with start=true, starts the bridge.
 * @returns {Promise<{ok:boolean, url?:string, token?:string, error?:string}>}
 */
async function bridgeInfo(start) {
  const s = await loadSettings();
  const p = (s.providers || []).find((x) => ['claudecli', 'geminiweb'].includes(x.type) && x.apiKey);
  if (p) return { ok: true, url: (p.baseUrl || 'http://127.0.0.1:8787').replace(/\/+$/, ''), token: p.apiKey };
  try {
    let r = await chrome.runtime.sendNativeMessage('com.lecturehelper.bridge', { cmd: start ? 'start' : 'token' });
    if (r?.ok && r.token) return { ok: true, url: `http://127.0.0.1:${r.port || 8787}`, token: r.token };
    return { ok: false, error: r?.error || 'the bridge is not set up' };
  } catch (e) { return { ok: false, error: `the bridge is not installed (${e.message})` }; }
}

async function handle(msg, sender) {
  const tabId = sender.tab?.id;
  switch (msg.type) {
    // ---- log entries from other pages (offscreen, options, content script) ----
    case 'LOG': {
      const e = msg.entry;
      if (e && typeof e === 'object') {
        if (!e.job && tabId != null) { // a content-script entry: file it under the job running for that tab
          const run = (await getQueue()).items.find((i) => i.status === 'running' && i.tabId === tabId);
          if (run) Object.assign(e, { job: run.id, jobTitle: String(run.title || run.url).slice(0, 120), jobKind: run.kind === 'download' ? 'download' : run.mode === 'youtube' ? 'youtube summary' : 'summary' });
        }
        appendLog(e);
      }
      return { ok: true };
    }
    // ---- from content script ----
    case 'GET_STATE': {
      const key = videosKey(tabId);
      const { [key]: videos = [] } = await chrome.storage.session.get(key);
      const q = await getQueue();
      const run = q.items.find((i) => i.status === 'running' && i.kind === 'summary');
      const paused = q.items.filter((i) => i.status === 'paused').map((i) => ({ id: i.id, url: i.url, title: i.title, info: i.pause }));
      return { videos, job: run ? { url: run.url, title: run.title } : null, paused };
    }
    case 'HAS_CACHE': {
      const r = await getResult(msg.url);
      return { cached: !!r, title: r?.title || null };
    }
    case 'START_DOWNLOAD':
      await enqueue([{ url: msg.url, kind: 'download', filename: msg.filename, title: msg.title, referer: msg.referer, withCookies: msg.withCookies }], tabId);
      return { ok: true };
    case 'START_SUMMARY':
      { const problem = await problemFor(msg.mode || 'video'); if (problem) return { error: problem }; }
      await enqueue([{
        url: msg.url, kind: 'summary', mode: msg.mode || 'video', videoUrl: msg.videoUrl, youtubeId: msg.youtubeId, transcript: msg.transcript,
        title: msg.title, course: msg.course, referer: msg.referer, withCookies: !!msg.withCookies, regenerate: !!msg.regenerate,
        durationSec: Number(msg.durationSec) || 0
      }], tabId);
      return { ok: true };
    case 'ENQUEUE':
      if (msg.items.some((i) => i.kind === 'summary')) { const problem = await problemFor('video'); if (problem) return { error: problem }; }
      await enqueue(msg.items, tabId);
      return { ok: true };
    case 'GET_STATES':
      await recoverStale();
      return { states: await getStates(msg.urls) };
    case 'CANCEL':
      await cancelQueue();
      return { ok: true };
    case 'OPEN_OPTIONS':
      chrome.runtime.openOptionsPage();
      return { ok: true };
    // frame capture / listening on a YouTube page: relay from the worker page to a content script
    case 'PAGE_CAPTURE_BEGIN':
    case 'PAGE_CAPTURE_FRAME':
    case 'PAGE_CAPTURE_END':
    case 'PAGE_CAPTURE_AUDIO_BEGIN':
    case 'PAGE_CAPTURE_AUDIO_STOP':
      return relayCapture(msg);
    case 'PAGE_HELPER_CLOSE':
      await closeHelper(msg.tabId);
      return { ok: true };
    case 'OPEN_LOCAL':
      await chrome.tabs.create({ url: chrome.runtime.getURL('local.html') });
      return { ok: true };
    // captions of the YouTube video in the sender's tab, loaded by the page's OWN player (it adds the token
    // YouTube now requires), so nothing has to be listened to
    case 'YT_PAGE_CAPTIONS': {
      if (tabId == null || !msg.videoId) return { text: '' };
      try {
        const [r] = await chrome.scripting.executeScript({ target: { tabId }, world: 'MAIN', func: pagePlayerCaptions, args: [msg.videoId] });
        const res = r?.result || {};
        if (res.json) {
          const text = json3ToLines(res.json);
          log.info('captions', `Captions read from the page's player (${res.via}${res.lang ? `, ${res.lang}${res.kind === 'asr' ? ' auto' : ''}` : ''}): no listening needed`, { lines: text.split(String.fromCharCode(10)).length });
          return { text, lang: res.lang || '', via: 'player' };
        }
        log.info('captions', `The page's player gave no captions: ${res.error || 'unknown reason'}`);
      } catch (e) { log.alert('captions', `Could not ask the page's player for captions: ${e.message}`); }
      return { text: '' };
    }
    // the local bridge (yt-dlp, Claude CLI, Gemini web): its address + token, starting it if needed
    case 'BRIDGE_INFO':
      return bridgeInfo(!!msg.start);

    // ---- from offscreen document ----
    case 'PROGRESS':
      chrome.tabs.sendMessage(msg.tabId, msg).catch(() => {});
      return { ok: true };
    case 'DOWNLOAD_READY': {
      try {
        const id = await chrome.downloads.download({
          url: msg.blobUrl,
          filename: msg.filename,
          conflictAction: 'uniquify',
          saveAs: false
        });
        await chrome.storage.session.set({ [`dl_${id}`]: { blobUrl: msg.blobUrl, tabId: msg.tabId, url: msg.url } });
        chrome.tabs.sendMessage(msg.tabId, { type: 'DOWNLOAD_STATUS', url: msg.url, state: 'saving' }).catch(() => {});
      } catch (e) {
        await sendToOffscreen({ type: 'REVOKE', blobUrl: msg.blobUrl }).catch(() => {});
        await finish({ url: msg.url, kind: 'download' }, 'error', e.message);
      }
      return { ok: true };
    }
    case 'DOWNLOAD_FAILED':
      await finish({ url: msg.url, kind: 'download' }, 'error', msg.message);
      return { ok: true };
    case 'JOB_DONE':
      await finish({ url: msg.url, kind: 'summary' }, 'done');
      return { ok: true };
    case 'JOB_ERROR':
      await finish({ url: msg.url, kind: 'summary' }, 'error', msg.message);
      return { ok: true };
    case 'JOB_PAUSED':
      await pauseItem(msg.url, msg.info || {});
      return { ok: true };

    // ---- from the "model failed" window (modelfix.html) and the page card ----
    case 'GET_PAUSE': {
      const it = (await getQueue()).items.find((i) => i.id === msg.id);
      return it?.status === 'paused' ? { item: { id: it.id, url: it.url, title: it.title, mode: it.mode, pause: it.pause } } : { gone: true };
    }
    case 'RESUME_JOB':
      return resumeItem(msg.id, msg.skip || '');
    case 'CANCEL_PAUSED':
      return cancelPaused(msg.id);
    case 'OPEN_MODEL_FIX': {
      const items = (await getQueue()).items.filter((i) => i.status === 'paused' && (msg.id ? i.id === msg.id : i.url === msg.url));
      if (!items.length) return { error: 'Nothing is waiting for a model decision.' };
      await openFixWindow(items[items.length - 1]);
      return { ok: true };
    }
    default:
      return { error: `Unknown message: ${msg.type}` };
  }
}
