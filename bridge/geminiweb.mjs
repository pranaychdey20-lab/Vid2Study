/**
 * Gemini consumer web app (gemini.google.com) backend, driven by Playwright over the user's installed Chrome with a
 * persistent profile. Sign in once with `npm run login` (headed); every call after that is HEADLESS.
 * One long-lived headless browser context, one request at a time (queue). Each prompt starts a new chat.
 *
 * UI selectors drift: on failure a screenshot is saved to bridge/errors/ and a short error is returned.
 * Google's terms prohibit automated access to the consumer app: keep volume low, prefer a secondary account.
 */
import { chromium } from 'playwright-core';
import { mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { GeminiLoginRequired, parseReply } from './geminihttp.mjs';
import { parseModel, geminiBrowserSession, geminiBrowserSessionFor, pickModel } from './gemini-selection.mjs';
import { readGeminiMarkdown } from './gemini-reply.mjs';
export { parseModel } from './gemini-selection.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE = process.env.GEMINI_PROFILE || join(HERE, 'profile');
const ERR_DIR = join(HERE, 'errors');
export const LAUNCH = { channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'], viewport: { width: 1400, height: 900 } };
// Gemini web (thinking models especially) can take minutes. We wait up to GEMINI_MAX_MS (default 30 min, at least
// 2 min, at most 60 min) for the whole answer, but return the moment it is complete (stop button gone and the text has stopped growing).
const MAX_REPLY_MS = Math.max(120000, Math.min(3600000, Number(process.env.GEMINI_MAX_MS) || 1800000));
const MAX_FILE_BYTES = 100 * 1024 * 1024;

let ctx = null;
let queue = Promise.resolve();

function inProfile(action) {
  const run = queue.then(action);
  queue = run.catch(() => {});
  return run;
}

/** The visible sign-in window needs exclusive access to the dedicated profile. */
export function withGeminiLogin(action) {
  return inProfile(async () => {
    await closeGemini();
    return action();
  });
}

async function context() {
  if (ctx) return ctx;
  ctx = await chromium.launchPersistentContext(PROFILE, { ...LAUNCH, headless: true }).catch((e) => {
    ctx = null;
    const busy = /ProcessSingleton|already in use|user data directory/i.test(e.message);
    throw Object.assign(new Error(busy ? 'The Gemini profile is in use by another Chrome window. Close the login window first.' : `Could not start Chrome: ${String(e.message).split('\n')[0]}`), { status: 503 });
  });
  ctx.on('close', () => { ctx = null; });
  return ctx;
}

/** Is the saved profile signed in to Google? (Opens the headless browser; closes it again if we opened it.) */
export async function geminiSignedIn() {
  return inProfile(async () => {
    const wasOpen = !!ctx;
    const c = await context();
    const page = await c.newPage();
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 });
      if (await signedOut(page)) return false;
      await page.locator('[role=textbox]').first().waitFor({ timeout: 45000 }).catch(() => {});
      return !(await signedOut(page)) && await page.locator('[role=textbox]').first().isVisible();
    } finally { await page.close().catch(() => {}); if (!wasOpen) await closeGemini(); }
  });
}

/** Google cookies of the signed-in profile (for the HTTP path). Opens the headless browser if it is not open. */
export async function exportGoogleCookies() {
  return inProfile(async () => {
    const wasOpen = !!ctx;
    let page;
    try {
      const c = await context();
      page = await c.newPage();
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 30000 });
      await page.waitForTimeout(2500); // let Google refresh rotating cookies (PSIDTS)
      if (await signedOut(page)) throw new GeminiLoginRequired();
      return await c.cookies('https://gemini.google.com/app');
    } finally {
      await page?.close().catch(() => {});
      if (!wasOpen) await closeGemini();
    }
  });
}

export async function closeGemini() { const c = ctx; ctx = null; await c?.close().catch(() => {}); }

