/**
 * Activity log page: the entries the service worker stores (lib/log.js) under "activityLog", grouped by job.
 * One block per summarisation or download (newest first), each with its entries in time order; entries that
 * belong to no job (setup, stray errors) are collected in one block at the end.
 * Every value is written with textContent, never as HTML, because messages can contain page text.
 */
import { groupJobs } from './lib/log.js';

const $ = (id) => document.getElementById(id);
const KIND = { 'youtube summary': 'YouTube summary', summary: 'Summary', download: 'Download' };
const STATUS = { done: 'finished', failed: 'failed', cancelled: 'cancelled', running: 'running', interrupted: 'interrupted', paused: 'paused: model failed' };
let entries = [];
let level = 'all';
/** job id -> open/closed, remembered while the page re-renders on new entries */
const openState = new Map();

const when = (t) => new Date(t).toLocaleString();
const clock = (t) => new Date(t).toLocaleTimeString();
const dur = (ms) => (ms < 90000 ? `${Math.round(ms / 1000)} s` : `${Math.round(ms / 60000)} min`);
const dataText = (d, sep) => Object.entries(d).map(([k, v]) => `${k}: ${v}`).join(sep);

async function load() {
  try {
    const { activityLog = [] } = await chrome.storage.local.get('activityLog');
    entries = activityLog;
  } catch { entries = []; }
  fillScopes();
  render();
}

function fillScopes() {
  const sel = $('scope');
  const keep = sel.value;
  const scopes = [...new Set(entries.map((e) => e.scope))].sort();
  sel.replaceChildren(new Option('All areas', ''), ...scopes.map((s) => new Option(s, s)));
  sel.value = scopes.includes(keep) ? keep : '';
}

function matches(e) {
  const q = $('q').value.trim().toLowerCase();
  const scope = $('scope').value;
  if (level === 'alert' ? e.level === 'info' : level === 'error' ? e.level !== 'error' : false) return false;
  if (scope && e.scope !== scope) return false;
  return !q || `${e.msg} ${e.scope} ${e.jobTitle || ''} ${JSON.stringify(e.data || '')}`.toLowerCase().includes(q);
}

function entryRow(e) {
  const div = document.createElement('div');
  div.className = `row ${e.level in { info: 1, alert: 1, error: 1 } ? e.level : 'info'}`;
  const meta = document.createElement('div');
  meta.className = 'meta';
  for (const [cls, text] of [['lvl', e.level], [null, clock(e.t)], [null, e.scope]]) {
    const s = document.createElement('span');
    if (cls) s.className = cls;
    s.textContent = text;
    meta.append(s);
  }
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.textContent = e.msg;
  div.append(meta, msg);
  if (e.data && Object.keys(e.data).length) {
    const pre = document.createElement('pre');
    pre.textContent = dataText(e.data, '\n');
    div.append(pre);
  }
  return div;
}

function jobBlock(j, shown, index) {
  const d = document.createElement('details');
  d.className = `job ${j.errors ? 'has-error' : j.alerts ? 'has-alert' : ''}`;
  const dflt = index === 0 || j.errors > 0; // the newest job and any job with errors start open
  d.open = openState.has(j.id) ? openState.get(j.id) : dflt;
  d.addEventListener('toggle', () => openState.set(j.id, d.open));
  const sum = document.createElement('summary');
  const title = document.createElement('span');
  title.className = 'jtitle';
  title.textContent = j.id ? `${KIND[j.kind] || 'Job'}: ${j.title || '(untitled)'}` : 'Other activity (not part of a summary or download)';
  const badges = document.createElement('span');
  badges.className = 'badges';
  const add = (cls, text) => { const b = document.createElement('span'); b.className = `badge ${cls}`; b.textContent = text; badges.append(b); };
  if (j.id) add(`st-${j.status}`, STATUS[j.status] || j.status);
  if (j.errors) add('b-error', `${j.errors} error${j.errors > 1 ? 's' : ''}`);
  if (j.alerts) add('b-alert', `${j.alerts} alert${j.alerts > 1 ? 's' : ''}`);
  const meta = document.createElement('span');
  meta.className = 'jmeta';
  meta.textContent = j.id ? `${when(j.first)} · ${dur(j.last - j.first)} · ${j.entries.length} entries` : `${j.entries.length} entries`;
  sum.append(title, badges, meta);
  d.append(sum);
  const body = document.createElement('div');
  body.className = 'jbody';
  body.append(...shown.map(entryRow));
  d.append(body);
  return d;
}

function render() {
  const box = $('list');
  const jobs = groupJobs(entries);
  const blocks = [];
  let shownCount = 0;
  jobs.forEach((j, i) => {
    const shown = j.entries.filter(matches);
    if (!shown.length) return;
    shownCount += shown.length;
    blocks.push(jobBlock(j, shown, i));
  });
  if (!blocks.length) {
    const empty = document.createElement('div');
    empty.className = 'empty';
    empty.textContent = entries.length ? 'No entries match.' : 'Nothing logged yet. Start a summary or download to see what happens behind the scenes.';
    box.replaceChildren(empty);
  } else {
    box.replaceChildren(...blocks);
  }
  $('count').textContent = `${shownCount} of ${entries.length} entries in ${blocks.length} group${blocks.length === 1 ? '' : 's'}`;
  const errors = entries.filter((e) => e.level === 'error').length;
  const alerts = entries.filter((e) => e.level === 'alert').length;
  document.title = `Activity log (${errors} errors, ${alerts} alerts)`;
}

document.querySelectorAll('button[data-level]').forEach((b) => b.addEventListener('click', () => {
  level = b.dataset.level;
  document.querySelectorAll('button[data-level]').forEach((x) => x.classList.toggle('on', x === b));
  render();
}));
$('q').addEventListener('input', render);
$('scope').addEventListener('change', render);

$('export').addEventListener('click', () => {
  const text = groupJobs(entries).map((j) => {
    const head = j.id
      ? `=== ${KIND[j.kind] || 'Job'}: ${j.title || '(untitled)'} | ${STATUS[j.status] || j.status} | ${when(j.first)} | ${dur(j.last - j.first)} | ${j.errors} errors, ${j.alerts} alerts ===`
      : '=== Other activity (not part of a summary or download) ===';
    const lines = j.entries.map((e) => `${clock(e.t)}  ${e.level.toUpperCase().padEnd(5)}  [${e.scope}]  ${e.msg}${e.data ? `\n      ${dataText(e.data, ', ')}` : ''}`);
    return `${head}\n${lines.join('\n')}`;
  }).join('\n\n');
  const url = URL.createObjectURL(new Blob([text || 'No entries.'], { type: 'text/plain' }));
  const a = Object.assign(document.createElement('a'), { href: url, download: `vid2study-log-${new Date().toISOString().slice(0, 10)}.txt` });
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
});

$('clear').addEventListener('click', async () => {
  if (!confirm('Clear the activity log?')) return;
  try { await chrome.storage.local.set({ activityLog: [] }); } catch { /* ignore */ }
  entries = [];
  openState.clear();
  fillScopes();
  render();
});

try {
  chrome.storage.onChanged.addListener((changes, area) => {
    if (area === 'local' && changes.activityLog) { entries = changes.activityLog.newValue || []; fillScopes(); render(); }
  });
} catch { /* not an extension page */ }

load();
