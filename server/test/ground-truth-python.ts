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
  verifyPackage,
  checkPyPiPackage,
  licenseFromClassifiers,
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
  ["reqeusts (typo) is phantom", verdict("reqeusts") === "phantom"],
  [
    "reqeusts phantom finding suggests requests (fuzzy)",
    (deps.find((d) => d.packageName === "reqeusts")?.registryMetadata as { alternatives?: { name: string; source: string }[] } | null)
      ?.alternatives?.[0]?.name === "requests" &&
      (deps.find((d) => d.packageName === "reqeusts")?.registryMetadata as { alternatives?: { name: string; source: string }[] } | null)
        ?.alternatives?.[0]?.source === "fuzzy",
  ],
  ["rich is unused", verdict("rich") === "unused"],
  ["requests is not phantom/unused", ["healthy", "suspicious"].includes(verdict("requests") ?? "")],
  ["flask (from pyproject.toml) is present and not phantom", ["healthy", "suspicious", "unused"].includes(verdict("flask") ?? "")],
  ["stdlib json never surfaces", !depNames.has("json")],
  ["local module helpers never surfaces", !depNames.has("helpers")],
  ["calculate_legacy_discount flagged", candNames.has("calculate_legacy_discount")],
  ["zombie_formatter flagged", candNames.has("zombie_formatter")],
  ["used_helper NOT flagged", !candNames.has("used_helper")],
  ["main NOT flagged (entry name)", !candNames.has("main")],
  // Precision fixes from the real-world FastAPI review:
  ["python-docx connected to lazy `import docx` (not unused)", verdict("python-docx") !== "unused" && verdict("python-docx") !== undefined],
  ["uvicorn (CLI-invoked, never imported) NOT flagged unused", verdict("uvicorn") !== "unused" && verdict("uvicorn") !== undefined],
  ["decorated route handler `health` NOT flagged", !candNames.has("health")],
  ["same-file-called `internal_helper` NOT flagged", !candNames.has("internal_helper")],
  ["genuinely-uncalled `lazy_docx_load` still flagged", candNames.has("lazy_docx_load")],
];

// --- Single-package verification primitive (offline path, for codeaudit-mcp) ---
const verifyPhantomTypoPy = await verifyPackage("reqeusts", "pypi");
const verifyHealthyPy = await verifyPackage("requests", "pypi");
checks.push(
  ["verifyPackage(reqeusts, pypi) is phantom", verifyPhantomTypoPy.status === "phantom"],
  ["verifyPackage(reqeusts, pypi) suggests requests", verifyPhantomTypoPy.alternatives?.[0]?.name === "requests"],
  ["verifyPackage(requests, pypi) is not phantom", verifyHealthyPy.status !== "phantom"],
);
// --- PEP 639 licence resolution (live PyPI) ---
// flask publishes only `license_expression` (modern PEP 639 metadata) and
// leaves the legacy `license` field null; requests is the reverse. Both
// must resolve to a non-null license, or every popular Python dependency
// falsely reads as "declares no licence".
const flaskMeta = await checkPyPiPackage("flask");
const requestsMeta = await checkPyPiPackage("requests");
checks.push(
  ["checkPyPiPackage(flask) resolves a license via license_expression", typeof flaskMeta.meta?.license === "string"],
  ["checkPyPiPackage(requests) resolves a license via the legacy field", typeof requestsMeta.meta?.license === "string"],
);

// --- Trove classifier fallback (live PyPI) ---
// pandas publishes `license_expression: null` and dumps the FULL 61,643-char
// BSD licence text into the legacy `license` field. Neither is usable as an
// identifier, so checkPyPiPackage must fall back to the "License ::" trove
// classifier — otherwise pandas (present in a huge share of Python repos)
// reads as "declares no licence", a false legal claim about well-licensed
// software that would land in the CLI's headline "Fix first" section.
const pandasMeta = await checkPyPiPackage("pandas");
checks.push(
  ["checkPyPiPackage(pandas) resolves a non-null license via classifier fallback", pandasMeta.meta?.license != null],
  [
    "checkPyPiPackage(pandas) license resolves to a permissive-looking BSD identifier",
    typeof pandasMeta.meta?.license === "string" && (pandasMeta.meta.license as string).startsWith("BSD"),
  ],
);

// --- Classifier -> SPDX ordering (pure, offline, no network) ---
// "GNU Affero General Public License" and "GNU Lesser General Public
// License" both contain "General Public" — the more specific families must
// be matched before the generic GPL fallback, or AGPL/LGPL packages would
// misreport as plain GPL (a materially different copyleft obligation).
checks.push(
  [
    "AGPL classifier resolves to AGPL-3.0, not GPL-3.0",
    licenseFromClassifiers(["License :: OSI Approved :: GNU Affero General Public License v3"]) === "AGPL-3.0",
  ],
  [
    "LGPL classifier resolves to LGPL-3.0, not GPL-3.0",
    licenseFromClassifiers(["License :: OSI Approved :: GNU Lesser General Public License v3 (LGPLv3)"]) === "LGPL-3.0",
  ],
  [
    "GPL classifier resolves to GPL-3.0",
    licenseFromClassifiers(["License :: OSI Approved :: GNU General Public License v3 (GPLv3)"]) === "GPL-3.0",
  ],
  [
    "MIT classifier resolves to MIT",
    licenseFromClassifiers(["License :: OSI Approved :: MIT License"]) === "MIT",
  ],
  [
    "a non-licence classifier resolves nothing",
    licenseFromClassifiers(["Programming Language :: Python :: 3"]) === null,
  ],
);

console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
