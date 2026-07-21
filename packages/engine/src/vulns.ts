// Known-vulnerability (CVE) lookup via OSV.dev — the free, key-less advisory
// database run by Google (covers npm, PyPI, and more). Static/HTTP only, so
// it lives in the core engine and runs in BOTH the hosted worker and the CLI
// (unlike LLM review). Never throws: a lookup failure degrades to "no vulns
// known" rather than failing the scan, mirroring registry.ts's philosophy.
import type { DependencyVerdict, Ecosystem } from "./registry.js";
import type { ResolvedTree } from "./lockfile.js";

export type VulnSeverity = "low" | "medium" | "high" | "critical" | "unknown";

export interface VulnAdvisory {
  /** OSV id — GHSA-…, PYSEC-…, or a CVE id. */
  id: string;
  /** Cross-referenced ids (usually the CVE). */
  aliases: string[];
  summary: string | null;
  severity: VulnSeverity;
  url: string;
}

export interface PackageVulns {
  packageName: string;
  version: string;
  ecosystem: Ecosystem;
  advisories: VulnAdvisory[];
  maxSeverity: VulnSeverity;
}

const OSV_BATCH_URL = "https://api.osv.dev/v1/querybatch";
const OSV_VULN_URL = "https://api.osv.dev/v1/vulns";
const OSV_ECOSYSTEM: Record<Ecosystem, string> = { npm: "npm", pypi: "PyPI" };
const CONCURRENCY = 5;
const SEVERITY_RANK: Record<VulnSeverity, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/**
 * Reduce a declared version spec to a single concrete version OSV can match
 * against a range. Handles the common `^1.2.3`, `~1.2.3`, `>=1.0.0 <2.0.0`,
 * `==1.2.3` forms by taking the first dotted-numeric token. Returns null when
 * nothing version-like is present (`*`, `latest`, `workspace:*`, git URLs) —
 * those are skipped rather than guessed. Lockfile resolution (phase 1) feeds
 * exact versions here and makes this coercion unnecessary.
 */
export function coerceVersion(spec: string | null): string | null {
  if (!spec) return null;
  const match = spec.match(/\d+(?:\.\d+){0,2}(?:[-+][0-9A-Za-z.-]+)?/);
  return match ? match[0] : null;
}

function bandFromScore(score: number): VulnSeverity {
  if (score >= 9) return "critical";
  if (score >= 7) return "high";
  if (score >= 4) return "medium";
  if (score > 0) return "low";
  return "unknown";
}

function normalizeQualitative(raw: string): VulnSeverity {
  const s = raw.toUpperCase();
  if (s === "CRITICAL") return "critical";
  if (s === "HIGH") return "high";
  if (s === "MODERATE" || s === "MEDIUM") return "medium";
  if (s === "LOW") return "low";
  return "unknown";
}

/** Best-effort severity extraction from an OSV vuln record. */
function extractSeverity(vuln: Record<string, unknown>): VulnSeverity {
  // GHSA records carry a clean qualitative band here — most reliable.
  const dbSpecific = vuln.database_specific as { severity?: string } | undefined;
  if (dbSpecific?.severity) {
    const q = normalizeQualitative(dbSpecific.severity);
    if (q !== "unknown") return q;
  }
  // Otherwise try to pull a numeric base score out of a CVSS vector/score.
  const severity = vuln.severity as { type?: string; score?: string }[] | undefined;
  for (const entry of severity ?? []) {
    const score = entry.score ?? "";
    // A bare numeric score (some ecosystems) vs a CVSS vector string.
    const asNum = Number(score);
    if (Number.isFinite(asNum) && score.trim() !== "") return bandFromScore(asNum);
  }
  return "unknown";
}

async function postJson(url: string, body: unknown): Promise<unknown> {
  const res = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new Error(`OSV request failed: ${res.status}`);
  return res.json();
}

