// Ground-truth validation: runs the analysis modules directly on the seeded fixture.
// Expected: react-toolkitz = phantom, date-fns = unused, lodash = healthy,
// calculateLegacyDiscount + zombieFormatter flagged as dead-code candidates,
// helper (called cross-file) and main (entry name) NOT flagged.
// Precision-fix regression cases (see docs/known-issues.md /
// docs/roadmap.md, self-scan false positives found 2026-07-20):
// - concurrently (devDependency, script-only, never imported) NOT unused
// - @fixture/internal (workspace member, "*" version, genuinely imported)
//   NOT phantom
// - formatTag (exported, only called within its own file by renderTag)
//   NOT flagged dead; renderTag (imported by index.js) also NOT flagged
// Run: npm run test:ground-truth
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parseManifest,
  analyzeRepo,
  checkDependencies,
  findDeadCodeCandidates,
  checkTyposquat,
  coerceVersion,
  resolveNpmTree,
} from "@codeaudit/engine";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

const manifest = parseManifest(fixtureDir);
if (!manifest) throw new Error("fixture package.json missing");
const analysis = analyzeRepo(fixtureDir);
const deps = await checkDependencies(fixtureDir, manifest, analysis.importedPackages);
const candidates = findDeadCodeCandidates(analysis);

console.log("--- dependency verdicts ---");
for (const d of [...deps].sort((a, b) => a.packageName.localeCompare(b.packageName)))
  console.log(`${d.packageName}: ${d.status}`);

console.log("--- dead-code candidates ---");
for (const c of candidates) console.log(`${c.name} (${c.filePath}:${c.lineStart}) ${c.findingType}`);

const verdict = (name: string) => deps.find((d) => d.packageName === name)?.status;
const candNames = new Set(candidates.map((c) => c.name));
const checks: [string, boolean][] = [
  ["react-toolkitz is phantom", verdict("react-toolkitz") === "phantom"],
  ["date-fns is unused", verdict("date-fns") === "unused"],
  ["lodash is healthy", verdict("lodash") === "healthy"],
  ["calculateLegacyDiscount flagged", candNames.has("calculateLegacyDiscount")],
  ["zombieFormatter flagged", candNames.has("zombieFormatter")],
  ["helper NOT flagged (alive)", !candNames.has("helper")],
  ["main NOT flagged (entry)", !candNames.has("main")],
  ["concurrently (script-only devDependency) NOT unused", verdict("concurrently") !== "unused"],
  ["typescript (compiler, never imported) NOT unused", verdict("typescript") !== "unused"],
  [
    "pg (Sequelize dialect driver, never imported directly) NOT unused",
    verdict("pg") !== "unused",
  ],
  ["@fixture/internal (workspace member) NOT phantom", verdict("@fixture/internal") !== "phantom"],
  ["formatTag (exported, same-file-only call) NOT flagged", !candNames.has("formatTag")],
  ["renderTag (called cross-file) NOT flagged", !candNames.has("renderTag")],
];

// --- Typosquat detection (pure, deterministic) ---
const squatExpress = checkTyposquat("expresss", "npm");
const squatLodash = checkTyposquat("lodahs", "npm");
const squatDotenv = checkTyposquat("python-dotnev", "pypi");
checks.push(
  ["expresss flagged as typosquat of express", squatExpress?.suspectedTarget === "express"],
  ["lodahs flagged as typosquat of lodash", squatLodash?.suspectedTarget === "lodash"],
  ["python-dotnev flagged as typosquat of python-dotenv", squatDotenv?.suspectedTarget === "python-dotenv"],
  ["react (itself popular) NOT a typosquat", checkTyposquat("react", "npm") === null],
  ["my-custom-app NOT a typosquat", checkTyposquat("my-custom-app", "npm") === null],
);

// --- Version coercion (pure) ---
checks.push(
  ["coerceVersion('^1.2.3') = 1.2.3", coerceVersion("^1.2.3") === "1.2.3"],
  ["coerceVersion('>=1.0.0 <2.0.0') = 1.0.0", coerceVersion(">=1.0.0 <2.0.0") === "1.0.0"],
  ["coerceVersion('*') = null", coerceVersion("*") === null],
  ["coerceVersion('workspace:*') = null", coerceVersion("workspace:*") === null],
);

// --- Lockfile resolution + transitive guard (offline fixture) ---
const lockDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeaudit-lock-"));
fs.writeFileSync(
  path.join(lockDir, "package-lock.json"),
  JSON.stringify({
    name: "lock-fixture",
    lockfileVersion: 3,
    packages: {
      "": { dependencies: { "left-pad": "^1.3.0" } },
      "node_modules/left-pad": { version: "1.3.0", dependencies: { "deep-transitive": "^2.0.0" } },
      "node_modules/deep-transitive": { version: "2.1.0" },
    },
  }),
);
const tree = resolveNpmTree(lockDir);
fs.rmSync(lockDir, { recursive: true, force: true });
checks.push(
  ["resolveNpmTree reads left-pad@1.3.0", tree?.packages.get("left-pad")?.version === "1.3.0"],
  ["resolveNpmTree marks left-pad direct", tree?.packages.get("left-pad")?.direct === true],
  ["resolveNpmTree reads transitive deep-transitive@2.1.0", tree?.packages.get("deep-transitive")?.version === "2.1.0"],
  ["resolveNpmTree marks deep-transitive NOT direct", tree?.packages.get("deep-transitive")?.direct === false],
  ["deep-transitive recorded as transitively required (unused-guard input)", tree?.transitivelyRequired.has("deep-transitive") === true],
);
console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
