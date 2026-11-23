/**
 * Cheap "is this lecture about programming?" detector (pure, no AI). Looks at the OCR text from the
 * slides and at the words spoken. The result only tells the notes writer whether to give examples as code.
 */

const LANGS = {
  python: [/\bdef\s+\w+\(/, /\bimport\s+\w+/, /\bprint\(/, /\belif\b/, /:\s*$/m, /\bself\b/],
  java: [/\bpublic\s+(static\s+)?(void|class|int)\b/, /System\.out/, /\bnew\s+[A-Z]\w+\(/, /\bString\[\]/],
  c: [/#include\b/, /\bint\s+main\s*\(/, /\bprintf\s*\(/, /\bmalloc\s*\(/, /\bstruct\s+\w+/],
  cpp: [/\bstd::/, /\bcout\s*<</, /\bvector\s*</, /\btemplate\s*</],
  javascript: [/\bfunction\s+\w*\(/, /\bconst\s+\w+\s*=/, /=>/, /console\.log/, /\blet\s+\w+\s*=/],
  sql: [/\bSELECT\b[\s\S]*\bFROM\b/i, /\bINSERT\s+INTO\b/i, /\bCREATE\s+TABLE\b/i],
  matlab: [/\bfunction\s+\w+\s*=/, /\bzeros\(|\bones\(|\beye\(/, /%\s/]
};

export const CODE_LINE =/[{};]\s*$|^\s*(def|class|import|from|function|const|let|var|int|float|double|public|private|return|for|while|if|else|elif|#include)\b|=>|==|!=|<=|>=|\(\)|:=|\+\+|->/;
const CODE_WORDS = /\b(function|variable|loop|compile|compiler|array|pointer|class|method|python|java|javascript|c\+\+|code|syntax|runtime|recursion|algorithm|string|integer|boolean|debug|api)\b/gi;

/**
 * @param {string[]} screenTexts OCR text per frame
 * @param {string} speech all spoken text
 * @returns {{likely:boolean, language:string, ratio:number}}
 */
export function detectCode(screenTexts, speech = '') {
  const lines = screenTexts.join('\n').split('\n').map((l) => l.trim()).filter(Boolean);
  const codeLines = lines.filter((l) => CODE_LINE.test(l)).length;
  const ratio = lines.length ? codeLines / lines.length : 0;
  const words = Math.max(1, speech.split(/\s+/).length);
  const mentions = ((speech.match(CODE_WORDS) || []).length / words) * 1000;
  const all = screenTexts.join('\n');
  let language = '', best = 1;
  for (const [name, res] of Object.entries(LANGS)) {
    const hits = res.filter((r) => r.test(all)).length;
    if (hits > best) { best = hits; language = name; }
  }
  const likely = (lines.length >= 5 && ratio > 0.2) || (ratio > 0.08 && mentions >= 6) || mentions >= 15;
  return { likely, language: likely ? language : '', ratio: Math.round(ratio * 100) / 100 };
}
