/**
 * Gemini consumer web app (gemini.google.com) backend, driven by Playwright over the user's installed Chrome with a
 * persistent profile. Sign in once with `npm run login` (headed); every call after that is HEADLESS.
 * One long-lived headless browser context, one request at a time (queue). Each prompt starts a new chat.
 *
 * UI selectors drift: on failure a screenshot is saved to bridge/errors/ and a short error is returned.
 * Google's terms prohibit automated access to the consumer app: keep volume low, prefer a secondary account.
 */
import { chromium } from 'playwright-core';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';

const HERE = dirname(fileURLToPath(import.meta.url));
export const PROFILE = process.env.GEMINI_PROFILE || join(HERE, 'profile');
const ERR_DIR = join(HERE, 'errors');
export const LAUNCH = { channel: 'chrome', args: ['--disable-blink-features=AutomationControlled'], viewport: { width: 1400, height: 900 } };
// Gemini web (thinking models especially) can take minutes. We wait up to GEMINI_MAX_MS (default 30 min, at least
// 2 min, at most 60 min) for the whole answer, but return the moment it is complete (stop button gone and the text has stopped growing).
const MAX_REPLY_MS = Math.max(120000, Math.min(3600000, Number(process.env.GEMINI_MAX_MS) || 1800000));
const MAX_FILE_BYTES = 100 * 1024 * 1024;

/** "hydrogen-low" -> { model: 'Hydrogen', level: 'Low' }; "auto" -> no change. */
export function parseModel(id) {
  const m = /^(auto|hydrogen|neon)(?:[-:](low|medium|high))?$/i.exec(String(id || 'auto').trim());
  if (!m) return { model: null, level: null };
  const cap = (s) => (s ? s[0].toUpperCase() + s.slice(1).toLowerCase() : null);
  return { model: m[1].toLowerCase() === 'auto' ? null : cap(m[1]), level: cap(m[2]) };
}

let ctx = null;
let queue = Promise.resolve();

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
  const wasOpen = !!ctx;
  const run = queue.then(async () => {
    const c = await context();
    const page = await c.newPage();
    try {
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 });
      await page.locator('[role=textbox]').first().waitFor({ timeout: 45000 }).catch(() => {});
      return !/accounts\.google\.com/.test(page.url()) && (await page.locator('[role=textbox]').count()) > 0;
    } finally { await page.close().catch(() => {}); if (!wasOpen) await closeGemini(); }
  });
  queue = run.catch(() => {});
  return run;
}

/** Google cookies of the signed-in profile (for the HTTP path). Opens the headless browser if it is not open. */
export async function exportGoogleCookies() {
  const wasOpen = !!ctx;
  const run = queue.then(async () => {
    try {
      const c = await context();
      const page = await c.newPage();
      await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 }).catch(() => {});
      await page.waitForTimeout(2500); // let Google refresh rotating cookies (PSIDTS)
      await page.close().catch(() => {});
      return (await c.cookies('https://gemini.google.com', 'https://www.google.com')).filter((x) => /(^|\.)google\.com$/.test(x.domain));
    } finally { if (!wasOpen) await closeGemini(); }
  });
  queue = run.catch(() => {});
  return run;
}

export async function closeGemini() { const c = ctx; ctx = null; await c?.close().catch(() => {}); }

/** One request at a time: they all share one browser profile. */
export function askGemini(job) {
  const run = queue.then(() => ask(job));
  queue = run.catch(() => {});
  return run;
}

