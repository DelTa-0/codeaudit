// Package names that LLMs are documented to invent.
//
// The point of this list is NOT "these names don't exist" — the registry check
// already answers that, and answers it for names nobody has ever catalogued.
// The point is the case the registry check gets exactly backwards: a
// hallucinated name that someone has since *registered*. Once an attacker owns
// the name, `exists: true` comes back healthy-looking, and every downstream
// signal (downloads, age) is under the attacker's control and can be farmed.
// A name known to be model-generated is evidence that survives registration,
// which is the only kind that helps here.
//
// Why a curated list is worth anything against an unbounded space: the USENIX
// Security 2025 study of 576,000 generated samples found 43% of hallucinated
// package names recur on *every* run of the same prompt, and 38% are
// conflations of two real packages rather than random strings. Hallucinations
// cluster hard, so a small list covers a disproportionate share of real
// exposure.
//
// Adding entries: every row needs a `source` a reader can check. This file is
// a security signal that can block a developer's install, so an unattributed
// guess in it is worse than an empty list. Confirmed phantoms found by our own
// scans belong here too — mark them `source: "codeorion-scan"` with the date.

export interface HallucinatedName {
  /** The invented name, as a model emits it. */
  name: string;
  ecosystem: "npm" | "pypi";
  /** The real package the model was reaching for, when that is known. */
  confusedWith?: string;
  /**
   * How the hallucination is formed. `conflation` merges two real packages,
   * `typo_variant` is a near-miss of one, `fabrication` resembles nothing.
   * From the USENIX taxonomy (38% / 13% / 51% of observed hallucinations).
   */
  shape: "conflation" | "typo_variant" | "fabrication";
  /** Checkable provenance. Never leave this empty. */
  source: string;
}

/**
 * Deliberately small and fully attributed rather than large and speculative.
 * A padded list would produce false warnings on legitimate installs, and one
 * bad warning costs more trust than ten missing entries buy.
 */
export const HALLUCINATED_NAMES: HallucinatedName[] = [
  {
    name: "unused-imports",
    ecosystem: "npm",
    confusedWith: "eslint-plugin-unused-imports",
    shape: "typo_variant",
    source:
      "CSA research note, slopsquatting & the AI supply chain (2026-04-19) — cited as one of the clearest documented cases, where models emit the bare name instead of the eslint-plugin- prefixed real package",
  },
  {
    name: "express-mongoose",
    ecosystem: "npm",
    shape: "conflation",
    source:
      "USENIX Security 2025 package-hallucination study, via the CSA research note (2026-04-19) — the canonical example of a conflation, merging two real packages that have no combined package",
  },
];

const INDEX = new Map<string, HallucinatedName>(
  HALLUCINATED_NAMES.map((h) => [`${h.ecosystem}:${h.name.toLowerCase()}`, h]),
);

/** Corpus lookup. Exact match only — fuzzy matching against invented names
 *  would flag the legitimate packages they were conflated *from*. */
export function lookupHallucinatedName(
  name: string,
  ecosystem: "npm" | "pypi",
): HallucinatedName | null {
  return INDEX.get(`${ecosystem}:${name.toLowerCase()}`) ?? null;
}
