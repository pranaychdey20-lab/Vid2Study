/**
 * Langdock web backend over plain HTTP (no browser after the one-time login). Talks to the same endpoints the
 * Langdock web app uses, with the saved session cookie (bridge/langdock-session.json, written by login-langdock.mjs).
 * Undocumented API: it can change without notice. Parallel requests are fine; one instance lives for the process.
 */
import { readFile, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { longFetch } from './longfetch.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const SESSION_FILE = join(HERE, 'langdock-session.json');
const BASE = 'https://app.langdock.com';
const ZERO = '00000000-0000-0000-0000-000000000000';
const squash = (s) => String(s).toLowerCase().replace(/[\s.\-_]/g, '');
const EXT = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' };

export const PROFILE_DIR = join(HERE, 'profile-langdock');
let refreshing = null;

/** Re-export the cookies of the signed-in sign-in profile (headless, a few seconds). False when there is no profile or it is signed out. */
export function refreshFromProfile() {
  if (!existsSync(PROFILE_DIR)) return Promise.resolve(false);
  return (refreshing ||= (async () => {
    try {
      const { chromium } = await import('playwright-core');
      const ctx = await chromium.launchPersistentContext(PROFILE_DIR, { channel: 'chrome', headless: true, args: ['--disable-blink-features=AutomationControlled'] });
      try {
        const page = ctx.pages()[0] || (await ctx.newPage());
        await page.goto(`${BASE}/chat`, { waitUntil: 'domcontentloaded', timeout: 45000 });
        await page.waitForTimeout(3000); // let the app renew its session cookie
        if (/login|signin|sign-in|auth/i.test(new URL(page.url()).pathname)) return false; // signed out for real
        const cookies = await ctx.cookies(BASE);
        if (!cookies.length) return false;
        await writeFile(SESSION_FILE, JSON.stringify(cookies), { mode: 0o600 });
        return true;
      } finally { await ctx.close().catch(() => {}); }
    } catch { return false; } finally { setTimeout(() => { refreshing = null; }, 0); }
  })());
}

export class LoginRequired extends Error {
  constructor(msg = 'Langdock is signed out. Sign in again (Options > Check setup > Sign in to Langdock, or: npm run login-langdock).') { super(msg); this.status = 401; }
}

export class Langdock {
  version = null; models = null; cookie = null;

  /** Load the cookie, the app version and the model list. Call again after a new login. */
  async init(canRefresh = true) {
    try { return await this.load(); } catch (e) {
      // Cookie rejected: if a signed-in sign-in profile exists, re-export fresh cookies from it (like the Gemini path), once.
      if (e instanceof LoginRequired && canRefresh && (await refreshFromProfile())) return this.load();
      throw e;
    }
  }

  async load() {
    let saved;
    try { saved = JSON.parse(await readFile(SESSION_FILE, 'utf8')); } catch { throw new LoginRequired(); }
    // Either the login window's cookie list, or a pasted `cookie` request header.
    this.cookie = Array.isArray(saved) ? saved.map((c) => `${c.name}=${c.value}`).join('; ') : String(saved?.cookie || '');
    if (!this.cookie) throw new LoginRequired();
    await this.refreshVersion();
    this.models = await this.trpc('models.getModelsForSelector', { onlyActive: true });
    return this;
  }

  async ready() { if (!this.models) await this.init(); return this; }

  async refreshVersion() {
    const html = await (await fetch(`${BASE}/chat`)).text();
    const m = html.match(/NEXT_PUBLIC_APP_VERSION["']?\s*:\s*["']([^"']+)["']/);
    if (!m) throw new Error('Could not read the Langdock app version (the site may have changed).');
    this.version = m[1];
  }

  headers(extra = {}) {
    return { cookie: this.cookie, origin: BASE, referer: `${BASE}/chat`, ...(this.version ? { 'x-app-version': this.version } : {}), ...extra };
  }

  check(res) {
    if (res.status === 401 || res.status === 403) { this.models = null; throw new LoginRequired(); }
    return res;
  }

  async trpc(proc, input) {
    const res = this.check(await fetch(`${BASE}/api/trpc/${proc}?batch=1&input=${encodeURIComponent(JSON.stringify({ 0: { json: input } }))}`, { headers: this.headers() }));
    const [j] = await res.json();
    if (j.error) throw new Error(`${proc}: ${j.error.json?.message}`);
    return j.result.data.json;
  }

  findModel(name) {
    const k = squash(name);
    const m = this.models.find((x) => squash(x.displayName) === k) || this.models.find((x) => squash(x.displayName).includes(k));
    if (!m) throw new Error(`Unknown Langdock model "${name}". Available: ${this.models.map((x) => x.displayName).join(', ')}`);
    return m;
  }

  /** Upload picture bytes; resolves to the attachment id. */
  async upload({ b64, mime = 'image/png' }, i = 0) {
    const name = `image-${i + 1}.${EXT[mime] || 'png'}`;
    const f = new FormData();
    f.set('file', new Blob([Buffer.from(b64, 'base64')], { type: mime }), name);
    f.set('name', name); f.set('type', 'image'); f.set('mimeType', mime); f.set('source', 'CHAT'); f.set('async', 'false');
    const res = this.check(await fetch(`${BASE}/api/storage/upload-attachment`, { method: 'POST', headers: this.headers(), body: f }));
    const j = await res.json().catch(() => ({}));
    if (!res.ok || !j.attachmentId) throw new Error(`Langdock picture upload failed: ${j.message || res.status}`);
    return j.attachmentId;
  }

  /**
   * One prompt in a new chat -> reply text.
   * @param {string} prompt @param {{model?:string, effort?:string, images?:{b64:string,mime:string}[], signal?:AbortSignal}} o
   */
  async ask(prompt, opts = {}) {
    try { return await this.askOnce(prompt, opts); } catch (e) {
      if (!(e instanceof LoginRequired)) throw e;
      await this.init(); // session ended mid-run: refresh from the profile (throws LoginRequired if that is gone too)
      return this.askOnce(prompt, opts);
    }
  }

  async askOnce(prompt, { model, effort, images = [], signal, session } = {}) {
    await this.ready();
    const m = model && model !== 'auto' ? this.findModel(model) : null;
    if (images.length && m && m.supportsVision === false) throw new Error(`${m.displayName} cannot see pictures: pick a vision model.`);
    const validId = id => typeof id === 'string' && /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/i.test(id);
    if (session && ![session.conversationId, session.replyId].every(validId)) {
      throw Object.assign(new Error('Invalid Langdock conversation.'), { status: 409 });
    }
    const conversationId = session?.conversationId || randomUUID(), turnId = randomUUID();
    const attachments = await Promise.all(images.map((im, i) => this.upload(im, i)));
    const body = {
      id: conversationId, conversationSource: 'WEB', userTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      modelSelection: m ? { kind: 'modelId', modelId: m.id } : { kind: 'auto' },
      extendedThinking: false, contextWindowMode: 'STANDARD',
      ...(m && effort && m.allowedReasoningEfforts?.includes(effort) ? { reasoningEffort: effort } : {}),
      messages: [{ id: turnId, role: 'user', parts: [{ type: 'text', text: prompt }], metadata: {
        parentId: session?.replyId || ZERO, threadId: turnId, selectedTool: null, selectedInternalSearchIntegrations: [], attachments,
        taggedIntegrations: [], taggedKnowledgeFolders: [], taggedWorkflows: [], taggedAssistantId: null,
        modelId: m ? m.id : 'auto', modelProvider: m ? m.provider : null, modelName: m ? m.displayName : null,
        userFeedback: null, createdAt: new Date().toISOString() } }]
    };
    // longFetch: the stream may stay silent for minutes while the model works (Node's fetch stops waiting after 5 min)
    const send = () => longFetch(`${BASE}/api/engine`, { method: 'POST', signal,
      headers: this.headers({ 'content-type': 'application/json', 'x-langdock-stream-end': 'waiting' }), body: JSON.stringify(body) });

    const parts = []; let error = '', sawEvents = false, head = '', replyId;
    const onEvent = async (ev) => {
      switch (ev.type) {
        case 'start': {
          // The stream appends a role suffix. The follow-up request expects the UUID alone.
          const id = typeof ev.messageId === 'string' && ev.messageId.split(':')[0];
          if (validId(id)) replyId = id;
          break;
        }
        case 'text-start': parts.push({ kind: 'text', text: '' }); break;
        case 'text-delta': { const p = parts.at(-1); if (p?.kind === 'text') p.text += ev.delta; break; }
        case 'tool-input-start': parts.push({ kind: 'tool' }); break;
        case 'error': error = ev.errorText || 'Langdock error'; break;
        case 'data-tool-awaiting': { // the model asked a question: dismiss it so the call cannot hang
          const d = ev.data;
          if (d?.toolName !== 'ask_user_questions') break;
          await fetch(`${BASE}/api/engine/complete-awakeable`, { method: 'POST', headers: this.headers({ 'content-type': 'application/json' }),
            body: JSON.stringify({ conversationId, toolCallId: d.toolCallId, sessionId: d.sessionId, payload: { dismissed: true, answers: {} } }) });
          break;
        }
      }
    };
    const read = async (r) => {
      const dec = new TextDecoder(); let buf = '';
      for await (const chunk of r.body) {
        buf += dec.decode(chunk, { stream: true });
        if (!sawEvents && head.length < 2000) head = (head + buf).slice(0, 2000);
        for (let i = buf.indexOf('\n'); i >= 0; i = buf.indexOf('\n')) {
          const line = buf.slice(0, i).trimEnd(); buf = buf.slice(i + 1);
          if (!line.startsWith('data:')) continue;
          try { const ev = JSON.parse(line.slice(5)); sawEvents = true; await onEvent(ev); } catch { /* partial or non-JSON line */ }
        }
      }
    };
    let res = this.check(await send());
    await read(res);
    if (!sawEvents && head.includes('new version of Langdock')) { await this.refreshVersion(); head = ''; res = this.check(await send()); await read(res); }
    if (!sawEvents && !error) error = head.trim().slice(0, 300) || `HTTP ${res.status}`;
    if (error) throw new Error(error);
    const lastTool = parts.map((p) => p.kind).lastIndexOf('tool');
    const text = parts.slice(lastTool + 1).map((p) => (p.kind === 'text' ? p.text.trim() : '')).filter(Boolean).join('\n\n');
    return { text, session: replyId ? { conversationId, replyId } : undefined, usage: { in: 0, out: 0 }, truncated: false };
  }
}

/** Save a cookie header pasted from DevTools (Network > a request to app.langdock.com > Request Headers > cookie). */
export async function saveCookieHeader(text) {
  const c = String(text || '').trim().replace(/^cookie:\s*/i, '').replace(/\s*[\r\n]+\s*/g, ' ');
  if (!/=/.test(c) || c.length < 20) throw new Error('That does not look like a cookie header (name=value; name=value ...).');
  await writeFile(SESSION_FILE, JSON.stringify({ cookie: c }), { mode: 0o600 });
}

let shared = null;
/** One shared instance for the bridge's lifetime (cookie, version and model list cached). */
export const langdock = () => (shared ||= new Langdock());
export const resetLangdock = () => { shared = null; };
