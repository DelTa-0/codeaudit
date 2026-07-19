// Python ground-truth validation, mirroring test/ground-truth.ts.
// Expected: totally-fake-pypi-pkg-xyz = phantom, rich = unused (declared,
// never imported), requests + flask = healthy/suspicious-not-phantom,
// stdlib (json) and the local module (helpers) never surface as findings,
// calculate_legacy_discount + zombie_formatter flagged as dead-code
// candidates, used_helper / main / ANSWER not flagged.
// Run: npm run test:ground-truth-python
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  parsePythonManifest,
  analyzePythonRepo,
  checkPythonDependencies,
  findDeadCodeCandidates,
  detectEcosystems,
} from "@codeaudit/engine";

const fixtureDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "fixture-python");

const ecosystems = detectEcosystems(fixtureDir);
const manifest = parsePythonManifest(fixtureDir);
if (!manifest) throw new Error("fixture python manifest missing");
const analysis = analyzePythonRepo(fixtureDir);
const deps = await checkPythonDependencies(fixtureDir, manifest, analysis.importedPackages);
const candidates = findDeadCodeCandidates(analysis);

console.log("--- ecosystems ---");
console.log(ecosystems.join(", "));
console.log("--- dependency verdicts ---");
for (const d of [...deps].sort((a, b) => a.packageName.localeCompare(b.packageName)))
  console.log(`${d.packageName}: ${d.status} (${d.ecosystem})`);
console.log("--- dead-code candidates ---");
for (const c of candidates) console.log(`${c.name} (${c.filePath}:${c.lineStart}) ${c.findingType}`);

const verdict = (name: string) => deps.find((d) => d.packageName === name)?.status;
const candNames = new Set(candidates.map((c) => c.name));
const depNames = new Set(deps.map((d) => d.packageName));
const checks: [string, boolean][] = [
  ["pypi ecosystem detected", ecosystems.includes("pypi")],
  ["fake package is phantom", verdict("totally-fake-pypi-pkg-xyz") === "phantom"],
  ["rich is unused", verdict("rich") === "unused"],
  ["requests is not phantom/unused", ["healthy", "suspicious"].includes(verdict("requests") ?? "")],
  ["flask (from pyproject.toml) is present and not phantom", ["healthy", "suspicious", "unused"].includes(verdict("flask") ?? "")],
  ["stdlib json never surfaces", !depNames.has("json")],
  ["local module helpers never surfaces", !depNames.has("helpers")],
  ["calculate_legacy_discount flagged", candNames.has("calculate_legacy_discount")],
  ["zombie_formatter flagged", candNames.has("zombie_formatter")],
  ["used_helper NOT flagged", !candNames.has("used_helper")],
  ["main NOT flagged (entry name)", !candNames.has("main")],
];
console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
