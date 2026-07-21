import fs from "node:fs";
import path from "node:path";
import type { Manifest } from "./manifest.js";
import { checkTyposquat } from "./typosquat.js";

export type Ecosystem = "npm" | "pypi";

export interface DependencyVerdict {
  packageName: string;
  declaredVersion: string | null;
  status: "phantom" | "unused" | "healthy" | "suspicious" | "vulnerable";
  ecosystem: Ecosystem;
  registryMetadata: Record<string, unknown> | null;
}

const cache = new Map<string, { exists: boolean; meta: Record<string, unknown> | null }>();
const CONCURRENCY = 5;
const SUSPICIOUS_WEEKLY_DOWNLOADS = 50;
const SUSPICIOUS_AGE_DAYS = 90;

/**
 * Packages legitimately declared without ever being `import`/`require`d:
 * invoked only from package.json scripts (concurrently, nodemon, cross-env,
 * husky), config-file-only tooling (tailwindcss, postcss), CLI/compiler
 * tools invoked via a script rather than imported (typescript, tsx,
 * esbuild), or peer runtimes required internally by another package the app
 * genuinely imports (pg/pg-hstore behind Sequelize's `dialect: "postgres"`,
 * @splinetool/runtime behind @splinetool/react-spline) — confirmed against a
 * real repo where all of these were false positives. Mirrors
 * python/registry.ts's NEVER_FLAG_UNUSED for the same reason — never flag
 * them unused.
 */
const NEVER_FLAG_UNUSED = new Set([
  "concurrently",
  "nodemon",
  "cross-env",
  "husky",
  "tailwindcss",
  "postcss",
  "autoprefixer",
  "typescript",
  "tsx",
  "esbuild",
  "pg-hstore",
  "@splinetool/runtime",
  // Linters/formatters: invoked as CLIs and configured by file, never imported.
  "eslint",
  "prettier",
  // Bundlers/dev servers: referenced from a build config (which is often itself
  // a thin wrapper package), not from application source. Confirmed against a
  // real Vite + TanStack Start scaffold where all of these read as "unused"
  // while removing any of them breaks the build.
  "vite",
  "vite-tsconfig-paths",
  "nitro",
  "vitest",
  "rollup",
  "webpack",
]);

/**
 * Prefix families that are config-referenced, not imported, by convention.
 * The bundler-plugin families matter because a project frequently declares
 * plugins that only a wrapper config package ever imports.
 */
const NEVER_FLAG_UNUSED_PREFIXES = [
  "eslint-plugin-",
  "eslint-config-",
  "@types/",
  "vite-plugin-",
  "@vitejs/",
  "rollup-plugin-",
  "babel-plugin-",
  "@tailwindcss/",
];

function isNeverFlagUnused(name: string): boolean {
  if (NEVER_FLAG_UNUSED.has(name)) return true;
  // A package named "…-plugin" is a build-tool plugin by near-universal
  // convention (@tanstack/router-plugin, unplugin-*, etc.) — wired up in a
  // bundler config, never imported by application source.
  if (name.endsWith("-plugin")) return true;
  return NEVER_FLAG_UNUSED_PREFIXES.some((prefix) => name.startsWith(prefix));
}

/**
 * Sequelize dialect drivers: Sequelize `require`s these internally based on
 * a `dialect: "..."` string at runtime, never via a literal import/require
 * the static analyzer can see. Only exempt them when Sequelize itself is
 * genuinely present — unlike the always-invisible NEVER_FLAG_UNUSED set,
 * "declared pg but never touched an ORM or Postgres at all" is still a
 * legitimate unused finding.
 */
const SEQUELIZE_DIALECT_DRIVERS = new Set(["pg", "mysql2", "mariadb", "tedious", "sqlite3", "oracledb"]);

function isImplicitOrmDriver(name: string, names: Set<string>): boolean {
  return SEQUELIZE_DIALECT_DRIVERS.has(name) && (names.has("sequelize") || names.has("sequelize-typescript"));
}

/**
 * Renderer/runtime peers that meta-frameworks import internally rather than
 * the application importing them directly — a TanStack Start / Next / Remix
 * app frequently never writes `import ... from "react-dom"` itself, yet
 * removing it breaks the build. Conditional like the ORM drivers above rather
 * than blanket-allowlisted: `react-dom` declared in a project with no React at
 * all is still a genuine finding. The asymmetry justifies the exemption —
 * wrongly advising "remove react-dom" breaks an app, while missing one truly
 * unused copy costs 3 points.
 */
const FRAMEWORK_PEERS: Record<string, string[]> = {
  "react-dom": ["react", "next", "@remix-run/react", "@tanstack/react-start"],
  "react": ["next", "@tanstack/react-start"],
};

function isFrameworkPeer(name: string, names: Set<string>): boolean {
  return (FRAMEWORK_PEERS[name] ?? []).some((required) => names.has(required));
}

export async function fetchJson(url: string): Promise<{ status: number; data: unknown }> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (res.status === 404) return { status: 404, data: null };
  if (!res.ok) throw new Error(`Registry request failed: ${res.status} ${url}`);
  return { status: res.status, data: await res.json() };
}

