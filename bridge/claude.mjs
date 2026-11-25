/**
 * Claude CLI backend: one text/image prompt in -> reply out, using the user's Claude *subscription* login.
 *
 * A plain `claude -p` loads the whole Claude Code harness (tool schemas, CLAUDE.md files, memory, skills, MCP
 * servers, plugins, ~100K+ tokens) into every request. For "write me some notes" none of it is needed, so it is
 * stripped with flags, while keeping OAuth/keychain auth working:
 *   --tools ""                    no built-in tools by default, or only WebSearch when requested
 *   --system-prompt <text>        replaces the default Claude Code system prompt
 *   --setting-sources ""          no user / project / local settings, hooks, CLAUDE.md, memory
 *   --strict-mcp-config + empty   no MCP servers
 *   --disable-slash-commands      no skills / commands listing
 *   --no-session-persistence      nothing written to disk
 *   cwd = an empty temp folder    nothing to auto-discover
 * NOT used: --bare (it only accepts an ANTHROPIC_API_KEY, so it would break subscription login), and
 * ANTHROPIC_API_KEY / ANTHROPIC_AUTH_TOKEN are removed from the child's environment so the CLI never
 * silently switches from the subscription to pay-per-token API billing.
 */
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname, delimiter } from 'node:path';

const DEFAULT_SYSTEM = 'You are a careful writing assistant. Follow the instructions in the user message exactly.';
let emptyDir;

/** Find the claude executable. CLAUDE_BIN wins; on Windows the npm shim (claude.cmd) points at a real claude.exe. */
export function findClaude() {
  if (process.env.CLAUDE_BIN) return process.env.CLAUDE_BIN;
  const names = process.platform === 'win32' ? ['claude.exe', 'claude.cmd', 'claude'] : ['claude'];
  for (const dir of (process.env.PATH || '').split(delimiter)) {
    for (const n of names) {
      const f = join(dir, n);
      if (!existsSync(f)) continue;
      if (!f.endsWith('.cmd')) return f;
      const exe = join(dirname(f), 'node_modules', '@anthropic-ai', 'claude-code', 'bin', 'claude.exe');
      if (existsSync(exe)) return exe;
    }
  }
  return null;
}

/**
 * @param {{model?:string, prompt:string, system?:string, images?:{mime:string,b64:string}[], effort?:string, signal?:AbortSignal}} o
 * @returns {Promise<{text:string, usage:{in:number,out:number}, truncated:boolean}>}
 */
export function runClaude({ model, prompt, system, images = [], effort, signal, search = false }) {
  const bin = findClaude();
  if (!bin) return Promise.reject(Object.assign(new Error('Claude CLI not found. Install it (npm i -g @anthropic-ai/claude-code), run `claude` once to sign in, or set CLAUDE_BIN.'), { status: 503 }));
  emptyDir ||= mkdtempSync(join(tmpdir(), 'lh-claude-'));
  const args = ['-p', '--output-format', images.length ? 'stream-json' : 'json', '--tools', search ? 'WebSearch' : '', '--system-prompt', system || DEFAULT_SYSTEM,
    '--setting-sources', '', '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}',
    '--disable-slash-commands', '--no-session-persistence'];
  if (search) args.push('--allowedTools', 'WebSearch');
  if (model) args.push('--model', model);
  if (['low', 'medium', 'high', 'xhigh', 'max'].includes(effort)) args.push('--effort', effort);
  // With pictures the prompt goes in as a stream-json user message (text + image blocks); otherwise plain stdin.
  let stdin = prompt;
  if (images.length) {
    args.push('--input-format', 'stream-json', '--verbose');
    stdin = JSON.stringify({
      type: 'user',
      message: { role: 'user', content: [...images.map((im) => ({ type: 'image', source: { type: 'base64', media_type: im.mime || 'image/png', data: im.b64 } })), { type: 'text', text: prompt }] }
    }) + '\n';
  }
  const env = { ...process.env };
  delete env.ANTHROPIC_API_KEY; delete env.ANTHROPIC_AUTH_TOKEN;
  return new Promise((resolve, reject) => {
    const child = spawn(bin, args, { cwd: emptyDir, env, windowsHide: true });
    let out = '', err = '';
    child.stdout.on('data', (d) => { out += d; });
    child.stderr.on('data', (d) => { err += d; });
    child.on('error', (e) => reject(Object.assign(new Error(`Could not start the Claude CLI: ${e.message}`), { status: 503 })));
    const kill = () => { try { child.kill(); } catch { /* gone */ } };
    signal?.addEventListener('abort', kill, { once: true });
    child.on('close', (code) => {
      let r = null;
      if (images.length) { // stream-json: several lines, the last "result" one holds the answer
        for (const line of out.split('\n')) { try { const j = JSON.parse(line); if (j.type === 'result') r = j; } catch { /* not json */ } }
      } else { try { r = JSON.parse(out); } catch { /* handled below */ } }
      if (!r) return reject(Object.assign(new Error(`Claude CLI failed (exit ${code}): ${(err || out).trim().slice(0, 400) || 'no output'}`), { status: 502 }));
      if (r.is_error) {
        const msg = String(r.result || r.subtype || 'error');
        const login = /login|auth|401|credential/i.test(msg);
        return reject(Object.assign(new Error(login ? `Claude CLI is not signed in: run \`claude\` once in a terminal and log in. (${msg.slice(0, 200)})` : `Claude CLI error: ${msg.slice(0, 400)}`), { status: login ? 401 : 502 }));
      }
      const u = r.usage || {};
      resolve({
        text: String(r.result ?? ''),
        truncated: r.stop_reason === 'max_tokens',
        usage: { in: (u.input_tokens || 0) + (u.cache_creation_input_tokens || 0) + (u.cache_read_input_tokens || 0), out: u.output_tokens || 0 }
      });
    });
    child.stdin.on('error', () => { /* closed early */ });
    child.stdin.end(stdin);
  });
}
