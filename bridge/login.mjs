/** One-time sign-in: opens a VISIBLE Chrome with the bridge profile. Sign in to Google, then close the window. */
import { chromium } from 'playwright-core';
import { spawn } from 'node:child_process';
import { PROFILE, LAUNCH } from './geminiweb.mjs';
import { findCodex } from './codex.mjs';

const chatgpt = process.argv.includes('--chatgpt');
const bin = chatgpt ? findCodex() : null;
if (chatgpt && !bin) throw new Error('Install Codex CLI with npm install -g @openai/codex first.');
const ctx = await chromium.launchPersistentContext(PROFILE, { ...LAUNCH, headless: false, viewport: null });
const page = ctx.pages()[0] || (await ctx.newPage());
const closed = new Promise(resolve => ctx.once('close', resolve));
if (!chatgpt) {
  await page.goto('https://gemini.google.com/app');
  console.log('Sign in to Google in the window, then close it.');
  await closed;
} else {
  const cli = spawn(bin, ['-c', 'cli_auth_credentials_store="auto"', 'login', '--device-auth'], { stdio: 'inherit', windowsHide: true });
  const exit = new Promise(resolve => {
    cli.once('close', resolve);
    cli.once('error', () => resolve(1));
  });
  console.log('Enter the one-time code shown here in the bridge Chrome window.');
  try {
    await page.goto('https://auth.openai.com/codex/device');
    process.exitCode = await Promise.race([exit, closed.then(() => 1)]);
  } finally {
    if (cli.exitCode == null) cli.kill();
    await ctx.close().catch(() => {});
  }
}
console.log('Done. Start the bridge with: npm start');
