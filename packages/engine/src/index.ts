// Core, no-heavy-dependency surface — safe to bundle into the CLI without
// pulling in the "openai" SDK. LLM review lives at the separate "./llm"
// subpath (see package.json "exports") specifically so consumers that don't
// need it (the CLI) never touch that import graph.
export { parseManifest, type Manifest } from "./manifest.js";
export { analyzeRepo, listSourceFiles, type RepoAnalysis, type SymbolInfo } from "./imports.js";
export { checkDependencies, type DependencyVerdict } from "./registry.js";
export { findDeadCodeCandidates, type DeadCodeCandidate } from "./deadcode.js";
export type { ReviewedFinding } from "./llm.js";
export { computeSummary, type ScanSummary } from "./score.js";