async function getJson(url: string): Promise<Record<string, unknown> | null> {
  const res = await fetch(url, {
    headers: { accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) return null;
  return (await res.json()) as Record<string, unknown>;
}

/**
 * Look up known vulnerabilities for a set of resolved packages. Each package
 * needs a concrete version; callers should coerce declared specs with
 * `coerceVersion` or pass exact lockfile versions. Returns one entry per
 * package that has at least one advisory. Any network/parse failure yields an
 * empty result for the affected packages — it never throws.
 */
export async function checkVulnerabilities(
  packages: { name: string; version: string; ecosystem: Ecosystem }[],
): Promise<PackageVulns[]> {
  const targets = packages.filter((p) => p.version);
  if (targets.length === 0) return [];

  // 1. Batch query — returns only vuln ids (+ modified) per package.
  let batch: { results?: { vulns?: { id: string }[] }[] };
  try {
    batch = (await postJson(OSV_BATCH_URL, {
      queries: targets.map((p) => ({
        package: { name: p.name, ecosystem: OSV_ECOSYSTEM[p.ecosystem] },
        version: p.version,
      })),
    })) as typeof batch;
  } catch {
    return []; // OSV unreachable — degrade to "nothing known".
  }

  // 2. Collect the packages that had hits, and the unique ids to hydrate.
  const hits: { pkg: (typeof targets)[number]; ids: string[] }[] = [];
  const uniqueIds = new Set<string>();
  batch.results?.forEach((result, i) => {
    const ids = (result.vulns ?? []).map((v) => v.id);
    if (ids.length === 0) return;
    hits.push({ pkg: targets[i], ids });
    for (const id of ids) uniqueIds.add(id);
  });
  if (hits.length === 0) return [];

  // 3. Hydrate each advisory once (severity + summary), concurrency-limited.
  const details = new Map<string, VulnAdvisory>();
  const idQueue = [...uniqueIds];
  async function hydrateLoop() {
    while (idQueue.length) {
      const id = idQueue.shift()!;
      try {
        const vuln = await getJson(`${OSV_VULN_URL}/${encodeURIComponent(id)}`);
        if (!vuln) continue;
        details.set(id, {
          id,
          aliases: Array.isArray(vuln.aliases) ? (vuln.aliases as string[]) : [],
          summary: (vuln.summary as string | undefined) ?? null,
          severity: extractSeverity(vuln),
          url: `https://osv.dev/vulnerability/${id}`,
        });
      } catch {
        // Skip an advisory we couldn't fetch rather than failing the scan.
      }
    }
  }
  await Promise.all(Array.from({ length: CONCURRENCY }, hydrateLoop));

  // 4. Assemble per-package results with a rolled-up max severity.
  const out: PackageVulns[] = [];
  for (const { pkg, ids } of hits) {
    const advisories = ids.map((id) => details.get(id)).filter((a): a is VulnAdvisory => Boolean(a));
    if (advisories.length === 0) continue;
    const maxSeverity = advisories.reduce<VulnSeverity>(
      (acc, a) => (SEVERITY_RANK[a.severity] > SEVERITY_RANK[acc] ? a.severity : acc),
      "unknown",
    );
    out.push({
      packageName: pkg.name,
      version: pkg.version,
      ecosystem: pkg.ecosystem,
      advisories,
      maxSeverity,
    });
  }
  return out;
}

/**
 * Merge vulnerability results back onto dependency verdicts: attaches the
 * advisory list to `registryMetadata.vulnerabilities` and upgrades the status
 * to "vulnerable" (a known CVE is more important to surface than
 * healthy/suspicious/unused). Phantom packages don't exist on the registry so
 * they're never upgraded. Mutates and returns the same array.
 */
export function applyVulnerabilities(
  verdicts: DependencyVerdict[],
  vulns: PackageVulns[],
): DependencyVerdict[] {
  const verdictByKey = new Map<string, DependencyVerdict>();
  for (const v of verdicts) verdictByKey.set(`${v.ecosystem}:${v.packageName}`, v);

  for (const hit of vulns) {
    const key = `${hit.ecosystem}:${hit.packageName}`;
    const verdict = verdictByKey.get(key);
    if (verdict) {
      if (verdict.status === "phantom") continue; // can't be vulnerable if it doesn't exist
      verdict.status = "vulnerable";
      verdict.registryMetadata = {
        ...(verdict.registryMetadata ?? {}),
        vulnerabilities: hit.advisories,
        maxSeverity: hit.maxSeverity,
      };
    } else {
      // Transitive-only vulnerable package (from the lockfile) — surface it as
      // a new finding so CVEs deep in the tree aren't invisible.
      verdicts.push({
        packageName: hit.packageName,
        declaredVersion: hit.version,
        status: "vulnerable",
        ecosystem: hit.ecosystem,
        registryMetadata: {
          vulnerabilities: hit.advisories,
          maxSeverity: hit.maxSeverity,
          transitive: true,
        },
      });
    }
  }
  return verdicts;
}

/** Highest-severity band across all vulnerable verdicts (for scoring/precedence). */
export function severityRank(sev: VulnSeverity): number {
  return SEVERITY_RANK[sev];
}

/**
 * Build the deduplicated list of packages to send to OSV: every exact version
 * from the resolved lockfile tree (declared + transitive), plus any declared
 * dep without a lockfile entry (coerced from its declared range). Capped to
 * bound the batch size on huge trees.
 */
export function collectVulnTargets(
  deps: DependencyVerdict[],
  trees: { ecosystem: Ecosystem; tree: ResolvedTree | null }[],
  cap = 1000,
): { name: string; ecosystem: Ecosystem; version: string }[] {
  const seen = new Set<string>();
  const targets: { name: string; ecosystem: Ecosystem; version: string }[] = [];
  const add = (name: string, ecosystem: Ecosystem, version: string | null) => {
    if (!version) return;
    const key = `${ecosystem}:${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    targets.push({ name, ecosystem, version });
  };
  for (const { ecosystem, tree } of trees) {
    for (const [name, resolved] of tree?.packages ?? []) add(name, ecosystem, resolved.version);
  }
  for (const d of deps) {
    if (d.status === "phantom") continue;
    add(d.packageName, d.ecosystem, coerceVersion(d.declaredVersion));
  }
  return targets.slice(0, cap);
}
