export { parseManifest, type Manifest } from "./manifest.js";
export { analyzeRepo, listSourceFiles, type RepoAnalysis, type SymbolInfo } from "./imports.js";
export { checkDependencies, type DependencyVerdict } from "./registry.js";
export { findDeadCodeCandidates, type DeadCodeCandidate } from "./deadcode.js";
export {
  reviewCandidatesWithLlm,
  type ReviewedFinding,
  type LlmConfig,
} from "./llm.js";
export { computeSummary, type ScanSummary } from "./score.js";
