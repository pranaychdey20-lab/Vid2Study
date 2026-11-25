/**
 * Settings model (ES module): AI providers (each with its own API key), which provider/model does
 * what, and output options. Works with plain objects so it can be unit-tested; the load/save
 * helpers need chrome.storage (not available in the offscreen page, which gets settings in the job).
 */
import { MODELS } from './common.js';

export const GEMINI_BASE = 'https://generativelanguage.googleapis.com';
export const BRIDGE_BASE = 'http://127.0.0.1:8787';

/** Provider types. Only 'gemini' can take a video; the others do the text stages. */
export const PROVIDER_TYPES = {
  gemini: { label: 'Gemini', base: GEMINI_BASE },
  openai: { label: 'OpenAI-compatible', base: 'https://api.openai.com/v1' },
  anthropic: { label: 'Anthropic', base: 'https://api.anthropic.com' },
  // Served by the local bridge (bridge/server.mjs). The "API key" is the bridge token (bridge/token.txt).
  claudecli: { label: 'Claude CLI (subscription, via bridge)', base: BRIDGE_BASE },
  codexcli: { label: 'ChatGPT (Codex CLI, via bridge)', base: BRIDGE_BASE },
  geminiweb: { label: 'Gemini web (headless, via bridge)', base: BRIDGE_BASE },
};

/** Provider types answered by the local bridge instead of a cloud API. */
export const BRIDGE_TYPES = ['claudecli', 'codexcli', 'geminiweb'];
export const isBridge = (p) => BRIDGE_TYPES.includes(p?.type);

/** Models offered for the bridge backends (the CLI also accepts full model ids; Gemini web: <model>-<thinking level>). */
export const BRIDGE_MODELS = {
  // "<model>:<effort>" sets the reasoning effort (low, medium, high, xhigh, max); a bare name uses the CLI default
  claudecli: ['haiku', 'sonnet', 'opus'].flatMap((m) => [m, ...['low', 'medium', 'high', 'xhigh', 'max'].map((e) => `${m}:${e}`)]),
  codexcli: ['default', 'gpt-6.2-sol', 'gpt-6.2-astra', 'gpt-6.1-sol', 'gpt-6-luna'].flatMap((m) => {
    const levels = ['low', 'medium', 'high', 'xhigh', 'max'];
    if (m !== 'default' && m !== 'gpt-6-luna') levels.push('ultra');
    return [m, ...levels.map((e) => `${m}:${e}`)];
  }),
  geminiweb: ['auto', 'hydrogen-low', 'hydrogen-medium', 'hydrogen-high', 'neon-low', 'neon-medium', 'neon-high']
};

export function providerModelIds(provider) {
  if (provider?.models?.length) return provider.models;
  return provider?.type === 'gemini' ? MODELS.map(model => model.id) : BRIDGE_MODELS[provider?.type] || [];
}

/** Repair old settings that carried a known model into a different provider's list. */
function removeForeignModel(ref, providers) {
  if (!ref.model || ref.custom) return ref;
  const provider = providers.find(item => item.id === ref.provider);
  const own = providerModelIds(provider);
  if (own.includes(ref.model)) return ref;
  const geminiWebAlias = provider?.type !== 'geminiweb' && /^(?:hydrogen|neon|carbon)[-:](?:low|medium|high)$/i.test(ref.model);
  const listedElsewhere = own.length && providers.some(item => item !== provider && providerModelIds(item).includes(ref.model));
  return geminiWebAlias || listedElsewhere ? { provider: ref.provider, model: '' } : ref;
}

