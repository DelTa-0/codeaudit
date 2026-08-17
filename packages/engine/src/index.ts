// Core, no-heavy-dependency surface. LLM review functions are plain fetch()
// calls (no SDK), so they live in this same main export alongside everything
// else — no separate subpath needed to keep the CLI bundle light.
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
export {
  callChatCompletion,
  reviewCandidatesWithLlm,
  suggestAlternatives,
  type LlmConfig,
  type ReviewedFinding,
  type ReviewStatus,
  type LlmReviewResult,
} from "./llm.js";
export {
  computeSummary,
  SCORE_VERSION,
  type ScanSummary,
  type ScoreAxes,
  type ScoreInput,
} from "./score.js";
export { detectEcosystems } from "./detect.js";
export { parsePythonManifest, type PythonManifest } from "./python/manifest.js";
export { analyzePythonRepo, listPythonFiles } from "./python/imports.js";
export { checkPythonDependencies, checkPyPiPackage, licenseFromClassifiers } from "./python/registry.js";
export { readProjectLicense, checkLicenseConflicts, type LicenseConflict } from "./license.js";
export {
  classifyLicenseTerm,
  classifyLicenseExpression,
  type LicenseClass,
} from "./licenseClass.js";
export {
  rankFindings,
  type RankedFinding,
  type RankInput,
  type Effort,
  type PriorityBand,
} from "./priority.js";
export {
  findSecrets,
  scanTextForSecrets,
  isSecretScannablePath,
  redact,
  fingerprintSecret,
  type SecretFinding,
  type FindSecretsOptions,
} from "./secrets.js";
export {
  classifyAgentSurface,
  scanAgentText,
  auditAgentJson,
  collectMcpPackageRefs,
  redactSnippet,
  findAgentConfigIssues,
  findMcpPackageRefs,
  type AgentSurface,
  type AgentConfigCategory,
  type AgentConfigFinding,
  type McpPackageRef,
} from "./agentConfig.js";
export { verifyAgentConfigPackages } from "./agentPackages.js";
export {
  extractMcpServers,
  diffMcpServers,
  findMcpDrift,
  type McpServerSpec,
} from "./mcpDrift.js";
export {
  HALLUCINATED_NAMES,
  lookupHallucinatedName,
  type HallucinatedName,
} from "./data/hallucinatedNames.js";
