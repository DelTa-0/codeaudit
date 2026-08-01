/**
 * Licence classification for SPDX-style expressions.
 *
 * Real registry data is not a single tidy identifier. npm and PyPI both ship
 * compound expressions ("BSD-3-Clause AND MIT", "(MIT OR GPL-2.0)"), exception
 * clauses ("Apache-2.0 WITH LLVM-exception"), and sometimes the entire licence
 * text. Prefix-matching the whole string only ever inspects the first term, so
 * "MIT AND GPL-3.0-only" reads as permissive and a copyleft obligation
 * disappears — a false negative on a legal risk.
 */
export type LicenseClass = "permissive" | "weak-copyleft" | "strong-copyleft" | "unknown";

const STRONG = /^(AGPL|GPL|SSPL|OSL|EUPL)/i;
const WEAK = /^(LGPL|MPL|EPL|CDDL|CECILL-C|Artistic)/i;
const PERMISSIVE = /^(MIT|ISC|Apache|BSD|BSL|0BSD|Unlicense|CC0|Zlib|PSF|Python|WTFPL|MIT-0)/i;

/** One bare licence identifier, no operators. */
export function classifyLicenseTerm(term: string): LicenseClass {
  const t = term.trim().replace(/^\(+|\)+$/g, "").trim();
  if (!t) return "unknown";
  // LGPL must be tested before GPL — "LGPL-3.0" contains "GPL".
  if (WEAK.test(t)) return "weak-copyleft";
  if (STRONG.test(t)) return "strong-copyleft";
  if (PERMISSIVE.test(t)) return "permissive";
  return "unknown";
}

const RESTRICTIVENESS: Record<LicenseClass, number> = {
  permissive: 0,
  unknown: 1,
  "weak-copyleft": 2,
  "strong-copyleft": 3,
};

/**
 * Classify a whole expression.
 *
 * OR means the consumer may choose, so the LEAST restrictive alternative wins —
 * "MIT OR GPL-2.0" can be taken as MIT. AND means every obligation applies, so
 * the MOST restrictive term wins. WITH attaches an exception that relaxes the
 * base licence, so the base term governs.
 */
export function classifyLicenseExpression(expression: string): LicenseClass {
  const alternatives = expression.split(/\s+OR\s+/i);
  let best: LicenseClass | null = null;
  for (const alternative of alternatives) {
    // Within one alternative every AND-ed obligation applies; WITH relaxes, so
    // only the base term before it is classified.
    const terms = alternative.split(/\s+AND\s+/i).map((t) => t.split(/\s+WITH\s+/i)[0]);
    let worst: LicenseClass = "permissive";
    for (const term of terms) {
      const cls = classifyLicenseTerm(term);
      if (RESTRICTIVENESS[cls] > RESTRICTIVENESS[worst]) worst = cls;
    }
    if (best === null || RESTRICTIVENESS[worst] < RESTRICTIVENESS[best]) best = worst;
  }
  return best ?? "unknown";
}
