// Canonicalization for AI instruction text.
//
// The problem this exists to solve: a prompt-injection payload can be rewritten
// so that it is byte-different and semantically identical. `Ignore all
// previous instructions` becomes `Ignore **all prevіous** instructions` — one
// markdown emphasis and one Cyrillic U+0456 — and a literal matcher goes
// silent while the model reading the file obeys exactly as before. The scanner
// and the victim were reading different documents.
//
// Three deliberate limits run through this module:
//
//   - **Tier 2 only.** Nothing here may touch the tier-1 shell rules. Those
//     match literal syntax where `|` and `;` ARE the signal; folding
//     punctuation to spaces would destroy `curl | sh` detection. See
//     agentConfig.ts, where the raw line is passed to tier 1 and the canonical
//     form only to the phrase rules.
//   - **Never user-visible.** The canonical form is a matching key, not text.
//     Findings quote the original file content, which is what keeps the
//     evidence contract in redactSnippet honest — reporting canonical text
//     would show a user a line that does not exist in their file.
//   - **No dependency.** A supply-chain scanner that pulls a transitive tree
//     to read its own input has argued against itself. Everything below uses
//     built-in `String.prototype.normalize` and Unicode property escapes.
//
// What this cannot do is documented rather than chased: acrostic payloads,
// semantic paraphrase with no shared keyword, and payloads staged across two
// files all pass through untouched. Canonicalization closes the character
// layer, not the meaning layer.

/**
 * Characters that occupy no visual space, and therefore change a string
 * without changing what a reader — human or model — perceives.
 *
 * Covers zero-width forms, the word joiner, BOM, soft hyphen, directional
 * marks, bidi isolates and overrides, and the Unicode tag block. Deliberately
 * a superset of the tier-1 `hidden_text` detectors: those rules REPORT these
 * characters as findings in their own right, while this constant removes them
 * so a payload hiding behind one is still matchable. Both behaviours are
 * wanted, which is why the character list appears in two places rather than
 * one shared helper that would force them to agree.
 */
export const INVISIBLE_CHARS =
  /[­؜᠎​-‏⁠-⁤⁪-⁯﻿]|[‪-‮⁦-⁩]|[\u{E0000}-\u{E007F}]/gu;

/**
 * Cyrillic and Greek characters that render as Latin letters.
 *
 * Deliberately hand-listed rather than generated from the full UTS #39
 * confusables set (~6,565 entries): only characters that fold to an ASCII
 * letter can affect a Latin-alphabet phrase rule, so the reachable subset is
 * small and stays small. The shape is a flat source-to-target object
 * specifically so it can later be regenerated from `confusables.txt` by a
 * script without any consumer changing.
 *
 * This is a matching aid, not a security boundary. `MIXED_SCRIPT_WORD` in
 * agentConfig.ts is the rule that treats script mixing as evidence in itself,
 * and it does not depend on this table being complete.
 */
export const CONFUSABLE_FOLD: Readonly<Record<string, string>> = Object.freeze({
  // Cyrillic, lowercase
  "а": "a", // а
  "е": "e", // е
  "о": "o", // о
  "р": "p", // р
  "с": "c", // с
  "х": "x", // х
  "у": "y", // у
  "і": "i", // і
  "ј": "j", // ј
  "һ": "h", // һ
  "ѕ": "s", // ѕ
  "м": "m", // м
  "т": "t", // т
  "в": "b", // в
  "к": "k", // к
  "н": "h", // н
  // Cyrillic, uppercase
  "А": "A", // А
  "В": "B", // В
  "С": "C", // С
  "Е": "E", // Е
  "Н": "H", // Н
  "К": "K", // К
  "М": "M", // М
  "О": "O", // О
  "Р": "P", // Р
  "Т": "T", // Т
  "Х": "X", // Х
  "Ѕ": "S", // Ѕ
  "І": "I", // І
  "Ј": "J", // Ј
  // Greek, lowercase
  "ο": "o", // ο
  "α": "a", // α
  "ε": "e", // ε
  "ι": "i", // ι
  "κ": "k", // κ
  "ν": "v", // ν
  "ρ": "p", // ρ
  "τ": "t", // τ
  "υ": "u", // υ
  "χ": "x", // χ
  // Greek, uppercase
  "Α": "A", // Α
  "Β": "B", // Β
  "Ε": "E", // Ε
  "Η": "H", // Η
  "Ι": "I", // Ι
  "Κ": "K", // Κ
  "Μ": "M", // Μ
  "Ν": "N", // Ν
  "Ο": "O", // Ο
  "Ρ": "P", // Ρ
  "Τ": "T", // Τ
  "Υ": "Y", // Υ
  "Χ": "X", // Χ
});

