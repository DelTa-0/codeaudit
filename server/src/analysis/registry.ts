import type { Manifest } from "./manifest.js";

export interface DependencyVerdict {
  packageName: string;
  declaredVersion: string | null;
  status: "phantom" | "unused" | "healthy" | "suspicious";
  registryMetadata: Record<string, unknown> | null;
}

const cache = new Map<string, { exists: boolean; meta: Record<string, unknown> | null }>();
const CONCURRENCY = 5;
const SUSPICIOUS_WEEKLY_DOWNLOADS = 50;
const SUSPICIOUS_AGE_DAYS = 90;

async function fetchJson(url: string): Promise<{ status: number; data: unknown }> {
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

export async function checkDependencies(
  manifest: Manifest,
  importedPackages: Set<string>,
): Promise<DependencyVerdict[]> {
  const declared = { ...manifest.devDependencies, ...manifest.dependencies };
  const names = new Set([...Object.keys(declared), ...importedPackages]);
  const verdicts: DependencyVerdict[] = [];
  const queue = [...names];

  async function workerLoop() {
    while (queue.length) {
      const name = queue.shift()!;
      const declaredVersion = declared[name] ?? null;
      const isDeclared = name in declared;
      const isImported = importedPackages.has(name);
      try {
        const { exists, meta } = await checkNpmPackage(name);
        let status: DependencyVerdict["status"];
        if (!exists) {
          status = "phantom";
        } else if (isDeclared && !isImported) {
          status = "unused";
        } else {
          const weekly = (meta?.weeklyDownloads as number | null) ?? null;
          const created = meta?.created ? new Date(meta.created as string) : null;
          const ageDays = created ? (Date.now() - created.getTime()) / 86_400_000 : Infinity;
          const lowDownloads = weekly !== null && weekly < SUSPICIOUS_WEEKLY_DOWNLOADS;
          const veryNew = ageDays < SUSPICIOUS_AGE_DAYS;
          status = lowDownloads || veryNew ? "suspicious" : "healthy";
        }
        verdicts.push({ packageName: name, declaredVersion, status, registryMetadata: meta });
      } catch (err) {
        // Registry unreachable — record as healthy-unknown rather than failing the scan.
        verdicts.push({
          packageName: name,
          declaredVersion,
          status: isDeclared && !isImported ? "unused" : "healthy",
          registryMetadata: { error: "registry_unreachable" },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  return verdicts;
}
