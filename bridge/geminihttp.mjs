/**
 * Gemini web over plain HTTP (no browser per call). After the one-time login the signed-in Chrome profile is opened
 * once, headless, only to export the Google cookies to gemini-session.json; every call after that is one `fetch` to the
 * web app's StreamGenerate endpoint (page tokens `at`/`bl`/`sid` come from GET /app and are cached).
 * Text only: pictures still go through the browser path (geminiweb.mjs). Undocumented: it can change without notice.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { longFetch } from './longfetch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const SESSION = join(HERE, 'gemini-session.json');
const BASE = 'https://gemini.google.com';
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/157.0.0.0 Safari/537.36';

/** Model ids of the web app's picker (Nov 2026). Override with bridge/gemini-models.json: { "hydrogen": "<id>", ... } */
const MODEL_IDS = { auto: '8c46e95b1a07cecc', hydrogen: '56fdd199312815e2', neon: 'e6fa609c3fa255c0', carbon: '95a4c0abcba24364' };
const LEVEL = { low: 1, medium: 4, high: 2 }; // the picker's thinking-level codes

export class GeminiLoginRequired extends Error {
  constructor(msg = 'Gemini web is signed out. Sign in again (Options > Check setup > Sign in to Gemini).') { super(msg); this.status = 401; }
}

let jar = null; // name -> value
let page = null; // { at, bl, sid }
let reqid = 100000 + Math.floor(Math.random() * 800000);
let modelOverride = null;

const cookieHeader = () => Object.entries(jar).map(([k, v]) => `${k}=${v}`).join('; ');

async function loadJar() {
  if (jar) return;
  try { jar = JSON.parse(await readFile(SESSION, 'utf8')); } catch { jar = null; }
}
async function saveJar() { if (jar) await writeFile(SESSION, JSON.stringify(jar), { mode: 0o600 }).catch(() => {}); }

/** Replace the jar with cookies exported from the signed-in browser profile (opens headless Chrome briefly). */
export async function refreshCookies() {
  const { exportGoogleCookies } = await import('./geminiweb.mjs');
  const list = await exportGoogleCookies();
  if (!list.length) throw new GeminiLoginRequired();
  jar = Object.fromEntries(list.map((c) => [c.name, c.value]));
  page = null;
  await saveJar();
}

function takeSetCookies(res) {
  for (const sc of res.headers.getSetCookie?.() || []) {
    const [pair] = sc.split(';');
    const i = pair.indexOf('=');
    if (i > 0) jar[pair.slice(0, i).trim()] = pair.slice(i + 1).trim();
  }
}

/** The page tokens. A signed-out cookie jar gets a page without them. */
async function bootstrap(force = false) {
  if (page && !force) return page;
  await loadJar();
  if (!jar) await refreshCookies();
  const get = async () => {
    const res = await fetch(`${BASE}/app`, { headers: { cookie: cookieHeader(), 'user-agent': UA, 'accept-language': 'en-US,en;q=0.9' } });
    takeSetCookies(res);
    const html = await res.text();
    return { at: /"SNlM0e":"([^"]+)"/.exec(html)?.[1], bl: /"cfb2h":"([^"]+)"/.exec(html)?.[1], sid: /"FdrFJe":"([^"]+)"/.exec(html)?.[1] };
  };
  let p = await get();
  if (!p.at) { await refreshCookies(); p = await get(); } // cookies rotated or expired: re-export once
  if (!p.at || !p.bl) throw new GeminiLoginRequired();
  await saveJar();
  return (page = p);
}

/** Pull the reply text out of the chunked response (the last full text wins; chunks carry the whole text so far). */
export function parseReply(t) {
  let best = null, error = null;
  for (const line of String(t).split('\n')) {
    if (!line.startsWith('[[')) continue;
    try {
      for (const row of JSON.parse(line)) {
        if (row[0] !== 'wrb.fr') continue;
        if (!row[2]) { if (row[5]) error = JSON.stringify(row[5]).slice(0, 200); continue; }
        const txt = JSON.parse(row[2])?.[4]?.[0]?.[1]?.[0];
        if (typeof txt === 'string') best = txt;
      }
    } catch { /* partial line */ }
  }
  return { text: best, error };
}

async function modelId(name) {
  if (!modelOverride) modelOverride = await readFile(join(HERE, 'gemini-models.json'), 'utf8').then(JSON.parse, () => ({}));
  const ids = { ...MODEL_IDS, ...modelOverride };
  return ids[name] || null;
}

/** "hydrogen-low" -> ["hydrogen", "low"] */
function split(id) {
  const m = /^(auto|hydrogen|neon|carbon)(?:[-:](low|medium|high))?$/i.exec(String(id || 'auto').trim());
  return m ? [m[1].toLowerCase(), (m[2] || '').toLowerCase()] : ['auto', ''];
}

