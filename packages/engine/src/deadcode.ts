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
 * Framework-generated code. These files are written by a tool and loaded by
 * convention (Django/Alembic discover migration modules by path, never by
 * name), so "nothing references this symbol" is true by construction and
 * says nothing about whether the code is dead. Caught in the wild: a Django
 * project produced 17 candidates entirely from `accounts/migrations/`, which
 * were not only false positives but burned the LLM review budget judging
 * generated code.
 */
const GENERATED_DIR_PATTERN = /(^|\/)(migrations|__pycache__|\.venv|venv|vendor|third_party)\//;
const GENERATED_FILE_PATTERN = /(\.gen\.[jt]sx?$|\.generated\.|_pb2\.pyi?$|\.min\.js$)/;

/**
 * A symbol is a dead-code candidate when nothing outside its own file
 * references it. Entry-point-looking names, test files and generated code are
 * excluded to keep precision high — the LLM pass judges the remainder.
 */
export function findDeadCodeCandidates(analysis: RepoAnalysis): DeadCodeCandidate[] {
  const candidates: DeadCodeCandidate[] = [];

  for (const sym of analysis.symbols) {
    if (IGNORED_NAMES.has(sym.name)) continue;
    if (/\.(test|spec|stories)\./.test(sym.filePath)) continue;
    if (/(^|\/)(tests?|__tests__|__mocks__|scripts)\//.test(sym.filePath)) continue;
    if (GENERATED_DIR_PATTERN.test(sym.filePath)) continue;
    if (GENERATED_FILE_PATTERN.test(sym.filePath)) continue;

    const refs = analysis.references.get(sym.name);
    const externalRefs = refs ? [...refs].filter((f) => f !== sym.filePath) : [];
    if (externalRefs.length > 0) continue;
    // Any symbol referenced within its own file is alive, exported or not —
    // an exported helper called only by other code in the same file (no
    // external import, no re-export) is not dead code.
    if (refs && refs.has(sym.filePath)) continue;

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
