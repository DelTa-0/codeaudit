import path from "node:path";
import { fetchJson, type DependencyVerdict } from "../registry.js";
import type { PythonManifest } from "./manifest.js";
import { PYTHON_STDLIB } from "./stdlib.js";
import { importNameToDistribution, normalizePyPiName } from "./aliases.js";
import { listPythonFiles } from "./imports.js";

const cache = new Map<string, { exists: boolean; meta: Record<string, unknown> | null }>();
const CONCURRENCY = 5;
const SUSPICIOUS_MONTHLY_DOWNLOADS = 200;
const SUSPICIOUS_AGE_DAYS = 90;

/**
 * Distributions that are legitimately declared without ever being imported
 * by name: CLI-invoked servers/tools, string-referenced parser backends
 * (BeautifulSoup(html, "lxml")), and framework peer requirements
 * (python-multipart for FastAPI's UploadFile). Import analysis cannot see
 * these usage patterns, so "declared but never imported" is not evidence of
 * anything — never flag them unused.
 */
const NEVER_FLAG_UNUSED = new Set([
  "uvicorn",
  "gunicorn",
  "lxml",
  "python-multipart",
  "setuptools",
  "wheel",
  "pip",
]);

async function checkPyPiPackage(name: string) {
  const cached = cache.get(name);
  if (cached) return cached;

  const result: { exists: boolean; meta: Record<string, unknown> | null } = {
    exists: false,
    meta: null,
  };
  const { status, data } = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (status !== 404 && data) {
    result.exists = true;
    const doc = data as {
      info?: { version?: string };
      releases?: Record<string, { upload_time_iso_8601?: string }[]>;
    };
    // First release date = earliest upload across all versions (best-effort).
    let created: string | null = null;
    for (const files of Object.values(doc.releases ?? {})) {
      for (const f of files) {
        const t = f.upload_time_iso_8601;
        if (t && (!created || t < created)) created = t;
      }
    }
    let monthlyDownloads: number | null = null;
    try {
      const dl = await fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
      monthlyDownloads =
        (dl.data as { data?: { last_month?: number } } | null)?.data?.last_month ?? null;
    } catch {
      // pypistats is best-effort and rate-limited — tolerate failures
    }
    result.meta = {
      created,
      latest: doc.info?.version ?? null,
      // stored under the same key the dashboard's downloads column reads
      weeklyDownloads: monthlyDownloads,
      downloadsPeriod: "month",
    };
  }
  cache.set(name, result);
  return result;
}

/**
 * Every module name the repo itself defines: the basename of each .py file
 * plus every directory segment on the way to one (packages). Anything in
 * this set can be satisfied by an intra-repo import from anywhere (tests
 * importing sibling test modules, src-layout packages, etc.), so it must
 * never be treated as a PyPI dependency.
 */
function collectLocalModuleNames(repoDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of listPythonFiles(repoDir)) {
    const rel = path.relative(repoDir, file).split(path.sep);
    const base = rel[rel.length - 1];
    names.add(base.replace(/\.py$/, ""));
    for (const segment of rel.slice(0, -1)) names.add(segment);
  }
  return names;
}

/**
 * PyPI verdicts, mirroring the npm checker. Python-specific care:
 * - stdlib modules are never checked or flagged
 * - imported-but-undeclared names that 404 are only phantom when they're
 *   also not resolvable as a local module in the repo — Python's import
 *   namespace conflates local and third-party names
 * - import names are mapped through the alias table (cv2 → opencv-python)
 */
export async function checkPythonDependencies(
  repoDir: string,
  manifest: PythonManifest | null,
  importedNames: Set<string>,
): Promise<DependencyVerdict[]> {
  const declared = manifest?.dependencies ?? {};
  const localModules = collectLocalModuleNames(repoDir);

  // Distribution name -> the import evidence that maps to it.
  const importedDistributions = new Map<string, string>();
  for (const importName of importedNames) {
    if (PYTHON_STDLIB.has(importName)) continue;
    if (localModules.has(importName)) continue;
    importedDistributions.set(importNameToDistribution(importName), importName);
  }

  const names = new Set([...Object.keys(declared), ...importedDistributions.keys()]);
  const verdicts: DependencyVerdict[] = [];
  const queue = [...names];

  async function workerLoop() {
    while (queue.length) {
      const name = queue.shift()!;
      const normalized = normalizePyPiName(name);
      const declaredVersion = declared[normalized] ?? null;
      const isDeclared = normalized in declared;
      const isImported = importedDistributions.has(normalized);
      try {
        const { exists, meta } = await checkPyPiPackage(normalized);
        let status: DependencyVerdict["status"];
        if (!exists) {
          status = "phantom";
        } else if (isDeclared && !isImported && !NEVER_FLAG_UNUSED.has(normalized)) {
          status = "unused";
        } else {
          const monthly = (meta?.weeklyDownloads as number | null) ?? null;
          const created = meta?.created ? new Date(meta.created as string) : null;
          const ageDays = created ? (Date.now() - created.getTime()) / 86_400_000 : Infinity;
          const lowDownloads = monthly !== null && monthly < SUSPICIOUS_MONTHLY_DOWNLOADS;
          const veryNew = ageDays < SUSPICIOUS_AGE_DAYS;
          status = lowDownloads || veryNew ? "suspicious" : "healthy";
        }
        verdicts.push({
          packageName: normalized,
          declaredVersion,
          status,
          ecosystem: "pypi",
          registryMetadata: meta,
        });
      } catch {
        verdicts.push({
          packageName: normalized,
          declaredVersion,
          status: isDeclared && !isImported ? "unused" : "healthy",
          ecosystem: "pypi",
          registryMetadata: { error: "registry_unreachable" },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  return verdicts;
}
