import fs from "node:fs";
import path from "node:path";
import { parse } from "@babel/parser";
import _traverse from "@babel/traverse";

// @babel/traverse ships CJS; interop differs between tsx/dev and node/prod.
const traverse = ((_traverse as unknown as { default?: unknown }).default ??
  _traverse) as typeof _traverse.default;

const SOURCE_EXTENSIONS = new Set([".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs"]);
const SKIP_DIRS = new Set(["node_modules", "dist", "build", ".git", ".next", "coverage", "out", "vendor"]);
// Build-output directories don't always use the exact bare name (e.g. a
// server bundled separately from a client build lands in "dist-server",
// "build-client", etc.) — match the common prefix pattern too, not just the
// bare-name set above.
const SKIP_DIR_PATTERN = /^(dist|build|out)(-|$)/;
const MAX_FILE_BYTES = 1024 * 1024;

function shouldSkipDir(name: string): boolean {
  return SKIP_DIRS.has(name) || SKIP_DIR_PATTERN.test(name);
}

export interface SymbolInfo {
  name: string;
  filePath: string; // repo-relative, forward slashes
  lineStart: number;
  lineEnd: number;
  exported: boolean;
  kind: "function" | "component";
  body: string;
}

export interface RepoAnalysis {
  /** bare package specifiers imported anywhere (npm package names, scoped supported) */
  importedPackages: Set<string>;
  /** declared top-level symbols across the repo */
  symbols: SymbolInfo[];
  /** every identifier reference site: name -> set of files it is referenced in */
  references: Map<string, Set<string>>;
  fileCount: number;
  /** import/export summary per file, used as context in LLM prompts */
  fileImportExports: Map<string, string[]>;
}

export function listSourceFiles(repoDir: string): string[] {
  const files: string[] = [];
  const stack = [repoDir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!shouldSkipDir(entry.name)) stack.push(path.join(current, entry.name));
      } else if (entry.isFile() && SOURCE_EXTENSIONS.has(path.extname(entry.name))) {
        const full = path.join(current, entry.name);
        if (fs.statSync(full).size <= MAX_FILE_BYTES) files.push(full);
      }
    }
  }
  return files;
}

function packageNameFromSpecifier(spec: string): string | null {
  if (spec.startsWith(".") || spec.startsWith("/") || spec.startsWith("node:")) return null;
  const parts = spec.split("/");
  return spec.startsWith("@") ? parts.slice(0, 2).join("/") : parts[0];
}

export function analyzeRepo(repoDir: string): RepoAnalysis {
  const importedPackages = new Set<string>();
  const symbols: SymbolInfo[] = [];
  const references = new Map<string, Set<string>>();
  const fileImportExports = new Map<string, string[]>();
  const files = listSourceFiles(repoDir);

  for (const file of files) {
    const rel = path.relative(repoDir, file).split(path.sep).join("/");
    let source: string;
    try {
      source = fs.readFileSync(file, "utf8");
    } catch {
      continue;
    }

    let ast;
    try {
      ast = parse(source, {
        sourceType: "unambiguous",
        plugins: ["typescript", "jsx", "decorators-legacy", "classProperties"],
        errorRecovery: true,
      });
    } catch {
      continue; // unparseable file — skip, never fail the scan for one file
    }

    const lines = source.split("\n");
    const importExportLines: string[] = [];
    const declaredHere = new Set<string>();

    const addSymbol = (
      name: string,
      node: { loc?: { start: { line: number }; end: { line: number } } | null },
      exported: boolean,
    ) => {
      if (!node.loc) return;
      const { line: lineStart } = node.loc.start;
      const { line: lineEnd } = node.loc.end;
      declaredHere.add(name);
      symbols.push({
        name,
        filePath: rel,
        lineStart,
        lineEnd,
        exported,
        kind: /^[A-Z]/.test(name) ? "component" : "function",
        body: lines.slice(lineStart - 1, lineEnd).join("\n"),
      });
    };

    traverse(ast, {
      ImportDeclaration(p) {
        const pkg = packageNameFromSpecifier(p.node.source.value);
        if (pkg) importedPackages.add(pkg);
        importExportLines.push(lines[p.node.loc!.start.line - 1]?.trim() ?? "");
      },
      CallExpression(p) {
        const callee = p.node.callee;
        if (
          callee.type === "Identifier" &&
          callee.name === "require" &&
          p.node.arguments[0]?.type === "StringLiteral"
        ) {
          const pkg = packageNameFromSpecifier(p.node.arguments[0].value);
          if (pkg) importedPackages.add(pkg);
        }
        if (callee.type === "Import" && p.node.arguments[0]?.type === "StringLiteral") {
          const pkg = packageNameFromSpecifier(p.node.arguments[0].value);
          if (pkg) importedPackages.add(pkg);
        }
      },
      FunctionDeclaration(p) {
        if (!p.node.id || p.parentPath.isExportDefaultDeclaration()) return;
        const exported = p.parentPath.isExportNamedDeclaration();
        if (p.scope.parent?.block.type === "Program" || exported)
          addSymbol(p.node.id.name, p.node, exported);
      },
      VariableDeclarator(p) {
        if (p.node.id.type !== "Identifier") return;
        const init = p.node.init;
        if (!init || (init.type !== "ArrowFunctionExpression" && init.type !== "FunctionExpression"))
          return;
        const decl = p.parentPath;
        const exported = decl.parentPath?.isExportNamedDeclaration() ?? false;
        const topLevel = decl.parentPath?.isProgram() || exported;
        if (topLevel) addSymbol(p.node.id.name, p.node, exported);
      },
      ExportNamedDeclaration(p) {
        if (p.node.loc) importExportLines.push(lines[p.node.loc.start.line - 1]?.trim() ?? "");
      },
      Identifier(p) {
        // Reference sites only — skip declarations/keys so a symbol's own definition doesn't count.
        if (!p.isReferencedIdentifier()) return;
        const name = p.node.name;
        let set = references.get(name);
        if (!set) references.set(name, (set = new Set()));
        set.add(rel);
      },
      JSXIdentifier(p) {
        // <Component /> usage counts as a reference to Component.
        if (p.parentPath.isJSXOpeningElement() || p.parentPath.isJSXClosingElement()) {
          const name = p.node.name;
          if (/^[A-Z]/.test(name)) {
            let set = references.get(name);
            if (!set) references.set(name, (set = new Set()));
            set.add(rel);
          }
        }
      },
    });

    fileImportExports.set(rel, importExportLines.filter(Boolean).slice(0, 40));
  }

  return { importedPackages, symbols, references, fileCount: files.length, fileImportExports };
}
