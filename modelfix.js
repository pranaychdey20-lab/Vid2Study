/**
 * "Model did not work" window. Opened by the service worker when an AI model fails in one stage of a summary
 * (the job is paused, its progress is saved). The user can pick another provider / model (tested first),
 * skip the stage when it is optional, or cancel the job. Saving a model resumes the job straight away.
 * Every value that comes from a provider is written with textContent, never as HTML.
 */
import { loadSettings, saveSettings } from './lib/settings.js';
import { listModels, signInGemini } from './lib/llm.js';
import { checkModel, checkVision } from './lib/modelcheck.js';
import { MODELS } from './lib/common.js';
import { adviceFor, needsGeminiSignIn } from './lib/stagefix.js';

const $ = (id) => document.getElementById(id);
const id = new URLSearchParams(location.search).get('id');
const send = (msg) => chrome.runtime.sendMessage(msg).catch((e) => ({ error: e.message }));

let S = null;       // settings
let info = null;    // what failed
let tested = null;  // the "provider|model" last tested OK or not, so a failed test can be overridden with "Continue anyway"
let busy = false;

const modelIds = (p) => (p?.models?.length ? p.models : p?.type === 'gemini' ? MODELS.map((m) => m.id) : []);
const providersFor = () => (info.slot === 'stt' ? S.providers.filter((p) => p.type === 'openai') : S.providers);
/** cheap / vision may be left empty (they then use the Strong AI); the speech slot may be empty (Whisper on this computer) */
const emptyLabel = () => (info.slot === 'stt' ? 'Whisper on this computer (no cloud)' : info.slot === 'strong' ? '' : info.slot === 'vision' || info.slot === 'digest' ? 'Same as the Cheap AI' : `Same as the Strong AI (${S.strong.model || 'not set'})`);

function say(text, ok) {
  const el = $('testMsg');
  el.textContent = text || '';
  el.className = `msg ${ok === true ? 'ok' : ok === false ? 'bad' : ''}`;
}

function fillModels() {
  const p = S.providers.find((x) => x.id === $('prov').value);
  const ids = modelIds(p);
  $('pick').innerHTML = '';
  $('pick').append(new Option(ids.length ? `Pick a model (${ids.length})` : p ? 'No models loaded: type a name or press Load models' : '', ''), ...ids.map((m) => new Option(m, m)));
  $('pick').value = ids.includes($('model').value.trim()) ? $('model').value.trim() : '';
  $('pick').disabled = !p;
  $('model').disabled = !p;
  $('load').disabled = !p;
  $('test').disabled = !p;
}

function resetTest() { tested = null; say(''); $('go').textContent = 'Save & continue'; }

async function init() {
  if (!id) return gone();
  const r = await send({ type: 'GET_PAUSE', id });
  if (!r?.item) return gone();
  info = r.item.pause;
  S = await loadSettings();

  $('vTitle').textContent = r.item.title || '(untitled)';
  $('vStage').textContent = info.label;
  $('vModel').textContent = `${info.slotLabel}: ${info.model || 'none'}${info.providerName ? ` (${info.providerName})` : ''}${info.status != null ? ` · HTTP ${info.status}` : ''}`;
  $('vReason').textContent = info.reason;
  $('vAdvice').textContent = adviceFor(info);
  $('geminiLoginRow').hidden = !needsGeminiSignIn(info) || !S.providers.some((p) => p.id === info.provider && p.type === 'geminiweb');
  $('slotNote').textContent = info.fallback
    ? `The ${info.slotLabel} is not set, so the Strong AI was used for this step. Pick the model this role should use from now on, or choose "Same as the Strong AI" and change the Strong AI instead.`
    : `This sets the ${info.slotLabel}.`;

  // provider list: the slot's own choice, plus "same as strong" / "Whisper" where that is allowed
  const list = providersFor();
  $('prov').innerHTML = '';
  if (info.slot !== 'strong') $('prov').append(new Option(emptyLabel(), ''));
  $('prov').append(...list.map((p) => new Option(`${p.name}${p.type === 'gemini' ? ' (Gemini)' : p.type === 'anthropic' ? ' (Anthropic)' : ''}`, p.id)));
  $('prov').value = list.some((p) => p.id === info.provider) ? info.provider : list[0]?.id || '';
  $('model').value = info.model || '';
  fillModels();

  if (info.skip) {
    $('skip').hidden = false;
    $('skipNote').textContent = `Skipping: ${info.skipNote}`;
  }
  $('content').hidden = false;
}

