/**
 * One command to get everything ready, then start the bridge:  node setup.mjs   (or double-click Start-Bridge.cmd)
 * Checks Node, playwright-core, Chrome, Claude CLI and both sign-ins; installs what is missing; asks you to sign in
 * once where needed (a window opens, you type the password yourself); registers lecturehelper://start (Windows) so
 * the extension's Options page can start the bridge; then starts it.
 * Flags: --no-claude / --no-gemini / --no-langdock to skip a backend, --langdock to sign in to Langdock without asking, --check to only report.
 */
import { createInterface } from 'node:readline/promises';
import { readFile } from 'node:fs/promises';
import { nodeCheck, playwrightCheck, chromeCheck, claudeCheck, claudeLoginCheck, geminiLoginCheck, langdockLoginCheck, fixes, registerNative } from './checks.mjs';

const args = new Set(process.argv.slice(2));
const wantClaude = !args.has('--no-claude'), wantGemini = !args.has('--no-gemini'), wantLangdock = !args.has('--no-langdock'), checkOnly = args.has('--check');
const ask = async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } };
let problems = 0;
const idArg = process.argv.includes('--extension-id') ? process.argv[process.argv.indexOf('--extension-id') + 1] : undefined;
const line = (ok, text) => console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${text}`);
const bridgeUrl = `http://127.0.0.1:${Number(process.env.BRIDGE_PORT || 8787)}`;
const running = await fetch(`${bridgeUrl}/ping`, { signal: AbortSignal.timeout(1500) })
  .then(r => r.ok, () => false);

async function runningGemini(method = 'GET') {
  try {
    const token = (await readFile(new URL('./token.txt', import.meta.url), 'utf8')).trim();
    const call = path => fetch(`${bridgeUrl}${path}`, {
      method, headers: { 'x-bridge-token': token }, signal: AbortSignal.timeout(600000)
    });
    const read = async path => {
      const response = await call(path);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return response.json();
    };
    const result = await read(method === 'POST' ? '/setup/login-gemini' : '/status/gemini');
    // Older bridges handle all /status paths but only check Gemini with deep=1.
    if (method === 'GET' && result.geminiLogin) return (await read('/status?deep=1')).geminiLogin;
    return result;
  } catch (error) {
    return { ok: false, detail: `Could not check Gemini through the running bridge (${error.message}).` };
  }
}

/** Check; if it fails and fixing is allowed, run the fix and check again. */
async function step(name, check, fix) {
  let r = await check();
  if (!r.ok && fix && !checkOnly) {
    console.log(`[ ..  ] ${name}: ${r.detail}. Fixing...`);
    const f = await fix(true);
    r = await check();
    if (!r.ok) r.detail = `${r.detail} (${f.detail})`;
  }
  line(r.ok, `${name}: ${r.detail}`);
  if (!r.ok) problems++;
  return r.ok;
}

console.log('Vid2Study bridge setup\n');
if (!(await step('Node', nodeCheck))) { console.log('Install Node 18+ from nodejs.org and run this again.'); process.exit(1); }
if (wantGemini) {
  const pw = await step('playwright-core', playwrightCheck, fixes.playwright);
  const ch = await step('Google Chrome', chromeCheck, fixes.chrome);
  if (pw && ch) {
    await step('Gemini sign-in', running ? runningGemini : geminiLoginCheck, async () => {
      console.log('\nFinish signing in to Google in the Chrome window, then close that window.\n');
      return running ? runningGemini('POST') : fixes.geminiLogin(true);
    });
  }
}
if (wantLangdock && playwrightCheck().ok && chromeCheck().ok) {
  // Langdock is optional: only ask when it is not signed in. A signed-in profile is what lets the bridge renew the cookie by itself.
  const ok = await step('Langdock sign-in', langdockLoginCheck);
  if (!ok && !checkOnly) {
    const go = args.has('--langdock') || (process.stdin.isTTY && /^y/i.test(await ask('Set up Langdock now (one-time sign-in, optional)? [y/N] ')));
    if (go) {
      console.log('\nA Chrome window opens: sign in to Langdock, wait for the chat home, then CLOSE the window.\n');
      await fixes.langdockLogin(true);
      await step('Langdock sign-in', langdockLoginCheck);
    } else { problems--; console.log('       (skipped: run "node setup.mjs --langdock" any time)'); }
  }
}
if (wantClaude) {
  if (await step('Claude CLI', claudeCheck, fixes.claude)) {
    if (!(await step('Claude sign-in', claudeLoginCheck)) && !checkOnly) {
      console.log('\nFollow the Claude sign-in prompts below.\n');
      await fixes.claudeLogin(true);
      await step('Claude sign-in', claudeLoginCheck);
    }
  }
}
// yt-dlp: YouTube captions / audio / video without playing the video (refreshes itself weekly while the bridge runs)
try {
  const y = await import('./youtube.mjs');
  if (checkOnly) { const s = y.ytdlpStatus(); line(!!s.path, `yt-dlp: ${s.path ? s.version || 'installed' : 'not installed yet'}`); if (!s.path) problems++; }
  else { await y.ensureYtDlp(); const u = await y.updateYtDlp(false); line(true, `yt-dlp: ${u.detail}`); }
} catch (e) { line(false, `yt-dlp: ${e.message}`); problems++; }
if (!checkOnly) { const r = registerNative(idArg); line(r.ok, r.detail); if (!r.ok) problems++; }
console.log(problems ? `\n${problems} item(s) need attention (see above).\n` : '\nAll set.\n');
if (!checkOnly) {
  if (running) console.log(`The bridge is running at ${bridgeUrl}.`);
  else await import('./server.mjs');
}
