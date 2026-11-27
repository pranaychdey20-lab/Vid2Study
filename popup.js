/**
 * Toolbar popup: enable the extension on the current site, scan the page once, global off switch.
 * Enabled sites are kept in chrome.storage.local ("sites"); background.js registers the content
 * script for exactly those sites.
 */
import { CONTENT_FILES } from './lib/common.js';
import { DEFAULT_SITES } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const say = (t) => { $('msg').textContent = t || ''; };

const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
let host = null;
try { const u = new URL(tab.url); if (/^https?:$/.test(u.protocol)) host = u.hostname; } catch { /* chrome:// pages etc. */ }
const store = await chrome.storage.local.get({ sites: DEFAULT_SITES, enabled: true });

$('site').textContent = host || 'This page cannot be used (browser page).';
$('siteOn').checked = !!host && store.sites.includes(host);
$('siteOn').disabled = !host;
$('scan').disabled = !host;
$('globalOn').checked = store.enabled;

/** Inject the content script into the open tab (registered scripts only apply to the next page load). */
async function inject() {
  await chrome.scripting.executeScript({ target: { tabId: tab.id }, files: CONTENT_FILES });
}

$('siteOn').addEventListener('change', async () => {
  const sites = new Set((await chrome.storage.local.get({ sites: DEFAULT_SITES })).sites);
  if ($('siteOn').checked) sites.add(host); else sites.delete(host);
  await chrome.storage.local.set({ sites: [...sites] });
  if ($('siteOn').checked) { await inject().catch(() => {}); say('Enabled. Videos on this site will show a Notes button.'); }
  else say('Disabled. Reload the page to remove the button.');
});

$('scan').addEventListener('click', async () => {
  say('Scanning...');
  const r = await chrome.tabs.sendMessage(tab.id, { type: 'RESCAN' }).catch(() => null);
  if (!r) {
    try { await inject(); } catch (e) { return say(`Cannot scan this page: ${e.message}`); }
  }
  say('Scanned. If a video was found, a Notes button appears on the page.');
});

$('globalOn').addEventListener('change', async () => {
  await chrome.storage.local.set({ enabled: $('globalOn').checked });
  say($('globalOn').checked ? 'On.' : 'Off. Reload open tabs to remove the button.');
});

$('lib').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }); window.close(); });
$('shelf').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('library-open.html') }); window.close(); });
$('logs').addEventListener('click', () => { chrome.tabs.create({ url: chrome.runtime.getURL('logs.html') }); window.close(); });
$('opts').addEventListener('click', () => { chrome.runtime.openOptionsPage(); window.close(); });
