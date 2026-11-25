/**
 * Environment checks and fixes shared by setup.mjs (terminal) and the bridge's /status + /setup/* endpoints
 * (the Options page button). Every check returns { ok, detail } and never throws.
 */
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { findClaude } from './claude.mjs';
import { codexLoginCheck, findCodex } from './codex.mjs';

export const HERE = dirname(fileURLToPath(import.meta.url));
const WIN = process.platform === 'win32';
const run = (cmd, args, opts = {}) => spawnSync(cmd, args, { encoding: 'utf8', shell: WIN, windowsHide: true, ...opts });

export function nodeCheck() {
  const major = Number(process.versions.node.split('.')[0]);
  return { ok: major >= 18, detail: `Node ${process.versions.node}${major >= 18 ? '' : ' (need 18 or newer)'}` };
}

export function playwrightCheck() {
  const ok = existsSync(join(HERE, 'node_modules', 'playwright-core', 'package.json'));
  return { ok, detail: ok ? 'playwright-core installed' : 'playwright-core missing (npm install)' };
}

export function chromePath() {
  const env = process.env;
  const list = WIN
    ? [join(env.PROGRAMFILES || '', 'Google/Chrome/Application/chrome.exe'), join(env['PROGRAMFILES(X86)'] || '', 'Google/Chrome/Application/chrome.exe'), join(env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe')]
    : process.platform === 'darwin' ? ['/Applications/Google Chrome.app/Contents/MacOS/Google Chrome']
      : ['/usr/bin/google-chrome', '/usr/bin/google-chrome-stable', '/opt/google/chrome/chrome'];
  return list.find((f) => existsSync(f)) || null;
}
export function chromeCheck() {
  const p = chromePath();
  return { ok: !!p, detail: p ? 'Google Chrome found' : 'Google Chrome not found' };
}

export function claudeCheck() {
  const bin = findClaude();
  return { ok: !!bin, detail: bin ? 'Claude CLI found' : 'Claude CLI not found' };
}

/** `claude auth status` is free (no model call). */
export function claudeLoginCheck() {
  const bin = findClaude();
  if (!bin) return { ok: false, detail: 'Claude CLI not installed' };
  try {
    const r = spawnSync(bin, ['auth', 'status', '--json'], { encoding: 'utf8', windowsHide: true, timeout: 20000 });
    const j = JSON.parse(r.stdout);
    return j.loggedIn ? { ok: true, detail: `Signed in to Claude (${j.authMethod || 'account'})` } : { ok: false, detail: 'Claude CLI is not signed in' };
  } catch { return { ok: false, detail: 'Could not read the Claude sign-in status' }; }
}

export async function geminiLoginCheck({ refresh = false } = {}) {
  if (!playwrightCheck().ok || !chromeCheck().ok) return { ok: false, detail: 'Needs Chrome and playwright-core first' };
  try {
    const { geminiHttpReady } = await import('./geminihttp.mjs');
    if (await geminiHttpReady({ refresh })) return { ok: true, detail: 'Signed in to Gemini web (fast HTTP path ready)' };
    const { geminiSignedIn } = await import('./geminiweb.mjs');
    const ok = await geminiSignedIn();
    return { ok, detail: ok ? 'Signed in to Gemini web' : 'Not signed in to Gemini web' };
  } catch (e) { return { ok: false, detail: String(e.message).split('\n')[0] }; }
}

/** All checks. `deep` also opens headless Chrome to verify the Google sign-in (about 10 s). */
export async function status({ deep = false } = {}) {
  const out = { node: nodeCheck(), playwright: playwrightCheck(), chrome: chromeCheck(), claude: claudeCheck(), claudeLogin: claudeLoginCheck() };
  [out.codexLogin, out.geminiLogin, out.ytdlp] = await Promise.all([
    codexLoginCheck(),
    deep ? geminiLoginCheck() : { ok: null, detail: 'Not checked (use the full check)' },
    ytdlpCheck()
  ]);
  return out;
}

const day = (t) => new Date(t).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
/** yt-dlp (YouTube captions / audio / video without listening): installed? which version? when updated? */
export async function ytdlpCheck() {
  const s = (await import('./youtube.mjs')).ytdlpStatus();
  if (!s.path) return { ok: true, detail: 'not installed yet: downloaded automatically on first YouTube use (or press Update now)' };
  return { ok: true, detail: `${s.version || 'installed'}${s.updatedAt ? `, updated ${day(s.updatedAt)}, next check ${day(s.nextUpdate)}` : ', update pending'} (refreshes itself weekly)` };
}

/** Run a visible command to completion, output inherited (terminal) or discarded (bridge). */
const runLong = (cmd, args, inherit, { shell = WIN, visible = inherit } = {}) => new Promise((resolve) => {
  const c = spawn(cmd, args, { shell, windowsHide: !visible, stdio: inherit ? 'inherit' : 'ignore', cwd: HERE });
  c.on('error', () => resolve(false));
  c.on('close', (code) => resolve(code === 0));
});

let geminiLoginWindow;

/** Fixes. Each returns { ok, detail }. */
export const fixes = {
  async ytdlp() {
    const y = await import('./youtube.mjs');
    try { await y.ensureYtDlp(); return await y.updateYtDlp(true); } catch (e) { return { ok: false, detail: e.message }; }
  },
  async playwright(inherit = false) {
    const ok = await runLong('npm', ['install', '--no-audit', '--no-fund'], inherit);
    return { ok: ok && playwrightCheck().ok, detail: ok ? 'npm install finished' : 'npm install failed' };
  },
  async claude(inherit = false) {
    const ok = await runLong('npm', ['install', '-g', '@anthropic-ai/claude-code'], inherit);
    return { ok: ok && claudeCheck().ok, detail: ok ? 'Claude CLI installed' : 'Could not install the Claude CLI (try: npm i -g @anthropic-ai/claude-code)' };
  },
  async chrome(inherit = false) {
    if (!WIN) return { ok: false, detail: 'Install Google Chrome from google.com/chrome, then re-run the check.' };
    const ok = await runLong('winget', ['install', '-e', '--id', 'Google.Chrome', '--accept-package-agreements', '--accept-source-agreements'], inherit);
    return { ok: ok && chromeCheck().ok, detail: ok ? 'Chrome installed' : 'Could not install Chrome (get it from google.com/chrome)' };
  },
  /** Opens a visible window for the user to sign in; resolves when it is closed. Passwords are never touched. */
  async geminiLogin(inherit = false, { chatgpt = false } = {}) {
    if (!playwrightCheck().ok || !chromeCheck().ok) return { ok: false, detail: 'Gemini sign-in needs Chrome and playwright-core. Use Check setup in Options.' };
    if (geminiLoginWindow && geminiLoginWindow.chatgpt !== chatgpt) {
      return { ok: false, detail: 'Finish the sign-in already open in the bridge Chrome profile, then try again.' };
    }
    if (!geminiLoginWindow) {
      geminiLoginWindow = (async () => {
        const { withGeminiLogin } = await import('./geminiweb.mjs');
        const args = ['login.mjs', ...(chatgpt ? ['--chatgpt'] : [])];
        const opened = await withGeminiLogin(() => chatgpt && !inherit
          ? runLong('start', ['"Vid2Study ChatGPT sign-in"', '/wait', `"${process.execPath}"`, ...args], false, { visible: true })
          : runLong(process.execPath, args, inherit, { shell: false }));
        if (!opened) return { ok: false, detail: chatgpt
          ? 'ChatGPT device sign-in did not complete. Enable device code sign-in in ChatGPT settings or use Sign in to ChatGPT.'
          : 'Could not open the Gemini sign-in window. Close any existing bridge sign-in window and try again.' };
        return chatgpt ? codexLoginCheck() : geminiLoginCheck({ refresh: true });
      })().finally(() => { geminiLoginWindow = null; });
      geminiLoginWindow.chatgpt = chatgpt;
    }
    return geminiLoginWindow;
  },
  async codexLogin() {
    const bin = findCodex();
    if (!bin) return { ok: false, detail: 'Install Codex CLI with npm install -g @openai/codex, then try again.' };
    const checked = await codexLoginCheck(bin);
    if (checked.ok) return checked;
    const ok = await runLong(bin, ['-c', 'cli_auth_credentials_store="auto"', 'login'], false, { shell: false });
    return ok ? codexLoginCheck(bin) : { ok: false, detail: 'ChatGPT sign-in did not complete. Run codex login in a terminal to see the error.' };
  },
  async codexProfileLogin() {
    const checked = await codexLoginCheck();
    if (checked.ok) return checked;
    if (!findCodex()) return checked;
    if (!WIN) return { ok: false, detail: 'Stop the bridge, then run node login.mjs --chatgpt in the bridge folder.' };
    return fixes.geminiLogin(false, { chatgpt: true });
  },
  /** Claude sign-in needs a terminal; open one on Windows, else the user runs `claude auth login`. */
  async claudeLogin(inherit = false) {
    const bin = findClaude();
    if (!bin) return { ok: false, detail: 'Install the Claude CLI first.' };
    if (inherit) { const ok = await runLong(`"${bin}"`, ['auth', 'login'], true); return { ok, detail: 'Claude sign-in finished' }; }
    if (WIN) { spawn('cmd', ['/c', 'start', '"Claude sign-in"', 'cmd', '/k', `"${bin}" auth login`], { detached: true, stdio: 'ignore', windowsHide: false }).unref(); return { ok: true, detail: 'A terminal window opened: finish signing in there, then check again.' }; }
    return { ok: false, detail: 'Run `claude auth login` in a terminal, then check again.' };
  }
};

/** Extension id of THIS unpacked extension, read from Chrome's own profile files (or given with --extension-id). */
export function findExtensionId(given) {
  if (given) return given;
  const norm = (p) => String(p).toLowerCase().replace(/[\\/]+/g, '/').replace(/\/+$/, '');
  const ext = norm(join(HERE, '..'));
  const base = WIN ? join(process.env.LOCALAPPDATA || '', 'Google/Chrome/User Data') : process.platform === 'darwin' ? join(process.env.HOME || '', 'Library/Application Support/Google/Chrome') : join(process.env.HOME || '', '.config/google-chrome');
  if (!existsSync(base)) return null;
  for (const dir of readdirSync(base)) {
    for (const f of ['Secure Preferences', 'Preferences']) {
      try {
        const settings = JSON.parse(readFileSync(join(base, dir, f), 'utf8')).extensions?.settings || {};
        for (const [id, v] of Object.entries(settings)) if (v.path && norm(v.path) === ext) return id;
      } catch { /* not a profile */ }
    }
  }
  return null;
}

/**
 * Windows: register the Native Messaging host so the extension's "Start bridge" button can launch the bridge.
 * Current user only (HKCU), no admin. Only the extension with this id may use the host.
 */
export function registerNative(extensionId) {
  if (!WIN) return { ok: false, detail: 'Start-from-Options is Windows only: run "node setup.mjs" from a terminal.' };
  const id = findExtensionId(extensionId);
  if (!id) return { ok: false, detail: 'Could not find the extension in Chrome. Load it unpacked first, or run: node setup.mjs --extension-id <id from chrome://extensions>' };
  const cmd = join(HERE, 'native-host.cmd');
  writeFileSync(cmd, ['@echo off', `"${process.execPath}" "${join(HERE, 'native-host.mjs')}"`, ''].join('\r\n'));
  const manifest = join(HERE, 'com.lecturehelper.bridge.json');
  writeFileSync(manifest, JSON.stringify({ name: 'com.lecturehelper.bridge', description: 'Starts the Vid2Study bridge', path: cmd, type: 'stdio', allowed_origins: [`chrome-extension://${id}/`] }, null, 2));
  const ok = spawnSync('reg', ['add', 'HKCU\\Software\\Google\\Chrome\\NativeMessagingHosts\\com.lecturehelper.bridge', '/ve', '/d', manifest, '/f'], { windowsHide: true }).status === 0;
  return { ok, detail: ok ? `Options "Start bridge" button enabled for extension ${id}` : 'Could not write the registry entry' };
}
