// Ground-truth validation: runs the analysis modules directly on the seeded fixture.
// Expected: react-toolkitz = phantom, date-fns = unused, lodash = healthy,
// calculateLegacyDiscount + zombieFormatter flagged as dead-code candidates,
// helper (called cross-file) and main (entry name) NOT flagged.
// Run: npm run test:ground-truth
import path from "node:path";
import { fileURLToPath } from "node:url";
import { parseManifest } from "../src/analysis/manifest.js";
import { analyzeRepo } from "../src/analysis/imports.js";
import { checkDependencies } from "../src/analysis/registry.js";
import { findDeadCodeCandidates } from "../src/analysis/deadcode.js";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture");

const manifest = parseManifest(fixtureDir);
if (!manifest) throw new Error("fixture package.json missing");
const analysis = analyzeRepo(fixtureDir);
const deps = await checkDependencies(manifest, analysis.importedPackages);
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
];
console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
