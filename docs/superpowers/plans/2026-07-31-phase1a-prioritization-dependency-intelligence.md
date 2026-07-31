# Phase 1a — Prioritization & Dependency Intelligence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank existing findings so engineers know what to fix first, and surface deprecated / licence-conflicting / duplicate dependencies from registry metadata already being downloaded.

**Architecture:** Four new pure modules in `packages/engine/src/` (`duplicates.ts`, `license.ts`, `priority.ts`, `data/equivalents.ts`) plus extended metadata extraction in the two existing registry clients. All pure and offline-testable except the registry extraction. Results ride `scan_jobs.summary` JSONB — no migration, no new API endpoint.

**Tech Stack:** TypeScript, Node 18+, `@codeaudit/engine` workspace, esbuild CLI bundle, React 19 dashboard, ground-truth assertion suite.

## Global Constraints

- **Engine stays LLM-free, heavy-dependency-free, and subprocess-free.** No new npm dependencies in `packages/engine/`.
- **No database migration in this plan.** Everything rides `registryMetadata` / `summary` JSONB.
- **No new HTTP requests.** Deprecation, licence and size come from packuments already fetched.
- **Precision over recall.** Every new detector must have a must-NOT-fire ground-truth case, per the false-positive history in `docs/roadmap.md`.
- **New findings are advisory-only in this plan** — they must NOT change `computeSummary`'s score. Secrets scoring lands in the Phase 1b plan.
- Ground-truth suite is the test harness: `npm run test:ground-truth --prefix server`. Tests are `[label, boolean]` pairs pushed to `checks`.
- Sort orderings are **lexicographic, never weighted sums** (spec: `docs/superpowers/specs/2026-07-31-phase1-signal-design.md`).

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/engine/src/data/equivalents.ts` | **Create.** Curated equivalent-library groups. Data only, no logic. |
| `packages/engine/src/duplicates.ts` | **Create.** `findDuplicateLibraries()` over verdicts. |
| `packages/engine/src/license.ts` | **Create.** `readProjectLicense()`, `checkLicenseConflicts()`. |
| `packages/engine/src/priority.ts` | **Create.** `rankFindings()` — the ranking. |
| `packages/engine/src/registry.ts` | **Modify.** Extract `deprecated`/`license`/`unpackedSize` from the existing packument. |
| `packages/engine/src/python/registry.ts` | **Modify.** Extract `license`/`yanked` from the existing PyPI doc. |
| `packages/engine/src/index.ts` | **Modify.** Export the new surface. |
| `server/src/worker.ts` | **Modify.** Call new modules, add `priorities`/`advisories` to summary. |
| `server/test/ground-truth.ts` | **Modify.** New assertions. |
| `cli/src/index.ts` | **Modify.** "Fix first" section. |
| `web/src/pages/ScanDetail.tsx` | **Modify.** Fix-first card, consolidation card, dependency badges. |
| `server/src/queue/prComment.ts` | **Modify.** Lead with top 3. |

---

### Task 1: Equivalent-library data + duplicate detection

**Files:**
- Create: `packages/engine/src/data/equivalents.ts`
- Create: `packages/engine/src/duplicates.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Consumes: `DependencyVerdict`, `Ecosystem` from `./registry.js`
- Produces: `findDuplicateLibraries(deps: DependencyVerdict[]): DuplicateGroup[]`, `interface DuplicateGroup { category: string; ecosystem: Ecosystem; packages: string[]; prefer: string | null; recommendation: string }`

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts`, immediately before the `console.log("--- checks ---")` line:

```ts
// --- Duplicate-library detection (offline, pure) ---
const dupDeps = [
  { packageName: "moment", declaredVersion: "^2.30.0", status: "healthy", ecosystem: "npm", registryMetadata: null },
  { packageName: "dayjs", declaredVersion: "^1.11.0", status: "healthy", ecosystem: "npm", registryMetadata: null },
  { packageName: "lodash", declaredVersion: "^4.17.21", status: "healthy", ecosystem: "npm", registryMetadata: null },
  { packageName: "underscore", declaredVersion: "^1.13.0", status: "unused", ecosystem: "npm", registryMetadata: null },
] as const;
const dupGroups = findDuplicateLibraries(dupDeps as unknown as Parameters<typeof findDuplicateLibraries>[0]);
checks.push(
  ["duplicate detection finds the date group", dupGroups.some((g) => g.category === "date")],
  [
    "duplicate date group contains both moment and dayjs",
    dupGroups.find((g) => g.category === "date")?.packages.slice().sort().join(",") === "dayjs,moment",
  ],
  [
    "duplicate detection does NOT fire on lodash+underscore when underscore is unused",
    !dupGroups.some((g) => g.category === "utility"),
  ],
  ["duplicate detection returns no group for a single library", findDuplicateLibraries([dupDeps[0]] as unknown as Parameters<typeof findDuplicateLibraries>[0]).length === 0],
);
```

Add `findDuplicateLibraries` to the existing `@codeaudit/engine` import block at the top of the same file.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL — TypeScript/module error, `findDuplicateLibraries` is not exported by `@codeaudit/engine`.

- [ ] **Step 3: Create the data module**

Create `packages/engine/src/data/equivalents.ts`:

```ts
import type { Ecosystem } from "../registry.js";

