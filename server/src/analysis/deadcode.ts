import type { RepoAnalysis, SymbolInfo } from "./imports.js";

export interface DeadCodeCandidate extends SymbolInfo {
  findingType: "dead_function" | "dead_export" | "dead_component";
}

const MAX_CANDIDATES = 40;
const IGNORED_NAMES = new Set([
  "default", "main", "index", "setup", "teardown",
  // common framework entry points that are called externally
  "loader", "action", "handler", "middleware", "config", "metadata",
  "getStaticProps", "getServerSideProps", "generateMetadata", "Route",
]);

/**
 * A symbol is a dead-code candidate when nothing outside its own file
 * references it. Entry-point-looking names and test files are excluded to
 * keep precision high — the LLM pass judges the remainder.
 */
export function findDeadCodeCandidates(analysis: RepoAnalysis): DeadCodeCandidate[] {
  const candidates: DeadCodeCandidate[] = [];

  for (const sym of analysis.symbols) {
    if (IGNORED_NAMES.has(sym.name)) continue;
    if (/\.(test|spec|stories)\./.test(sym.filePath)) continue;
    if (/(^|\/)(tests?|__tests__|__mocks__|scripts)\//.test(sym.filePath)) continue;

    const refs = analysis.references.get(sym.name);
    const externalRefs = refs ? [...refs].filter((f) => f !== sym.filePath) : [];
    if (externalRefs.length > 0) continue;
    // Un-exported symbols referenced within their own file are alive.
    if (!sym.exported && refs && refs.has(sym.filePath)) continue;

    candidates.push({
      ...sym,
      findingType: sym.exported
        ? sym.kind === "component"
          ? "dead_component"
          : "dead_export"
        : "dead_function",
    });
    if (candidates.length >= MAX_CANDIDATES) break;
  }

  return candidates;
}