const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };
const PUSH = 'https://push.clients6.google.com/upload/';

/**
 * Upload one picture with Google's resumable upload (two POSTs: start, then upload+finalize).
 * Resolves to { id, name }: the id looks like "/contrib_service/ttl_1d/..." and goes into the chat request.
 */
export async function uploadImage({ b64, mime = 'image/png' }, i = 0, signal) {
  await bootstrap();
  const bytes = Buffer.from(b64, 'base64');
  const name = `image-${i + 1}.${EXT[mime] || 'png'}`;
  const common = { cookie: cookieHeader(), origin: BASE, referer: `${BASE}/`, 'user-agent': UA, 'push-id': 'feeds/mcudyrk2a4khkz', 'x-tenant-id': 'bard-storage' };
  const start = await fetch(PUSH, {
    method: 'POST', signal,
    headers: { ...common, 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', 'x-goog-upload-protocol': 'resumable', 'x-goog-upload-command': 'start', 'x-goog-upload-header-content-length': String(bytes.length) },
    body: `File name: ${name}`
  });
  const target = start.headers.get('x-goog-upload-url') || start.headers.get('x-goog-upload-control-url');
  if (!start.ok || !target) throw Object.assign(new Error(`Gemini picture upload could not start (${start.status}).`), { status: 502 });
  const fin = await fetch(target, {
    method: 'POST', signal,
    headers: { ...common, 'x-goog-upload-command': 'upload, finalize', 'x-goog-upload-offset': '0', 'content-type': 'application/octet-stream' },
    body: bytes
  });
  const idText = (await fin.text()).trim();
  if (!fin.ok || !idText.startsWith('/')) throw Object.assign(new Error(`Gemini picture upload failed (${fin.status}).`), { status: 502 });
  return { id: idText, name };
}

/** @returns {Promise<{text:string, usage:{in:number,out:number}, truncated:boolean}>} */
export async function askGeminiHttp({ prompt, system, model, images = [], signal }) {
  const [name, level] = split(model);
  const id = await modelId(name);
  const text = system ? `${system}\n\n${prompt}` : prompt;
  const files = await Promise.all(images.map((im, i) => uploadImage(im, i, signal))); // parallel
  // [prompt, 0, null, [[[uploadId, 1], filename], ...]] is how the web app attaches pictures
  const turn = files.length ? [text, 0, null, files.map((f) => [[f.id, 1], f.name])] : [text];
  for (let attempt = 0; attempt < 2; attempt++) {
    const p = await bootstrap(attempt > 0);
    const headers = { 'content-type': 'application/x-www-form-urlencoded;charset=UTF-8', cookie: cookieHeader(), origin: BASE, referer: `${BASE}/`, 'user-agent': UA, 'x-same-domain': '1' };
    if (id) headers['x-goog-ext-525001261-jspb'] = JSON.stringify([1, null, null, null, id, null, null, 0, [4], null, null, LEVEL[level] || 1]);
    const url = `${BASE}/_/BardChatUi/data/assistant.lamda.BardFrontendService/StreamGenerate?bl=${encodeURIComponent(p.bl)}${p.sid ? `&f.sid=${encodeURIComponent(p.sid)}` : ''}&hl=en&_reqid=${(reqid += 100000)}&rt=c`;
    const body = new URLSearchParams({ 'f.req': JSON.stringify([null, JSON.stringify([turn, null, null])]), at: p.at }).toString();
    // longFetch: a thinking model can stay silent for minutes; Node's fetch would give up after 5 min and the bridge would
    // then fall back to the (slower) browser path
    const res = await longFetch(url, { method: 'POST', headers, body, signal });
    takeSetCookies(res);
    const raw = await res.text();
    if (res.status === 401 || res.status === 403 || (res.status === 400 && attempt === 0)) continue; // stale token: re-bootstrap once
    if (!res.ok) throw Object.assign(new Error(`Gemini web error ${res.status}`), { status: 502 });
    const { text: out, error } = parseReply(raw);
    if (out == null) { if (attempt === 0) continue; throw Object.assign(new Error(`Gemini web returned no answer${error ? ` (${error})` : ''}.`), { status: 502 }); }
    // Drop the model's code-execution scratch blocks (```python?code_reference ... ```), keep its answer.
    const clean = out.replace(/```[a-z]*\?code_(?:reference|stdout)[^\n]*\n[\s\S]*?```\s*/g, '').trim();
    return { text: clean || out.trim(), usage: { in: 0, out: 0 }, truncated: false };
  }
  throw new GeminiLoginRequired();
}

/** Fast sign-in check without a browser (when a cookie jar exists). */
export async function geminiHttpReady() {
  try { await bootstrap(true); return true; } catch { return false; }
}
