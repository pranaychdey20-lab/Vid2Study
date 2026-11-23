/**
 * yt-dlp backend of the bridge: YouTube captions, audio and video without playing the video in Chrome.
 *   subs(id)              -> { text, lang }         captions as "[mm:ss] text" lines (json3, any track)
 *   media(id, kind, opt)  -> { file, mime, cleanup } audio (m4a) or video-only (mp4, <= maxHeight) on disk
 *   ytdlpStatus()         -> { path, version, updatedAt, nextUpdate }
 *   updateYtDlp(force)    -> runs `yt-dlp --update-to nightly` (YouTube changes often; nightly gets the fixes first)
 *
 * yt-dlp is downloaded on first use into bridge/bin (the official single-file build from GitHub; no Python,
 * no ffmpeg needed: audio and video are fetched as single streams, never merged). It refreshes itself once a
 * week while the bridge runs (checked at start and every 6 hours; skipped while a download is running, since
 * Windows locks a running .exe). Player clients tv / android_vr are tried with the default ones: per yt-dlp's
 * PO-token guide they need no proof-of-origin token.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync, readdirSync, rmSync, chmodSync, createWriteStream } from 'node:fs';
import { join, dirname } from 'node:path';
import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { json3ToLines } from '../lib/ytcaptions.js';

const HERE = dirname(fileURLToPath(import.meta.url));
const BIN = join(HERE, 'bin');
const ASSET = process.platform === 'win32' ? 'yt-dlp.exe' : process.platform === 'darwin' ? 'yt-dlp_macos' : 'yt-dlp';
const EXE = join(BIN, process.platform === 'win32' ? 'yt-dlp.exe' : 'yt-dlp');
const STATE = join(BIN, 'yt-dlp.json');
// downloads are written inside the bridge folder (not the Windows temp folder on C:), so they live on whatever
// drive this folder is on; each job's subfolder is deleted once the file has been sent to the extension
const TMP = join(HERE, 'tmp');
const WEEK = 7 * 24 * 3600 * 1000;
const CLIENTS = ['--extractor-args', 'youtube:player_client=default,tv,android_vr'];

let active = 0; // running yt-dlp jobs (the weekly update waits for 0)
let installing = null;

const readState = () => { try { return JSON.parse(readFileSync(STATE, 'utf8')); } catch { return {}; } };
const writeState = (s) => { mkdirSync(BIN, { recursive: true }); writeFileSync(STATE, JSON.stringify({ ...readState(), ...s }, null, 2)); };
const log = (m) => console.log(`[yt-dlp] ${new Date().toISOString().slice(0, 19)} ${m}`);

/** A YouTube id, never anything else (it ends up on a command line). */
export const validId = (id) => /^[\w-]{11}$/.test(String(id || ''));

/** Run yt-dlp; resolves { code, out, err }. Never through a shell. */
function run(args, { signal, timeoutMs = 30 * 60 * 1000 } = {}) {
  return new Promise((resolve, reject) => {
    mkdirSync(TMP, { recursive: true });
    const p = spawn(EXE, args, { windowsHide: true, cwd: TMP });
    let out = '', err = '';
    p.stdout.on('data', (d) => { out += d; if (out.length > 2e6) out = out.slice(-1e6); });
    p.stderr.on('data', (d) => { err += d; if (err.length > 2e6) err = err.slice(-1e6); });
    const kill = () => { try { p.kill(); } catch { /* gone */ } };
    const timer = setTimeout(kill, timeoutMs);
    signal?.addEventListener('abort', kill, { once: true });
    p.on('error', (e) => { clearTimeout(timer); reject(e); });
    p.on('close', (code) => { clearTimeout(timer); signal?.removeEventListener('abort', kill); resolve({ code, out, err }); });
  });
}

/** Download the official build if it is missing. */
export async function ensureYtDlp() {
  if (existsSync(EXE)) return EXE;
  installing ??= (async () => {
    mkdirSync(BIN, { recursive: true });
    log(`downloading ${ASSET} from GitHub`);
    const res = await fetch(`https://github.com/yt-dlp/yt-dlp/releases/latest/download/${ASSET}`, { redirect: 'follow' });
    if (!res.ok) throw new Error(`Could not download yt-dlp (HTTP ${res.status}).`);
    const tmp = `${EXE}.part`;
    await pipeline(Readable.fromWeb(res.body), createWriteStream(tmp));
    rmSync(EXE, { force: true });
    (await import('node:fs')).renameSync(tmp, EXE);
    if (process.platform !== 'win32') chmodSync(EXE, 0o755);
    writeState({ installedAt: Date.now(), updatedAt: 0 }); // updatedAt 0: switch to nightly right away
    log('installed');
    return EXE;
  })().finally(() => { installing = null; });
  return installing;
}

/** `yt-dlp --update-to nightly` when the last update is a week old (or `force`). Returns a short status. */
export async function updateYtDlp(force = false) {
  if (!existsSync(EXE)) return { ok: false, detail: 'yt-dlp is not installed yet (it is downloaded on first use)' };
  const st = readState();
  if (!force && Date.now() - (st.updatedAt || 0) < WEEK) return { ok: true, detail: 'up to date (checked this week)', skipped: true };
  if (active) return { ok: false, detail: 'a download is running; will update later' };
  active++;
  try {
    const r = await run(['--update-to', 'nightly'], { timeoutMs: 5 * 60 * 1000 });
    const v = await run(['--version'], { timeoutMs: 60 * 1000 }).catch(() => ({ out: '' }));
    const version = v.out.trim();
    if (r.code === 0) { writeState({ updatedAt: Date.now(), version }); log(`updated: ${version}`); return { ok: true, detail: `updated to ${version}` }; }
    log(`update failed: ${r.err.trim().split('\n').pop()}`);
    return { ok: false, detail: r.err.trim().split('\n').pop() || `exit ${r.code}` };
  } finally { active--; }
}

