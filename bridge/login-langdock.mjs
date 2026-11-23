/**
 * One-time Langdock sign-in: a VISIBLE Chrome opens, you sign in by hand and close it.
 * Cookies are saved to langdock-session.json. Set LANGDOCK_BROWSER=brave to use Brave instead.
 */
import { chromium } from 'playwright-core';
import { writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { SESSION_FILE } from './langdock.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const env = process.env;
const brave = [join(env.PROGRAMFILES || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'), join(env['PROGRAMFILES(X86)'] || '', 'BraveSoftware/Brave-Browser/Application/brave.exe'), join(env.LOCALAPPDATA || '', 'BraveSoftware/Brave-Browser/Application/brave.exe')]
  .find((f) => existsSync(f));
const useBrave = !!brave && env.LANGDOCK_BROWSER === 'brave';
console.log(`Opening ${useBrave ? 'Brave' : 'Chrome'}...`);

const ctx = await chromium.launchPersistentContext(join(HERE, 'profile-langdock'), {
  ...(useBrave ? { executablePath: brave } : { channel: 'chrome' }),
  headless: false, viewport: null, args: ['--disable-blink-features=AutomationControlled']
});
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://app.langdock.com/chat');
console.log('Sign in to Langdock, wait for the chat home, then CLOSE the window.');
const save = async () => { const c = await ctx.cookies('https://app.langdock.com'); if (c.length) await writeFile(SESSION_FILE, JSON.stringify(c)); };
const timer = setInterval(() => save().catch(() => {}), 3000);
await new Promise((r) => ctx.on('close', r));
clearInterval(timer);
console.log('Saved. Done.');