/** Render the self-contained notes in an isolated browser, with no network or scripts. */
export async function renderNotesPdf(html, signal) {
  signal.throwIfAborted();
  const browser = await chromium.launch({ channel: 'chrome', headless: true });
  const close = () => browser.close().catch(() => {});
  signal.addEventListener('abort', close, { once: true });
  try {
    signal.throwIfAborted();
    const context = await browser.newContext({ javaScriptEnabled: false, serviceWorkers: 'block' });
    await context.route('**/*', route => route.abort());
    const page = await context.newPage();
    await page.setContent(html, { waitUntil: 'load' });
    const buffer = await page.pdf({ preferCSSPageSize: true, printBackground: true });
    if (buffer.length > MAX_FILE_BYTES) throw new Error('The combined notes PDF is too large to attach.');
    return { name: 'combined-lecture-notes.pdf', mimeType: 'application/pdf', buffer };
  } finally {
    signal.removeEventListener('abort', close);
    await close();
  }
}

/** One request at a time: they all share one browser profile. */
export function askGemini(job) {
  return inProfile(() => ask(job));
}

async function signedOut(page) {
  if (new URL(page.url()).hostname === 'accounts.google.com') return true;
  return page.getByRole('link', { name: /^sign in$/i }).or(page.getByRole('button', { name: /^sign in$/i })).first().isVisible();
}

async function ask({ prompt, system, images = [], notesPdf, model: modelId, signal, onProgress, session }) {
  signal?.throwIfAborted();
  onProgress?.('Opening Gemini in the bridge browser');
  const selection = parseModel(modelId);
  if (!selection) throw Object.assign(new Error('Unknown Gemini web model.'), { status: 400 });
  if (session && !geminiBrowserSession(session)) throw Object.assign(new Error('This Gemini chat cannot be resumed in the browser.'), { status: 409 });
  const c = await context();
  const page = await c.newPage();
  const fail = async (msg, status = 502) => {
    try { mkdirSync(ERR_DIR, { recursive: true }); await page.screenshot({ path: join(ERR_DIR, `err-${Date.now()}.png`) }); } catch { /* best effort */ }
    throw Object.assign(new Error(msg), { status });
  };
  signal?.addEventListener('abort', () => page.close().catch(() => {}), { once: true });
  try {
    await page.goto(`https://gemini.google.com/app${session ? '/' + session.chatId : ''}`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (await signedOut(page)) throw new GeminiLoginRequired();
    const box = page.locator('[role=textbox]').first();
    try { await box.waitFor({ timeout: 90000 }); } catch {
      if (await signedOut(page)) throw new GeminiLoginRequired();
      await fail('Gemini web: the input box did not appear (the page layout may have changed).');
    }
    if (await signedOut(page)) throw new GeminiLoginRequired();
    const responses = page.locator('model-response, message-content:not(model-response message-content), .model-response-text:not(model-response .model-response-text):not(message-content .model-response-text)');
    if (session) {
      await responses.first().waitFor({ timeout: 20000 }).catch(() => fail('The original Gemini conversation did not load.', 409));
      if (geminiBrowserSessionFor(page.url())?.chatId !== session.chatId) await fail('The original Gemini conversation is unavailable.', 409);
    }
    if (images.length + Number(!!notesPdf) > 10) await fail('Gemini can take up to 10 attachments. With a notes PDF, use at most 9 question screenshots that need to be sent as images.', 400);
    if (images.length || notesPdf) {
      onProgress?.(notesPdf ? 'Uploading the combined notes PDF and any assignment images' : 'Uploading images in the Gemini browser');
      await attach(page, images, notesPdf).catch((e) => fail(`Gemini web: could not attach the files (${e.message.split('\n')[0]}).`));
    }
    await box.click();
    const text = system ? `${system}\n\n${prompt}` : prompt;
    // Long prompts: type() is slow, so insert the text in one go.
    await box.evaluate((el, t) => { el.focus(); document.execCommand('insertText', false, t); }, text);
    await pickModel(page, selection).catch((e) => fail(`Gemini web: could not verify ${modelId || 'auto'} (${e.message.split('\n')[0]}).`));
    await box.focus();
    const resp = responses.nth(await responses.count());
    let rawReply;
    page.on('requestfinished', async request => {
      if (request.method() !== 'POST' || !request.url().includes('/StreamGenerate?')) return;
      try {
        const response = await request.response();
        const reply = response?.ok() && parseReply(await response.text());
        if (reply?.complete) rawReply = reply.text;
      } catch { /* The rendered answer is still available. */ }
    });
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    onProgress?.(`Prompt submitted in Gemini ${selection.model}${selection.level ? ' · ' + selection.level : ''}. Waiting for an answer`);
    const deadline = t0 + MAX_REPLY_MS;
    const mins = Math.round(MAX_REPLY_MS / 60000);
    // thinking models show nothing for a while: wait for the answer to start, up to the same overall limit
    try { await resp.waitFor({ timeout: Math.max(1000, deadline - Date.now()) }); } catch { await fail(`Gemini web did not start answering within ${mins} min.`, 504); }
    // "busy" = the Stop button (or a progress spinner) is still on screen; done = not busy and the text is stable
    const busy = () => page.locator('button[aria-label*="Stop" i], button[aria-label*="stop response" i], [data-test-id="stop-button"], .stop-icon').first().isVisible().catch(() => false);
    let last = '', stable = 0, done = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const body = resp.locator('message-content, .model-response-text, .markdown').first();
      const cur = (await (await body.count() ? body : resp).innerText({ timeout: 2000 }).catch(() => '')).trim();
      stable = cur && cur === last ? stable + 1 : 0;
      last = cur;
      const working = await busy();
      if (cur) onProgress?.('Gemini is writing the answer');
      else if (working) onProgress?.('Gemini shows generation in progress');
      // Wait for the Stop button to disappear and the answer text to settle.
      if (cur && !working && stable >= 2) { done = true; break; }
    }
    if (!last) await fail(`Gemini web returned no answer within ${mins} min.`, 504);
    if (!done) console.log(`[gemini-web] the answer was still changing after ${mins} min; returning what is there`);
    const body = resp.locator('.markdown, message-content, .model-response-text').first();
    const rendered = rawReply ? '' : await readGeminiMarkdown(await body.count() ? body : resp).catch(() => '');
    last = (rawReply || rendered || last).replace(/```[a-z]*\?code_(?:reference|stdout)[^\n]*\n[\s\S]*?```\s*/g, '').trim();
    // Known quirk: the reply can end with the attached file's name.
    for (let i = 0; i < images.length; i++) last = last.replace(/\n?\s*image-?\d*\.(png|jpe?g|webp)\s*$/i, '').trim();
    return { text: last, usage: { in: 0, out: 0 }, truncated: !done && !rawReply, session: geminiBrowserSessionFor(page.url()) };
  } finally {
    await page.close().catch(() => {});
  }
}

