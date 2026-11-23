/**
 * Test runner: `node tests/run.mjs` (or `npm test`). No dependencies, no browser.
 * It copies lib/ (without the big vendored libraries) into a temp folder, swaps lib/db.js and lib/llm.js
 * for the in-memory stubs in tests/stubs/, copies tests/cases/ next to it and runs each case with node.
 * Covers the pure logic only (chunking, alignment, scene detection, frame classifier, MP4 audio reader,
 * live transcription, cloud speech-to-text windows, the pipeline end to end with a fake AI).
 * Not covered: anything that needs Chrome (Whisper, Tesseract, canvas, the YouTube page, WebCodecs).
 */
import { cpSync, mkdtempSync, writeFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const dir = mkdtempSync(join(tmpdir(), 'lh-test-'));
cpSync(join(root, 'lib'), join(dir, 'lib'), { recursive: true, filter: (p) => !/[\\/](vendor|katex)([\\/]|$)/.test(p) });
for (const f of ['db.js', 'llm.js']) cpSync(join(root, 'tests', 'stubs', f), join(dir, 'lib', f));
cpSync(join(root, 'tests', 'cases'), dir, { recursive: true });
writeFileSync(join(dir, 'package.json'), '{"type":"module"}');

let failed = 0;
for (const f of readdirSync(join(root, 'tests', 'cases')).filter((x) => x.endsWith('.mjs')).sort()) {
  const r = spawnSync(process.execPath, [f], { cwd: dir, encoding: 'utf8' });
  const ok = r.status === 0;
  if (!ok) failed++;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${f}`);
  if (!ok || process.env.VERBOSE) console.log((r.stdout + r.stderr).split('\n').map((l) => `      ${l}`).join('\n'));
}
rmSync(dir, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
