// Lockfile resolution — turns declared version ranges into the exact
// installed versions, and exposes the full transitive tree. Two payoffs:
//   1. Exact versions make OSV vulnerability matching precise, and let us
//      surface vulnerabilities in *transitive* deps (where most CVEs live).
//   2. Knowing which packages are pulled in transitively lets us stop
//      false-flagging a declared-but-unimported package as "unused" when it's
//      actually required by another dependency.
// Best-effort and dependency-light: no lockfile → callers keep their current
// behavior. Parsing never throws; a malformed lockfile yields null.
import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";

export interface ResolvedPackage {
  version: string;
  /** declared directly in the manifest (vs pulled in transitively) */
  direct: boolean;
}

export interface ResolvedTree {
  /** package name → resolved version + whether it's a direct dependency */
  packages: Map<string, ResolvedPackage>;
  /** names required by at least one other package (i.e. pulled transitively) */
  transitivelyRequired: Set<string>;
}

function readIf(file: string): string | null {
  try {
    return fs.readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Extract the bare package name from an `node_modules/...` lockfile path. */
function nameFromNodeModulesPath(key: string): string | null {
  const idx = key.lastIndexOf("node_modules/");
  if (idx === -1) return null;
  return key.slice(idx + "node_modules/".length);
}

function parseNpmLock(repoDir: string): ResolvedTree | null {
  const raw = readIf(path.join(repoDir, "package-lock.json"));
  if (!raw) return null;
  let doc: {
    packages?: Record<string, { version?: string; dependencies?: Record<string, string>; devDependencies?: Record<string, string> }>;
    dependencies?: Record<string, { version?: string; requires?: Record<string, string> }>;
  };
  try {
    doc = JSON.parse(raw);
  } catch {
    return null;
  }

  const packages = new Map<string, ResolvedPackage>();
  const transitivelyRequired = new Set<string>();

  // Lockfile v2/v3: the `packages` map keyed by install path.
  if (doc.packages) {
    const root = doc.packages[""] ?? {};
    const directNames = new Set([
      ...Object.keys(root.dependencies ?? {}),
      ...Object.keys(root.devDependencies ?? {}),
    ]);
    for (const [key, entry] of Object.entries(doc.packages)) {
      if (key === "" || !entry.version) continue;
      const name = nameFromNodeModulesPath(key);
      if (!name) continue;
      // Nested (deduped) copies can repeat a name; first/shallowest wins.
      if (!packages.has(name)) {
        packages.set(name, { version: entry.version, direct: directNames.has(name) });
      }
      for (const dep of Object.keys(entry.dependencies ?? {})) transitivelyRequired.add(dep);
    }
    return { packages, transitivelyRequired };
  }

  // Lockfile v1: the recursive `dependencies` tree.
  if (doc.dependencies) {
    const walk = (tree: Record<string, { version?: string; requires?: Record<string, string> }>, direct: boolean) => {
      for (const [name, entry] of Object.entries(tree)) {
        if (entry.version && !packages.has(name)) packages.set(name, { version: entry.version, direct });
        for (const dep of Object.keys(entry.requires ?? {})) transitivelyRequired.add(dep);
        const nested = (entry as { dependencies?: Record<string, { version?: string; requires?: Record<string, string> }> }).dependencies;
        if (nested) walk(nested, false);
      }
    };
    walk(doc.dependencies, true);
    return { packages, transitivelyRequired };
  }

  return null;
}

function parseYarnLock(repoDir: string): ResolvedTree | null {
  const raw = readIf(path.join(repoDir, "yarn.lock"));
  if (!raw) return null;

  const packages = new Map<string, ResolvedPackage>();
  const transitivelyRequired = new Set<string>();
  const lines = raw.split(/\r?\n/);
  let currentNames: string[] = [];
  let inDependencies = false;

  const nameFromSpec = (spec: string): string => {
    const s = spec.replace(/^"|"$/g, "").trim();
    // scoped: @scope/name@range → keep everything before the LAST '@'
    const at = s.lastIndexOf("@");
    return at <= 0 ? s : s.slice(0, at);
  };

  for (const line of lines) {
    if (!line.trim() || line.trimStart().startsWith("#")) continue;
    const indented = /^\s/.test(line);

    if (!indented && line.trimEnd().endsWith(":")) {
      // Header line: one or more comma-separated specs for the same package.
      const header = line.trimEnd().slice(0, -1);
      currentNames = header.split(",").map((s) => nameFromSpec(s));
      inDependencies = false;
      continue;
    }
    const versionMatch = line.match(/^\s+version:?\s+"?([^"]+)"?\s*$/);
    if (versionMatch && currentNames.length) {
      for (const name of currentNames) {
        if (!packages.has(name)) packages.set(name, { version: versionMatch[1], direct: false });
      }
      continue;
    }
    if (/^\s+dependencies:\s*$/.test(line)) {
      inDependencies = true;
      continue;
    }
    if (inDependencies) {
      const depMatch = line.match(/^\s+"?([^"\s]+)"?\s+"?[^"]+"?\s*$/);
      if (depMatch) transitivelyRequired.add(nameFromSpec(depMatch[1] + "@x"));
      else inDependencies = false;
    }
  }
  return packages.size ? { packages, transitivelyRequired } : null;
}

function parsePoetryLock(repoDir: string): ResolvedTree | null {
  const raw = readIf(path.join(repoDir, "poetry.lock"));
  if (!raw) return null;
  let doc: { package?: { name?: string; version?: string; category?: string; dependencies?: Record<string, unknown> }[] };
  try {
    doc = parseToml(raw) as typeof doc;
  } catch {
    return null;
  }
  const packages = new Map<string, ResolvedPackage>();
  const transitivelyRequired = new Set<string>();
  for (const pkg of doc.package ?? []) {
    if (!pkg.name || !pkg.version) continue;
    // Poetry lock doesn't distinguish direct vs transitive by itself; the
    // caller cross-references the manifest. Mark direct=false here.
    if (!packages.has(pkg.name)) packages.set(pkg.name, { version: pkg.version, direct: false });
    for (const dep of Object.keys(pkg.dependencies ?? {})) transitivelyRequired.add(dep.toLowerCase());
  }
  return packages.size ? { packages, transitivelyRequired } : null;
}

/** Pinned `pkg==1.2.3` lines in requirements.txt — no graph, just versions. */
function parsePinnedRequirements(repoDir: string): ResolvedTree | null {
  const raw = readIf(path.join(repoDir, "requirements.txt"));
  if (!raw) return null;
  const packages = new Map<string, ResolvedPackage>();
  for (const line of raw.split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z0-9._-]+)\s*==\s*([A-Za-z0-9._+!-]+)/);
    if (m) packages.set(m[1].toLowerCase(), { version: m[2], direct: true });
  }
  return packages.size ? { packages, transitivelyRequired: new Set() } : null;
}

/** Resolve the npm dependency tree from whichever lockfile is present. */
export function resolveNpmTree(repoDir: string): ResolvedTree | null {
  return parseNpmLock(repoDir) ?? parseYarnLock(repoDir);
}

/** Resolve the Python dependency tree from poetry.lock or pinned requirements. */
export function resolvePythonTree(repoDir: string): ResolvedTree | null {
  return parsePoetryLock(repoDir) ?? parsePinnedRequirements(repoDir);
}
