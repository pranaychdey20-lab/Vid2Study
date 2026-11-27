/** Options page: AI providers (key + URL, automatic model fetch), who does what, output, sites, cache. */
import { MODELS } from './lib/common.js';
import { clearAll, countResults } from './lib/db.js';
import { listModels, detectProvider, nativeBridge, signInGemini } from './lib/llm.js';
import { sttModelsFor } from './lib/stt.js';
import { checkModel, checkVision } from './lib/modelcheck.js';
import { needsGeminiSignIn } from './lib/stagefix.js';
import { loadSettings, saveSettings, KNOWN_SERVICES, PROVIDER_TYPES, PRESETS, BRIDGE_TYPES, BRIDGE_BASE, providerModelIds as modelIds } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c]);
/** @type {object} settings being edited */
let S;
const timers = new Map();
let savedSnapshot;
let saveChain = Promise.resolve();

/**
 * Debounce typing without delaying committed selections or the Save button.
 */
function persistSoon() {
  clearTimeout(timers.get('persist'));
  timers.set('persist', setTimeout(save, 250));
}

function setMsg(el, text, ok) {
  el.textContent = text;
  el.className = `msg ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}

// ---------- providers ----------
function drawProviders() {
  $('providers').innerHTML = S.providers.map((p) => `
    <div class="prov" data-id="${esc(p.id)}">
      <h3>${esc(p.name || 'Provider')}</h3>
      <label>Name</label><input type="text" data-f="name" value="${esc(p.name)}">
      <label>Type</label>
      <select data-f="type">${Object.entries(PROVIDER_TYPES).map(([k, v]) => `<option value="${k}" ${p.type === k ? 'selected' : ''}>${v.label}</option>`).join('')}</select>
      <label>Base URL</label><input type="text" data-f="baseUrl" value="${esc(p.baseUrl)}" placeholder="${esc(PROVIDER_TYPES[p.type].base)}">
      <label>${BRIDGE_TYPES.includes(p.type) ? 'Bridge token' : 'API key'}</label>
      <div class="row"><input type="password" data-f="apiKey" value="${esc(p.apiKey)}" autocomplete="off" placeholder="${BRIDGE_TYPES.includes(p.type) ? 'Filled in by the local bridge' : 'paste key'}">
        <button type="button" data-a="show">Show</button></div>
      <div class="row"><button type="button" data-a="fetch">Fetch models</button><button type="button" data-a="remove" ${S.providers.length < 2 ? 'disabled' : ''}>Remove</button></div>
      <label>Check that a model answers</label>
      <select data-c="pick"></select>
      <div class="row" style="margin-top:6px">
        <button type="button" data-a="check">Check model</button><button type="button" data-a="checkVision">Check vision</button></div>
      <div class="msg" data-r="check"></div>
      ${p.type === 'geminiweb' ? `<div class="row"><button type="button" data-a="geminiLogin" ${$('bridgeLogins').querySelector('[data-session="geminiLogin"] .session-dot').dataset.state === 'connected' ? 'disabled' : ''}>Sign in to Gemini</button></div>` : ''}
      <div class="msg" data-r="status">${p.models?.length ? `${p.models.length} models loaded.` : ''}</div>
    </div>`).join('');
  fillSelects();
}

/**
 * Every place a provider + model is chosen. `optional` slots can be left on "Same as Strong AI" (empty);
 * `gemini` slots only offer Gemini providers (only Gemini can watch a video).
 */
const SLOTS = [
  { k: 'cheap', prov: 'cheapProv', model: 'cheapModel', optional: true },
  { k: 'strong', prov: 'strongProv', model: 'strongModel' },
  { k: 'vision', prov: 'visionProv', model: 'visionModel', optional: true, none: 'Same as Cheap AI' },
  { k: 'stt', prov: 'sttProv', model: 'sttModel', optional: true, none: 'This computer (free, slower)', openaiOnly: true, suggest: (p) => (p ? sttModelsFor(p) : []) },
  { k: 'video', prov: 'videoProv', model: 'videoModel', gemini: true },
  { k: 'notes', prov: 'notesProv', model: 'notesModel' },
  { k: 'digest', prov: 'digestProv', model: 'digestModel', optional: true, none: 'Same as Cheap AI' },
  { k: 'strongFallback', prov: 'strongFbProv', model: 'strongFbModel', optional: true, none: 'No fallback' },
  { k: 'practice', prov: 'practiceProv', model: 'practiceModel', optional: true }
];

function fillSelects() {
  const opts = (list, sel) => list.map((p) => `<option value="${esc(p.id)}" ${p.id === sel ? 'selected' : ''}>${esc(p.name)} (${PROVIDER_TYPES[p.type].label})</option>`).join('');
  for (const s of SLOTS) {
    const list = s.gemini ? S.providers.filter((p) => p.type === 'gemini') : s.openaiOnly ? S.providers.filter((p) => p.type === 'openai') : S.providers;
    const none = s.optional ? `<option value="" ${S[s.k].provider ? '' : 'selected'}>${s.none || 'Same as Strong AI'}</option>` : '';
    const provider = $(s.prov);
    provider.innerHTML = none + opts(list, S[s.k].provider) || '<option value="">Add a Gemini provider first</option>';
    if (provider.value !== S[s.k].provider) S[s.k] = { provider: provider.value, model: '' };
    fillSlotModel(s);
  }
  fillLevels();
  fillCheckPicks();
  drawCheapPool();
}

function fillSlotModel(slot) {
  const ref = S[slot.k];
  const provider = S.providers.find(p => p.id === ref.provider);
  const pick = $(`${slot.model}Pick`);
  pick.disabled = !provider;
  pick.innerHTML = modelOptions(slot.suggest ? slot.suggest(provider) : modelIds(provider), provider ? ref.model : '');
}

function clearProviderModels(id) {
  for (const slot of SLOTS) {
    if (S[slot.k].provider === id) S[slot.k] = { provider: id, model: '' };
  }
  S.cheapPool = S.cheapPool.map(ref => ref.provider === id ? { provider: id, model: '' } : ref);
}

/** The Cheap AI fallbacks: one row per extra model (provider + model), tried in order. */
function drawCheapPool() {
  const el = $('cheapPool');
  if (!el) return;
  el.innerHTML = (S.cheapPool || []).map((r, i) => `<div class="row" data-i="${i}" style="margin-bottom:6px">
    <b style="min-width:22px">${i + 2}.</b>
    <select data-p="provider">${S.providers.map((p) => `<option value="${esc(p.id)}" ${p.id === r.provider ? 'selected' : ''}>${esc(p.name)} (${PROVIDER_TYPES[p.type].label})</option>`).join('')}</select>
    <select data-p="model" aria-label="Fallback model">${modelOptions(modelIds(S.providers.find(p => p.id === r.provider)), r.model)}</select>
    <button type="button" data-a="rmCheap">Remove</button></div>`).join('') || '<div class="hint">No fallbacks yet.</div>';
}
$('addCheap')?.addEventListener('click', () => {
  (S.cheapPool ||= []).push({ provider: S.cheap.provider || S.providers[0]?.id || '', model: '' });
  drawCheapPool();
  persistSoon();
  $('cheapPool').querySelector('.row:last-child [data-p="model"]')?.focus();
});
$('cheapPool')?.addEventListener('change', e => {
  const i = Number(e.target.closest('.row')?.dataset.i);
  const row = S.cheapPool?.[i];
  if (!row) return;
  if (e.target.dataset.p === 'provider') {
    S.cheapPool[i] = { provider: e.target.value, model: '' };
  } else if (e.target.dataset.p === 'model') {
    S.cheapPool[i] = modelChoice(e.target, row);
  }
  drawCheapPool();
  save();
});
$('cheapPool')?.addEventListener('click', (e) => { if (e.target.dataset.a !== 'rmCheap') return; S.cheapPool.splice(Number(e.target.closest('.row').dataset.i), 1); drawCheapPool(); save(); });

const CUSTOM_MODEL = '__vid2study_enter_custom_model__';

function modelOptions(ids, current) {
  const models = [...new Set([...ids, current].filter(Boolean))];
  return '<option value="">Pick a model</option>' +
    models.map(id => `<option value="${esc(id)}" ${id === current ? 'selected' : ''}>${esc(id)}</option>`).join('') +
    `<option value="${CUSTOM_MODEL}">Enter a custom model…</option>`;
}

function pickedModel(select, previous = '') {
  if (select.value !== CUSTOM_MODEL) return select.value;
  return window.prompt('Enter the model ID', previous)?.trim() || previous;
}

function modelChoice(select, previous) {
  const model = pickedModel(select, previous.model).replace(/^models\//, '');
  const custom = model && (select.value === CUSTOM_MODEL || (previous.custom && previous.model === model));
  return { provider: previous.provider, model, ...(custom ? { custom: true } : {}) };
}
for (const slot of SLOTS) {
  $(`${slot.model}Pick`).addEventListener('change', e => {
    S[slot.k] = modelChoice(e.target, S[slot.k]);
    fillSlotModel(slot);
    if (slot.k === 'video') fillLevels();
    save();
  });
}

/** The Vision AI slot: its own check button, and an automatic check whenever its provider or model changes. */
{
  const row = document.createElement('div');
  row.className = 'row';
  row.style.marginTop = '6px';
  row.innerHTML = '<button type="button" id="visionCheck">Check it can see images</button>';
  const msg = document.createElement('div');
  msg.className = 'msg';
  msg.id = 'visionMsg';
  $('visionModelPick').after(row, msg);
  let timer = 0, seq = 0;
  const run = async () => {
    const { provider, model } = S.vision.provider ? S.vision : S.strong;
    const p = S.providers.find(x => x.id === provider);
    if (!p || !model) { setMsg(msg, ''); return; }
    const mine = ++seq;
    setMsg(msg, `Checking that ${model} can see images...`);
    try { const t = await checkVision(p, model); if (mine === seq) setMsg(msg, t, true); } catch (e) { if (mine === seq) setMsg(msg, `Cannot see images: ${e.message}`, false); }
  };
  $('visionCheck').addEventListener('click', run);
  const soon = () => { clearTimeout(timer); timer = setTimeout(run, 1200); };
  $('visionModelPick').addEventListener('change', soon);
  $('visionProv').addEventListener('change', soon);
}

/** The model to check first for a provider: one a slot already uses with it, else its first model. */
function defaultCheckModel(p) {
  const used = SLOTS.map(slot => S[slot.k]).find(ref => ref.provider === p.id && ref.model);
  return used?.model || modelIds(p)[0] || '';
}

/** Thinking levels the chosen video model allows (Gemini only). */
function fillLevels() {
  const m = MODELS.find(x => x.id === S.video.model);
  const sel = $('thinkingLevel');
  const want = S.thinkingLevel;
  sel.innerHTML = m ? m.levels.map((l) => `<option value="${l}">${l}</option>`).join('') : '<option value="">Model default</option>';
  sel.disabled = !m;
  if (m) sel.value = m.levels.includes(want) ? want : m.level;
}

/** Ask the provider for its models (also proves the key works). Runs shortly after the user stops typing. */
function sameProviderConfig(provider, requested) {
  return S.providers.includes(provider) && provider.type === requested.type &&
    provider.baseUrl === requested.baseUrl && provider.apiKey === requested.apiKey;
}

async function fetchModels(id, { quiet = false } = {}) {
  const p = S.providers.find((x) => x.id === id);
  const status = () => document.querySelector(`.prov[data-id="${CSS.escape(id)}"] [data-r="status"]`);
  if (!p || !status()) return;
  if (!p.baseUrl || (!p.apiKey && !/localhost|127\.0\.0\.1/.test(p.baseUrl))) { if (!quiet) setMsg(status(), 'Enter the URL and the API key first.', false); return; }
  const requested = { ...p };
  setMsg(status(), 'Fetching models...');
  try {
    const models = await listModels(requested);
    if (!sameProviderConfig(p, requested)) return;
    p.models = models;
    setMsg(status(), `Key works. ${p.models.length} models found. Saved.`, true);
    fillSelects();
    persistSoon();
  } catch (e) {
    if (sameProviderConfig(p, requested)) setMsg(status(), `Could not fetch models: ${e.message}`, false);
  }
}
const isStockUrl = (u) => !u || [...PRESETS, ...KNOWN_SERVICES].some((x) => x.base === u);
const isStockName = (n) => !n || n === 'New provider' || [...PRESETS, ...KNOWN_SERVICES].some((x) => x.name === n);

/**
 * After a key is pasted: recognise the service from the key, fill in its URL and name, load the models.
 * Only when the URL is empty or a stock one; a hand-typed URL is respected.
 */
async function autoDetect(id) {
  const p = S.providers.find((x) => x.id === id);
  const status = () => document.querySelector(`.prov[data-id="${CSS.escape(id)}"] [data-r="status"]`);
  if (!p?.apiKey) return;
  if (!isStockUrl(p.baseUrl)) return fetchModels(id, { quiet: true });
  if (status()) setMsg(status(), 'Detecting the service...');
  const requested = { ...p };
  const hit = await detectProvider(requested.apiKey);
  if (!sameProviderConfig(p, requested)) return;
  if (!hit) {
    if (p.baseUrl) return fetchModels(id, { quiet: true });
    if (status()) setMsg(status(), 'Could not tell which service this key belongs to. Enter the Base URL.', false);
    return;
  }
  if (isStockName(p.name)) p.name = hit.name;
  if (p.type !== hit.type || (p.baseUrl && p.baseUrl !== hit.baseUrl)) clearProviderModels(id);
  Object.assign(p, { type: hit.type, baseUrl: hit.baseUrl, models: hit.models });
  drawProviders();
  persistSoon();
  if (status()) setMsg(status(), `Detected ${hit.name}. ${hit.models.length} models found. Saved.`, true);
}
const detectSoon = (id) => { clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => autoDetect(id), 700)); };
const fetchSoon = (id) => { clearTimeout(timers.get(id)); timers.set(id, setTimeout(() => fetchModels(id, { quiet: true }), 700)); };

$('providers').addEventListener('input', (e) => {
  const box = e.target.closest('.prov');
  const f = e.target.dataset.f;
  if (!box || !f) return;
  const p = S.providers.find((x) => x.id === box.dataset.id);
  const value = e.target.value.trim();
  if (!p || p[f] === value) return;
  p[f] = value;
  persistSoon();
  if (f === 'type') { // a new type brings its own default URL
    p.baseUrl = PROVIDER_TYPES[p.type].base;
    p.models = [];
    clearProviderModels(p.id);
    drawProviders();
    return;
  }
  if (f === 'name') { box.querySelector('h3').textContent = p.name || 'Provider'; fillSelects(); }
  if (f === 'apiKey') { p.models = []; detectSoon(p.id); }
  if (f === 'baseUrl') { p.models = []; fetchSoon(p.id); }
});
// Each provider card's check: a dropdown with ALL its models (a datalist only shows names matching what is typed).
function fillCheckPicks() {
  for (const box of document.querySelectorAll('.prov')) {
    const p = S.providers.find((x) => x.id === box.dataset.id);
    const sel = box.querySelector('[data-c="pick"]');
    if (!p || !sel) continue;
    sel.innerHTML = modelOptions(modelIds(p), sel.value || defaultCheckModel(p));
    sel.dataset.previous = sel.value;
  }
}
$('providers').addEventListener('change', e => {
  if (e.target.dataset.c !== 'pick') return;
  const select = e.target;
  const p = S.providers.find(provider => provider.id === select.closest('.prov').dataset.id);
  if (select.value === CUSTOM_MODEL) {
    select.innerHTML = modelOptions(modelIds(p), pickedModel(select, select.dataset.previous));
  }
  select.dataset.previous = select.value;
});
$('providers').addEventListener('click', async (e) => {
  const a = e.target.dataset.a;
  const box = e.target.closest('.prov');
  if (!a || !box) return;
  const id = box.dataset.id;
  if (a === 'show') {
    const i = box.querySelector('[data-f="apiKey"]');
    i.type = i.type === 'password' ? 'text' : 'password';
    e.target.textContent = i.type === 'password' ? 'Show' : 'Hide';
  } else if (a === 'geminiLogin') {
    const p = S.providers.find((x) => x.id === id);
    const out = box.querySelector('[data-r="check"]');
    e.target.disabled = true;
    setMsg(out, 'Finish signing in to Google in the Chrome window, then close that window.');
    try { setMsg(out, await signInGemini(p), true); }
    catch (err) { setMsg(out, err.message, false); }
    finally { e.target.disabled = false; refreshSessions().catch(() => {}); }
  } else if (a === 'check' || a === 'checkVision') {
    const p = S.providers.find((x) => x.id === id);
    const input = box.querySelector('[data-c="pick"]');
    const out = box.querySelector('[data-r="check"]');
    const vision = a === 'checkVision';
    if (!input.value.trim()) input.innerHTML = modelOptions(modelIds(p), defaultCheckModel(p));
    e.target.disabled = true;
    setMsg(out, vision ? 'Checking that it can see images...' : 'Checking...');
    try { setMsg(out, await (vision ? checkVision : checkModel)(p, input.value.trim(), message => setMsg(out, message)), true); }
    catch (err) {
      setMsg(out, needsGeminiSignIn(err) ? 'Gemini web is signed out. Use “Sign in to Gemini” below.' : `${vision ? 'Vision check failed' : 'Model check failed'}: ${err.message}`, false);
    } finally { e.target.disabled = false; }
  } else if (a === 'fetch') { const p = S.providers.find((x) => x.id === id); (isStockUrl(p.baseUrl) && p.apiKey ? autoDetect(id) : fetchModels(id)); }
  else if (a === 'remove' && S.providers.length > 1) {
    S.providers = S.providers.filter((p) => p.id !== id);
    persistSoon();
    for (const slot of SLOTS.filter(slot => S[slot.k]?.provider === id)) {
      const provider = slot.optional ? '' : slot.gemini ? S.providers.find(p => p.type === 'gemini')?.id || '' : S.providers[0].id;
      S[slot.k] = { provider, model: '' };
    }
    S.cheapPool = (S.cheapPool || []).filter((r) => r.provider !== id);
    drawProviders();
  }
});
$('addProv').addEventListener('click', () => {
  const pr = PRESETS[Number($('preset').value)];
  S.providers.push({ id: `p_${Math.random().toString(36).slice(2, 8)}`, name: pr.auto ? 'New provider' : pr.name, type: pr.type, baseUrl: pr.base, apiKey: '', models: [] });
  drawProviders();
  persistSoon();
  if (BRIDGE_TYPES.includes(pr.type)) autoToken(); else document.querySelector('.prov:last-child [data-f="apiKey"]')?.focus();
});
for (const s of SLOTS) {
  $(s.prov).addEventListener('change', () => {
    const provider = $(s.prov).value;
    if (provider === S[s.k].provider) return;
    const model = s.k === 'stt' && provider ? sttModelsFor(S.providers.find(p => p.id === provider))[0] : '';
    S[s.k] = { provider, model };
    fillSlotModel(s);
    if (s.k === 'video') fillLevels();
    save();
  });
}
$('thinkingLevel').addEventListener('change', e => { S.thinkingLevel = e.target.value; });
const showEngine = () => {
  const legacy = $('engine').value === 'gemini';
  $('legacy').hidden = !legacy;
  $('localSlots').hidden = legacy;
};
$('engine').addEventListener('change', showEngine);

// ---------- local helper (bridge) ----------
const bridgeP = () => S.providers.find((p) => BRIDGE_TYPES.includes(p.type) && p.apiKey);
const bridgeUrl = () => (bridgeP()?.baseUrl || BRIDGE_BASE).replace(/\/+$/, '');
let freshToken = '';
const bridgeTok = () => freshToken || bridgeP()?.apiKey || $('bridgeToken').value.trim();
/** Fill the bridge token into bridge providers that have none, asking the native host (no pasting). */
async function autoToken() {
  const need = S.providers.filter((p) => BRIDGE_TYPES.includes(p.type) && !p.apiKey);
  const r = await nativeBridge('token');
  if (!r.ok) return;
  freshToken = r.token; $('bridgeToken').value = r.token;
  if (!need.length) return;
  need.forEach((p) => { p.apiKey = r.token; });
  persistSoon(); drawProviders();
  if (r.running) need.forEach((p) => fetchModels(p.id, { quiet: true }));
}
async function bridgeCall(path, method = 'GET') {
  const timeout = path === '/setup/login-codex-profile' ? 960000 : 600000;
  const res = await fetch(`${bridgeUrl()}${path}`, { method, headers: { 'x-bridge-token': bridgeTok() }, signal: AbortSignal.timeout(timeout) });
  if (res.status === 401) throw new Error('The bridge is running but the token is wrong. Paste the token from bridge/token.txt.');
  return res.json();
}
const FIXES = { ytdlp: ['Update now', 'ytdlp'], playwright: ['Install playwright-core', 'playwright'], chrome: ['Install Chrome', 'chrome'], claude: ['Install Claude CLI', 'claude'] };
const LABELS = { node: 'Node', playwright: 'playwright-core', chrome: 'Google Chrome', claude: 'Claude CLI', ytdlp: 'yt-dlp (YouTube without listening)' };
let sessionCheck;
let sessionVersion = 0;

function paintSessions(status, fallback = 'Status unavailable') {
  for (const row of $('bridgeLogins').querySelectorAll('[data-session]')) {
    if (row.dataset.signingIn) continue;
    const session = status?.[row.dataset.session];
    const connected = session?.ok === true;
    const disconnected = session?.ok === false;
    row.querySelector('.session-dot').dataset.state = connected ? 'connected' : disconnected ? 'disconnected' : 'unknown';
    const label = row.querySelector('[data-session-status]');
    label.textContent = connected ? 'Connected' : disconnected ? 'Needs attention' : fallback;
    label.title = session?.detail || '';
    for (const button of row.querySelectorAll('button')) button.disabled = !disconnected;
    if (row.dataset.session === 'geminiLogin') {
      for (const button of $('providers').querySelectorAll('[data-a="geminiLogin"]')) button.disabled = connected;
    }
  }
}

function refreshSessions() {
  if (!sessionCheck) {
    const version = sessionVersion;
    sessionCheck = bridgeCall('/status?deep=1').then(status => {
      if (!status.node) throw new Error(status.error?.message || 'Session status unavailable');
      if (version === sessionVersion) paintSessions(status);
      return status;
    }).catch(error => {
      if (version === sessionVersion) paintSessions(null);
      throw error;
    }).finally(() => { sessionCheck = null; });
  }
  return sessionCheck;
}
async function bridgeCheck() {
  const msg = $('bridgeMsg');
  setMsg(msg, 'Checking (the Gemini sign-in check opens a hidden Chrome, about 10 s)...');
  try {
    const up = await fetch(`${bridgeUrl()}/ping`, { signal: AbortSignal.timeout(3000) }).then((r) => r.ok, () => false);
    if (!up) { $('bridgeList').innerHTML = ''; return setMsg(msg, 'The bridge is not running. Press "Start bridge", or double-click bridge/Start-Bridge.cmd.', false); }
    if (!bridgeTok()) return setMsg(msg, 'The bridge is running. Paste its token above (bridge/token.txt).', false);
    const st = await refreshSessions();
    $('bridgeList').innerHTML = Object.entries(LABELS).map(([k, label]) => {
      const r = st[k]; if (!r) return '';
      const fix = k === 'ytdlp' || !r.ok ? FIXES[k] : null;
      return `<div class="site"><span>${r.ok ? '✓' : '✗'} ${esc(label)}: ${esc(r.detail)}</span>${fix ? `<button type="button" data-fix="${fix[1]}">${fix[0]}</button>` : ''}</div>`;
    }).join('');
    const bad = Object.values(st).filter((r) => r.ok === false).length;
    setMsg(msg, bad ? `${bad} item(s) need attention. Use the buttons, then check again.` : 'Everything is ready.', !bad);
  } catch (e) { setMsg(msg, e.message, false); }
}
$('bridgeCheck').addEventListener('click', bridgeCheck);
$('bridgeStop').addEventListener('click', async () => {
  try { await bridgeCall('/shutdown', 'POST'); sessionVersion++; paintSessions(null, 'Bridge stopped'); setMsg($('bridgeMsg'), 'Bridge stopped. It starts again by itself when a summary needs it, or press Start bridge.', true); $('bridgeList').innerHTML = ''; } catch (e) { setMsg($('bridgeMsg'), /fetch/i.test(e.message) ? 'The bridge is not running.' : e.message, false); }
});
async function bridgeAction(e) {
  const what = e.target.dataset.fix;
  if (!what) return;
  const row = e.target.closest('[data-session]');
  if (row) row.dataset.signingIn = 'true';
  for (const button of row?.querySelectorAll('button') || [e.target]) button.disabled = true;
  setMsg($('bridgeMsg'), what === 'login-codex-profile'
    ? 'Enter the code shown in the terminal in the Chrome window opened by the bridge.'
    : what.startsWith('login') ? 'Complete the sign-in in the window that opens.' : 'Working, this can take a minute...');
  try { const r = await bridgeCall(`/setup/${what}`, 'POST'); setMsg($('bridgeMsg'), r.detail || r.error?.message || 'Done', r.ok); if (!what.startsWith('login')) await bridgeCheck(); } catch (err) { setMsg($('bridgeMsg'), err.message, false); }
  if (row) {
    sessionVersion++;
    if (sessionCheck) await sessionCheck.catch(() => {});
    delete row.dataset.signingIn;
    await refreshSessions().catch(() => {});
  } else e.target.disabled = false;
}
$('bridgeList').addEventListener('click', bridgeAction);
$('bridgeLogins').addEventListener('click', bridgeAction);
$('bridgeStart').addEventListener('click', async () => {
  setMsg($('bridgeMsg'), 'Starting the bridge...');
  // Native Messaging: Chrome starts the small host registered by bridge/setup.mjs, which starts the bridge and returns its token.
  let r;
  try { r = await chrome.runtime.sendNativeMessage('com.lecturehelper.bridge', { cmd: 'start' }); } catch (e) { r = { ok: false, error: e.message }; }
  if (!r?.ok) {
    const missing = /not found|forbidden|specified native/i.test(r?.error || '');
    return setMsg($('bridgeMsg'), missing ? 'One-time step: run bridge/Start-Bridge.cmd once (it installs what is missing and enables this button), then reload the extension and try again.' : `Could not start the bridge: ${r?.error || 'no answer'}`, false);
  }
  await autoToken();
  return bridgeCheck();
});

// ---------- sites ----------
function drawSites() {
  $('sites').innerHTML = S.sites.map((h) => `<div class="site"><span>${esc(h)}</span><button type="button" data-h="${esc(h)}">Remove</button></div>`).join('') || '<div class="hint">No sites enabled.</div>';
}
$('sites').addEventListener('click', (e) => {
  if (e.target.dataset.h) { S.sites = S.sites.filter((h) => h !== e.target.dataset.h); drawSites(); save(); }
});
$('addSite').addEventListener('click', () => {
  const h = $('newSite').value.trim().replace(/^https?:\/\//, '').replace(/\/.*$/, '').toLowerCase();
  if (h && !S.sites.includes(h)) S.sites.push(h);
  $('newSite').value = '';
  drawSites();
  save();
});

// ---------- load / save ----------
async function load() {
  S = await loadSettings();
  S.sites = [...S.sites];
  $('preset').innerHTML = PRESETS.map((p, i) => `<option value="${i}">${esc(p.name)}</option>`).join('');
  drawProviders();
  $('engine').value = S.engine;
  showEngine();
  $('downloadFirst').checked = S.downloadFirst !== false;
  $('useVision').checked = S.useVision;
  for (const id of ['sceneThreshold', 'sampleSeconds', 'ocrMinWords', 'chunkMinutes', 'shortVideoMinutes', 'writerImages', 'trimTokens', 'screenImages', 'maxRequestMB', 'screenKeepPerHour', 'asrModel', 'asrLanguage', 'listenSpeed', 'downloadMaxHours']) $(id).value = S[id];
  $('mediaResolution').value = S.mediaResolution;
  $('detail').value = S.detail;
  $('webSearch').checked = S.webSearch !== false;
  $('writeFullTranscript').checked = S.writeFullTranscript !== false;
  $('practiceQuestions').checked = S.practiceQuestions !== false;
  $('researchReferences').checked = S.researchReferences !== false;
  $('debugDump').checked = S.debugDump !== false;
  $('maxFrames').value = S.maxFrames;
  $('maxWidth').value = S.maxWidth;
  $('deleteAfter').checked = S.deleteAfter;
  $('enabled').checked = S.enabled;
  drawSites();
  savedSnapshot = readForm();
  await showCache();
  await showFileHint();
  await autoToken();
  refreshSessions().catch(() => {});
}

const refreshVisibleSessions = () => {
  if (!document.hidden && S && !$('bridgeLogins').querySelector('[data-signing-in]')) refreshSessions().catch(() => {});
};
document.addEventListener('visibilitychange', refreshVisibleSessions);
setInterval(refreshVisibleSessions, 45000);

/** One-time hint, only when a saved lecture exists and file access is off; hidden after the button is used. */
async function showFileHint() {
  const { downloads = {}, fileHintSeen } = await chrome.storage.local.get({ downloads: {}, fileHintSeen: false });
  const allowed = await chrome.extension.isAllowedFileSchemeAccess();
  $('fileHint').hidden = allowed || fileHintSeen || !Object.keys(downloads).length;
}
$('openExt').addEventListener('click', () => {
  chrome.storage.local.set({ fileHintSeen: true });
  chrome.tabs.create({ url: `chrome://extensions/?id=${chrome.runtime.id}` });
});

