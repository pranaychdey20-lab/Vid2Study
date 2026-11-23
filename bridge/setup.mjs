/**
 * One command to get everything ready, then start the bridge:  node setup.mjs   (or double-click Start-Bridge.cmd)
 * Checks Node, playwright-core, Chrome, Claude CLI and both sign-ins; installs what is missing; asks you to sign in
 * once where needed (a window opens, you type the password yourself); registers lecturehelper://start (Windows) so
 * the extension's Options page can start the bridge; then starts it.
 * Flags: --no-claude / --no-gemini / --no-langdock to skip a backend, --langdock to sign in to Langdock without asking, --check to only report.
 */
import { createInterface } from 'node:readline/promises';
import { nodeCheck, playwrightCheck, chromeCheck, claudeCheck, claudeLoginCheck, geminiLoginCheck, langdockLoginCheck, fixes, registerNative } from './checks.mjs';

const args = new Set(process.argv.slice(2));
const wantClaude = !args.has('--no-claude'), wantGemini = !args.has('--no-gemini'), wantLangdock = !args.has('--no-langdock'), checkOnly = args.has('--check');
const ask = async (q) => { const rl = createInterface({ input: process.stdin, output: process.stdout }); try { return await rl.question(q); } finally { rl.close(); } };
let problems = 0;
const idArg = process.argv.includes('--extension-id') ? process.argv[process.argv.indexOf('--extension-id') + 1] : undefined;
const line = (ok, text) => console.log(`${ok ? '[ ok ]' : '[FAIL]'} ${text}`);

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
    let ok = await step('Gemini sign-in', geminiLoginCheck);
    if (!ok && !checkOnly) {
      console.log('\nA Chrome window opens: sign in to Google there, then CLOSE the window.\n');
      await fixes.geminiLogin(true);
      await step('Gemini sign-in', geminiLoginCheck);
    }
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
console.log(problems ? `\n${problems} item(s) need attention (see above). Starting the bridge anyway: backends that are ready will work.\n` : '\nAll set.\n');
if (!checkOnly) await import('./server.mjs');