/** Upload pictures through the "+" menu (found by label, not by coordinates). */
async function attach(page, images, notesPdf) {
  const files = images.map((im, i) => {
    const buf = Buffer.from(im.b64, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw new Error('picture too large');
    const ext = /jpe?g/.test(im.mime || '') ? 'jpg' : /webp/.test(im.mime || '') ? 'webp' : /text/.test(im.mime || '') ? 'txt' : 'png';
    return { name: im.name || `image-${i + 1}.${ext}`, mimeType: im.mime || 'image/png', buffer: buf };
  });
  if (notesPdf) files.unshift(notesPdf);
  const plus = page.getByRole('button', { name: /upload|add files|open upload|attach|^\+$/i }).first();
  await plus.click({ timeout: 8000 });
  const item = page.getByText('Upload files', { exact: true }).first();
  await item.waitFor({ timeout: 8000 });
  const [chooser] = await Promise.all([page.waitForEvent('filechooser', { timeout: 10000 }), item.click()]);
  await chooser.setFiles(files);
  // wait until every upload preview has finished (no spinner), at most 4 s + 3 s per file
  const until = Date.now() + 4000 + 3000 * files.length;
  await page.waitForTimeout(2000);
  while (Date.now() < until && await page.locator('[role=progressbar], mat-progress-spinner, .loading-spinner').first().isVisible().catch(() => false)) await page.waitForTimeout(500);
}