function readForm() {
  const clamp = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Math.round(Number(v)) || d));
  const modelSettings = Object.fromEntries(SLOTS.map(slot => [slot.k, { ...S[slot.k] }]));
  const cheapPool = S.cheapPool.filter(row => row.model).map(row => ({ ...row }));
  const engine = $('engine').value;
  const num = (id, lo, hi, d) => Math.min(hi, Math.max(lo, Number($(id).value) || d));
  return {
    providers: S.providers.map((p) => ({ ...p, baseUrl: (p.baseUrl || '').replace(/\/+$/, '') })),
    engine, ...modelSettings, cheapPool,
    useVision: $('useVision').checked,
    downloadFirst: $('downloadFirst').checked,
    downloadMaxHours: num('downloadMaxHours', 0, 48, 3),
    sceneThreshold: num('sceneThreshold', 0.005, 0.9, 0.05),
    sampleSeconds: num('sampleSeconds', 1, 60, 2),
    ocrMinWords: clamp($('ocrMinWords').value, 0, 200, 12),
    chunkMinutes: num('chunkMinutes', 5, 30, 12),
    shortVideoMinutes: num('shortVideoMinutes', 0, 240, 60),
    writerImages: Math.min(20, Math.max(0, Math.round(Number($('writerImages').value)))) || 0,
    writeFullTranscript: $('writeFullTranscript').checked,
    practiceQuestions: $('practiceQuestions').checked,
    researchReferences: $('researchReferences').checked,
    screenImages: clamp($('screenImages').value, 50, 3000, 3000),
    maxRequestMB: clamp($('maxRequestMB').value, 0, 200, 0),
    screenKeepPerHour: clamp($('screenKeepPerHour').value, 10, 600, 250),
    trimTokens: Math.max(0, Math.round(Number($('trimTokens').value) || 0)),
    debugDump: $('debugDump').checked,
    listenSpeed: num('listenSpeed', 1, 3, 2),
    asrModel: $('asrModel').value,
    asrLanguage: $('asrLanguage').value.trim().toLowerCase() || 'en',
    thinkingLevel: $('thinkingLevel').value,
    mediaResolution: $('mediaResolution').value,
    detail: $('detail').value,
    webSearch: $('webSearch').checked,
    maxFrames: clamp($('maxFrames').value, 1, 60, 10),
    maxWidth: clamp($('maxWidth').value, 480, 3840, 1600),
    deleteAfter: $('deleteAfter').checked,
    enabled: $('enabled').checked,
    sites: [...S.sites]
  };
}