/** Weekly refresh while the bridge runs: at start, then every 6 hours (only acts when a week has passed). */
export function startWeeklyUpdates() {
  // leftovers of a job the bridge was stopped in the middle of
  try { for (const d of readdirSync(TMP)) if (d.startsWith('lh-yt-')) rmSync(join(TMP, d), { recursive: true, force: true }); } catch { /* no tmp yet */ }
  const tick = () => updateYtDlp(false).catch((e) => log(`update check failed: ${e.message}`));
  setTimeout(tick, 20 * 1000).unref?.();
  setInterval(tick, 6 * 3600 * 1000).unref?.();
}

export function ytdlpStatus() {
  const st = readState();
  return { path: existsSync(EXE) ? EXE : null, version: st.version || null, updatedAt: st.updatedAt || null, nextUpdate: st.updatedAt ? st.updatedAt + WEEK : null };
}

const workDir = () => { const d = join(TMP, `lh-yt-${randomBytes(6).toString('hex')}`); mkdirSync(d, { recursive: true }); return d; };
const lastLine = (s) => String(s || '').trim().split('\n').filter((l) => /ERROR|WARNING/.test(l)).pop() || String(s || '').trim().split('\n').pop() || '';

/**
 * Pick the caption file to use from what yt-dlp wrote: English as spoken (en-orig), else English
 * (hand-made, or YouTube's own translation), else the original-language auto track, else anything. Pure.
 * @param {string[]} files  names like "ID.en.json3", "ID.hi-orig.json3"
 */
export function pickSubFile(files) {
  const lang = (f) => (/\.([\w-]+)\.json3$/.exec(f) || [])[1] || '';
  const order = [(l) => l === 'en-orig', (l) => l === 'en', (l) => /^en-/.test(l), (l) => /-orig$/.test(l), () => true];
  for (const ok of order) { const f = files.find((x) => x.endsWith('.json3') && ok(lang(x))); if (f) return { file: f, lang: lang(f).replace(/-orig$/, '') }; }
  return null;
}

/** Captions through yt-dlp (no video download). */
export async function subs(id, { signal } = {}) {
  if (!validId(id)) throw Object.assign(new Error('Not a YouTube video id.'), { status: 400 });
  await ensureYtDlp();
  const dir = workDir();
  active++;
  try {
    const r = await run(['--skip-download', '--write-subs', '--write-auto-subs', '--sub-langs', 'en,en-orig,en-.*,.*-orig', '--sub-format', 'json3',
      '--no-playlist', '--no-warnings', ...CLIENTS, '-o', join(dir, '%(id)s.%(ext)s'), `https://www.youtube.com/watch?v=${id}`], { signal, timeoutMs: 3 * 60 * 1000 });
    const pick = pickSubFile(readdirSync(dir));
    if (!pick) throw Object.assign(new Error(r.code === 0 ? 'This video has no captions.' : `yt-dlp: ${lastLine(r.err)}`), { status: 404 });
    const text = json3ToLines(readFileSync(join(dir, pick.file), 'utf8'));
    if (text.length < 40) throw Object.assign(new Error('The captions were empty.'), { status: 404 });
    return { text, lang: pick.lang };
  } finally { active--; rmSync(dir, { recursive: true, force: true }); }
}

/**
 * Audio (m4a, single stream) or video only (mp4, <= maxHeight, for the slide scan). The caller streams the
 * file to the extension and then calls cleanup().
 */
export async function media(id, kind, { maxHeight = 720, signal } = {}) {
  if (!validId(id)) throw Object.assign(new Error('Not a YouTube video id.'), { status: 400 });
  await ensureYtDlp();
  const h = Math.max(240, Math.min(2160, Number(maxHeight) || 720));
  const format = kind === 'audio'
    ? 'bestaudio[ext=m4a]/bestaudio[acodec^=mp4a]/bestaudio'
    : `bv*[ext=mp4][vcodec^=avc1][height<=${h}]/bv*[ext=mp4][height<=${h}]/bv*[height<=${h}]/bv*`;
  const dir = workDir();
  const cleanup = () => rmSync(dir, { recursive: true, force: true });
  active++;
  try {
    const r = await run(['-f', format, '--no-playlist', '--no-part', '--concurrent-fragments', '4', '--no-warnings', ...CLIENTS,
      '-o', join(dir, `${kind}.%(ext)s`), `https://www.youtube.com/watch?v=${id}`], { signal });
    const file = readdirSync(dir).find((f) => f.startsWith(`${kind}.`));
    if (r.code !== 0 || !file) { cleanup(); throw Object.assign(new Error(`yt-dlp could not get the ${kind}: ${lastLine(r.err)}`), { status: 502 }); }
    const ext = file.split('.').pop().toLowerCase();
    const mime = kind === 'audio' ? (ext === 'webm' ? 'audio/webm' : 'audio/mp4') : (ext === 'webm' ? 'video/webm' : 'video/mp4');
    return { file: join(dir, file), mime, cleanup };
  } catch (e) { cleanup(); throw e; } finally { active--; }
}