/**
 * Curated groups of libraries that solve the same problem. Declaring two
 * members of a group is not a defect — a repo mid-migration legitimately has
 * both — but it is a strong "an agent reached for a new library instead of
 * reusing the one already here" signal, which is exactly the AI-debt pattern
 * this product exists to surface.
 *
 * Kept as a committed TS module rather than a fetched list, matching
 * data/popular.ts: offline, deterministic, and it bundles into the esbuild
 * CLI with no asset-copy step.
 *
 * `prefer` is the modern default recommended when consolidating, or null when
 * the choice is genuinely situational.
 */
export interface EquivalentGroup {
  category: string;
  ecosystem: Ecosystem;
  members: string[];
  prefer: string | null;
}

export const EQUIVALENT_GROUPS: EquivalentGroup[] = [
  { category: "date", ecosystem: "npm", members: ["moment", "dayjs", "date-fns", "luxon"], prefer: "date-fns" },
  { category: "utility", ecosystem: "npm", members: ["lodash", "underscore", "ramda"], prefer: "lodash" },
  { category: "http", ecosystem: "npm", members: ["axios", "node-fetch", "got", "superagent", "request"], prefer: "axios" },
  { category: "state", ecosystem: "npm", members: ["redux", "zustand", "jotai", "mobx", "recoil"], prefer: null },
  { category: "test", ecosystem: "npm", members: ["jest", "vitest", "mocha", "ava", "jasmine"], prefer: "vitest" },
  { category: "uuid", ecosystem: "npm", members: ["uuid", "nanoid", "shortid", "cuid"], prefer: "nanoid" },
  { category: "http", ecosystem: "pypi", members: ["requests", "httpx", "aiohttp", "urllib3"], prefer: null },
  { category: "date", ecosystem: "pypi", members: ["arrow", "pendulum", "dateutil"], prefer: null },
  { category: "test", ecosystem: "pypi", members: ["pytest", "nose", "unittest2"], prefer: "pytest" },
];
```

- [ ] **Step 4: Create the detector**

Create `packages/engine/src/duplicates.ts`:

```ts
import type { DependencyVerdict, Ecosystem } from "./registry.js";
import { EQUIVALENT_GROUPS } from "./data/equivalents.js";

export interface DuplicateGroup {
  category: string;
  ecosystem: Ecosystem;
  packages: string[];
  prefer: string | null;
  recommendation: string;
}

/**
 * Two or more libraries from the same equivalence group, both genuinely in
 * use. "In use" deliberately excludes `unused` (declared but never imported —
 * that is already its own finding, and reporting it twice is noise) and
 * `phantom` (does not exist, so it cannot be a real duplicate).
 */
export function findDuplicateLibraries(deps: DependencyVerdict[]): DuplicateGroup[] {
  const inUse = new Set(
    deps.filter((d) => d.status !== "unused" && d.status !== "phantom").map((d) => `${d.ecosystem}:${d.packageName}`),
  );

  const groups: DuplicateGroup[] = [];
  for (const group of EQUIVALENT_GROUPS) {
    const present = group.members.filter((m) => inUse.has(`${group.ecosystem}:${m}`));
    if (present.length < 2) continue;
    const target = group.prefer && present.includes(group.prefer) ? group.prefer : null;
    groups.push({
      category: group.category,
      ecosystem: group.ecosystem,
      packages: present,
      prefer: target,
      recommendation: target
        ? `${present.join(", ")} solve the same problem. Consolidating on ${target} removes ${present.length - 1} dependenc${present.length === 2 ? "y" : "ies"}.`
        : `${present.join(", ")} solve the same problem. Consolidating on one removes ${present.length - 1} dependenc${present.length === 2 ? "y" : "ies"}.`,
    });
  }
  return groups;
}
```

- [ ] **Step 5: Export from the engine**

In `packages/engine/src/index.ts`, add after the `checkTyposquat` export line:

```ts
export { findDuplicateLibraries, type DuplicateGroup } from "./duplicates.js";
export { EQUIVALENT_GROUPS, type EquivalentGroup } from "./data/equivalents.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: PASS on all four new duplicate checks, zero regression on the existing checks.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/data/equivalents.ts packages/engine/src/duplicates.ts packages/engine/src/index.ts server/test/ground-truth.ts
git commit -m "Add duplicate-library detection over equivalent-package groups"
```

---

### Task 2: Registry metadata extraction (deprecated, licence, size)

**Files:**
- Modify: `packages/engine/src/registry.ts:143-178` (`checkNpmPackage`)
- Modify: `packages/engine/src/python/registry.ts:32-73` (`checkPyPiPackage`)
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Produces: `registryMetadata` gains `deprecated: string | null`, `license: string | null`, `unpackedSize: number | null` (npm) and `license: string | null`, `deprecated: string | null` (pypi — derived from `info.yanked`, so both ecosystems expose the same `deprecated` key and downstream tasks need no per-ecosystem branch). No signature change.

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts` before `console.log("--- checks ---")`:

