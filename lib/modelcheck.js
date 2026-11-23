/**
 * Model checks (ES module, needs a DOM for the picture test): does a model of this provider actually answer,
 * and can it see images? Used by the Options page and by the "model failed" window (modelfix.html).
 */
import { generate, gfetch } from './llm.js';
import { wavBlob } from './stt.js';

export const isSpeechModel = (m) => /whisper|transcribe/i.test(m);
/** How long a check may wait: Gemini web (a real browser, thinking models) gets 3 min, the Claude CLI 1 min, APIs 20-25 s. */
const limitFor = (p, ms) => (p?.type === 'geminiweb' || p?.type === 'langdock' ? 600000 : p?.type === 'claudecli' ? 60000 : ms);

export const clipText = (s, n) => { const t = String(s || '').replace(/\s+/g, ' ').trim(); return t.length > n ? `${t.slice(0, n)}…` : t; };

/** Send the smallest possible request to the model. Resolves to a short success note, throws on failure. */
export async function checkModel(p, model) {
  if (!p?.baseUrl) throw new Error('Enter the URL first.');
  const limitMs = limitFor(p, 20000);
  if (!model) throw new Error('Pick or type a model first.');
  const t0 = performance.now();
  try {
    if (isSpeechModel(model)) {
      // 1 s of a quiet tone as WAV: proves the key, the endpoint and the model name
      const f32 = new Float32Array(16000).map((_, i) => 0.05 * Math.sin(i / 8));
      const form = new FormData();
      form.append('file', wavBlob(f32), 'check.wav');
      form.append('model', model);
      form.append('response_format', 'json');
      await gfetch(`${String(p.baseUrl).replace(/\/+$/, '')}/audio/transcriptions`, { method: 'POST', body: form }, p, AbortSignal.timeout(20000), () => {}, { retries: 0 });
    } else {
      const r = await generate(p, model, { prompt: 'Reply with the single word OK.', maxTokens: 512, temperature: 0, signal: AbortSignal.timeout(limitMs), retries: 0 });
      if (!r?.text?.trim() && r?.finishReason !== 'MAX_TOKENS') throw new Error('The model answered with nothing.');
    }
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`No answer within ${Math.round(limitMs / 1000)} s (the model may be overloaded or the name wrong).`);
    throw e;
  }
  return `Working: ${model} answered in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
}

/**
 * Can the model SEE? Sends a small picture (a red square with a big black "7") and asks what it shows.
 * A text-only model either rejects the image (error) or answers without seeing it (guesses wrong).
 */
export async function checkVision(p, model) {
  if (!p?.baseUrl) throw new Error('Pick a provider first.');
  if (!model) throw new Error('Pick or type a model first.');
  if (isSpeechModel(model)) throw new Error(`${model} is a speech model, not a vision model.`);
  const c = document.createElement('canvas');
  c.width = c.height = 96;
  const g = c.getContext('2d');
  g.fillStyle = '#e00000'; g.fillRect(0, 0, 96, 96);
  g.fillStyle = '#000'; g.font = 'bold 72px Arial'; g.textAlign = 'center'; g.textBaseline = 'middle'; g.fillText('7', 48, 52);
  const b64 = c.toDataURL('image/png').split(',')[1];
  const t0 = performance.now();
  let r;
  try {
    r = await generate(p, model, {
      prompt: 'Look at the image. Reply in the form "<colour> <digit>": the background colour and the digit shown. Nothing else.',
      images: [{ mime: 'image/png', b64 }], maxTokens: 512, temperature: 0, signal: AbortSignal.timeout(limitFor(p, 25000)), retries: 0
    });
  } catch (e) {
    if (e?.name === 'TimeoutError' || e?.name === 'AbortError') throw new Error(`No answer within ${Math.round(limitFor(p, 25000) / 1000)} s (the model may be overloaded or the name wrong).`);
    if (/image|vision|multimodal|modalit|content type|image_url|not support/i.test(e.message)) throw new Error(`${model} does not accept images (${e.message}). Pick a vision model.`);
    throw e;
  }
  const text = String(r?.text || '').toLowerCase();
  const sees = /red/.test(text) && /\b7\b|seven/.test(text);
  if (!sees) throw new Error(`${model} answered "${clipText(r?.text, 60)}" but did not read the test picture (red, 7): it probably cannot see images. Pick a vision model.`);
  return `Sees images: ${model} read the test picture correctly in ${((performance.now() - t0) / 1000).toFixed(1)} s.`;
}
