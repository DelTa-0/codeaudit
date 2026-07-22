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
console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
