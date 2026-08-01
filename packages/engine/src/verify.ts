// Single-package, ad-hoc verification primitive — used by codematrix-mcp to
// answer "is this ONE package (that an agent is about to install) real and
// trustworthy?" without needing a whole repo/manifest/import-graph context.
// Recomposes the same checks a full scan runs (registry existence, fuzzy
// "did you mean", typosquat, downloads/age, known CVEs) rather than adding
// new detection logic. No LLM import here — hosted LLM-based alternative
// suggestions are a separate, server-side concern (see mcp/src/hosted.ts).
import { checkNpmPackage, type AlternativeSuggestion, type Ecosystem } from "./registry.js";
import { checkPyPiPackage } from "./python/registry.js";
import { normalizePyPiName } from "./python/aliases.js";
import { checkTyposquat, fuzzyAlternative } from "./typosquat.js";
import { checkVulnerabilities, type VulnAdvisory, type VulnSeverity } from "./vulns.js";

export interface PackageVerifyResult {
  name: string;
  ecosystem: Ecosystem;
  exists: boolean;
  status: "phantom" | "healthy" | "suspicious" | "vulnerable";
  reason: string;
  weeklyDownloads: number | null;
  downloadsPeriod: "week" | "month";
  ageDays: number | null;
  latestVersion: string | null;
  typosquatOf?: string;
  typosquatDistance?: number;
  alternatives?: AlternativeSuggestion[];
  vulnerabilities?: VulnAdvisory[];
  maxSeverity?: VulnSeverity;
}

const SUSPICIOUS_DOWNLOADS: Record<Ecosystem, number> = { npm: 50, pypi: 200 };
const SUSPICIOUS_AGE_DAYS = 90;
const ESTABLISHED_DOWNLOADS = 100_000;
const DEFAULT_DOWNLOADS_PERIOD: Record<Ecosystem, "week" | "month"> = { npm: "week", pypi: "month" };

/**
 * Verifies one package name against its registry. Mirrors the per-package
 * logic inside registry.ts's/python/registry.ts's checkDependencies loops,
 * but for a single ad-hoc name with no manifest/import-graph context.
 *
 * When `version` is provided, known-CVE lookups target that version instead
 * of the registry's latest — the caller is about to install a specific pinned
 * version, so that's what matters for a pre-install guardrail. `latestVersion`
 * in the result always reflects the registry's actual latest regardless.
 */
export async function verifyPackage(
  rawName: string,
  ecosystem: Ecosystem,
  version?: string,
): Promise<PackageVerifyResult> {
  const name = ecosystem === "pypi" ? normalizePyPiName(rawName) : rawName;
  const { exists, meta } = ecosystem === "npm" ? await checkNpmPackage(name) : await checkPyPiPackage(name);

  if (!exists) {
    const alternative = fuzzyAlternative(name, ecosystem);
    const reason = alternative
      ? `Package "${name}" does not exist on ${ecosystem}. It looks like a typo of "${alternative.name}".`
      : `Package "${name}" does not exist on ${ecosystem}.`;
    return {
      name,
      ecosystem,
      exists: false,
      status: "phantom",
      reason,
      weeklyDownloads: null,
      downloadsPeriod: DEFAULT_DOWNLOADS_PERIOD[ecosystem],
      ageDays: null,
      latestVersion: null,
      alternatives: alternative ? [alternative] : undefined,
    };
  }

  const weekly = (meta?.weeklyDownloads as number | null) ?? null;
  const downloadsPeriod = (meta?.downloadsPeriod as "week" | "month" | undefined) ?? DEFAULT_DOWNLOADS_PERIOD[ecosystem];
  const created = meta?.created ? new Date(meta.created as string) : null;
  const ageDays = created ? Math.round((Date.now() - created.getTime()) / 86_400_000) : null;
  const lowDownloads = weekly !== null && weekly < SUSPICIOUS_DOWNLOADS[ecosystem];
  const veryNew = ageDays !== null && ageDays < SUSPICIOUS_AGE_DAYS;

  const result: PackageVerifyResult = {
    name,
    ecosystem,
    exists: true,
    status: lowDownloads || veryNew ? "suspicious" : "healthy",
    reason: `Package "${name}" exists on ${ecosystem} and looks healthy.`,
    weeklyDownloads: weekly,
    downloadsPeriod,
    ageDays,
    latestVersion: (meta?.latest as string | null) ?? null,
  };

  if (result.status === "suspicious") {
    const triggers: string[] = [];
    if (lowDownloads) triggers.push(`low ${downloadsPeriod}ly downloads (${weekly})`);
    if (veryNew) triggers.push(`newly published (${ageDays} days old)`);
    result.reason = `Package "${name}" exists on ${ecosystem} but looks suspicious: ${triggers.join(" and ")}.`;
  }

  const established = weekly !== null && weekly >= ESTABLISHED_DOWNLOADS;
  const squat = checkTyposquat(name, ecosystem);
  if (squat && (result.status === "suspicious" || (squat.distance === 1 && !established))) {
    result.status = "suspicious";
    result.typosquatOf = squat.suspectedTarget;
    result.typosquatDistance = squat.distance;
    result.reason = `Package "${name}" exists on ${ecosystem} but is suspiciously close to the popular package "${squat.suspectedTarget}" (edit distance ${squat.distance}) — possible typosquat.`;
  }

  const versionToCheck = version ?? result.latestVersion;
  if (versionToCheck) {
    const vulns = await checkVulnerabilities([{ name, version: versionToCheck, ecosystem }]);
    if (vulns.length) {
      result.status = "vulnerable";
      result.vulnerabilities = vulns[0].advisories;
      result.maxSeverity = vulns[0].maxSeverity;
      result.reason = `Package "${name}" has ${vulns[0].advisories.length} known vulnerabilit${vulns[0].advisories.length === 1 ? "y" : "ies"} at version ${versionToCheck}, max severity ${vulns[0].maxSeverity}.`;
    }
  }

  return result;
}