function save(manual = false) {
  if (!savedSnapshot) return;
  clearTimeout(timers.get('persist'));
  const next = readForm();
  saveChain = saveChain.then(async () => {
    const patch = Object.fromEntries(Object.entries(next).filter(([key, value]) => JSON.stringify(value) !== JSON.stringify(savedSnapshot[key])));
    if (Object.keys(patch).length) await saveSettings(patch);
    savedSnapshot = next;
    setMsg($('saveMsg'), manual ? 'Saved' : 'Saved automatically', true);
  }).catch(error => setMsg($('saveMsg'), `Could not save settings: ${error.message}`, false));
  return saveChain;
}

const settingsControl = target => target.matches('input[id], select[id]') && !target.closest('#bridgeBox') && !['preset', 'newSite'].includes(target.id);
document.addEventListener('input', event => { if (savedSnapshot && settingsControl(event.target)) persistSoon(); });
document.addEventListener('change', event => { if (settingsControl(event.target)) save(); });
addEventListener('pagehide', () => { if (timers.get('persist')) save(); });

async function showCache() {
  const count = await countResults().catch(() => 0);
  const est = await navigator.storage?.estimate?.().catch(() => null);
  const size = est?.usage ? ` · about ${(est.usage / 1024 / 1024).toFixed(1)} MB used` : '';
  $('cacheInfo').textContent = `${count} lecture${count === 1 ? '' : 's'} saved${size}.`;
}

$('library').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('library.html') }));
$('save').addEventListener('click', () => save(true));
$('clear').addEventListener('click', async () => {
  if (!confirm('Delete all saved summaries and images?')) return;
  await clearAll();
  setMsg($('clearMsg'), 'Cleared', true);
  await showCache();
});

load();
