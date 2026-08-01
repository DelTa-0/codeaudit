// Core, no-heavy-dependency surface — safe to bundle into the CLI without
// pulling in the "openai" SDK. LLM review lives at the separate "./llm"
// subpath (see package.json "exports") specifically so consumers that don't
// need it (the CLI) never touch that import graph.
export { parseManifest, type Manifest } from "./manifest.js";
export { analyzeRepo, listSourceFiles, type RepoAnalysis, type SymbolInfo } from "./imports.js";
export {
  checkDependencies,
  checkNpmPackage,
  type DependencyVerdict,
  type Ecosystem,
  type AlternativeSuggestion,
} from "./registry.js";
export {
  checkVulnerabilities,
  applyVulnerabilities,
  collectVulnTargets,
  coerceVersion,
  severityRank,
  type VulnAdvisory,
  type VulnSeverity,
  type PackageVulns,
} from "./vulns.js";
export {
  resolveNpmTree,
  resolvePythonTree,
  type ResolvedTree,
  type ResolvedPackage,
} from "./lockfile.js";
export { checkTyposquat, type TyposquatHit } from "./typosquat.js";
export { findDuplicateLibraries, type DuplicateGroup } from "./duplicates.js";
export { EQUIVALENT_GROUPS, type EquivalentGroup } from "./data/equivalents.js";
export { verifyPackage, type PackageVerifyResult } from "./verify.js";
export { findDeadCodeCandidates, type DeadCodeCandidate } from "./deadcode.js";
export type { ReviewedFinding } from "./llm.js";
export { computeSummary, type ScanSummary } from "./score.js";
export { detectEcosystems } from "./detect.js";
export { parsePythonManifest, type PythonManifest } from "./python/manifest.js";
export { analyzePythonRepo, listPythonFiles } from "./python/imports.js";
export { checkPythonDependencies, checkPyPiPackage, licenseFromClassifiers } from "./python/registry.js";
export { readProjectLicense, checkLicenseConflicts, type LicenseConflict } from "./license.js";
export {
  rankFindings,
  type RankedFinding,
  type RankInput,
  type Effort,
  type PriorityBand,
} from "./priority.js";