async function checkNpmPackage(name: string) {
  const cached = cache.get(name);
  if (cached) return cached;

  const result: { exists: boolean; meta: Record<string, unknown> | null } = {
    exists: false,
    meta: null,
  };
  const { status, data } = await fetchJson(
    `https://registry.npmjs.org/${encodeURIComponent(name)}`,
  );
  if (status !== 404 && data) {
    result.exists = true;
    const doc = data as {
      time?: Record<string, string>;
      "dist-tags"?: Record<string, string>;
    };
    const created = doc.time?.created ?? null;
    let weeklyDownloads: number | null = null;
    try {
      const dl = await fetchJson(
        `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(name)}`,
      );
      weeklyDownloads = (dl.data as { downloads?: number } | null)?.downloads ?? 0;
    } catch {
      // downloads API is best-effort
    }
    result.meta = {
      created,
      latest: doc["dist-tags"]?.latest ?? null,
      weeklyDownloads,
    };
  }
  cache.set(name, result);
  return result;
}

/**
 * npm/yarn/pnpm workspace member package names (the "name" field of each
 * workspace member's own package.json). A dependency that resolves to one
 * of these is internally linked via a symlink, not the public registry —
 * declared versions like "*" or "workspace:*" will 404 against
 * registry.npmjs.org and must never be treated as phantom/unused evidence.
 */
function resolveWorkspaceMemberNames(repoDir: string): Set<string> {
  const names = new Set<string>();
  let rootPkg: { workspaces?: string[] | { packages?: string[] } } | null = null;
  try {
    rootPkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8"));
  } catch {
    return names;
  }
  const patterns = Array.isArray(rootPkg?.workspaces)
    ? rootPkg.workspaces
    : (rootPkg?.workspaces?.packages ?? []);

  const memberDirs: string[] = [];
  for (const pattern of patterns) {
    if (pattern.endsWith("/*")) {
      const base = path.join(repoDir, pattern.slice(0, -2));
      try {
        for (const entry of fs.readdirSync(base, { withFileTypes: true })) {
          if (entry.isDirectory()) memberDirs.push(path.join(base, entry.name));
        }
      } catch {
        // pattern's parent dir doesn't exist — skip
      }
    } else {
      memberDirs.push(path.join(repoDir, pattern));
    }
  }

  for (const dir of memberDirs) {
    try {
      const pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")) as {
        name?: string;
      };
      if (pkg.name) names.add(pkg.name);
    } catch {
      // no package.json at this member path — skip
    }
  }
  return names;
}

export async function checkDependencies(
  repoDir: string,
  manifest: Manifest,
  importedPackages: Set<string>,
  options?: { transitivelyRequired?: Set<string> },
): Promise<DependencyVerdict[]> {
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const names = new Set([...Object.keys(declared), ...importedPackages]);
  const workspaceMembers = resolveWorkspaceMemberNames(repoDir);
  const transitivelyRequired = options?.transitivelyRequired ?? new Set<string>();
  const verdicts: DependencyVerdict[] = [];
  const queue = [...names];

  async function workerLoop() {
    while (queue.length) {
      const name = queue.shift()!;
      const declaredVersion = declared[name] ?? null;
      const isDeclared = name in declared;
      const isImported = importedPackages.has(name);
      // A declared-but-unimported package that another dependency pulls in
      // transitively isn't dead weight — don't flag it unused.
      const neverUnused =
        isNeverFlagUnused(name) ||
        isImplicitOrmDriver(name, names) ||
        isFrameworkPeer(name, names) ||
        transitivelyRequired.has(name);
      if (workspaceMembers.has(name)) {
        // Internally linked, not on the public registry — never phantom.
        verdicts.push({
          packageName: name,
          declaredVersion,
          status: isDeclared && !isImported && !neverUnused ? "unused" : "healthy",
          ecosystem: "npm",
          registryMetadata: { workspaceMember: true },
        });
        continue;
      }
      try {
        const { exists, meta } = await checkNpmPackage(name);
        let status: DependencyVerdict["status"];
        if (!exists) {
          status = "phantom";
        } else if (isDeclared && !isImported && !neverUnused) {
          status = "unused";
        } else {
          const weekly = (meta?.weeklyDownloads as number | null) ?? null;
          const created = meta?.created ? new Date(meta.created as string) : null;
          const ageDays = created ? (Date.now() - created.getTime()) / 86_400_000 : Infinity;
          const lowDownloads = weekly !== null && weekly < SUSPICIOUS_WEEKLY_DOWNLOADS;
          const veryNew = ageDays < SUSPICIOUS_AGE_DAYS;
          status = lowDownloads || veryNew ? "suspicious" : "healthy";
        }
        // Typosquat/slopsquat check. A distance-1 name is escalated to
        // suspicious unless the package is clearly established (high download
        // count) — that guard keeps legit near-neighbors like `preact` (≈react)
        // from being flagged. A distance-2 name only enriches an
        // already-suspicious verdict.
        let registryMetadata = meta;
        if (status !== "phantom") {
          const weeklyDl = (meta?.weeklyDownloads as number | null) ?? null;
          const established = weeklyDl !== null && weeklyDl >= 100_000;
          const squat = checkTyposquat(name, "npm");
          if (squat && (status === "suspicious" || (squat.distance === 1 && !established))) {
            status = "suspicious";
            registryMetadata = {
              ...(meta ?? {}),
              typosquatOf: squat.suspectedTarget,
              typosquatDistance: squat.distance,
            };
          }
        }
        verdicts.push({
          packageName: name,
          declaredVersion,
          status,
          ecosystem: "npm",
          registryMetadata,
        });
      } catch (err) {
        // Registry unreachable — record as healthy-unknown rather than failing the scan.
        verdicts.push({
          packageName: name,
          declaredVersion,
          status: isDeclared && !isImported && !neverUnused ? "unused" : "healthy",
          ecosystem: "npm",
          registryMetadata: { error: "registry_unreachable" },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  return verdicts;
}
