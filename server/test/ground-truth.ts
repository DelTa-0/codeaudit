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
  verifyPackage,
  findDuplicateLibraries,
  checkNpmPackage,
  checkLicenseConflicts,
  readProjectLicense,
  rankFindings,
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
  ["tyepscript is phantom", verdict("tyepscript") === "phantom"],
  [
    "tyepscript phantom finding suggests typescript (fuzzy)",
    (deps.find((d) => d.packageName === "tyepscript")?.registryMetadata as { alternatives?: { name: string; source: string }[] } | null)
      ?.alternatives?.[0]?.name === "typescript" &&
      (deps.find((d) => d.packageName === "tyepscript")?.registryMetadata as { alternatives?: { name: string; source: string }[] } | null)
        ?.alternatives?.[0]?.source === "fuzzy",
  ],
  [
    "react-toolkitz phantom finding has NO fuzzy alternative (not a spelling neighbor)",
    !(deps.find((d) => d.packageName === "react-toolkitz")?.registryMetadata as { alternatives?: unknown } | null)
      ?.alternatives,
  ],
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

// --- generated code is never a dead-code candidate (offline) ---
// Real-world false positive: a Django project produced 17 candidates entirely
// from accounts/migrations/. Migration modules are discovered by path, never
// referenced by name, so "no references" is true by construction — and
// reviewing them burned the LLM token budget on generated code.
const genAnalysis = {
  symbols: [
    { name: "Migration", filePath: "accounts/migrations/0008_alter_field.py", lineStart: 1, lineEnd: 9, exported: true, kind: "component" as const, body: "class Migration: pass" },
    { name: "fix_categories", filePath: "accounts/migrations/0007_fix.py", lineStart: 1, lineEnd: 5, exported: true, kind: "function" as const, body: "def fix_categories(): pass" },
    { name: "routeTree", filePath: "src/routeTree.gen.ts", lineStart: 1, lineEnd: 3, exported: true, kind: "function" as const, body: "export const routeTree = {}" },
    { name: "genuinelyDead", filePath: "src/utils.ts", lineStart: 1, lineEnd: 3, exported: true, kind: "function" as const, body: "export function genuinelyDead() {}" },
  ],
  references: new Map<string, Set<string>>(),
  importedPackages: new Set<string>(),
  fileCount: 4,
  fileImportExports: new Map<string, string[]>(),
};
const genCandidates = findDeadCodeCandidates(genAnalysis);
const genNames = new Set(genCandidates.map((c) => c.name));
checks.push(
  ["Django migration class NOT a dead-code candidate", !genNames.has("Migration")],
  ["Django migration function NOT a dead-code candidate", !genNames.has("fix_categories")],
  ["codegen .gen.ts symbol NOT a dead-code candidate", !genNames.has("routeTree")],
  ["genuinely unreferenced symbol IS still flagged", genNames.has("genuinelyDead")],
);

// --- tsconfig path aliases are NOT npm packages (offline) ---
// Real-world false positive: a Vite + shadcn/ui + TanStack repo reported
// @/components, @/hooks and @/lib as phantom dependencies (-45 score) because
// every "@…" specifier was treated as a scoped package. "@/" has an empty
// scope and can never be a real package; custom aliases come from tsconfig.
const aliasDir = fs.mkdtempSync(path.join(os.tmpdir(), "codeaudit-alias-"));
fs.mkdirSync(path.join(aliasDir, "src"));
fs.writeFileSync(
  path.join(aliasDir, "tsconfig.json"),
  `{
  // tsconfig is conventionally JSONC — comments must not break parsing
  "compilerOptions": { "paths": { "@/*": ["./src/*"], "~utils/*": ["./src/utils/*"] } },
}`,
);
fs.writeFileSync(
  path.join(aliasDir, "src", "main.tsx"),
  `import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import helper from "~utils/helper";
import ReactDOM from "react-dom/client";
import { zodResolver } from "@hookform/resolvers/zod";
export function App() { return <Button className={cn("x")} onClick={helper} />; }
`,
);
const aliasAnalysis = analyzeRepo(aliasDir);
fs.rmSync(aliasDir, { recursive: true, force: true });
const imported = aliasAnalysis.importedPackages;
checks.push(
  ["@/components NOT treated as a package", !imported.has("@/components")],
  ["@/lib NOT treated as a package", !imported.has("@/lib")],
  ["custom tsconfig alias ~utils NOT treated as a package", !imported.has("~utils/helper") && !imported.has("~utils")],
  ["react-dom/client still resolves to react-dom", imported.has("react-dom")],
  ["@hookform/resolvers/zod still resolves to @hookform/resolvers", imported.has("@hookform/resolvers")],
);

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

// --- Single-package verification primitive (offline path, for codeaudit-mcp) ---
const verifyPhantomTypo = await verifyPackage("tyepscript", "npm");
const verifyHealthy = await verifyPackage("lodash", "npm");
const verifyMadeUp = await verifyPackage("react-toolkitz", "npm");
checks.push(
  ["verifyPackage(tyepscript) is phantom", verifyPhantomTypo.status === "phantom"],
  ["verifyPackage(tyepscript) suggests typescript", verifyPhantomTypo.alternatives?.[0]?.name === "typescript"],
  ["verifyPackage(lodash) is not phantom", verifyHealthy.status !== "phantom"],
  ["verifyPackage(lodash) reports a latestVersion", typeof verifyHealthy.latestVersion === "string"],
  ["verifyPackage(react-toolkitz) is phantom with NO alternative", verifyMadeUp.status === "phantom" && !verifyMadeUp.alternatives],
);

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