/** Quick-fill choices for "Add provider". */
export const PRESETS = [
  { name: 'Auto-detect from the key', type: 'openai', base: '', auto: true },
  { name: 'Gemini', type: 'gemini', base: GEMINI_BASE },
  { name: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1' },
  { name: 'Anthropic', type: 'anthropic', base: 'https://api.anthropic.com' },
  { name: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1' },
  { name: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1' },
  { name: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com' },
  { name: 'Mistral', type: 'openai', base: 'https://api.mistral.ai/v1' },
  { name: 'Together', type: 'openai', base: 'https://api.together.xyz/v1' },
  { name: 'Claude CLI (subscription)', type: 'claudecli', base: BRIDGE_BASE },
  { name: 'ChatGPT (Codex CLI)', type: 'codexcli', base: BRIDGE_BASE },
  { name: 'Gemini web (headless)', type: 'geminiweb', base: BRIDGE_BASE },
  { name: 'Ollama (local)', type: 'openai', base: 'http://localhost:11434/v1' },
  { name: 'Custom (OpenAI-compatible)', type: 'openai', base: '' }
];

/**
 * Services whose API keys can be recognised by their prefix. Used to fill in the URL and the name
 * after a key is pasted. Keys are only ever sent to services whose prefix matches, never to all of them.
 */
export const KNOWN_SERVICES = [
  { name: 'Gemini', type: 'gemini', base: GEMINI_BASE, prefix: /^AIza/ },
  { name: 'Anthropic', type: 'anthropic', base: 'https://api.anthropic.com', prefix: /^sk-ant-/ },
  { name: 'Groq', type: 'openai', base: 'https://api.groq.com/openai/v1', prefix: /^gsk_/ },
  { name: 'OpenRouter', type: 'openai', base: 'https://openrouter.ai/api/v1', prefix: /^sk-or-/ },
  { name: 'xAI', type: 'openai', base: 'https://api.x.ai/v1', prefix: /^xai-/ },
  { name: 'NVIDIA', type: 'openai', base: 'https://integrate.api.nvidia.com/v1', prefix: /^nvapi-/ },
  { name: 'Cerebras', type: 'openai', base: 'https://api.cerebras.ai/v1', prefix: /^csk-/ },
  { name: 'Fireworks', type: 'openai', base: 'https://api.fireworks.ai/inference/v1', prefix: /^fw_/ },
  // "sk-" is shared: the matching ones are tried in this order
  { name: 'OpenAI', type: 'openai', base: 'https://api.openai.com/v1', prefix: /^sk-(?!ant-|or-)/ },
  { name: 'DeepSeek', type: 'openai', base: 'https://api.deepseek.com', prefix: /^sk-(?!ant-|or-)/ },
  { name: 'Qwen (DashScope)', type: 'openai', base: 'https://dashscope-intl.aliyuncs.com/compatible-mode/v1', prefix: /^sk-(?!ant-|or-)/ },
  { name: 'Moonshot (Kimi)', type: 'openai', base: 'https://api.moonshot.ai/v1', prefix: /^sk-(?!ant-|or-)/ }
];

export const DEFAULT_SITES = ['elearn.iitg.ac.in', 'www.youtube.com'];

export const SETTING_DEFAULTS = {
  providers: [],
  // 'local' = transcript + slide-change scan + OCR done in the browser, AI only writes notes (default).
  // 'gemini' = legacy: Gemini watches the whole video (uses `video` + `notes` below).
  engine: 'local',
  // Three model slots for the local engine. Any provider/model can fill any slot, the same one in several.
  cheap: { provider: '', model: '' }, // per-chunk bullet notes for long videos (empty = use `strong`)
  strong: { provider: '', model: '' }, // writes the final notes; does the whole job for short videos
  vision: { provider: '', model: '' }, // screens and describes the video's frames (empty = use `cheap`, which is `strong` when empty)
  cheapPool: [], // more Cheap AIs [{provider, model}], tried in this order when the one before fails (as many as you like)
  practice: { provider: '', model: '' },
  strongFallback: { provider: '', model: '' }, // the Strong AI's one fallback (two Strong AIs at most)
  digest: { provider: '', model: '' }, // the Transcript AI (always used): brief summary + detailed timeline of the transcript for the vision calls, and the video type, from the transcript and up to 6 frames. Empty = the Cheap AI pool
  stt: { provider: '', model: '' }, // optional cloud speech-to-text (OpenAI-compatible /audio/transcriptions); empty = Whisper on this computer
  useVision: true,
  sceneThreshold: 0.05, // fraction of the picture that must change to count as a new slide
  sampleSeconds: 2,
  maxScenes: 600,
  maxVision: 60, // most frames sent to the vision model per lecture
  chunkMinutes: 12,
  shortVideoMinutes: 60, // up to this length the strong model does everything in one pass
  writeFullTranscript: true, // longer videos: the strong model reads the FULL transcript in 2-3 parts (no cheap summaries in between)
  scanRefine: 2, // the scan reads every 2nd sample and fills in the rest only where the picture changed (1 = read every sample)
  researchReferences: true, // list extracted lecture sources and on-screen quotes in a separate References section
  practiceQuestions: true, // add hard exam / interview questions with worked answers for every topic
  writerImages: 10, // frames sent to the Strong AI as pictures with each write call (0 = descriptions only; Gemini web: 10 at most)
  screenImages: 3000, // most frames in one screening call of the vision AI (more frames = more calls; it also splits at ~17 MB of pictures per request)
  screenInPerHour: 300, // the CODE screening sends the screening AI at most this many frames per hour of video (distinct, needing vision, spread over the video)
  maxRequestMB: 0, // most MB of pictures in one vision request; 0 = automatic (Gemini ~85, other services ~17)
  screenKeepPerHour: 250, // the screening call keeps at most this many frames per hour of video (the model may keep fewer)
  trimTokens: 40000, // speech longer than this (about 3 h) is also tightened by the cheap model, losslessly (0 = never)
  debugDump: true, // TEMP DEBUG: save a full plain-text dump of every step with each result (remove after testing)
  ocrMinWords: 12, // fewer words than this on a frame = probably a diagram: ask the vision model
  asrModel: 'base', // tiny | base | small
  asrLanguage: 'en', // 'auto' = detect the spoken language (uses the multilingual model)
  listenSpeed: 2, // YouTube without captions: the page player is played this fast, muted, to hear it
  downloadFirst: true, // YouTube: download the audio + video streams first, then process at CPU speed (falls back to listening)
  downloadMaxHours: 3, // longer YouTube videos skip the download and are heard + scanned through the page player (0 = no limit)
  video: { provider: '', model: '' },
  notes: { provider: '', model: '' },
  detail: 'standard', // brief | standard | deep
  webSearch: true,
  maxFrames: 10, // most figures in the notes (and the PDF), per hour of lecture: a cap, not a target
  maxWidth: 1600,
  deleteAfter: true,
  mediaResolution: 'MEDIA_RESOLUTION_LOW',
  thinkingLevel: '',
  sites: DEFAULT_SITES,
  enabled: true,
  // legacy single-key settings (v1/v2), migrated into `providers` on load
  apiKey: '',
  model: '',
  apiBase: ''
};

/**
 * Fill defaults and migrate the legacy apiKey/model/apiBase fields into a Gemini provider.
 * @param {object} raw whatever chrome.storage.local returned
 * @returns {object} settings with `providers`, `video` and `notes` always set
 */
export function normalizeSettings(raw = {}) {
  const s = { ...SETTING_DEFAULTS };
  for (const k of Object.keys(SETTING_DEFAULTS)) if (raw[k] !== undefined) s[k] = raw[k]; // ignore unrelated storage keys
  s.providers = (Array.isArray(s.providers) ? s.providers : []).filter(p => Object.hasOwn(PROVIDER_TYPES, p?.type)).map((p) => ({ models: [], ...p }));
  if (!s.providers.length && (s.apiKey || s.model)) {
    s.providers.push({ id: 'gemini', name: 'Gemini', type: 'gemini', baseUrl: s.apiBase || GEMINI_BASE, apiKey: s.apiKey, models: [] });
  }
  if (!s.providers.length) s.providers.push({ id: 'gemini', name: 'Gemini', type: 'gemini', baseUrl: GEMINI_BASE, apiKey: '', models: [] });
  const firstGemini = s.providers.find((p) => p.type === 'gemini');
  const videoProvider = s.providers.find(p => p.id === s.video?.provider && p.type === 'gemini');
  s.video = videoProvider ? { model: s.model || 'gemini-2.5-flash', ...s.video }
    : { provider: firstGemini?.id || '', model: firstGemini ? s.model || 'gemini-2.5-flash' : '' };
  const notesProvider = s.providers.find(p => p.id === s.notes?.provider);
  const defaultNotesProvider = notesProvider || firstGemini || s.providers[0];
  s.notes = {
    provider: defaultNotesProvider.id,
    model: defaultNotesProvider.models?.[0] || (defaultNotesProvider.type === 'gemini' ? 'gemini-2.5-flash' : ''),
    ...(notesProvider ? s.notes : {})
  };
  // Local-engine slots. `strong` inherits the old "notes" choice; empty cheap/vision fall back to strong at use time.
  const known = (id) => s.providers.some((p) => p.id === id);
  s.strong = { ...s.strong };
  if (!known(s.strong.provider)) s.strong = { ...s.notes };
  s.cheapPool = (Array.isArray(s.cheapPool) ? s.cheapPool : []).filter(r => r && known(r.provider))
    .map(r => removeForeignModel({ provider: r.provider, model: String(r.model || '').trim(), ...(r.custom === true ? { custom: true } : {}) }, s.providers))
    .filter(r => r.model).slice(0, 20);
  if (!s.digest?.provider && raw.classify?.provider) s.digest = { ...raw.classify }; // migration: the old Video type AI became the Transcript AI
  for (const slot of ['cheap', 'vision', 'stt', 'digest', 'strongFallback', 'practice']) {
    s[slot] = { ...s[slot] };
    if (!known(s[slot].provider)) s[slot] = { provider: '', model: '' };
  }
  for (const slot of ['video', 'notes', 'strong', 'cheap', 'vision', 'stt', 'digest', 'strongFallback', 'practice']) {
    s[slot] = removeForeignModel(s[slot], s.providers);
  }
  if (s.engine !== 'gemini') s.engine = 'local';
  const num = (v, lo, hi, d) => Math.min(hi, Math.max(lo, Number.isFinite(Number(v)) ? Number(v) : d));
  s.sceneThreshold = num(s.sceneThreshold, 0.005, 0.9, 0.05);
  s.sampleSeconds = num(s.sampleSeconds, 1, 60, 2);
  s.maxScenes = Math.round(num(s.maxScenes, 10, 3000, 600));
  s.maxVision = Math.round(num(s.maxVision, 0, 300, 60));
  s.chunkMinutes = num(s.chunkMinutes, 5, 30, 12);
  s.shortVideoMinutes = num(s.shortVideoMinutes, 0, 240, 60);
  s.writeFullTranscript = s.writeFullTranscript !== false;
  s.scanRefine = Math.round(num(s.scanRefine, 1, 3, 2));
  s.researchReferences = s.researchReferences !== false;
  s.practiceQuestions = s.practiceQuestions !== false;
  s.writerImages = Math.round(num(s.writerImages, 0, 20, 10));
  s.screenImages = Math.round(num(s.screenImages, 50, 3000, 3000));
  s.screenInPerHour = Math.round(num(s.screenInPerHour, 20, 1500, 300));
  s.maxRequestMB = Math.round(num(s.maxRequestMB, 0, 200, 0));
  s.screenKeepPerHour = Math.round(num(s.screenKeepPerHour, 10, 600, 250));
  s.trimTokens = Math.round(num(s.trimTokens, 0, 1000000, 40000));
  s.debugDump = s.debugDump !== false;
  s.ocrMinWords = Math.round(num(s.ocrMinWords, 0, 200, 12));
  if (!['tiny', 'base', 'small'].includes(s.asrModel)) s.asrModel = 'base';
  s.listenSpeed = num(s.listenSpeed, 1, 4, 2);
  s.downloadFirst = s.downloadFirst !== false;
  s.downloadMaxHours = num(s.downloadMaxHours, 0, 48, 3);
  s.webSearch = s.webSearch !== false;
  if (!s.figuresV2) { if (Number(s.maxFrames) === 30) s.maxFrames = 10; s.figuresV2 = true; } // old default 30 -> 10 per hour, once
  s.maxFrames = Math.round(num(s.maxFrames, 1, 60, 10));
  s.asrLanguage = String(s.asrLanguage || 'en').toLowerCase().slice(0, 12);
  return s;
}

/** Cloud speech-to-text choice, or null when transcription stays on this computer. */
export function sttRef(settings) {
  const r = settings.stt;
  return r?.provider && r?.model ? resolveRef(settings, r) : null;
}

/**
 * Provider + model for a local-engine slot. `cheap` and `vision` fall back to `strong` when left empty.
 * @param {object} settings normalised settings
 * @param {'cheap'|'strong'|'vision'} slot
 */
export function slotRef(settings, slot) {
  const ref = settings[slot];
  const set = (r) => !!(r?.provider && r?.model);
  const tryResolve = (r) => { try { return resolveRef(settings, r); } catch { return null; } };
  // the Strong AI, plus its ONE fallback (two Strong AIs at most)
  const strongChain = () => ({ ...resolveRef(settings, settings.strong), pool: set(settings.strongFallback) ? [tryResolve(settings.strongFallback)].filter(Boolean) : [] });
  if (slot === 'strong') return strongChain();
  if (slot === 'practice') return set(ref) ? resolveRef(settings, ref) : strongChain();
  // Cheap AI = a POOL: the first model, then each fallback in order (any number). Video type, Transcript summary and
  // Vision use it too when their own slot is empty. No Cheap AI at all = the Strong AI (and its fallback).
  if (slot === 'cheap' || (['digest', 'vision'].includes(slot) && !set(ref))) {
    const chain = [settings.cheap, ...(settings.cheapPool || [])].filter(set);
    if (!chain.length) return strongChain();
    const first = resolveRef(settings, chain[0]);
    return { ...first, pool: chain.slice(1).map(tryResolve).filter(Boolean) };
  }
  if (!set(ref)) return strongChain();
  return { ...resolveRef(settings, ref), pool: [] };
}

/**
 * Look up the provider and model behind a { provider, model } reference.
 * @returns {{provider: object, model: string}}
 */
export function resolveRef(settings, ref) {
  const provider = settings.providers.find((p) => p.id === ref?.provider);
  if (!provider) throw new Error('No AI provider selected. Pick one in Options.');
  if (!ref.model) throw new Error(`No model chosen for ${provider.name}. Pick one in Options.`);
  return { provider, model: ref.model };
}

/**
 * Plain-language problem with the settings for a job mode, or null when ready.
 * @param {object} settings normalised settings
 * @param {'video'|'youtube'|'text'} mode
 */
export function settingsProblem(settings, mode) {
  const need = (ref, what) => {
    const p = settings.providers.find((x) => x.id === ref.provider);
    if (!p) return `Choose a ${what} provider in Options.`;
    if (what === 'Speech-to-text AI' && p?.type !== 'openai') return 'The Speech-to-text AI must be an OpenAI-compatible provider (Groq, OpenAI, ...).';
    if (isBridge(p)) return ref.model ? null : `Choose a ${what} model in Options.`; // the token is fetched automatically
    if (!p.apiKey && p.type !== 'openai') return `Add an API key for ${p.name} in Options.`;
    if (!p.apiKey && p.type === 'openai' && !/localhost|127\.0\.0\.1/.test(p.baseUrl)) return `Add an API key for ${p.name} in Options.`;
    if (!ref.model) return `Choose a ${what} model in Options.`;
    return null;
  };
  if (settings.engine !== 'gemini') {
    const e = need(settings.strong, 'Strong AI');
    if (e) return e;
    // cheap / vision are optional (they fall back to the strong model) but must be complete when set
    for (const r of [...(settings.cheapPool || []).map((x) => [x, 'Cheap AI (fallback)']), [settings.strongFallback, 'Strong AI (fallback)']]) {
      if (r[0]?.provider && r[0].model) { const err = need(r[0], r[1]); if (err) return err; }
    }
    for (const [slot, what] of [['cheap', 'Cheap AI'], ['vision', 'Vision AI'], ['stt', 'Speech-to-text AI'], ['digest', 'Transcript AI']]) {
      if (settings[slot]?.provider && settings[slot].model) { const err = need(settings[slot], what); if (err) return err; }
    }
    return null;
  }
  if (mode !== 'text') {
    const p = settings.providers.find((x) => x.id === settings.video.provider);
    if (p && p.type !== 'gemini') return 'Video summaries need a Gemini provider. Pick one for "Video AI" in Options, or use captions.';
    const e = need(settings.video, 'video');
    if (e) return e;
  }
  return need(settings.notes, 'notes');
}

/** Load settings from chrome.storage.local (pages and the service worker). */
export async function loadSettings() {
  const raw = await chrome.storage.local.get(null);
  const settings = normalizeSettings(raw);
  if (Array.isArray(raw.providers) && raw.providers.some(p => !Object.hasOwn(PROVIDER_TYPES, p?.type))) {
    const keys = ['providers', 'video', 'notes', 'strong', 'cheap', 'digest', 'vision', 'stt', 'strongFallback', 'cheapPool', 'practice'];
    await saveSettings(Object.fromEntries(keys.map(key => [key, settings[key]])));
  }
  return settings;
}

/** Save a partial settings object. */
export const saveSettings = (partial) => chrome.storage.local.set(partial);
