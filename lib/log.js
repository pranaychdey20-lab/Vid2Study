/**
 * Activity logger (ES module, used by every extension page and the service worker).
 *
 * Every event is printed to the console in colour and kept (the last 1500) so the "Activity log" page
 * (logs.html) can show what happened behind the scenes:
 *   info   - normal steps: job started, stage changed, a model was called            (blue)
 *   alert  - something was skipped, retried, cut short, or hit a limit               (yellow)
 *   error  - something failed                                                        (red)
 *
 * Only the service worker writes the stored list. Other contexts forward their entries to it with a LOG
 * message (see `record`). Secrets are removed before anything is stored (see `clean`).
 * Classic scripts (content.js) cannot import this file; they carry a small copy of the forwarding code.
 */

const STYLE = {
  info: 'color:#8ab4f8',
  alert: 'color:#f5c542;font-weight:bold',
  error: 'color:#ff5f5f;font-weight:bold'
};
const KEEP = 1500;
const SECRET_KEY = /key|token|auth|secret|password|cookie|signature/i;
// keys and tokens that providers sometimes echo back in error text
const SECRET_TEXT = /(AIza[0-9A-Za-z_-]{20,}|sk-[A-Za-z0-9_-]{16,}|gsk_[A-Za-z0-9]{16,}|Bearer\s+[A-Za-z0-9._-]{12,})/g;

const raw = { log: console.log.bind(console), warn: console.warn.bind(console), error: console.error.bind(console) };
let localStore = null; // set in the service worker: writes straight to storage
let tapped = false;
/** The job this page is working on; every entry it records is tagged with it (the log page groups by job). */
let currentJob = null;

/**
 * Tag all following entries of this page with a job (one summarisation or download), or clear it with null.
 * @param {{id:string, title?:string, kind?:'summary'|'youtube summary'|'download'}|null} j
 */
export function setJob(j) { currentJob = j?.id ? jobFields(j) : null; }
const jobFields = (j) => ({ job: String(j.id), jobTitle: clip(j.title || '', 120), jobKind: j.kind || 'summary' });

/** Short, secret-free text. */
export function clip(v, n = 400) {
  let s = typeof v === 'string' ? v : v instanceof Error ? v.message : (() => { try { return JSON.stringify(v); } catch { return String(v); } })();
  s = String(s ?? '').replace(SECRET_TEXT, '[hidden]');
  return s.length > n ? `${s.slice(0, n)}...` : s;
}

/** Keep only small, non-secret fields of `data`. */
export function clean(data) {
  if (data == null) return undefined;
  if (typeof data !== 'object' || data instanceof Error) return { value: clip(data, 300) };
  const out = {};
  for (const [k, v] of Object.entries(data)) {
    if (SECRET_KEY.test(k) || v === undefined) continue;
    out[k] = typeof v === 'number' || typeof v === 'boolean' || v == null ? v : clip(v, 300);
  }
  return out;
}

/** Store one entry through the service worker (or directly, in the service worker). */
export function record(entry) {
  if (currentJob && !entry.job) Object.assign(entry, currentJob);
  if (localStore) return localStore(entry);
  try { chrome?.runtime?.sendMessage?.({ type: 'LOG', entry })?.catch?.(() => {}); } catch { /* no extension here */ }
}

function emit(level, scope, msg, data, extra) {
  const entry = { t: Date.now(), level, scope: String(scope || 'app'), msg: clip(msg, 600), ...extra };
  const d = clean(data);
  if (d) entry.data = d;
  const fn = level === 'error' ? raw.error : level === 'alert' ? raw.warn : raw.log;
  if (d) fn(`%c[LH:${entry.scope}] ${entry.msg}`, STYLE[level], d); else fn(`%c[LH:${entry.scope}] ${entry.msg}`, STYLE[level]);
  record(entry);
  return entry;
}

/** The logger: log.info / log.alert / log.error (scope, message, optional data object). */
export const log = {
  info: (scope, msg, data) => emit('info', scope, msg, data),
  alert: (scope, msg, data) => emit('alert', scope, msg, data),
  error: (scope, msg, data) => emit('error', scope, msg, data),
  /** A logger whose entries all belong to one job (the service worker handles many jobs, so it names them). */
  job(j) {
    const extra = jobFields(j);
    return {
      info: (scope, msg, data) => emit('info', scope, msg, data, extra),
      alert: (scope, msg, data) => emit('alert', scope, msg, data, extra),
      error: (scope, msg, data) => emit('error', scope, msg, data, extra)
    };
  }
};

/** Use this context's storage directly (service worker only). */
export function useLocalStore() { localStore = appendLog; }

/** Append one entry to the stored list (last KEEP entries). Writes are queued, so none are lost. */
let chainP = Promise.resolve();
export function appendLog(entry) {
  chainP = chainP.then(async () => {
    if (typeof chrome === 'undefined' || !chrome.storage?.local) return;
    const { activityLog = [] } = await chrome.storage.local.get('activityLog');
    activityLog.push(entry);
    if (activityLog.length > KEEP) activityLog.splice(0, activityLog.length - KEEP);
    await chrome.storage.local.set({ activityLog });
  }).catch(() => {});
  return chainP;
}

/** Entries -> jobs (newest first). Each job: its entries in time order, title, kind, status, counts. */
export function groupJobs(list) {
  const jobs = new Map();
  for (const e of list) {
    const id = e.job || '';
    let j = jobs.get(id);
    if (!j) jobs.set(id, (j = { id, title: e.jobTitle || '', kind: e.jobKind || '', entries: [] }));
    if (e.jobTitle && !j.title) j.title = e.jobTitle;
    j.entries.push(e);
  }
  const out = [...jobs.values()].map((j) => {
    const first = j.entries[0].t, last = j.entries[j.entries.length - 1].t;
    const end = [...j.entries].reverse().find((e) => e.scope === 'queue' && e.data?.status)?.data.status;
    return {
      ...j, first, last,
      errors: j.entries.filter((e) => e.level === 'error').length,
      alerts: j.entries.filter((e) => e.level === 'alert').length,
      status: end || (Date.now() - last > 10 * 60000 ? 'interrupted' : 'running')
    };
  });
  // real jobs newest first; the "no job" block always last
  return out.sort((a, b) => (a.id === '') - (b.id === '') || b.first - a.first);
}

/**
 * Route this page's console.warn / console.error (and uncaught errors) into the log too, so existing
 * warnings in the code are recorded without changes. Call once per page.
 */
export function tapConsole(scope = 'app') {
  if (tapped) return;
  tapped = true;
  const text = (args) => args.map((a) => clip(a, 300)).join(' ');
  console.warn = (...args) => { raw.warn(...args); record({ t: Date.now(), level: 'alert', scope, msg: clip(text(args), 600) }); };
  console.error = (...args) => { raw.error(...args); record({ t: Date.now(), level: 'error', scope, msg: clip(text(args), 600) }); };
  globalThis.addEventListener?.('error', (e) => record({ t: Date.now(), level: 'error', scope, msg: clip(`Uncaught: ${e.message} (${e.filename || ''}:${e.lineno || 0})`, 600) }));
  globalThis.addEventListener?.('unhandledrejection', (e) => record({ t: Date.now(), level: 'error', scope, msg: clip(`Unhandled promise rejection: ${clip(e.reason, 400)}`, 600) }));
}
