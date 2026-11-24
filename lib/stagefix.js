export function needsGeminiSignIn(info) {
  return info?.code === 'GEMINI_LOGIN_REQUIRED' ||
    (info?.status === 401 && /Gemini web is signed out/i.test(info.reason || info.message || ''));
}

/**
 * Plain-language advice for the "model did not work" window (ES module, pure).
 * @param {{status:number|null, reason:string, slot:string, skip?:string|null}} info  a StageError's info
 * @returns {string}
 */
export function adviceFor(info) {
  const reason = String(info?.reason || '');
  const status = info?.status;
  if (needsGeminiSignIn(info)) return 'Sign in to Gemini to resume from this step.';
  if (/image|vision|multimodal|modalit/i.test(reason)) {
    return 'This model cannot read pictures. Pick a model that accepts image input (use "Test this model": it sends a small picture).';
  }
  if (status === 404) return 'The provider does not know this model: the name may be wrong, the model may have been removed, or it is not on your account. Pick another model from the list.';
  if (status === 401 || status === 403) return 'The provider refused the API key or this model. Check the key in Options, or pick another model.';
  if (status === 429) return 'The provider\'s rate or quota limit was reached (common with free models). Wait a little and continue with the same model, or pick another one.';
  if (status === 400 || status === 413) return 'The provider rejected the request: this model may not accept this kind of input or this much text. Pick another model.';
  if (status === 0) return 'The provider could not be reached. Check your internet connection and the provider URL in Options, then continue.';
  if (status >= 500) return 'The provider had a problem on its side. Continue in a moment with the same model, or pick another one.';
  return info?.slot === 'stt'
    ? 'The speech-to-text service did not answer. Pick another model, or use Whisper on this computer.'
    : 'The model did not answer. Pick another model, or try the same one again.';
}