function gone() {
  $('content').hidden = true;
  $('gone').hidden = false;
  $('sub').textContent = '';
}

$('closeGone').addEventListener('click', () => window.close());
$('prov').addEventListener('change', () => { $('model').value = ''; fillModels(); resetTest(); });
$('pick').addEventListener('change', (e) => { if (e.target.value) { $('model').value = e.target.value; resetTest(); } });
$('model').addEventListener('input', () => {
  const v = $('model').value.trim();
  $('pick').value = [...$('pick').options].some((o) => o.value === v) ? v : '';
  resetTest();
});

$('load').addEventListener('click', async () => {
  const p = S.providers.find((x) => x.id === $('prov').value);
  if (!p) return;
  $('load').disabled = true;
  say('Loading the model list...');
  try {
    p.models = await listModels(p);
    await saveSettings({ providers: S.providers });
    fillModels();
    say(`${p.models.length} models found.`, true);
  } catch (e) { say(`Could not load the models: ${e.message}`, false); }
  $('load').disabled = false;
});

/** Test the chosen model (a picture test for the vision role). Resolves to {ok, text}. */
async function runTest() {
  const p = S.providers.find((x) => x.id === $('prov').value);
  const model = $('model').value.trim();
  if (!p) return { ok: true, text: '' }; // "same as strong" / Whisper: nothing to test here
  if (!model) return { ok: false, text: 'Pick or type a model first.' };
  say(info.slot === 'vision' ? `Checking that ${model} can see images...` : `Checking ${model}...`);
  try { return { ok: true, text: info.slot === 'vision' ? await checkVision(p, model) : await checkModel(p, model) }; }
  catch (e) { return { ok: false, text: `Not working: ${e.message}` }; }
}

$('test').addEventListener('click', async () => {
  if (busy) return;
  busy = true; $('test').disabled = true;
  const r = await runTest();
  say(r.text, r.ok);
  tested = r.ok ? 'ok' : 'bad';
  $('test').disabled = false; busy = false;
});

$('geminiLogin').addEventListener('click', async () => {
  if (busy) return;
  const p = S.providers.find((p) => p.id === info.provider && p.type === 'geminiweb');
  if (!p) return;
  busy = true;
  $('geminiLogin').disabled = true;
  const msg = $('geminiLoginMsg');
  msg.className = 'msg';
  msg.textContent = 'Finish signing in to Google in the Chrome window, then close that window.';
  try {
    await signInGemini(p);
    msg.textContent = 'Signed in. Resuming this summary…';
    const r = await send({ type: 'RESUME_JOB', id });
    if (r?.error) throw new Error(r.error);
    window.close();
  } catch (err) {
    msg.className = 'msg bad';
    msg.textContent = err.message;
  } finally {
    busy = false;
    $('geminiLogin').disabled = false;
  }
});

$('go').addEventListener('click', async () => {
  if (busy) return;
  const providerId = $('prov').value;
  const model = $('model').value.trim();
  if (providerId && !model) return say('Pick or type a model first.', false);
  busy = true; $('go').disabled = true; $('skip').disabled = true; $('cancel').disabled = true;
  try {
    if (providerId && tested !== 'ok' && tested !== 'bad') { // test first; a failed test needs a second click to continue anyway
      const r = await runTest();
      say(r.text, r.ok);
      tested = r.ok ? 'ok' : 'bad';
      if (!r.ok) { $('go').textContent = 'Continue anyway'; return; }
    }
    await saveSettings({ [info.slot]: providerId ? { provider: providerId, model } : { provider: '', model: '' } });
    say('Saved. Resuming...', true);
    const res = await send({ type: 'RESUME_JOB', id });
    if (res?.error) { say(res.error, false); return; }
    window.close();
  } finally { busy = false; $('go').disabled = false; $('skip').disabled = false; $('cancel').disabled = false; }
});

$('skip').addEventListener('click', async () => {
  if (busy || !info?.skip) return;
  busy = true;
  const res = await send({ type: 'RESUME_JOB', id, skip: info.skip });
  busy = false;
  if (res?.error) return say(res.error, false);
  window.close();
});

$('cancel').addEventListener('click', async () => {
  if (busy) return;
  if (!confirm('Cancel this summary? The saved progress stays, so starting it again continues from here.')) return;
  await send({ type: 'CANCEL_PAUSED', id });
  window.close();
});

init().catch((e) => { gone(); $('goneText').textContent = `Could not open this window: ${e.message}`; });
