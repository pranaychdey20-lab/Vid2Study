import { execFile, spawn, spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { delimiter, join, resolve } from 'node:path';
import { createInterface } from 'node:readline';

const WINDOWS = process.platform === 'win32';
const LOGIN_REQUIRED = 'Sign in to ChatGPT in a terminal with `codex login`, then try again.';
const INSTALL_REQUIRED = 'Codex CLI not found. Run `npm install -g @openai/codex`, or set CODEX_BIN to the Codex executable.';
const EFFORTS = ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max', 'ultra'];
const IMAGE_EXTENSIONS = new Map([['image/png', 'png'], ['image/jpeg', 'jpg'], ['image/webp', 'webp'], ['image/gif', 'gif']]);
const AUTH_CONFIG = 'cli_auth_credentials_store="auto"';
const failure = (message, status) => Object.assign(new Error(message), { status });
let desktopBin;
let desktopCheckedAt = -Infinity;

export function findCodex() {
  if (process.env.CODEX_BIN) {
    const bin = resolve(process.env.CODEX_BIN);
    return existsSync(bin) ? bin : null;
  }
  const dirs = (process.env.PATH || '').split(delimiter).filter(Boolean);
  if (WINDOWS && process.env.APPDATA) dirs.push(join(process.env.APPDATA, 'npm'));
  for (const dir of dirs) {
    const bin = resolve(dir, WINDOWS ? 'codex.exe' : 'codex');
    if (existsSync(bin)) return bin;
    if (!WINDOWS) continue;
    // npm puts a .cmd shim on PATH. Use its native executable to avoid a shell and allow cancellation.
    const triple = `${process.arch === 'arm64' ? 'aarch64' : 'x86_64'}-pc-windows-msvc`;
    const npmDir = join(dir, 'node_modules', '@openai');
    for (const pkg of [`codex-win32-${process.arch}`, 'codex']) {
      const exe = resolve(npmDir, pkg, 'vendor', triple, 'bin', 'codex.exe');
      if (existsSync(exe)) return exe;
    }
  }
  if (!WINDOWS) return null;
  if (desktopBin && existsSync(desktopBin)) return desktopBin;
  if (Date.now() - desktopCheckedAt < 60000) return null;
  desktopCheckedAt = Date.now();
  // Chrome's PATH may omit the executable bundled with the Windows desktop app.
  const r = spawnSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command',
    'Get-AppxPackage -Name OpenAI.Codex | Select-Object -First 1 -ExpandProperty InstallLocation'],
  { encoding: 'utf8', windowsHide: true, timeout: 3000 });
  const location = r.stdout?.trim();
  desktopBin = location && join(location, 'app', 'resources', 'codex.exe');
  return desktopBin && existsSync(desktopBin) ? desktopBin : null;
}

function subscriptionEnv() {
  return Object.fromEntries(Object.entries(process.env).filter(([key]) =>
    !['OPENAI_API_KEY', 'CODEX_API_KEY', 'OPENAI_BASE_URL', 'CODEX_ACCESS_TOKEN', 'CODEX_AUTH_TOKEN'].includes(key.toUpperCase())));
}

let verifiedLogin;
let pendingLogin;

export async function codexLoginCheck(bin = findCodex(), signal) {
  if (!bin) return { ok: false, detail: INSTALL_REQUIRED };
  return new Promise((resolve) => {
    execFile(bin, ['-c', AUTH_CONFIG, 'login', 'status'],
      { env: subscriptionEnv(), windowsHide: true, timeout: 10000, signal }, (error, stdout, stderr) => {
        const ok = !error && /logged in using chatgpt/i.test(`${stdout}\n${stderr}`);
        const detail = ok ? 'Signed in with ChatGPT'
          : error?.killed || typeof error?.code === 'string' ? 'Could not run Codex CLI to check the ChatGPT sign-in.'
            : LOGIN_REQUIRED;
        resolve({ ok, detail });
      });
  });
}

async function requireSubscription(bin, signal) {
  if (verifiedLogin?.bin === bin && verifiedLogin.expires > Date.now()) return;
  if (pendingLogin?.bin !== bin) {
    const check = codexLoginCheck(bin).then(result => {
      if (result.ok) verifiedLogin = { bin, expires: Date.now() + 60000 };
      return result;
    }).finally(() => { if (pendingLogin?.check === check) pendingLogin = null; });
    pendingLogin = { bin, check };
  }
  const login = await pendingLogin.check;
  signal?.throwIfAborted();
  if (!login.ok) throw failure(login.detail, 401);
}

