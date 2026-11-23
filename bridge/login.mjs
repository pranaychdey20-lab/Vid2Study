/** One-time sign-in: opens a VISIBLE Chrome with the bridge profile. Sign in to Google, then close the window. */
import { chromium } from 'playwright-core';
import { PROFILE, LAUNCH } from './geminiweb.mjs';

const ctx = await chromium.launchPersistentContext(PROFILE, { ...LAUNCH, headless: false, viewport: null });
const page = ctx.pages()[0] || (await ctx.newPage());
await page.goto('https://gemini.google.com/app');
console.log('Sign in to Google in the window, then CLOSE the window to finish.');
await new Promise((r) => ctx.on('close', r));
console.log('Done. Start the bridge with: npm start');