// --- Registry metadata enrichment (live npm; `request` is famously deprecated) ---
const enriched = await checkNpmPackage("request");
const lodashMeta = await checkNpmPackage("lodash");
checks.push(
  ["checkNpmPackage surfaces a deprecation message for request", typeof enriched.meta?.deprecated === "string"],
  ["checkNpmPackage surfaces a license for lodash", typeof lodashMeta.meta?.license === "string"],
  ["checkNpmPackage surfaces unpackedSize for lodash", typeof lodashMeta.meta?.unpackedSize === "number"],
  ["lodash is NOT marked deprecated", lodashMeta.meta?.deprecated === null],
);

// --- Licence conflict detection (offline, pure) ---
const licDeps = [
  { packageName: "copyleft-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "AGPL-3.0" } },
  { packageName: "weak-copyleft-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "LGPL-3.0" } },
  { packageName: "permissive-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: "MIT" } },
  { packageName: "unlicensed-lib", declaredVersion: "^1.0.0", status: "healthy", ecosystem: "npm", registryMetadata: { license: null } },
  { packageName: "unused-copyleft", declaredVersion: "^1.0.0", status: "unused", ecosystem: "npm", registryMetadata: { license: "GPL-3.0" } },
  { packageName: "@fixture/internal", declaredVersion: "workspace:*", status: "healthy", ecosystem: "npm", registryMetadata: { workspaceMember: true } },
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
  ["a workspace member with no declared licence is NOT flagged", !conflictNames.has("@fixture/internal")],
  ["copyleft deps are NOT conflicts when the project is itself AGPL", !gplConflicts.some((c) => c.packageName === "copyleft-lib")],
  ["readProjectLicense returns null when package.json declares no license", readProjectLicense(fixtureDir) === null],
);

// --- Unreachable registry is "unknown", not "unlicensed"/"in use" (offline, pure) ---
// A registry_unreachable verdict has no license key at all (it was never
// fetched), which used to read identically to "declares no licence" and fire
// a conflict for every dependency in the repo when a scan runs behind a
// corporate proxy.
const unreachableDeps = [
  {
    packageName: "unreachable-lib",
    declaredVersion: "^1.0.0",
    status: "healthy",
    ecosystem: "npm",
    registryMetadata: { error: "registry_unreachable" },
  },
] as unknown as Parameters<typeof checkLicenseConflicts>[0];
const unreachableConflicts = checkLicenseConflicts(unreachableDeps, "MIT");
checks.push([
  "a registry_unreachable dep produces NO licence conflict",
  !unreachableConflicts.some((c) => c.packageName === "unreachable-lib"),
]);

// A duplicate-group pair that both carry registry_unreachable must not be
// reported as "in use" duplicates — an unreachable registry never confirmed
// they're genuinely used at all.
const unreachableDupDeps = [
  { packageName: "moment", declaredVersion: "^2.30.0", status: "healthy", ecosystem: "npm", registryMetadata: { error: "registry_unreachable" } },
  { packageName: "dayjs", declaredVersion: "^1.11.0", status: "healthy", ecosystem: "npm", registryMetadata: { error: "registry_unreachable" } },
] as const;
const unreachableDupGroups = findDuplicateLibraries(
  unreachableDupDeps as unknown as Parameters<typeof findDuplicateLibraries>[0],
);
checks.push([
  "two registry_unreachable equivalent-group members produce NO duplicate group",
  !unreachableDupGroups.some((g) => g.category === "date"),
]);

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
  ["ranking places a phantom dependency above an unused one", kinds.indexOf("unused_dependency") > kinds.indexOf("phantom_dependency")],
  ["ranking places a critical CVE above an unused dependency", kinds.indexOf("unused_dependency") > kinds.indexOf("vulnerable_dependency")],
  ["ranking places unused dependency above dead code", kinds.indexOf("dead_code") > kinds.indexOf("unused_dependency")],
  ["deprecated dependency is ranked medium", ranked.find((r) => r.kind === "deprecated_dependency")?.band === "medium"],
  ["every ranked finding carries a non-empty why", ranked.every((r) => r.why.trim().length > 0)],
  ["removing an unused dependency is S effort", ranked.find((r) => r.kind === "unused_dependency")?.effort === "S"],
  ["ranks are 1-based and contiguous", ranked.every((r, i) => r.rank === i + 1)],
  ["ranking respects the limit option", rankFindings({ deps: rankDeps, codeFindings: [], limit: 2 }).length === 2],
);

// --- Kind ordering: typosquat-suspicious outranks a licence conflict (offline, pure) ---
// Spec order: phantom -> vulnerable -> suspicious(typosquat) -> licence
// conflict -> deprecated -> duplicate library -> unused -> dead code.
const squatDeps = [
  {
    packageName: "reqeusts",
    declaredVersion: "^1.0.0",
    status: "suspicious",
    ecosystem: "npm",
    registryMetadata: { typosquatOf: "requests" },
  },
] as unknown as Parameters<typeof rankFindings>[0]["deps"];
const squatVsLicense = rankFindings({
  deps: squatDeps,
  codeFindings: [],
  duplicates: [],
  licenseConflicts: [
    {
      packageName: "some-lib",
      ecosystem: "npm",
      packageLicense: "GPL-3.0",
      projectLicense: "MIT",
      severity: "high",
      reason: "test",
    },
  ],
});
const squatVsLicenseKinds = squatVsLicense.map((r) => r.kind);
checks.push([
  "a typosquat-suspicious finding outranks a licence conflict",
  squatVsLicenseKinds.indexOf("suspicious_dependency") < squatVsLicenseKinds.indexOf("license_conflict"),
]);

console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