/**
 * Emphasis characters deleted outright rather than replaced with a space,
 * because markdown allows them INSIDE a word: `prev**i**ous` must fold to
 * `previous`, not to `prev i ous`.
 *
 * `_` is deliberately absent. CommonMark does not honour intra-word
 * underscore emphasis, so `_` is always a separator in practice and is left to
 * the punctuation step — which is also what makes `ignore_previous` fold to
 * two words rather than one run-on.
 */
const MARKDOWN_EMPHASIS = /[*`~]/g;

/** Everything that is neither a letter, a number, nor whitespace. */
const NON_WORD = /[^\p{L}\p{N}\s]/gu;

const WHITESPACE_RUN = /\s+/g;

/**
 * Printable ASCII plus tab. For a line made only of these, three of the
 * seven pipeline steps are provably no-ops — NFKC has nothing to decompose,
 * there are no invisible characters, and no key in CONFUSABLE_FOLD is ASCII
 * (asserted in the canonicalize suite). Skipping them is not an
 * approximation; it is the same answer without the allocation.
 *
 * This matters because it is the overwhelmingly common case: an ordinary
 * English instruction file is entirely ASCII, and the confusable fold is the
 * most expensive step, allocating an array per line to iterate code points.
 */
const PURE_ASCII = /^[\x20-\x7E\t]*$/;

/** The steps that ran and actually changed the text, in pipeline order. */
export type CanonicalizationStep =
  | "nfkc"
  | "invisible_strip"
  | "confusable_fold"
  | "markdown_strip"
  | "punctuation_fold"
  | "whitespace_collapse"
  | "lowercase";

export interface CanonicalizationTrace {
  /** The canonical form. A matching key — never shown to a user. */
  text: string;
  /**
   * Which steps changed the input. Reported on a finding so a reviewer can
   * see WHY a match needed canonicalization: `confusable_fold` present means
   * someone put a Cyrillic character inside a Latin word, which is a fact
   * about intent, not about our matcher.
   */
  transformations: CanonicalizationStep[];
}

/**
 * Folds instruction text to a canonical matching key.
 *
 * Pure and deterministic: same input, same output, no I/O, no clock, no
 * locale dependence (`toLowerCase` is called without a locale argument
 * precisely so a Turkish-locale host cannot change what the scanner matches).
 *
 * Composes across a space join — `canonicalize(a + " " + b)` equals
 * `canonicalize(a) + " " + canonicalize(b)` — because every step is either
 * character-local or a whitespace collapse. agentConfig.ts relies on this to
 * canonicalize each line once and assemble multi-line windows from the
 * cached results, which is what keeps the sliding window O(n) rather than
 * O(n × window sizes).
 */
export function canonicalizeInstructionText(text: string): string {
  return canonicalizeWithTrace(text).text;
}

/** As `canonicalizeInstructionText`, but reporting which steps did work. */
export function canonicalizeWithTrace(text: string): CanonicalizationTrace {
  const transformations: CanonicalizationStep[] = [];
  const step = (before: string, after: string, name: CanonicalizationStep) => {
    if (before !== after) transformations.push(name);
    return after;
  };

  let t = text;
  if (!PURE_ASCII.test(text)) {
    // 1. NFKC. Resolves compatibility forms — fullwidth Ｉ (U+FF29) to I — but
    //    NOT confusables, which are distinct characters with no compatibility
    //    relation to their Latin lookalikes. Step 3 exists because of that.
    t = step(t, t.normalize("NFKC"), "nfkc");

    // 2. Invisible characters. Removed, not spaced: a zero-width space inside
    //    a word is meant to split it for a matcher while leaving it whole for
    //    a reader, so closing the gap is the correct inverse.
    t = step(t, t.replace(INVISIBLE_CHARS, ""), "invisible_strip");

    // 3. Confusable fold. Iterated by code point so astral characters stay
    //    single units.
    t = step(
      t,
      Array.from(t)
        .map((ch) => CONFUSABLE_FOLD[ch] ?? ch)
        .join(""),
      "confusable_fold",
    );
  }

  // 4. Markdown emphasis, deleted (see MARKDOWN_EMPHASIS).
  t = step(t, t.replace(MARKDOWN_EMPHASIS, ""), "markdown_strip");

  // 5. Remaining punctuation to spaces, so `ignore,previous` and
  //    `ignore-previous` both become two words rather than one token.
  t = step(t, t.replace(NON_WORD, " "), "punctuation_fold");

  // 6. Collapse. This is also what makes a multi-line window join cleanly.
  t = step(t, t.replace(WHITESPACE_RUN, " ").trim(), "whitespace_collapse");

  // 7. Case. Last, so the steps above see the text as written.
  t = step(t, t.toLowerCase(), "lowercase");

  return { text: t, transformations };
}

const LATIN = /\p{Script=Latin}/u;
/** Split on anything that is not a letter, mark or digit — i.e. into words. */
const TOKEN_SPLIT = /[^\p{L}\p{M}\p{N}]+/u;
/** Present-at-all check, so the token walk runs only when it could matter. */
const CYRILLIC_OR_GREEK = /[\p{Script=Cyrillic}\p{Script=Greek}]/u;

/**
 * Words that mix Latin with Cyrillic or Greek characters.
 *
 * The discipline is per-token, and that is the whole design. A wholly Russian
 * `CLAUDE.md` is a legitimate document written by a Russian-speaking team; a
 * Latin word with one Cyrillic character in the middle of it is not a
 * document written by anyone. Testing per-document would flag the first and
 * catch the second only by accident; testing per-token flags exactly the
 * second.
 *
 * Accented Latin (`café`, `naïve`) is unaffected — those characters are
 * Script=Latin, so the token is single-script and never reported.
 *
 * The non-Latin character must be a known Latin *lookalike* — a key in
 * CONFUSABLE_FOLD — not merely non-Latin. Running the first version over 695
 * real third-party instruction files produced three false positives and
 * every one was mathematics: `nθ`, `Σₖ Xₖ`, `Σ₂ᴾ`. A Greek letter used as a
 * mathematical symbol impersonates nothing; theta looks like no Latin
 * letter, so a Latin word beside it is notation, not spoofing. Requiring a
 * lookalike is not a carve-out for maths — it is what the rule always meant.
 */
export function findMixedScriptWords(text: string): string[] {
  // A token can only mix scripts if a non-Latin script is present at all.
  // One regex over the line replaces splitting it into tokens and testing
  // three properties on each — and for ordinary English prose, which is
  // every line of nearly every instruction file, it answers immediately.
  if (!CYRILLIC_OR_GREEK.test(text)) return [];
  const found: string[] = [];
  for (const token of text.split(TOKEN_SPLIT)) {
    if (!token) continue;
    if (!LATIN.test(token)) continue;
    if (!Array.from(token).some((ch) => ch in CONFUSABLE_FOLD)) continue;
    found.push(token);
  }
  return found;
}
