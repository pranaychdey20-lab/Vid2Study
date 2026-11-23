/**
 * Math lint for generated notes (ES module, pure functions).
 * Free fixes first (spelled-out Greek letters inside math), and a flag for the one problem that
 * needs the AI: sentences inside \text{...} in math.
 */

const GREEK = 'alpha|beta|gamma|delta|epsilon|varepsilon|zeta|eta|theta|vartheta|iota|kappa|lambda|mu|nu|xi|pi|rho|sigma|tau|upsilon|phi|varphi|chi|psi|omega|Gamma|Delta|Theta|Lambda|Xi|Pi|Sigma|Phi|Psi|Omega';
const BARE_GREEK = new RegExp(`(?<![\\\\A-Za-z])(${GREEK})(?![A-Za-z])`, 'g');
const MATH = /\$\$([\s\S]+?)\$\$|\$([^$\n]+?)\$/g;
const TEXT_CMD = /\\text\{([^{}]*)\}/g;

/** Apply fn to the parts of md outside fenced code blocks. */
function outsideCode(md, fn) {
  return md.split(/(```[\s\S]*?```)/g).map((part, i) => (i % 2 ? part : fn(part))).join('');
}

/** Replace bare Greek names ("theta") inside math with their LaTeX commands ("\theta"). */
export function fixGreek(md) {
  return outsideCode(md, (part) => part.replace(MATH, (m, block, inline) => {
    const tex = block ?? inline;
    const fixed = tex.replace(BARE_GREEK, '\\$1');
    return fixed === tex ? m : block != null ? `$$${fixed}$$` : `$${fixed}$`;
  }));
}

/** True when a \text{...} holds a sentence (more than 3 words). */
const sentenceLike = (s) => s.trim().split(/\s+/).filter(Boolean).length > 3;

/**
 * Find math that still breaks the rules after the free fixes.
 * @returns {string[]} human-readable problems (empty when clean)
 */
export function mathProblems(md) {
  const problems = [];
  outsideCode(md, (part) => {
    for (const m of part.matchAll(MATH)) {
      const tex = m[1] ?? m[2];
      // Prose in math: one long \text{...}, or several short ones that add up to a sentence.
      const texts = [...tex.matchAll(TEXT_CMD)].map((t) => t[1]);
      if (texts.some(sentenceLike) || texts.join(' ').trim().split(/\s+/).filter(Boolean).length > 4) {
        problems.push(`sentence in \\text{}: "${texts.join(' ').trim().slice(0, 40)}"`);
      }
      for (const g of tex.matchAll(BARE_GREEK)) problems.push(`spelled-out symbol: ${g[1]}`);
    }
    return part;
  });
  return problems;
}

/**
 * Lint one notes section: free fixes applied, plus whether the AI is still needed.
 * @returns {{md: string, needsAi: boolean, problems: string[]}}
 */
export function lintSection(md) {
  const fixed = fixGreek(md);
  const problems = mathProblems(fixed);
  return { md: fixed, needsAi: problems.length > 0, problems };
}