```ts
// --- Registry metadata enrichment (live npm; `request` is famously deprecated) ---
const enriched = await checkNpmPackage("request");
const lodashMeta = await checkNpmPackage("lodash");
checks.push(
  ["checkNpmPackage surfaces a deprecation message for request", typeof enriched.meta?.deprecated === "string"],
  ["checkNpmPackage surfaces a license for lodash", typeof lodashMeta.meta?.license === "string"],
  ["checkNpmPackage surfaces unpackedSize for lodash", typeof lodashMeta.meta?.unpackedSize === "number"],
  ["lodash is NOT marked deprecated", lodashMeta.meta?.deprecated === null],
);
```

Add `checkNpmPackage` to the `@codeaudit/engine` import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL — `checkNpmPackage` is not exported, and once exported the four assertions fail because the fields are undefined.

- [ ] **Step 3: Extend the npm client**

In `packages/engine/src/registry.ts`, replace the `if (status !== 404 && data) { ... }` body inside `checkNpmPackage` with:

```ts
  if (status !== 404 && data) {
    result.exists = true;
    const doc = data as {
      time?: Record<string, string>;
      "dist-tags"?: Record<string, string>;
      versions?: Record<
        string,
        { deprecated?: string; license?: string | { type?: string }; dist?: { unpackedSize?: number } }
      >;
    };
    const created = doc.time?.created ?? null;
    const latest = doc["dist-tags"]?.latest ?? null;
    // The full packument is already downloaded above — deprecation, licence and
    // package weight are read from it directly, costing zero extra requests.
    const latestDoc = latest ? doc.versions?.[latest] : undefined;
    const rawLicense = latestDoc?.license;
    let weeklyDownloads: number | null = null;
    try {
      const dl = await fetchJson(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
      );
      weeklyDownloads = (dl.data as { downloads?: number } | null)?.downloads ?? 0;
    } catch {
      // downloads API is best-effort
    }
    result.meta = {
      created,
      latest,
      weeklyDownloads,
      deprecated: typeof latestDoc?.deprecated === "string" ? latestDoc.deprecated : null,
      license: typeof rawLicense === "string" ? rawLicense : (rawLicense?.type ?? null),
      unpackedSize: latestDoc?.dist?.unpackedSize ?? null,
    };
  }
```

- [ ] **Step 4: Extend the PyPI client**

In `packages/engine/src/python/registry.ts`, change the `doc` type annotation and the `result.meta` assignment inside `checkPyPiPackage`:

```ts
    const doc = data as {
      info?: { version?: string; license?: string; yanked?: boolean };
      releases?: Record<string, { upload_time_iso_8601?: string }[]>;
    };
```

and:

```ts
    result.meta = {
      created,
      latest: doc.info?.version ?? null,
      // stored under the same key the dashboard's downloads column reads
      weeklyDownloads: monthlyDownloads,
      downloadsPeriod: "month",
      license: doc.info?.license || null,
      deprecated: doc.info?.yanked ? "This release has been yanked from PyPI." : null,
    };
```

- [ ] **Step 5: Export `checkNpmPackage` from the engine**

In `packages/engine/src/index.ts`, extend the existing `./registry.js` export block to include `checkNpmPackage`:

```ts
export {
  checkDependencies,
  checkNpmPackage,
  type DependencyVerdict,
  type Ecosystem,
  type AlternativeSuggestion,
} from "./registry.js";
```

