/**
 * Local bridge for the Vid2Study extension (a Chrome extension cannot start Playwright or the Claude CLI).
 *   GET  /health            -> { ok, backends: { 'claude-cli': bool, 'gemini-web': bool } }
 *   POST /generate          -> { backend:'claude-cli'|'gemini-web', model, prompt, system?, images?:[{mime,b64}], json?, effort? }
 *                              reply { text, usage:{in,out}, truncated }
 *   POST /youtube/subs      -> { id } -> { text, lang }  captions through yt-dlp (youtube.mjs)
 *   POST /youtube/media     -> { id, kind:'audio'|'video', maxHeight? } -> the file itself (audio/mp4, video/mp4)
 *   GET  /youtube/status, POST /youtube/update -> yt-dlp version / force the weekly self-update now
 * Security: listens on 127.0.0.1 only, needs the secret in bridge/token.txt (header x-bridge-token; paste it as the
 * "API key" of the provider in the extension Options), and only answers requests from chrome-extension:// origins,
 * so a web page cannot use your Claude / Google sessions.
 */
import { createServer } from 'node:http';
import { randomBytes } from 'node:crypto';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runClaude, findClaude } from './claude.mjs';
import { status, fixes } from './checks.mjs';
import { askGeminiHttp } from './geminihttp.mjs';
import { langdock, resetLangdock, saveCookieHeader } from './langdock.mjs';
import { statSync, createReadStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import * as yt from './youtube.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN_FILE = join(HERE, 'token.txt');
if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'));
const TOKEN = readFileSync(TOKEN_FILE, 'utf8').trim();
const MAX_BODY = 300 * 1024 * 1024;

let gemini = null; // loaded on first use, so the Claude CLI backend works without playwright-core installed
async function geminiBackend() {
  if (gemini) return gemini;
  try { gemini = await import('./geminiweb.mjs'); } catch (e) {
    throw Object.assign(new Error(`Gemini web needs playwright-core: run "npm install" in the bridge folder (${e.message.split('\n')[0]}).`), { status: 503 });
  }
  return gemini;
}

// Cap parallel Claude CLI runs (each is a process); Gemini web has its own one-at-a-time queue.
let claudeActive = 0;
const claudeWaiters = [];
async function claudeSlot() {
  if (claudeActive >= 3) await new Promise((r) => claudeWaiters.push(r));
  claudeActive++;
  return () => { claudeActive--; claudeWaiters.shift()?.(); };
}

/** "sonnet:high" -> { model: 'sonnet', effort: 'high' }; a name without a known effort suffix is returned as it is. */
function splitEffort(name) {
  const m = /^(.*):(none|minimal|low|medium|high|xhigh|max)$/i.exec(String(name || ''));
  return m ? { model: m[1], effort: m[2].toLowerCase() } : { model: name, effort: undefined };
}

/** Ask for JSON only when the extension wants JSON (the CLI and the web app have no JSON mode). */
const withJson = (prompt, json) => (json ? `${prompt}\n\nReply with a single valid JSON value only: no code fence, no commentary.` : prompt);

function send(res, status, body, origin) {
  const h = { 'Content-Type': 'application/json' };
  if (origin) { h['Access-Control-Allow-Origin'] = origin; h.Vary = 'Origin'; }
  res.writeHead(status, h);
  res.end(JSON.stringify(body));
}

const server = createServer(async (req, res) => {
  const origin = req.headers.origin || '';
  const okOrigin = origin.startsWith('chrome-extension://') ? origin : '';
  if (origin && !okOrigin) return send(res, 403, { error: { message: 'Origin not allowed.' } });
  if (req.method === 'OPTIONS') {
    res.writeHead(204, { 'Access-Control-Allow-Origin': okOrigin, 'Access-Control-Allow-Headers': 'content-type, x-bridge-token', 'Access-Control-Allow-Methods': 'GET, POST', 'Access-Control-Max-Age': '600', Vary: 'Origin' });
    return res.end();
  }
  if (req.method === 'GET' && req.url === '/ping') return send(res, 200, { ok: true }, okOrigin); // lets Options tell "not running" from "wrong token"
  if (req.headers['x-bridge-token'] !== TOKEN) return send(res, 401, { error: { message: 'Wrong or missing bridge token. Paste the contents of bridge/token.txt as the API key.' } }, okOrigin);
  try {
    if (req.method === 'GET' && req.url === '/health') {
      return send(res, 200, { ok: true, backends: { 'claude-cli': !!findClaude(), 'gemini-web': true, langdock: true } }, okOrigin);
    }
    if (req.method === 'POST' && req.url === '/shutdown') {
      send(res, 200, { ok: true }, okOrigin);
      setTimeout(async () => { await gemini?.closeGemini?.(); process.exit(0); }, 200);
      return;
    }
    if (req.method === 'GET' && req.url === '/models/langdock') {
      const ld = await langdock().ready();
      return send(res, 200, { models: ld.models.map((m) => ({ name: m.displayName, vision: m.supportsVision !== false, efforts: m.allowedReasoningEfforts || [] })) }, okOrigin);
    }
    if (req.method === 'GET' && req.url.startsWith('/status')) {
      return send(res, 200, await status({ deep: req.url.includes('deep=1') }), okOrigin);
    }
    if (req.method === 'POST' && req.url === '/setup/langdock-cookie') {
      const chunks = []; for await (const c of req) chunks.push(c);
      try {
        await saveCookieHeader(JSON.parse(Buffer.concat(chunks).toString('utf8')).cookie);
        resetLangdock();
        const ld = await langdock().init();
        return send(res, 200, { ok: true, detail: `Cookie works: signed in to Langdock (${ld.models.length} models).` }, okOrigin);
      } catch (e) { resetLangdock(); return send(res, 200, { ok: false, detail: e.status === 401 ? 'Langdock refused that cookie (expired or incomplete). Copy it again from a fresh request.' : e.message }, okOrigin); }
    }
    if (req.method === 'POST' && req.url.startsWith('/setup/')) {
      const what = req.url.slice(7); // fix: playwright | claude | chrome ; login: gemini | claude
      const table = { ytdlp: fixes.ytdlp, playwright: fixes.playwright, claude: fixes.claude, chrome: fixes.chrome, 'login-gemini': fixes.geminiLogin, 'login-langdock': fixes.langdockLogin, 'login-claude': fixes.claudeLogin };
      if (!table[what]) return send(res, 404, { error: { message: 'Unknown setup step.' } }, okOrigin);
      if (what === 'login-langdock') resetLangdock(); // pick up the new cookie
      if (what === 'login-gemini') await gemini?.closeGemini?.(); // the visible login window needs the profile to itself
      return send(res, 200, await table[what](), okOrigin);
    }
    // ---- YouTube via yt-dlp (captions / audio / video without playing the video) ----
    if (req.method === 'GET' && req.url === '/youtube/status') return send(res, 200, yt.ytdlpStatus(), okOrigin);
    if (req.method === 'POST' && req.url === '/youtube/update') return send(res, 200, await yt.updateYtDlp(true), okOrigin);
    if (req.method === 'POST' && (req.url === '/youtube/subs' || req.url === '/youtube/media')) {
      let body = '';
      for await (const c of req) { body += c; if (body.length > 10000) return send(res, 413, { error: { message: 'Request too large.' } }, okOrigin); }
      const j = JSON.parse(body || '{}');
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); });
      if (req.url === '/youtube/subs') return send(res, 200, await yt.subs(j.id, { signal: ac.signal }), okOrigin);
      const m = await yt.media(j.id, j.kind === 'video' ? 'video' : 'audio', { maxHeight: j.maxHeight, signal: ac.signal });
      try {
        const size = statSync(m.file).size;
        res.writeHead(200, { 'Content-Type': m.mime, 'Content-Length': size, ...(okOrigin ? { 'Access-Control-Allow-Origin': okOrigin, Vary: 'Origin' } : {}) });
        await pipeline(createReadStream(m.file), res);
      } finally { m.cleanup(); }
      return;
    }
    if (req.method === 'POST' && req.url === '/generate') {
      let size = 0; const chunks = [];
      for await (const c of req) { size += c.length; if (size > MAX_BODY) return send(res, 413, { error: { message: 'Request too large.' } }, okOrigin); chunks.push(c); }
      const j = JSON.parse(Buffer.concat(chunks).toString('utf8'));
      const ac = new AbortController();
      res.on('close', () => { if (!res.writableEnded) ac.abort(); }); // the extension gave up: stop the work
      const o = { prompt: withJson(String(j.prompt || ''), j.json), system: j.system, images: Array.isArray(j.images) ? j.images : [], model: j.model, signal: ac.signal };
      let out;
      if (j.backend === 'claude-cli') {
        const done = await claudeSlot();
        const m = splitEffort(j.model);
        try { out = await runClaude({ ...o, model: m.model, effort: m.effort || j.effort }); } finally { done(); }
      } else if (j.backend === 'gemini-web') {
        // Text and pictures go over plain HTTP (fast); any HTTP failure that is not a sign-out falls back to the browser path.
        if (!process.env.GEMINI_BROWSER_ONLY) {
          try { out = await askGeminiHttp(o); } catch (e) { if (e.status === 401 || o.signal.aborted) throw e; console.log(`Gemini HTTP failed (${e.message}); using the browser.`); }
        }
        out ||= await (await geminiBackend()).askGemini(o);
      } else if (j.backend === 'langdock') {
        out = await langdock().ask(o.system ? `${o.system}

${o.prompt}` : o.prompt, { ...(({ model, effort }) => ({ model, effort: effort || j.effort }))(splitEffort(j.model)), images: o.images, signal: o.signal });
      } else return send(res, 400, { error: { message: `Unknown backend "${j.backend}".` } }, okOrigin);
      return send(res, 200, out, okOrigin);
    }
    return send(res, 404, { error: { message: 'Not found.' } }, okOrigin);
  } catch (e) {
    return send(res, e.status || 500, { error: { message: e.message } }, okOrigin);
  }
});

// a Gemini web answer can take up to 10 min and a yt-dlp download longer: never cut a request off on time
// the bridge must survive a stray error in one request (a crash would cut every call running at that moment: the extension
// sees "Failed to fetch"); log it and keep serving
process.on('uncaughtException', (e) => console.log(`Bridge error (still running): ${e?.stack || e}`));
process.on('unhandledRejection', (e) => console.log(`Bridge error (still running): ${e?.stack || e}`));
server.requestTimeout = 0;
server.timeout = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE') { console.log(`The bridge is already running on port ${PORT}. Nothing to do.`); process.exit(0); }
  throw e;
});
server.listen(PORT, '127.0.0.1', () => {
  console.log(`Vid2Study bridge on http://127.0.0.1:${PORT}`);
  console.log(`Token (paste as the API key in Options): ${TOKEN}`);
  console.log(`Claude CLI: ${findClaude() || 'NOT FOUND'}`);
  const y = yt.ytdlpStatus();
  console.log(`yt-dlp: ${y.path ? `${y.version || 'installed'} (refreshes itself weekly)` : 'downloaded on first YouTube use'}`);
  yt.startWeeklyUpdates();
});
process.on('SIGINT', async () => { await gemini?.closeGemini?.(); process.exit(0); });
