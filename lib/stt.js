/**
 * Cloud speech-to-text (ES module): any OpenAI-compatible `/audio/transcriptions` endpoint (Groq,
 * OpenAI, ...). 10-minute pieces of the 16 kHz audio are sent as WAV, so a 12-hour lecture takes
 * minutes instead of hours. This is the only place audio leaves the computer, and only when the user
 * picked a provider for the "Speech-to-text AI" slot.
 */
import { gfetch } from './llm.js';
import { isSilent, cleanSegments, asrLang } from './asr.js';
import { fmtTime } from './common.js';

const SR = 16000;
const WINDOW_SEC = 600; // 10 min of 16 kHz mono WAV = 19 MB, under the usual 25 MB upload limit
const pct = (a, b) => (b ? Math.min(100, Math.round((a / b) * 100)) : null);

/** Float32 mono 16 kHz -> WAV file bytes. */
export function wavBlob(f32) {
  const n = f32.length;
  const buf = new ArrayBuffer(44 + n * 2);
  const v = new DataView(buf);
  const w = (p, s) => { for (let i = 0; i < s.length; i++) v.setUint8(p + i, s.charCodeAt(i)); };
  w(0, 'RIFF'); v.setUint32(4, 36 + n * 2, true); w(8, 'WAVE'); w(12, 'fmt ');
  v.setUint32(16, 16, true); v.setUint16(20, 1, true); v.setUint16(22, 1, true);
  v.setUint32(24, SR, true); v.setUint32(28, SR * 2, true); v.setUint16(32, 2, true); v.setUint16(34, 16, true);
  w(36, 'data'); v.setUint32(40, n * 2, true);
  for (let i = 0; i < n; i++) { const s = Math.max(-1, Math.min(1, f32[i])); v.setInt16(44 + i * 2, s < 0 ? s * 32768 : s * 32767, true); }
  return new Blob([buf], { type: 'audio/wav' });
}

/**
 * Same contract as transcribeAudio() in asr.js, but the recognition is done by the provider.
 * @param {{length:number, slice:(a:number,b:number)=>Float32Array|Promise<Float32Array>}} audio
 * @param {{ref:{provider:object, model:string}, language?:string, signal:AbortSignal, progress:Function,
 *          mapTime?:(sec:number)=>number, resume?:object, onWindow?:Function}} o
 */
/**
 * Speech models each service really has, best first. Names differ per service: OpenAI's "whisper-1" does
 * not exist on Groq, and Groq's "whisper-large-v3-turbo" does not exist on OpenAI. Pure.
 */
export function sttModelsFor(provider) {
  const u = String(provider?.baseUrl || '').toLowerCase();
  if (/groq\.com/.test(u)) return ['whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'];
  if (/api\.openai\.com/.test(u)) return ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe'];
  if (/deepinfra|together|fireworks/.test(u)) return ['openai/whisper-large-v3-turbo', 'openai/whisper-large-v3', 'whisper-large-v3'];
  return ['whisper-large-v3-turbo', 'whisper-large-v3', 'whisper-1'];
}

const KNOWN_STT = ['whisper-1', 'gpt-4o-mini-transcribe', 'gpt-4o-transcribe', 'whisper-large-v3-turbo', 'whisper-large-v3', 'distil-whisper-large-v3-en'];
/** The model to use: the chosen one if this service has it (or it is a name we do not know), else the service's best. Pure. */
export function sttModelFor(provider, model) {
  const own = sttModelsFor(provider);
  return !model || (KNOWN_STT.includes(model) && !own.includes(model)) ? own[0] : model;
}

/** "verbose_json is not supported, use json" (OpenRouter and the gpt-4o transcribe models). */
const isPlainOnly = (e) => /verbose_json|timestamp_granularities|response_format/i.test(e?.message || '');
const PLAIN_SEC = 60;

/** "This model does not exist / no access", as opposed to a network or quota error. */
const isModelError = (e) => /\(404\)|does not exist|model_not_found|not found|invalid model|unknown model|do not have access|decommissioned/i.test(e?.message || '');