function runExec(bin, args, cwd, input, signal) {
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd, env: subscriptionEnv(), windowsHide: true, signal });
    const lines = createInterface({ input: child.stdout });
    let text = '', err = '', error = '', usage, spawnError;
    lines.on('line', (line) => {
      let event;
      try { event = JSON.parse(line); } catch { return; }
      if (event.type === 'item.completed' && event.item?.type === 'agent_message') text = event.item.text;
      if (event.type === 'turn.completed') usage = event.usage;
      if (event.type === 'turn.failed') error = event.error?.message || error;
      if (event.type === 'error') error = event.message || error;
    });
    child.stderr.setEncoding('utf8').on('data', (chunk) => { err = (err + chunk).slice(-2000); });
    child.stdin.on('error', () => { /* CLI exited before reading the request */ });
    child.on('error', (e) => { spawnError = e; });
    child.on('close', (code) => {
      if (signal?.aborted) return reject(signal.reason);
      if (spawnError) return reject(failure(`Could not start Codex CLI: ${spawnError.message}`, 503));
      if (code !== 0 || !usage || !text?.trim()) {
        const msg = (error || err.trim().split(/\r?\n/).at(-1) || `exit ${code}, no answer`).slice(0, 600);
        if (/not logged in|sign.in|login|401|authentication|unauthorized/i.test(msg)) {
          verifiedLogin = null;
          return reject(failure(LOGIN_REQUIRED, 401));
        }
        return reject(failure(`Codex CLI: ${msg}`, /429|rate limit|usage limit/i.test(msg) ? 429 : 502));
      }
      resolve({ text, usage: { in: usage.input_tokens || 0, out: usage.output_tokens || 0 }, truncated: false });
    });
    child.stdin.end(input);
  });
}

export async function runCodex({ model, effort, prompt, system, images = [], signal }) {
  const bin = findCodex();
  if (!bin) throw failure(INSTALL_REQUIRED, 503);
  if (model && (typeof model !== 'string' || !/^[\w.:-]+$/.test(model) || model.startsWith('-'))) {
    throw failure('Enter a valid Codex model ID and optional reasoning level, such as gpt-6.2-sol:high.', 400);
  }
  const [id, modelEffort, ...extra] = (model || 'default').split(':');
  const level = modelEffort ?? effort;
  if (!id || extra.length || (level !== undefined && !EFFORTS.includes(level))) {
    throw failure('Choose a reasoning level supported by the selected Codex model.', 400);
  }
  signal?.throwIfAborted();
  await requireSubscription(bin, signal);
  signal?.throwIfAborted();

  const cwd = await mkdtemp(join(tmpdir(), 'lh-codex-'));
  try {
    const instructions = join(cwd, 'instructions.txt');
    await writeFile(instructions, 'Answer the request directly using the supplied text and images.');
    const args = ['exec', '--json', '--ephemeral', '--skip-git-repo-check', '--ignore-user-config', '--sandbox', 'read-only',
      '-c', 'approval_policy="never"', '-c', AUTH_CONFIG, '-c', 'forced_login_method="chatgpt"', '-c', 'web_search="disabled"',
      '-c', `model_instructions_file=${JSON.stringify(instructions)}`,
      '-c', 'project_doc_max_bytes=0',
      '--enable', 'skip_host_skill_discovery', '--enable', 'omit_skill_descriptions',
      '--disable', 'skill_search', '--disable', 'multi_agent',
      '--disable', 'shell_tool', '--disable', 'hooks', '--disable', 'apps', '--disable', 'plugins', '--disable', 'computer_use'];
    if (id !== 'default') args.push('--model', id);
    if (level) args.push('-c', `model_reasoning_effort="${level}"`);

    const labels = [];
    const files = [];
    for (const [i, image] of images.entries()) {
      const ext = IMAGE_EXTENSIONS.get(image?.mime || 'image/png');
      if (!ext || typeof image?.b64 !== 'string' || !image.b64) throw failure('Invalid Codex image attachment.', 400);
      const file = `${i.toString(36)}.${ext}`;
      signal?.throwIfAborted();
      await writeFile(join(cwd, file), Buffer.from(image.b64, 'base64'));
      files.push(file);
      if (image.label) labels.push(`Image ${i + 1}: ${image.label}`);
    }
    if (files.length) args.push(`--image=${files.join(',')}`);
    const input = [system, prompt, labels.length ? `Attached images in order:\n${labels.join('\n')}` : ''].filter(Boolean).join('\n\n');
    return await runExec(bin, [...args, '--', '-'], cwd, input, signal);
  } finally {
    await rm(cwd, { recursive: true, force: true, maxRetries: 3 }).catch(() => {});
  }
}
