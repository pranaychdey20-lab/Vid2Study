/**
 * LLM client (ES module) for the three provider types: Gemini, OpenAI-compatible, Anthropic.
 * Text calls only here (the video upload/summary calls live in pipeline.js and reuse `gfetch`).
 * Every call returns token usage so the extension can show what a lecture cost.
 */
import { MODELS } from './common.js';
import { KNOWN_SERVICES, BRIDGE_MODELS, isBridge } from './settings.js';
import { log } from './log.js';

export const sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); reject(new DOMException('Aborted', 'AbortError')); }, { once: true });
  });

const trim = (u) => String(u || '').replace(/\/+$/, '');

/** Auth headers for a provider. The key is only ever sent in a header, never logged. */
let bridgeToken = ''; // fetched from the native host; wins over a stale saved one

/** Ask the native-messaging host (bridge/native-host.mjs) to start the bridge or hand over its token. */
export async function nativeBridge(cmd) {
  try { const r = await chrome.runtime.sendNativeMessage('com.lecturehelper.bridge', { cmd }); if (r?.token) bridgeToken = r.token; return r || { ok: false }; } catch (e) { return { ok: false, error: e.message }; }
}

export function authHeaders(p) {
  if (isBridge(p)) return { 'x-bridge-token': bridgeToken || p.apiKey || '' };
  if (p.type === 'gemini') return { 'x-goog-api-key': p.apiKey };
  if (p.type === 'anthropic') {
    return { 'x-api-key': p.apiKey, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' };
  }
  return p.apiKey ? { Authorization: `Bearer ${p.apiKey}` } : {};
}

/** Turn a failed response into a short, friendly Error. */
export async function apiError(res, p) {
  let msg = '', code;
  try {
    const j = await res.json();
    msg = j?.error?.message || j?.message || (typeof j?.error === 'string' ? j.error : '');
    code = j?.error?.code;
  } catch { /* not JSON */ }
  const who = p?.name || 'The AI service';
  const retryAfter = res.headers.get('retry-after');
  const err = (text) => Object.assign(new Error(text), { status: res.status, apiMessage: msg, code });
  if (code === 'GEMINI_LOGIN_REQUIRED' && msg) return err(msg);
  switch (res.status) {
    case 400: return err(`${who} rejected the request (400): ${msg || 'bad request'}. Check the model name in Options.`);
    case 401:
    case 403: return err(`${who} refused access (${res.status}): ${msg || 'invalid API key or missing permission'}.`);
    case 404: return err(`Not found (404): ${msg || 'check the model name or URL in Options'}.`);
    case 413: return err(`The request is too large for ${who} (413).`);
    case 429: return err(`Rate limited by ${who}${retryAfter ? `, retry in ${retryAfter}s` : ''}. ${msg} Try again later.`);
    default: return err(`${who} error ${res.status}: ${msg || res.statusText}`);
  }
}

/**
 * fetch() with provider auth, retries (429/5xx/network) and friendly errors.
 * With `keep400`, a 400 response is returned so the caller can adapt its parameters.
 * @returns {Promise<Response>}
 */
export async function gfetch(url, opts, p, signal, onWait, { keep400 = false, retries = 3 } = {}) {
  const model = modelOf(opts, url);
  const who = `${p.name || 'the AI service'}${model ? ` (model ${model})` : ''}`;
  let healed = false; // bridge: start it / refresh its token once, automatically
  if (isBridge(p) && !bridgeToken && !p.apiKey) healed = (await nativeBridge('start')).ok;
  for (let attempt = 0; ; attempt++) {
    let res;
    try {
      res = await fetch(url, { ...opts, signal, headers: { ...(opts.headers || {}), ...authHeaders(p) } });
    } catch (e) {
      if (signal?.aborted) throw e;
      if (isBridge(p) && !healed) { healed = true; if ((await nativeBridge('start')).ok) { attempt--; continue; } } // bridge was not running
      if (attempt < retries) {
        log.alert('llm', `Network error talking to ${who}; retry ${attempt + 1}/${retries}`, { error: e.message });
        await sleep(2 ** attempt * 1500, signal);
        continue;
      }
      const hint = isBridge(p) ? ' Is the bridge running? Start it with "npm start" in the extension\'s bridge folder.' : '';
      const err = Object.assign(new Error(`Network error talking to ${p.name || 'the AI service'}: ${e.message}.${hint}`), { status: 0 });
      log.error('llm', `${who} unreachable after ${attempt + 1} attempt(s): ${e.message}`);
      throw err;
    }
    if (res.ok || (keep400 && res.status === 400)) return res;
    const authError = res.status === 401 && isBridge(p) ? await apiError(res, p) : null;
    if (authError && authError.code !== 'GEMINI_LOGIN_REQUIRED' && !healed) {
      healed = true;
      if ((await nativeBridge('token')).ok) { attempt--; continue; }
    }
    if ((res.status === 429 || res.status >= 500) && attempt < retries && !(isBridge(p) && res.status === 504)) {
      const ra = Number(res.headers.get('retry-after'));
      const wait = ra > 0 ? ra * 1000 : 2 ** attempt * 3000;
      const why = res.status === 429 ? 'rate limit reached' : `server error ${res.status}`;
      log.alert('llm', `${who}: ${why}; waiting ${Math.round(wait / 1000)} s, retry ${attempt + 1}/${retries}`, { status: res.status, retry_after_s: ra || undefined });
      onWait?.(res.status === 429 ? `Rate limited, retrying in ${Math.round(wait / 1000)}s...` : `AI error ${res.status}, retrying...`);
      await sleep(wait, signal);
      continue;
    }
    const err = authError || await apiError(res, p);
    log.error('llm', `${who} failed after ${attempt + 1} attempt(s), status ${res.status}: ${err.message}`);
    throw err;
  }
}

/** Let the user sign into the bridge's own Chrome profile and verify that the session works. */
export async function signInGemini(p) {
  const res = await gfetch(`${trim(p.baseUrl)}/setup/login-gemini`, { method: 'POST' },
    p, AbortSignal.timeout(600000), null, { retries: 0 });
  const result = await res.json();
  if (!result.ok) throw new Error(result.detail || 'Gemini sign-in could not be verified.');
  return result.detail;
}

/** The model name for a request (from the JSON body, or the Gemini URL), for log lines only. */
function modelOf(opts, url) {
  try {
    if (typeof opts?.body === 'string') { const m = JSON.parse(opts.body).model; if (m) return m; }
    return decodeURIComponent((/models\/([^:/?]+)/.exec(String(url)) || [])[1] || '') || null;
  } catch { return null; }
}

/**
 * Fetch the model list for a provider (used right after the key/URL are pasted).
 * @returns {Promise<string[]>} model ids, sorted
 */
export async function listModels(p, signal) {
  const base = trim(p.baseUrl);
  if (isBridge(p)) { // proves the bridge is up and the token is right; the model names are fixed
    const health = await gfetch(`${base}/health`, { method: 'GET' }, p, signal, null, { retries: 0 });
    if (p.type === 'codexcli' && !(await health.json()).backends?.['codex-cli']) {
      throw new Error('Codex CLI is unavailable. Restart the bridge and use Check setup in Options.');
    }
    if (p.type === 'langdock') { // the workspace decides which models exist
      const r = await gfetch(`${base}/models/langdock`, { method: 'GET' }, p, signal, null, { retries: 0 });
      // "<model>:<effort>" for every reasoning effort the workspace allows for that model
      return (await r.json()).models.flatMap((m) => [m.name, ...(m.efforts || []).map((e) => `${m.name}:${e}`)]);
    }
    return [...BRIDGE_MODELS[p.type]];
  }
  let url;
  if (p.type === 'gemini') url = `${base}/v1beta/models?pageSize=200`;
  else if (p.type === 'anthropic') url = `${base}/v1/models?limit=100`;
  else url = `${base}/models`;
  const res = await gfetch(url, { method: 'GET' }, p, signal, null, { retries: 0 });
  const data = await res.json();
  let ids;
  if (p.type === 'gemini') {
    ids = (data.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name).replace(/^models\//, ''));
  } else {
    // Drop models that cannot chat (speech, embeddings, moderation, retired ones).
    ids = (data.data || data.models || [])
      .filter((m) => m.active !== false)
      .map((m) => m.id || m.name)
      .filter((id) => id && !/whisper|tts|speech|embed|guard|moderation|dall-e|rerank|playai|transcribe/i.test(id));
  }
  return [...new Set(ids)].sort();
}

/** Gemini thinking config for a model id. Text stages ask for the least thinking (saves tokens). */
export function thinkingFor(modelId, level, { minimal = false } = {}) {
  // Gemini 2.5 can switch thinking off (Flash) or down to its floor (Pro): the cheapest option for text stages.
  if (minimal && /^gemini-2\.5/.test(modelId)) return { thinkingBudget: /pro/.test(modelId) ? 128 : 0 };
  const known = MODELS.find((m) => m.id === modelId);
  let lv = level;
  if (minimal) lv = known ? (known.levels.includes('minimal') ? 'minimal' : 'low') : 'low';
  else if (!lv || (known && !known.levels.includes(lv))) lv = known?.level || 'medium';
  if (/^gemini-2\.5/.test(modelId)) {
    const budget = { minimal: 0, low: 1024, medium: 8192, high: 24576 }[lv] ?? 8192;
    return { thinkingBudget: /pro/.test(modelId) ? Math.max(budget, 128) : budget };
  }
  if (/^gemini-[3-9]/.test(modelId)) return { thinkingLevel: lv };
  return undefined;
}

/** Pull the first JSON value out of a model reply (handles code fences and chatter). */
export function parseJsonLoose(text) {
  let t = String(text || '').trim();
  const fence = /```(?:json)?\s*([\s\S]*?)```/i.exec(t);
  if (fence) t = fence[1].trim();
  try { return JSON.parse(t); } catch { /* look for the outermost braces */ }
  const a = t.indexOf('{'), b = t.lastIndexOf('}');
  if (a >= 0 && b > a) return JSON.parse(t.slice(a, b + 1));
  throw new Error('The AI did not return valid JSON.');
}

/**
 * One text-in, text-out call on any provider.
 * @param {object} p provider  @param {string} model
 * @param {{prompt:string, system?:string, json?:object|boolean, maxTokens?:number, temperature?:number,
 *          level?:string, signal?:AbortSignal, onWait?:Function}} o
 *   `json`: pass a Gemini response schema (or true) to ask for JSON output.
 * @returns {Promise<{text:string, usage:{in:number,out:number}}>}
 */
export async function generate(p, model, { prompt, system, json, maxTokens = 2048, temperature = 0.4, level, signal, onWait, images = [], thinking: wantThinking = false, retries = 3, search = false, session }) {
  const opts = { prompt, system, json, maxTokens, temperature, level, signal, onWait, images, thinking: wantThinking, retries, session };
  if (search && !json && searchTool(p, model)) {
    // Web search lets the writer check facts and add context. Not every model accepts it: retry plainly.
    try { return await generateOnce(p, model, { ...opts, search: true }); } catch (e) {
      if (e?.name === 'AbortError' || signal?.aborted) throw e;
      console.warn('[Vid2Study] web search not accepted, retrying without:', e?.message);
    }
  }
  const r = await generateOnce(p, model, opts);
  if (r.truncated) log.alert('llm', `${model} stopped at its output limit (${opts.maxTokens} tokens); the reply is cut short`, { provider: p.name });
  return r;
}

/**
 * How this provider + model searches the web, or null. Gemini: Google Search grounding; Anthropic: the
 * server-side web_search tool; OpenRouter: its "web" plugin; Groq compound models search by themselves.
 */
export function searchTool(p, model) {
  const m = String(model || '').toLowerCase();
  if (isBridge(p)) return null; // Gemini web searches by itself; the CLI has its tools turned off
  if (p.type === 'gemini') return /gemini-(1\.5|[2-9])/.test(m) && !/image|tts|embedding/.test(m) ? 'gemini' : null;
  if (p.type === 'anthropic') return 'anthropic';
  if (/openrouter\.ai/.test(p.baseUrl || '')) return 'openrouter';
  return null;
}

async function generateOnce(p, model, { prompt, system, json, maxTokens, temperature, level, signal, onWait, images, thinking: wantThinking, retries, search, session }) {
  const base = trim(p.baseUrl);
  if (isBridge(p)) {
    // Slow, serialised backends (a browser / a CLI process): one retry at most, and no thinking-budget games.
    const lv = level && ['low', 'medium', 'high', 'xhigh', 'max'].includes(level) ? level : undefined;
    const effort = ['claudecli', 'codexcli'].includes(p.type) ? (wantThinking ? lv : undefined) : p.type === 'langdock' ? (wantThinking ? lv || 'medium' : 'low') : undefined;
    const progressId = p.type === 'geminiweb' && onWait ? crypto.randomUUID() : undefined;
    const progressAbort = new AbortController();
    let timer;
    const started = Date.now();
    const progress = async () => {
      try {
        const res = await fetch(`${base}/progress/${progressId}`, {
          headers: authHeaders(p), signal: AbortSignal.any([progressAbort.signal, AbortSignal.timeout(2000)])
        });
        const data = res.ok ? await res.json() : {};
        if (data.message && !progressAbort.signal.aborted && !signal?.aborted) {
          onWait(`${data.message} · ${Math.floor((Date.now() - started) / 1000)} s elapsed`);
        }
      } catch { /* Progress is optional and older bridges may not serve it. */ }
      finally { if (!progressAbort.signal.aborted && !signal?.aborted) timer = setTimeout(progress, 2000); }
    };
    if (progressId) {
      onWait('Sending request to the Gemini bridge');
      timer = setTimeout(progress, 1000);
    }
    try {
      const res = await gfetch(`${base}/generate`, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ backend: { claudecli: 'claude-cli', codexcli: 'codex-cli', geminiweb: 'gemini-web', langdock: 'langdock' }[p.type], model, prompt, system, images, json: !!json, effort, maxTokens, progressId, session })
      }, p, signal, onWait, { retries: Math.min(retries, 1) });
      const d = await res.json();
      return { text: d.text || '', session: d.session, truncated: !!d.truncated, usage: { in: d.usage?.in || 0, out: d.usage?.out || 0 } };
    } finally {
      progressAbort.abort();
      clearTimeout(timer);
    }
  }
  if (p.type === 'gemini') {
    const generationConfig = { temperature, maxOutputTokens: maxTokens };
    if (json) { generationConfig.responseMimeType = 'application/json'; if (typeof json === 'object') generationConfig.responseSchema = json; }
    // wantThinking: the strong writer may think a little (better structure); everything else stays minimal.
    const thinking = thinkingFor(model, level, { minimal: !wantThinking });
    if (thinking) generationConfig.thinkingConfig = thinking;
    // an image may carry a `label` ("F12 at 03:20"): it goes as a text part right BEFORE its image, so a model that gets
    // hundreds of pictures never has to count them to know which is which
    const parts = [...images.flatMap((im) => [...(im.label ? [{ text: im.label }] : []), { inline_data: { mime_type: im.mime || 'image/png', data: im.b64 } }]), { text: prompt }];
    const body = { contents: [{ role: 'user', parts }], generationConfig };
    if (system) body.systemInstruction = { parts: [{ text: system }] };
    if (search) body.tools = [{ google_search: {} }];
    const res = await gfetch(`${base}/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, p, signal, onWait, { retries });
    return readGemini(await res.json());
  }

  if (p.type === 'anthropic') {
    const content = images.length
      ? [...images.flatMap((im) => [...(im.label ? [{ type: 'text', text: im.label }] : []), { type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: im.b64 } }]), { type: 'text', text: prompt }]
      : prompt;
    const body = { model, max_tokens: maxTokens, temperature, messages: [{ role: 'user', content }] };
    if (system) body.system = system;
    if (search) body.tools = [{ type: 'web_search_20250305', name: 'web_search', max_uses: 3 }];
    const res = await gfetch(`${base}/v1/messages`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, p, signal, onWait, { retries });
    const d = await res.json();
    return { text: (d.content || []).filter((c) => c.type === 'text').map((c) => c.text || '').join(''), truncated: d.stop_reason === 'max_tokens', usage: { in: d.usage?.input_tokens || 0, out: d.usage?.output_tokens || 0 } };
  }

  // OpenAI-compatible. Servers disagree about parameter names, so adapt on a 400.
  const body = {
    model,
    messages: [...(system ? [{ role: 'system', content: system }] : []), {
      role: 'user',
      content: images.length
        ? [...images.flatMap((im) => [...(im.label ? [{ type: 'text', text: im.label }] : []), { type: 'image_url', image_url: { url: `data:${im.mime || 'image/png'};base64,${im.b64}` } }]), { type: 'text', text: prompt }]
        : prompt
    }],
    temperature,
    max_tokens: maxTokens
  };
  if (json) body.response_format = { type: 'json_object' };
  if (search) body.plugins = [{ id: 'web', max_results: 3 }];
  for (let attempt = 0; attempt < 4; attempt++) {
    const res = await gfetch(`${base}/chat/completions`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body)
    }, p, signal, onWait, { keep400: true, retries });
    if (res.ok) {
      const d = await res.json();
      return { text: d.choices?.[0]?.message?.content || '', truncated: d.choices?.[0]?.finish_reason === 'length', usage: { in: d.usage?.prompt_tokens || 0, out: d.usage?.completion_tokens || 0 } };
    }
    const err = await apiError(res, p);
    const m = err.message;
    if (/max_completion_tokens/.test(m) && body.max_tokens != null) { body.max_completion_tokens = body.max_tokens; delete body.max_tokens; continue; }
    if (/temperature/.test(m) && 'temperature' in body) { delete body.temperature; continue; }
    if (/response_format|json_object/.test(m) && body.response_format) { delete body.response_format; continue; }
    throw err;
  }
  throw new Error(`${p.name} kept rejecting the request parameters.`);
}

/** Text and usage out of a Gemini generateContent response. */
export function readGemini(data) {
  const cand = data.candidates?.[0];
  if (!cand) {
    const reason = data.promptFeedback?.blockReason;
    throw new Error(`Gemini returned no answer${reason ? ` (blocked: ${reason})` : ''}.`);
  }
  const text = (cand.content?.parts || []).filter((x) => !x.thought).map((x) => x.text || '').join('');
  const u = data.usageMetadata || {};
  return { text, finishReason: cand.finishReason, truncated: cand.finishReason === 'MAX_TOKENS', usage: { in: u.promptTokenCount || 0, out: (u.candidatesTokenCount || 0) + (u.thoughtsTokenCount || 0) } };
}

/**
 * Work out which service an API key belongs to, from its prefix, and load its models.
 * The key is sent only to services whose key format matches, so a key is never tried against
 * every provider. Returns null when the prefix is unknown (then the URL must be entered by hand).
 * @param {string} key
 * @returns {Promise<{name:string,type:string,baseUrl:string,models:string[]}|null>}
 */
export async function detectProvider(key) {
  const candidates = KNOWN_SERVICES.filter((s) => s.prefix.test(key));
  for (const s of candidates) {
    try {
      const models = await listModels({ name: s.name, type: s.type, baseUrl: s.base, apiKey: key }, AbortSignal.timeout(8000));
      return { name: s.name, type: s.type, baseUrl: s.base, models };
    } catch { /* wrong service for this key: try the next one with the same prefix */ }
  }
  return null;
}