export async function transcribeCloud(audio, { ref, language = 'en', signal, progress, mapTime, resume, onWindow }) {
  const { provider } = ref;
  let model = sttModelFor(provider, ref.model);
  let modelChecked = !!resume?.segments?.length; // a resumed job already proved its model
  // Some services / models only return plain text (OpenRouter, gpt-4o-*-transcribe): then the audio goes in
  // 1-minute pieces, so every piece still carries its own time.
  let plain = /^gpt-4o/.test(model);
  const map = mapTime || ((s) => s);
  const segments = [...(resume?.segments || [])];
  for (let s = resume?.nextSec || 0; ; s += WINDOW_SEC) {
    if (signal.aborted) throw new DOMException('Aborted', 'AbortError');
    await audio.until?.(Math.floor((s + WINDOW_SEC) * SR)); // live source: wait for a full window, or the end
    if (s * SR >= audio.length) break;
    const dur = audio.length / SR;
    progress('transcribe', pct(s, dur), `Sending audio to ${provider.name || 'the speech service'} ${fmtTime(map(s))} / ${fmtTime(map(dur))}`);
    const slice = await audio.slice(Math.floor(s * SR), Math.min(audio.length, Math.floor((s + WINDOW_SEC) * SR)));
    if (slice.length > SR && !isSilent(slice)) {
      const send = async (m, piece) => {
        const form = new FormData();
        form.append('file', wavBlob(piece), 'audio.wav');
        form.append('model', m);
        if (plain) form.append('response_format', 'json');
        else { form.append('response_format', 'verbose_json'); form.append('timestamp_granularities[]', 'segment'); }
        form.append('temperature', '0');
        if (asrLang(language) !== 'auto') form.append('language', asrLang(language));
        const res = await gfetch(`${String(provider.baseUrl).replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', body: form }, provider, signal,
          (t) => progress('transcribe', null, t));
        return res.json();
      };
      /** One request, recovering (once per job) from a model this service lacks or one that only answers plain json. */
      const ask = async (piece) => {
        try { return await send(model, piece); } catch (e) {
          if (signal.aborted) throw e;
          if (!plain && isPlainOnly(e)) { plain = true; return null; } // caller re-splits the window
          if (modelChecked || !isModelError(e)) throw e;
          for (const m of sttModelsFor(provider).filter((x) => x !== model)) {
            try {
              const d = await send(m, piece);
              console.warn(`[Vid2Study] speech model "${model}" is not available on ${provider.name}, using "${m}"`);
              model = m;
              return d;
            } catch (e2) { if (signal.aborted || !isModelError(e2)) throw e2; }
          }
          throw new Error(`${provider.name || 'The speech service'} has no speech model named "${model}" (also tried ${sttModelsFor(provider).join(', ')}). Pick its speech model in Options > Speech-to-text, or choose "This computer".`);
        }
      };
      const run = async () => {
        const out = [];
        const step = plain ? PLAIN_SEC * SR : slice.length;
        for (let o = 0; o < slice.length; o += step) {
          const piece = plain ? slice.subarray(o, Math.min(slice.length, o + step)) : slice;
          if (plain && (piece.length < SR || isSilent(piece))) continue;
          const wasPlain = plain;
          const data = await ask(piece);
          if (!data) return wasPlain ? out : null; // switched to plain json: start the window again in pieces
          const at = s + o / SR;
          if (Array.isArray(data.segments) && data.segments.length) out.push(...data.segments.map((x) => ({ start: at + x.start, end: at + x.end, text: String(x.text || '') })));
          else if (data.text) out.push({ start: at, end: at + piece.length / SR, text: String(data.text) });
        }
        modelChecked = true;
        return out;
      };
      const segs = (await run()) || (await run());
      for (const x of segs) segments.push({ start: map(x.start), end: map(x.end), text: x.text });
    }
    const next = s + WINDOW_SEC;
    await onWindow?.({ segments: cleanSegments(segments), nextSec: next });
    audio.release?.(Math.floor(next * SR));
  }
  progress('transcribe', 100, 'Transcript ready');
  return cleanSegments(segments);
}
