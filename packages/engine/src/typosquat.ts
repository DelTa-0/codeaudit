// Typosquat / slopsquat detection — the attack CodeAudit's phantom check
// misses: a package that DOES exist under a name one or two edits away from a
// popular one (reqeusts, expresss, lodahs, python-dotnev). Compares each
// dependency name against a curated popular-package list using Damerau-
// Levenshtein (optimal string alignment) distance. Offline and dependency-free
// so it runs in both the hosted worker and the CLI.
import type { Ecosystem } from "./registry.js";
import { POPULAR_NPM, POPULAR_PYPI } from "./data/popular.js";

const POPULAR: Record<Ecosystem, Set<string>> = {
  npm: new Set(POPULAR_NPM),
  pypi: new Set(POPULAR_PYPI),
};

export interface TyposquatHit {
  /** the popular package this name is suspiciously close to */
  suspectedTarget: string;
  /** edit distance (1 = single typo, 2 = two edits) */
  distance: number;
}

/**
 * Damerau-Levenshtein (optimal string alignment) distance — counts insertions,
 * deletions, substitutions, and adjacent transpositions. Bails out early once
 * the running minimum exceeds `max`, since we only ever care about distance ≤ 2.
 */
function editDistance(a: string, b: string, max: number): number {
  const al = a.length;
  const bl = b.length;
  if (Math.abs(al - bl) > max) return max + 1;
  const prev2 = new Array<number>(bl + 1);
  const prev1 = new Array<number>(bl + 1);
  const curr = new Array<number>(bl + 1);
  for (let j = 0; j <= bl; j++) prev1[j] = j;

  for (let i = 1; i <= al; i++) {
    curr[0] = i;
    let rowMin = curr[0];
    for (let j = 1; j <= bl; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      let v = Math.min(
        prev1[j] + 1, // deletion
        curr[j - 1] + 1, // insertion
        prev1[j - 1] + cost, // substitution
      );
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) {
        v = Math.min(v, prev2[j - 2] + 1); // transposition
      }
      curr[j] = v;
      if (v < rowMin) rowMin = v;
    }
    if (rowMin > max) return max + 1;
    for (let j = 0; j <= bl; j++) {
      prev2[j] = prev1[j];
      prev1[j] = curr[j];
    }
  }
  return prev1[bl];
}

/**
 * Returns the nearest popular package within edit distance 2, or null. A name
 * that IS itself popular is never a squat. Very short names (< 4 chars) are
 * skipped — a one-edit neighborhood is too crowded there to be meaningful.
 * Callers decide how to act on distance 1 (strong) vs 2 (weaker) — see
 * registry.ts, which only escalates a healthy package on distance 1.
 */
export function checkTyposquat(name: string, ecosystem: Ecosystem): TyposquatHit | null {
  const set = POPULAR[ecosystem];
  if (set.has(name) || name.length < 4) return null;

  let best: TyposquatHit | null = null;
  for (const target of set) {
    if (Math.abs(target.length - name.length) > 2 || target.length < 4) continue;
    const distance = editDistance(name, target, 2);
    if (distance >= 1 && distance <= 2 && (!best || distance < best.distance)) {
      best = { suspectedTarget: target, distance };
      if (distance === 1) break; // can't do better than a single edit
    }
  }
  return best;
}
