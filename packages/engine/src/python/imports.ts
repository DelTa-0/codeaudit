import fs from "node:fs";
import path from "node:path";
import type { RepoAnalysis, SymbolInfo } from "../imports.js";

const SKIP_DIRS = new Set([
  "venv", ".venv", "env", ".env", "__pycache__", "site-packages", ".tox",
  ".git", "node_modules", "build", "dist", ".mypy_cache", ".pytest_cache",
  ".ruff_cache", "eggs", ".eggs",
]);
const MAX_FILE_BYTES = 1024 * 1024;

export function listPythonFiles(repoDir: string): string[] {
  const files: string[] = [];
  const stack = [repoDir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name) && !entry.name.endsWith(".egg-info")) {
          stack.push(path.join(current, entry.name));
        }
      } else if (entry.isFile() && entry.name.endsWith(".py")) {
        const full = path.join(current, entry.name);
        try {
          if (fs.statSync(full).size <= MAX_FILE_BYTES) files.push(full);
        } catch {
          // unreadable file — skip
        }
      }
    }
  }
  return files;
}

const IDENTIFIER_RE = /[A-Za-z_][A-Za-z0-9_]*/g;
const PY_KEYWORDS = new Set([
  "False", "None", "True", "and", "as", "assert", "async", "await", "break",
  "class", "continue", "def", "del", "elif", "else", "except", "finally",
  "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal",
  "not", "or", "pass", "raise", "return", "try", "while", "with", "yield",
  "self", "cls", "print", "len", "range", "str", "int", "float", "dict",
  "list", "set", "tuple", "type", "super", "isinstance", "Exception",
]);

/**
 * Line-oriented Python analysis producing the same RepoAnalysis shape as the
 * JS analyzer, so dead-code candidate filtering and LLM review run unchanged.
 * Deliberately pragmatic (no full AST): Python's import syntax and top-level
 * def/class structure are line-oriented enough for candidate-level precision,
 * and the LLM pass filters false positives downstream. tree-sitter WASM is
 * the documented upgrade path if more accuracy is ever needed.
 */
export function analyzePythonRepo(repoDir: string): RepoAnalysis {
  const importedPackages = new Set<string>();
  const symbols: SymbolInfo[] = [];
  const references = new Map<string, Set<string>>();
  const fileImportExports = new Map<string, string[]>();
  const files = listPythonFiles(repoDir);

  for (const file of files) {
    const rel = path.relative(repoDir, file).split(path.sep).join("/");
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }
    const lines = source.split("\n");
    const importLines: string[] = [];
    /** line numbers (1-based) where a symbol is *defined* in this file — its
     * own def line shouldn't count as a reference to itself */
    const defLineByName = new Map<string, number[]>();

    // --- Imports (including parenthesized multi-line `from x import (...)`) ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const importMatch = line.match(/^\s*import\s+(.+)$/);
      if (importMatch) {
        importLines.push(line.trim());
        for (const part of importMatch[1].split(",")) {
          const mod = part.trim().split(/\s+as\s+/)[0].trim();
          const top = mod.split(".")[0];
          if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(top)) importedPackages.add(top);
        }
        continue;
      }
      const fromMatch = line.match(/^\s*from\s+([A-Za-z_][\w.]*)\s+import\b/);
      if (fromMatch) {
        importLines.push(line.trim());
        const top = fromMatch[1].split(".")[0];
        importedPackages.add(top);
        // consume a parenthesized continuation for the import-line context only
        if (line.includes("(") && !line.includes(")")) {
          while (i + 1 < lines.length && !lines[i].includes(")")) i++;
        }
      }
      // `from . import x` / `from .mod import x` — relative, intentionally ignored
    }

    // --- Top-level symbols: column-0 def / async def / class ---
    for (let i = 0; i < lines.length; i++) {
      const defMatch = lines[i].match(/^(?:async\s+)?def\s+([A-Za-z_]\w*)\s*\(/);
      const classMatch = lines[i].match(/^class\s+([A-Za-z_]\w*)\s*[(:]/);
      const name = defMatch?.[1] ?? classMatch?.[1];
      if (!name) continue;

      // Decorated definitions (@app.get(...), @pytest.fixture, @click.command,
      // @celery.task, ...) are wired up by their framework, never by a name
      // reference — static call-graph analysis cannot see that dispatch, so
      // they must never be dead-code candidates. Top-level decorators sit at
      // column 0 directly above the def; walk up past blank/comment/indented
      // (multi-line decorator args) lines to the nearest column-0 line.
      let back = i - 1;
      let decorated = false;
      while (back >= 0) {
        const raw = lines[back];
        const trimmed = raw.trim();
        if (trimmed === "" || trimmed.startsWith("#") || /^[\s)\]}]/.test(raw)) {
          back--;
          continue;
        }
        decorated = raw.startsWith("@");
        break;
      }
      if (decorated) continue;

      // body extends until the next column-0 statement (or EOF)
      let end = i + 1;
      while (end < lines.length) {
        const l = lines[end];
        if (l.trim() !== "" && !/^[\s#]/.test(l) && !l.startsWith(")")) break;
        end++;
      }
      const lineStart = i + 1;
      const lineEnd = end; // last line of the body block (1-based, inclusive-ish)

      const defLines = defLineByName.get(name) ?? [];
      defLines.push(lineStart);
      defLineByName.set(name, defLines);

      // dunder / pytest / private-convention names are handled by the shared
      // candidate filter's entry-point list where applicable; skip dunders here
      if (name.startsWith("__") && name.endsWith("__")) continue;

      symbols.push({
        name,
        filePath: rel,
        lineStart,
        lineEnd,
        // Python has no export keyword; anything top-level is importable.
        exported: !name.startsWith("_"),
        kind: classMatch ? "component" : "function",
        body: lines.slice(i, Math.min(end, i + 200)).join("\n"),
      });
    }

    // --- Identifier references (excluding each symbol's own def lines) ---
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*#/.test(line)) continue;
      for (const match of line.matchAll(IDENTIFIER_RE)) {
        const name = match[0];
        if (PY_KEYWORDS.has(name)) continue;
        const defLines = defLineByName.get(name);
        if (defLines?.includes(i + 1)) continue; // its own definition line
        let set = references.get(name);
        if (!set) references.set(name, (set = new Set()));
        set.add(rel);
      }
    }

    fileImportExports.set(rel, importLines.slice(0, 40));
  }

  // Same-file usage is liveness. Unlike JS, Python has no export keyword —
  // every top-level name *could* be imported elsewhere, so the analyzer
  // marks non-underscore symbols "exported", which would bypass the shared
  // candidate filter's same-file rescue and flag internal helpers that are
  // only called within their own module (the dominant false-positive class
  // in real FastAPI-style codebases). Downgrade any symbol referenced in
  // its own file to non-exported so that rescue applies.
  for (const sym of symbols) {
    if (sym.exported && references.get(sym.name)?.has(sym.filePath)) {
      sym.exported = false;
    }
  }

  return { importedPackages, symbols, references, fileCount: files.length, fileImportExports };
}
