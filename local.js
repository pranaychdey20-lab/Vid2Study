/**
 * "Summarize from a file" page: pick or drop an MP4, run the shared pipeline on it.
 * The File stays on disk (it is sliced for upload and played through an object URL), so nothing
 * is copied into memory up front. The tab must stay open while the job runs.
 */
import { runPipeline } from './lib/pipeline.js';
import { cleanUrl } from './lib/common.js';
import { loadSettings, settingsProblem } from './lib/settings.js';

const $ = (id) => document.getElementById(id);
let file = null;
let controller = null;

function setMsg(text, bad) {
  $('msg').textContent = text || '';
  $('msg').className = `msg${bad ? ' bad' : ''}`;
}

function setProgress(percent, text) {
  $('prog').hidden = false;
  $('ptext').textContent = text || '';
  const bar = $('bar');
  bar.classList.toggle('indet', percent == null);
  bar.firstElementChild.style.width = percent == null ? '' : `${percent}%`;
}

function pickFile(f) {
  if (!f) return;
  if (!/\.(mp4|m4a|mov|wav|mp3|aac|webm|ogg|opus)$/i.test(f.name) && !/^(video|audio)\//.test(f.type)) return setMsg('Choose an MP4, M4A or other video / audio file.', true);
  file = f;
  setMsg('');
  $('fileInfo').textContent = `${f.name} · ${(f.size / 1024 / 1024).toFixed(1)} MB`;
  if (!$('title').value) $('title').value = f.name.replace(/\.\w+$/, '');
  $('start').disabled = false;
}

/** The cache key is the clean CDN URL when given, so it matches summaries made from the server. */
const cacheKey = () => cleanUrl($('url').value.trim()) || `local:${file.name}:${file.size}`;

async function start() {
  const settings = await loadSettings();
  const problem = settingsProblem(settings, 'video');
  if (problem) return setMsg(problem, true);
  const key = cacheKey();
  const title = $('title').value.trim() || file.name;
  controller = new AbortController();
  $('start').disabled = true;
  $('cancel').hidden = false;
  $('view').hidden = true;
  setMsg('');
  setProgress(null, 'Starting');
  const guard = (e) => e.preventDefault();
  addEventListener('beforeunload', guard);
  try {
    let transcript;
    const capFile = $('caps').files[0];
    if (capFile) {
      // same parser the content script uses; it is a classic script, so load it once here
      if (!window.__lhUtil) await import(chrome.runtime.getURL('adapters/util.js')).catch(() => {});
      transcript = window.__lhUtil?.parseCaptions(await capFile.text());
      if (transcript && transcript.length < 40) transcript = undefined;
    }
    await runPipeline({
      mode: 'video', audioOnly: /\.(m4a|wav|mp3|aac|ogg|opus)$/i.test(file.name) || file.type.startsWith('audio/'), getSource: async () => file, key, title, course: $('course').value.trim(), settings, transcript,
      signal: controller.signal, onProgress: (_s, p, t) => setProgress(p, t), regenerate: false
    });
    $('view').href = `${chrome.runtime.getURL('results.html')}?key=${encodeURIComponent(key)}`;
    $('view').hidden = false;
    setProgress(100, 'Done');
  } catch (e) {
    setProgress(0, '');
    $('prog').hidden = true;
    setMsg(controller.signal.aborted ? 'Cancelled.' : e.message || String(e), true);
  } finally {
    removeEventListener('beforeunload', guard);
    $('cancel').hidden = true;
    $('start').disabled = false;
    controller = null;
  }
}

$('drop').addEventListener('click', () => $('file').click());
$('drop').addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); $('file').click(); } });
$('file').addEventListener('change', () => pickFile($('file').files[0]));
for (const ev of ['dragenter', 'dragover']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.add('over'); });
for (const ev of ['dragleave', 'drop']) $('drop').addEventListener(ev, (e) => { e.preventDefault(); $('drop').classList.remove('over'); });
$('drop').addEventListener('drop', (e) => pickFile(e.dataTransfer.files[0]));
$('start').addEventListener('click', start);
$('cancel').addEventListener('click', () => { controller?.abort(); setMsg('Cancelling…'); });
$('url').addEventListener('change', () => {
  const hit = $('known').querySelector(`option[value="${CSS.escape($('url').value)}"]`);
  if (hit && !$('title').value.trim()) $('title').value = hit.label;
});

// Offer the lectures from any course list cached by the drawer.
chrome.storage.session.get(null).then((all) => {
  for (const [k, v] of Object.entries(all)) {
    if (!k.startsWith('course_') || !v?.lectures) continue;
    for (const l of v.lectures) $('known').append(new Option(`${v.name} / ${l.title}`, l.url));
  }
}).catch(() => {});