- [ ] **Step 6: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: PASS on all four new metadata checks. Existing checks unchanged.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/registry.ts packages/engine/src/python/registry.ts packages/engine/src/index.ts server/test/ground-truth.ts
git commit -m "Extract deprecation, licence and package size from existing registry documents"
```

---

### Task 3: Licence conflict detection

**Files:**
- Create: `packages/engine/src/license.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Consumes: `DependencyVerdict`
- Produces: `readProjectLicense(repoDir: string): string | null`, `checkLicenseConflicts(deps: DependencyVerdict[], projectLicense: string | null): LicenseConflict[]`, `interface LicenseConflict { packageName: string; ecosystem: Ecosystem; packageLicense: string | null; projectLicense: string | null; severity: "high" | "medium"; reason: string }`

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts` before `console.log("--- checks ---")`:

```ts
// --- Licence conflict detection (offline, pure) ---
const licDeps = [
  { packageName: "copyleft-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "AGPL-3.0" } },
  { packageName: "weak-copyleft-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "LGPL-3.0" } },
  { packageName: "permissive-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "MIT" } },
  { packageName: "unlicensed-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: null } },
  { packageName: "unused-copyleft", declaredVersion: "^1.0.0", status: "unused", ecosystem: "npm", registryMetadata: { license: "GPL-3.0" } },
] as unknown as Parameters<typeof checkLicenseConflicts>[0];
const mitConflicts = checkLicenseConflicts(licDeps, "MIT");
const gplConflicts = checkLicenseConflicts(licDeps, "AGPL-3.0");
const conflictNames = new Set(mitConflicts.map((c) => c.packageName));
checks.push(
  ["AGPL dep in an MIT project is a high-severity conflict", mitConflicts.find((c) => c.packageName === "copyleft-lib")?.severity === "high"],
  ["LGPL dep in an MIT project is medium severity", mitConflicts.find((c) => c.packageName === "weak-copyleft-lib")?.severity === "medium"],
  ["MIT dep in an MIT project is NOT a conflict", !conflictNames.has("permissive-lib")],
  ["a dependency with no declared licence is flagged", conflictNames.has("unlicensed-lib")],
  ["an unused copyleft dep is NOT flagged as a licence conflict", !conflictNames.has("unused-copyleft")],
  ["copyleft deps are NOT conflicts when the project is itself AGPL", !gplConflicts.some((c) => c.packageName === "copyleft-lib")],
  ["readProjectLicense returns null when package.json declares no license", readProjectLicense(fixtureDir) === null],
);
```

Add `checkLicenseConflicts` and `readProjectLicense` to the `@codeaudit/engine` import block. (The fixture `package.json` has no `license` field, so `null` is the correct expectation and it doubles as the missing-field case.)

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL — the two functions are not exported.

- [ ] **Step 3: Create the module**

Create `packages/engine/src/license.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import type { DependencyVerdict, Ecosystem } from "./registry.js";

export interface LicenseConflict {
  packageName: string;
  ecosystem: Ecosystem;
  packageLicense: string | null;
  projectLicense: string | null;
  severity: "high" | "medium";
  reason: string;
}

/**
 * Strong copyleft: linking these into a distributed work generally obliges you
 * to release your own source under the same terms. In a permissively-licensed
 * project that is a genuine legal conflict, not a style preference.
 */
const STRONG_COPYLEFT = /^(AGPL|GPL)-?/i;
/** Weak copyleft: obligations usually attach to the library, not the whole work. */
const WEAK_COPYLEFT = /^(LGPL|MPL|EPL|CDDL)-?/i;
const PERMISSIVE = /^(MIT|ISC|Apache|BSD|Unlicense|CC0|0BSD|Zlib|Python-2)/i;

function isCopyleftProject(license: string | null): boolean {
  return license !== null && (STRONG_COPYLEFT.test(license) || WEAK_COPYLEFT.test(license));
}

/**
 * The project's own licence, read as plain text — package.json first, then a
 * LICENSE file's first line as a fallback. Never installs or executes anything.
 */
export function readProjectLicense(repoDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as {
      license?: string | { type?: string };
    };
    const raw = pkg.license;
    const value = typeof raw === "string" ? raw : (raw?.type ?? null);
    if (value) return value;
  } catch {
    // no package.json, or unparseable — fall through to LICENSE
  }
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    try {
      const first = fs.readFileSync(path.join(repoDir, name), "utf8").split("\n")[0]?.trim();
      if (first) return first;
    } catch {
      // not present — try the next candidate
    }
  }
  return null;
}

/**
 * Copyleft dependencies inside a permissive project, and dependencies with no
 * declared licence at all.
 *
 * Only considers dependencies genuinely in use: an `unused` dependency is
 * already its own finding and carries no licence obligation once removed, and
 * a `phantom` one does not exist. Skipped entirely when the project is itself
 * copyleft, where a copyleft dependency is expected rather than a conflict.
 */
export function checkLicenseConflicts(
  deps: DependencyVerdict[],
  projectLicense: string | null,
): LicenseConflict[] {
  const projectIsCopyleft = isCopyleftProject(projectLicense);
  const conflicts: LicenseConflict[] = [];

  for (const dep of deps) {
    if (dep.status === "unused" || dep.status === "phantom") continue;
    const license = (dep.registryMetadata?.license as string | null | undefined) ?? null;

    if (license === null) {
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: null,
        projectLicense,
        severity: "medium",
        reason: `${dep.packageName} declares no licence. Code with no licence grant is legally "all rights reserved" by default.`,
      });
      continue;
    }
    if (projectIsCopyleft) continue;
    if (PERMISSIVE.test(license)) continue;

    if (STRONG_COPYLEFT.test(license)) {
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: license,
        projectLicense,
        severity: "high",
        reason: `${dep.packageName} is ${license}, a strong copyleft licence, in a project licensed ${projectLicense ?? "permissively or not at all"}. Distributing this may oblige you to release your own source under the same terms.`,
      });
    } else if (WEAK_COPYLEFT.test(license)) {
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: license,
        projectLicense,
        severity: "medium",
        reason: `${dep.packageName} is ${license}, a weak copyleft licence. Obligations usually attach to the library rather than your whole application, but modifications to it must typically be published.`,
      });
    }
  }
  return conflicts;
}
```

- [ ] **Step 4: Export from the engine**

In `packages/engine/src/index.ts`, add:

```ts
export { readProjectLicense, checkLicenseConflicts, type LicenseConflict } from "./license.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: PASS on all seven new licence checks.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/license.ts packages/engine/src/index.ts server/test/ground-truth.ts
git commit -m "Add licence conflict detection for copyleft and unlicensed dependencies"
```

---

### Task 4: Prioritization

**Files:**
- Create: `packages/engine/src/priority.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Consumes: `DependencyVerdict`, `ReviewedFinding`, `DuplicateGroup`, `LicenseConflict`
- Produces: `rankFindings(input): RankedFinding[]`, types `Effort = "S" | "M" | "L"`, `PriorityBand = "critical" | "high" | "medium" | "low"`, `RankedFinding { rank; band; kind; title; location; why; effort; confidence }`

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts` before `console.log("--- checks ---")`:

```ts
// --- Prioritization (offline, pure) ---
const rankDeps = [
  { packageName: "date-fns", declaredVersion: "^4.1.0", status: "unused", ecosystem: "npm", registryMetadata: null },
  { packageName: "react-toolkitz", declaredVersion: "^2.1.0", status: "phantom", ecosystem: "npm", registryMetadata: null },
  { packageName: "old-lib", declaredVersion: "^1.0.0", status: "vulnerable", ecosystem: "npm", registryMetadata: { maxSeverity: "critical" } },
  { packageName: "stale-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { deprecated: "use new-lib instead" } },
] as unknown as Parameters<typeof rankFindings>[0]["deps"];
const ranked = rankFindings({
  deps: rankDeps,
  codeFindings: [
    { filePath: "src/x.ts", lineStart: 1, lineEnd: 4, symbolName: "deadFn", findingType: "dead_export", confidence: 0.9, reasoning: "unreferenced" },
  ],
  duplicates: [],
  licenseConflicts: [],
});
const kinds = ranked.map((r) => r.kind);
checks.push(
  ["ranking puts a phantom dependency in the critical band", ranked.find((r) => r.title.includes("react-toolkitz"))?.band === "critical"],
  ["ranking places phantom+critical-CVE above unused", kinds.indexOf("unused_dependency") > kinds.indexOf("phantom_dependency")],
  ["ranking places unused dependency above dead code", kinds.indexOf("dead_code") > kinds.indexOf("unused_dependency")],
  ["deprecated dependency is ranked medium", ranked.find((r) => r.kind === "deprecated_dependency")?.band === "medium"],
  ["every ranked finding carries a non-empty why", ranked.every((r) => r.why.trim().length > 0)],
  ["removing an unused dependency is S effort", ranked.find((r) => r.kind === "unused_dependency")?.effort === "S"],
  ["ranks are 1-based and contiguous", ranked.every((r, i) => r.rank === i + 1)],
  ["ranking respects the limit option", rankFindings({ deps: rankDeps, codeFindings: [], limit: 2 }).length === 2],
);
```

Add `rankFindings` to the `@codeaudit/engine` import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL — `rankFindings` is not exported.

- [ ] **Step 3: Create the module**

Create `packages/engine/src/priority.ts`:

```ts
import type { DependencyVerdict } from "./registry.js";
import type { ReviewedFinding } from "./llm.js";
import type { DuplicateGroup } from "./duplicates.js";
import type { LicenseConflict } from "./license.js";

export type Effort = "S" | "M" | "L";
export type PriorityBand = "critical" | "high" | "medium" | "low";

export interface RankedFinding {
  rank: number;
  band: PriorityBand;
  kind: string;
  title: string;
  location: string | null;
  /** Why this sits where it does. Never empty — an unexplained rank is just a
   *  differently-shaped wall of noise. */
  why: string;
  effort: Effort;
  confidence: number;
}

const BAND_ORDER: Record<PriorityBand, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EFFORT_ORDER: Record<Effort, number> = { S: 0, M: 1, L: 2 };
const DEFAULT_LIMIT = 20;

export interface RankInput {
  deps: DependencyVerdict[];
  codeFindings: ReviewedFinding[];
  duplicates?: DuplicateGroup[];
  licenseConflicts?: LicenseConflict[];
  limit?: number;
}

/**
 * Orders findings so the top of the list is what to fix first.
 *
 * Ordering is lexicographic — band, then confidence descending, then effort
 * ascending — deliberately not a weighted sum. A weighted score needs magic
 * coefficients nobody can justify, which is the same fake-precision problem
 * that got hour/currency debt costing rejected. Lexicographic ordering states
 * itself: worst class first, most certain first within a class, cheapest first
 * among equals.
 */
export function rankFindings(input: RankInput): RankedFinding[] {
  const items: Omit<RankedFinding, "rank">[] = [];

  for (const dep of input.deps) {
    const meta = dep.registryMetadata ?? {};
    if (dep.status === "phantom") {
      const alt = (meta.alternatives as { name: string }[] | undefined)?.[0]?.name;
      items.push({
        band: "critical",
        kind: "phantom_dependency",
        title: `${dep.packageName} does not exist on ${dep.ecosystem}`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: alt
          ? `The package cannot be installed and looks like a typo of "${alt}". Names like this are registered by attackers precisely because AI tools suggest them — treat as urgent.`
          : `The package cannot be installed. Hallucinated names are registered by attackers precisely because AI tools suggest them — treat as urgent.`,
        effort: "M",
        confidence: 1,
      });
    } else if (dep.status === "vulnerable") {
      const severity = (meta.maxSeverity as string | undefined) ?? "unknown";
      const critical = severity === "critical" || severity === "high";
      items.push({
        band: critical ? "critical" : "medium",
        kind: "vulnerable_dependency",
        title: `${dep.packageName} has known vulnerabilities (${severity})`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `A published advisory affects the version currently resolved. Upgrading is usually a version bump, which makes this a high-value, low-effort fix.`,
        effort: "S",
        confidence: 1,
      });
    } else if (dep.status === "suspicious") {
      const squat = meta.typosquatOf as string | undefined;
      items.push({
        band: squat ? "high" : "medium",
        kind: "suspicious_dependency",
        title: squat
          ? `${dep.packageName} closely resembles ${squat}`
          : `${dep.packageName} looks suspicious (new or very low usage)`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: squat
          ? `One character away from a widely-used package. Confirm you meant this one and not ${squat}.`
          : `Very few downloads or published very recently. Confirm it is the package you intended before relying on it.`,
        effort: "M",
        confidence: 0.8,
      });
    } else if (typeof meta.deprecated === "string") {
      items.push({
        band: "medium",
        kind: "deprecated_dependency",
        title: `${dep.packageName} is deprecated`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `The maintainer has marked this package deprecated: "${meta.deprecated.slice(0, 160)}" It will not receive security fixes.`,
        effort: "M",
        confidence: 1,
      });
    } else if (dep.status === "unused") {
      items.push({
        band: "low",
        kind: "unused_dependency",
        title: `${dep.packageName} is declared but never imported`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `Nothing in the repository imports it. Removing it shrinks install size and attack surface, and is a one-line change.`,
        effort: "S",
        confidence: 0.9,
      });
    }
  }

  for (const conflict of input.licenseConflicts ?? []) {
    items.push({
      band: conflict.severity === "high" ? "high" : "medium",
      kind: "license_conflict",
      title: `${conflict.packageName} licence (${conflict.packageLicense ?? "none declared"}) may conflict`,
      location: conflict.ecosystem === "npm" ? "package.json" : "requirements",
      why: conflict.reason,
      effort: "L",
      confidence: 0.7,
    });
  }

  for (const group of input.duplicates ?? []) {
    items.push({
      band: "low",
      kind: "duplicate_library",
      title: `${group.packages.join(" + ")} overlap in purpose`,
      location: group.ecosystem === "npm" ? "package.json" : "requirements",
      why: group.recommendation,
      effort: "M",
      confidence: 0.6,
    });
  }

  for (const finding of input.codeFindings) {
    items.push({
      band: "low",
      kind: "dead_code",
      title: `${finding.symbolName} appears unused`,
      location: `${finding.filePath}:${finding.lineStart}`,
      why: finding.reasoning?.trim()
        ? finding.reasoning
        : `Nothing outside its own file references this symbol.`,
      effort: "S",
      confidence: finding.confidence,
    });
  }

  items.sort(
    (a, b) =>
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      b.confidence - a.confidence ||
      EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] ||
      a.title.localeCompare(b.title),
  );

  return items
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
```

- [ ] **Step 4: Export from the engine**

In `packages/engine/src/index.ts`, add:

```ts
export {
  rankFindings,
  type RankedFinding,
  type RankInput,
  type Effort,
  type PriorityBand,
} from "./priority.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: PASS on all eight ranking checks.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/priority.ts packages/engine/src/index.ts server/test/ground-truth.ts
git commit -m "Add lexicographic finding prioritization with explained ranks and effort tiers"
```

---

### Task 5: Wire into the worker

**Files:**
- Modify: `server/src/worker.ts:19-26` (imports), `:213` (summary construction)

**Interfaces:**
- Consumes: `findDuplicateLibraries`, `readProjectLicense`, `checkLicenseConflicts`, `rankFindings`
- Produces: `scan_jobs.summary` gains `priorities: RankedFinding[]` and `advisories: { duplicates: DuplicateGroup[]; licenseConflicts: LicenseConflict[] }`

- [ ] **Step 1: Extend the engine import block**

In `server/src/worker.ts`, add to the existing `@codeaudit/engine` import:

```ts
  findDuplicateLibraries,
  readProjectLicense,
  checkLicenseConflicts,
  rankFindings,
```

- [ ] **Step 2: Compute the new data and attach it to the summary**

Replace line 213 (`const summary = { ...computeSummary(deps, zombies, fileCount, reviewStatus), ai: aiStats };`) with:

```ts
    // Advisory-only in this release: these inform the prioritized list and the
    // dashboard, but deliberately do not feed computeSummary's score yet — see
    // docs/superpowers/specs/2026-07-31-phase1-signal-design.md ("Scoring
    // changes"). Landing detection and scoring in one step would silently move
    // every repo's score and could break merge gates on unchanged code.
    const duplicates = findDuplicateLibraries(deps);
    const licenseConflicts = checkLicenseConflicts(deps, readProjectLicense(dir));
    const priorities = rankFindings({ deps, codeFindings: zombies, duplicates, licenseConflicts });
    const summary = {
      ...computeSummary(deps, zombies, fileCount, reviewStatus),
      ai: aiStats,
      priorities,
      advisories: { duplicates, licenseConflicts },
    };
```

- [ ] **Step 3: Verify the server typechecks**

Run: `npm run lint`
Expected: exit 0, no TypeScript errors.

- [ ] **Step 4: Run a real scan end-to-end**

Start the stack (`docker compose up -d`, `npm run dev`), register/log in, scan a public repo, then confirm the new keys are present:

```bash
docker compose exec -T postgres psql -U codeaudit -d codeaudit -c "SELECT jsonb_pretty(summary -> 'priorities' -> 0) FROM scan_jobs WHERE summary ? 'priorities' ORDER BY created_at DESC LIMIT 1;"
```

Expected: a JSON object with `rank`, `band`, `kind`, `title`, `why`, `effort`.

- [ ] **Step 5: Commit**

```bash
git add server/src/worker.ts
git commit -m "Attach prioritized findings and dependency advisories to scan summary"
```

---

### Task 6: CLI "Fix first" section

**Files:**
- Modify: `cli/src/index.ts`

**Interfaces:**
- Consumes: `rankFindings`, `findDuplicateLibraries`, `readProjectLicense`, `checkLicenseConflicts`

- [ ] **Step 1: Extend the engine import block**

In `cli/src/index.ts`, add to the existing `@codeaudit/engine` import:

```ts
  findDuplicateLibraries,
  readProjectLicense,
  checkLicenseConflicts,
  rankFindings,
```

- [ ] **Step 2: Compute rankings before output**

Immediately after the existing `const summary = computeSummary(deps, staticFindings, fileCount);` line, add:

```ts
  const duplicates = findDuplicateLibraries(deps);
  const licenseConflicts = checkLicenseConflicts(deps, readProjectLicense(dir));
  const priorities = rankFindings({
    deps,
    codeFindings: staticFindings,
    duplicates,
    licenseConflicts,
    limit: 5,
  });
```

- [ ] **Step 3: Include rankings in `--json` output**

In the `if (json)` block, add `priorities,` and `advisories: { duplicates, licenseConflicts },` to the object literal passed to `JSON.stringify`, immediately after `deadCodeCandidates: staticFindings,`.

- [ ] **Step 4: Print the "Fix first" section**

Immediately after the `console.log(`\n${BOLD}CodeAudit${RESET} ...`)` header line, add:

```ts
  const BAND_COLOR: Record<string, string> = { critical: RED, high: RED, medium: YELLOW, low: DIM };
  if (priorities.length) {
    console.log(`${BOLD}Fix first${RESET}`);
    for (const p of priorities) {
      const color = BAND_COLOR[p.band] ?? "";
      console.log(`  ${color}${String(p.rank).padStart(2)}. ${p.band.toUpperCase().padEnd(8)}${RESET} ${p.title} ${DIM}[${p.effort}]${RESET}`);
      console.log(`      ${DIM}${p.why}${RESET}`);
      if (p.location) console.log(`      ${DIM}${p.location}${RESET}`);
    }
    console.log();
  }
```

- [ ] **Step 5: Build and run against the fixture**

```bash
npm run build:cli
node cli/dist/index.js scan server/test/fixture
```

Expected: a "Fix first" section printed above "Dependencies", with `react-toolkitz` and `tyepscript` ranked CRITICAL and `date-fns` ranked LOW.

- [ ] **Step 6: Commit**

```bash
git add cli/src/index.ts
git commit -m "Lead CLI output with a ranked fix-first section"
```

---

### Task 7: Dashboard surfacing

**Files:**
- Modify: `web/src/pages/ScanDetail.tsx`

**Interfaces:**
- Consumes: `summary.priorities`, `summary.advisories` from the existing `GET /api/scans/:id` response.

- [ ] **Step 1: Add types for the new summary fields**

Extend the existing scan-summary type in `ScanDetail.tsx` with:

```ts
type RankedFinding = {
  rank: number;
  band: "critical" | "high" | "medium" | "low";
  kind: string;
  title: string;
  location: string | null;
  why: string;
  effort: "S" | "M" | "L";
  confidence: number;
};
type Advisories = {
  duplicates: { category: string; packages: string[]; recommendation: string }[];
  licenseConflicts: { packageName: string; packageLicense: string | null; severity: string; reason: string }[];
};
```

- [ ] **Step 2: Render the "Fix first" card above the existing cards**

Add, as the first card in the results area:

```tsx
{summary?.priorities?.length ? (
  <Card>
    <h2 className="text-lg font-semibold mb-1">Fix first</h2>
    <p className="text-sm opacity-70 mb-4">
      Ranked by severity, then confidence, then effort. Showing {summary.priorities.length} of the highest-priority findings.
    </p>
    <ol className="space-y-3">
      {summary.priorities.map((p: RankedFinding) => (
        <li key={p.rank} className="flex gap-3">
          <Badge tone={p.band === "critical" || p.band === "high" ? "danger" : p.band === "medium" ? "warn" : "muted"}>
            {p.band}
          </Badge>
          <div className="min-w-0">
            <div className="font-medium">{p.title}</div>
            <div className="text-sm opacity-70">{p.why}</div>
            <div className="text-xs opacity-50 mt-1">
              {p.location ? `${p.location} · ` : ""}effort {p.effort}
            </div>
          </div>
        </li>
      ))}
    </ol>
  </Card>
) : null}
```

If the local `Badge` primitive does not accept a `tone` prop with those values, match whatever prop and variant names `web/src/components/ui.tsx` already exposes rather than adding new ones.

- [ ] **Step 3: Render the consolidation + licence cards**

Add below the existing dependency card:

```tsx
{summary?.advisories?.duplicates?.length ? (
  <Card>
    <h2 className="text-lg font-semibold mb-1">Consolidation opportunities</h2>
    <p className="text-sm opacity-70 mb-4">
      Libraries that solve the same problem. Not a defect — a repo mid-migration legitimately has both.
    </p>
    <ul className="space-y-2">
      {summary.advisories.duplicates.map((d) => (
        <li key={d.category}>
          <div className="font-medium">{d.packages.join(" + ")}</div>
          <div className="text-sm opacity-70">{d.recommendation}</div>
        </li>
      ))}
    </ul>
  </Card>
) : null}

{summary?.advisories?.licenseConflicts?.length ? (
  <Card>
    <h2 className="text-lg font-semibold mb-1">Licence review</h2>
    <ul className="space-y-2">
      {summary.advisories.licenseConflicts.map((c) => (
        <li key={c.packageName}>
          <div className="font-medium">
            {c.packageName} <span className="opacity-60">({c.packageLicense ?? "none declared"})</span>
          </div>
          <div className="text-sm opacity-70">{c.reason}</div>
        </li>
      ))}
    </ul>
  </Card>
) : null}
```

- [ ] **Step 4: Verify in the browser**

Start the stack, open a completed scan, and confirm: the Fix first card renders at the top with bands and effort tiers; consolidation/licence cards appear only when non-empty; no console errors; light and dark themes both readable.

- [ ] **Step 5: Verify the production build**

Run: `npm run build --workspace web`
Expected: exit 0.

- [ ] **Step 6: Commit**

```bash
git add web/src/pages/ScanDetail.tsx
git commit -m "Surface fix-first ranking, consolidation and licence cards in the dashboard"
```

---

### Task 8: PR comment leads with top 3

**Files:**
- Modify: `server/src/queue/prComment.ts`

- [ ] **Step 1: Read the current comment body builder**

Open `server/src/queue/prComment.ts` and locate the function that assembles the markdown body from `summary`.

- [ ] **Step 2: Insert a top-3 block above the existing findings table**

Immediately before the existing findings table is appended, add:

```ts
  const priorities = (summary.priorities ?? []) as {
    rank: number; band: string; title: string; why: string; effort: string; location: string | null;
  }[];
  if (priorities.length) {
    body += `\n**Fix first**\n\n`;
    for (const p of priorities.slice(0, 3)) {
      body += `${p.rank}. **${p.title}** \`${p.band}\` · effort ${p.effort}${p.location ? ` · \`${p.location}\`` : ""}\n`;
      body += `   ${p.why}\n`;
    }
    body += `\n`;
  }
```

Match the surrounding code's existing string-building style — if the function builds an array of lines and joins it, push lines instead of using `+=`.

- [ ] **Step 3: Verify the server typechecks**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 4: Verify comment rendering**

Trigger a PR scan against a connected repo (or invoke the comment builder directly in a scratch script with a fixture summary) and confirm the "Fix first" block renders above the table with no broken markdown.

- [ ] **Step 5: Commit**

```bash
git add server/src/queue/prComment.ts
git commit -m "Lead PR comment with the top three prioritized findings"
```

---

### Task 9: Publish the CLI

Per the publish-drift lesson in `docs/roadmap.md`: an engine change is not done when the code changes and tests pass — it is done when the published package reflects it.

- [ ] **Step 1: Confirm the full suite passes**

```bash
npm run test:ground-truth --prefix server
npm run test:ground-truth-python --prefix server
npm run lint
npm run build
```

Expected: all exit 0.

- [ ] **Step 2: Bump the CLI version**

```bash
npm version minor --no-git-tag-version --prefix cli
```

Expected: `0.2.x` → `0.3.0` (minor, because CLI output gains a new section).

- [ ] **Step 3: Publish**

```bash
npm publish --workspace cli
```

Requires `npm login`. This is an explicit, world-visible action — get the user's go-ahead before running it.

- [ ] **Step 4: Verify the published package**

```bash
npx codeaudit-scan@latest scan .
```

Expected: the "Fix first" section appears.

- [ ] **Step 5: Commit**

```bash
git add cli/package.json package-lock.json
git commit -m "Publish codeaudit-scan 0.3.0 with prioritized fix-first output"
```

---

## Self-Review

**Spec coverage.** Prioritization → Tasks 4, 6, 7, 8. Dependency intelligence (deprecated / licence / duplicates / heavy) → Tasks 1, 2, 3. Zero new HTTP requests → Task 2 reads the existing packument. Advisory-only scoring → Task 5 Step 2 comment, and no change to `score.ts` anywhere in the plan. Capped top-20 → `DEFAULT_LIMIT` in Task 4. `why` mandatory → asserted in Task 4 Step 1. Publish discipline → Task 9.

**Known gaps, deliberately deferred:** heavy-package flagging reads `unpackedSize` in Task 2 but is not yet surfaced as its own finding — it needs a size threshold that should be calibrated against real scans rather than guessed, so it belongs with the advisory-scoring follow-up. Secrets detection, git-history scanning, and migration `004` are in the Phase 1b plan.

**Placeholder scan.** No TBD/TODO. Every code step carries complete code. Task 8 Steps 1–2 depend on reading existing code first, which is stated as an explicit step rather than assumed.

**Type consistency.** `DuplicateGroup` (category/ecosystem/packages/prefer/recommendation) is produced in Task 1 and consumed identically in Tasks 4, 5, 7. `LicenseConflict` (packageName/ecosystem/packageLicense/projectLicense/severity/reason) produced in Task 3, consumed in 4, 5, 7. `RankedFinding` produced in Task 4, consumed in 5, 6, 7, 8. `rankFindings` takes a single object argument in every call site. `registryMetadata.deprecated` is written in Task 2 and read in Tasks 3 and 4 under the same key.
