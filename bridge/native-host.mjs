/**
 * Chrome Native Messaging host (started by Chrome for the extension's "Start bridge" button; registered by setup.mjs,
 * and only the extension id found there may talk to it). Messages are JSON with a 4-byte length prefix.
 *   {cmd:'start'} -> starts the bridge detached if it is not running; replies { ok, token, port, started }
 */
import { spawn } from 'node:child_process';
import { readFileSync, existsSync, writeFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { randomBytes } from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.BRIDGE_PORT || 8787);
const TOKEN_FILE = join(HERE, 'token.txt');

function reply(obj) {
  const b = Buffer.from(JSON.stringify(obj));
  const len = Buffer.alloc(4); len.writeUInt32LE(b.length);
  process.stdout.write(Buffer.concat([len, b]), () => process.exit(0));
}

const up = () => fetch(`http://127.0.0.1:${PORT}/ping`, { signal: AbortSignal.timeout(1500) }).then((r) => r.ok, () => false);

async function startBridge() {
  if (!existsSync(TOKEN_FILE)) writeFileSync(TOKEN_FILE, randomBytes(24).toString('hex'));
  let started = false;
  if (!(await up())) {
    // Detached and hidden: it keeps running after this host exits. Logs go to bridge.log.
    const log = join(HERE, 'bridge.log');
    const out = (await import('node:fs')).openSync(log, 'a');
    spawn(process.execPath, [join(HERE, 'server.mjs')], { cwd: HERE, detached: true, stdio: ['ignore', out, out], windowsHide: true }).unref();
    started = true;
    for (let i = 0; i < 20 && !(await up()); i++) await new Promise((r) => setTimeout(r, 500));
  }
  if (!(await up())) return { ok: false, error: 'The bridge did not start (see bridge/bridge.log).' };
  return { ok: true, started, port: PORT, token: readFileSync(TOKEN_FILE, 'utf8').trim() };
}

// Read exactly one message from stdin.
let buf = Buffer.alloc(0);
process.stdin.on('data', async (d) => {
  buf = Buffer.concat([buf, d]);
  if (buf.length < 4 || buf.length < 4 + buf.readUInt32LE(0)) return;
  process.stdin.removeAllListeners('data');
  let msg = {};
  try { msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString('utf8')); } catch { /* ignore */ }
  if (msg.cmd === 'token') reply(existsSync(TOKEN_FILE) ? { ok: true, token: readFileSync(TOKEN_FILE, 'utf8').trim(), port: PORT, running: await up() } : { ok: false, error: 'The bridge has not been started yet.' });
  else if (msg.cmd === 'start') reply(await startBridge().catch((e) => ({ ok: false, error: e.message })));
  else reply({ ok: false, error: 'Unknown command.' });
});