async function ask({ prompt, system, images = [], model: modelId, signal }) {
  const { model, level } = parseModel(modelId);
  const c = await context();
  const page = await c.newPage();
  const fail = async (msg, status = 502) => {
    try { mkdirSync(ERR_DIR, { recursive: true }); await page.screenshot({ path: join(ERR_DIR, `err-${Date.now()}.png`) }); } catch { /* best effort */ }
    throw Object.assign(new Error(msg), { status });
  };
  signal?.addEventListener('abort', () => page.close().catch(() => {}), { once: true });
  try {
    await page.goto('https://gemini.google.com/app', { waitUntil: 'domcontentloaded', timeout: 120000 });
    if (/accounts\.google\.com/.test(page.url())) throw Object.assign(new Error('Gemini web is signed out. Run `npm run login` in the bridge folder and sign in.'), { status: 401 });
    const box = page.locator('[role=textbox]').first();
    try { await box.waitFor({ timeout: 90000 }); } catch {
      if (/accounts\.google\.com/.test(page.url())) throw Object.assign(new Error('Gemini web is signed out. Run `npm run login` in the bridge folder and sign in.'), { status: 401 });
      await fail('Gemini web: the input box did not appear (the page layout may have changed).');
    }
    if (model || level) await pickModel(page, model, level).catch((e) => fail(`Gemini web: could not select ${modelId} (${e.message.split('\n')[0]}).`));
    if (images.length) await attach(page, images.slice(0, 10)).catch((e) => fail(`Gemini web: could not attach the pictures (${e.message.split('\n')[0]}).`));
    await box.click();
    const text = system ? `${system}\n\n${prompt}` : prompt;
    // Long prompts: type() is slow, so insert the text in one go.
    await box.evaluate((el, t) => { el.focus(); document.execCommand('insertText', false, t); }, text);
    const t0 = Date.now();
    await page.keyboard.press('Enter');
    const deadline = t0 + MAX_REPLY_MS;
    const mins = Math.round(MAX_REPLY_MS / 60000);
    const resp = page.locator('message-content, .model-response-text, .markdown').last();
    // thinking models show nothing for a while: wait for the answer to start, up to the same overall limit
    try { await resp.waitFor({ timeout: Math.max(1000, deadline - Date.now()) }); } catch { await fail(`Gemini web did not start answering within ${mins} min.`, 504); }
    // "busy" = the Stop button (or a progress spinner) is still on screen; done = not busy and the text is stable
    const busy = () => page.locator('button[aria-label*="Stop" i], button[aria-label*="stop response" i], [data-test-id="stop-button"], .stop-icon').first().isVisible().catch(() => false);
    let last = '', stable = 0, done = false;
    while (Date.now() < deadline) {
      await page.waitForTimeout(1000);
      const cur = (await resp.innerText().catch(() => '')).trim();
      stable = cur && cur === last ? stable + 1 : 0;
      last = cur;
      const working = await busy();
      // finished: no Stop button and 2 s without change; or (if the Stop button cannot be seen at all) 8 s without change
      if (cur && ((!working && stable >= 2) || stable >= 8)) { done = true; break; }
    }
    if (!last) await fail(`Gemini web returned no answer within ${mins} min.`, 504);
    if (!done) console.log(`[gemini-web] the answer was still changing after ${mins} min; returning what is there`);
    // Known quirk: the reply can end with the attached file's name.
    for (let i = 0; i < images.length; i++) last = last.replace(/\n?\s*image-?\d*\.(png|jpe?g|webp)\s*$/i, '').trim();
    return { text: last, usage: { in: 0, out: 0 }, truncated: false };
  } finally {
    await page.close().catch(() => {});
  }
}

const PILL = /^(Auto|Hydrogen|Neon)$/;

/** Choose model and thinking level, only clicking when the current choice differs. */
async function pickModel(page, model, level) {
  const pill = () => page.getByText(PILL).first();
  if (model && (await pill().innerText().catch(() => '')).trim() !== model) {
    await pill().click();
    await page.getByText(`4 ${model}`, { exact: true }).first().click();
    await page.waitForTimeout(800);
    if ((await pill().innerText().catch(() => '')).trim() !== model) throw new Error('the model picker did not change');
  }
  if (level) {
    await pill().click();
    await page.getByText('Thinking level', { exact: true }).first().click();
    await page.getByText(level, { exact: true }).first().click();
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
  }
}

/** Upload pictures through the "+" menu (found by label, not by coordinates). */
async function attach(page, images) {
  const dir = join(tmpdir(), `lh-gemini-${Date.now()}`);
  mkdirSync(dir, { recursive: true });
  const files = images.map((im, i) => {
    const buf = Buffer.from(im.b64, 'base64');
    if (buf.length > MAX_FILE_BYTES) throw new Error('picture too large');
    const ext = /jpe?g/.test(im.mime || '') ? 'jpg' : /webp/.test(im.mime || '') ? 'webp' : 'png';
    const f = join(dir, `image-${i + 1}.${ext}`);
    writeFileSync(f, buf);
    return f;
  });
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
