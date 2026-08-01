import type { DependencyVerdict } from "./registry.js";
import type { ReviewedFinding } from "./llm.js";
import type { DuplicateGroup } from "./duplicates.js";
import type { LicenseConflict } from "./license.js";

export type Effort = "S" | "M" | "L";
export type PriorityBand = "critical" | "high" | "medium" | "low";

export interface RankedFinding {
  rank: number;
  band: PriorityBand;
  kind: string;
  title: string;
  location: string | null;
  /** Why this sits where it does. Never empty — an unexplained rank is just a
   *  differently-shaped wall of noise. */
  why: string;
  effort: Effort;
  confidence: number;
}

const BAND_ORDER: Record<PriorityBand, number> = { critical: 0, high: 1, medium: 2, low: 3 };
const EFFORT_ORDER: Record<Effort, number> = { S: 0, M: 1, L: 2 };
/**
 * Ordering between finding kinds inside the same band. Needed because
 * `confidence` is not comparable across kinds — an LLM's 0.95 "this looks
 * dead" and a static analyzer's hardcoded 0.9 "this dependency is never
 * imported" are different scales, so comparing them directly ranks by
 * coincidence rather than by judgement. Kinds are ordered by how confidently
 * actionable they are: a dependency you can delete from a manifest outranks
 * source code an LLM believes is unreachable.
 */
const KIND_ORDER: Record<string, number> = {
  phantom_dependency: 0,
  vulnerable_dependency: 1,
  suspicious_dependency: 2,
  license_conflict: 3,
  deprecated_dependency: 4,
  duplicate_library: 5,
  unused_dependency: 6,
  dead_code: 7,
};
const DEFAULT_LIMIT = 20;

export interface RankInput {
  deps: DependencyVerdict[];
  codeFindings: ReviewedFinding[];
  duplicates?: DuplicateGroup[];
  licenseConflicts?: LicenseConflict[];
  limit?: number;
}

/**
 * Orders findings so the top of the list is what to fix first.
 *
 * Ordering is lexicographic — band, then kind, then confidence descending,
 * then effort ascending — deliberately not a weighted sum. A weighted score
 * needs magic coefficients nobody can justify, which is the same
 * fake-precision problem that got hour/currency debt costing rejected. The
 * kind ordering exists because confidence isn't comparable across kinds: an
 * LLM's 0.95 "looks dead" and a static analyzer's hardcoded 0.9 "never
 * imported" are different scales. Lexicographic ordering states itself:
 * worst class first, most actionable kind first, most certain first within
 * a kind, cheapest first among equals.
 */
export function rankFindings(input: RankInput): RankedFinding[] {
  const items: Omit<RankedFinding, "rank">[] = [];

  for (const dep of input.deps) {
    const meta = dep.registryMetadata ?? {};
    if (dep.status === "phantom") {
      const alt = (meta.alternatives as { name: string }[] | undefined)?.[0]?.name;
      items.push({
        band: "critical",
        kind: "phantom_dependency",
        title: `${dep.packageName} does not exist on ${dep.ecosystem}`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: alt
          ? `The package cannot be installed and looks like a typo of "${alt}". Names like this are registered by attackers precisely because AI tools suggest them — treat as urgent.`
          : `The package cannot be installed. Hallucinated names are registered by attackers precisely because AI tools suggest them — treat as urgent.`,
        effort: "M",
        confidence: 1,
      });
    } else if (dep.status === "vulnerable") {
      const severity = (meta.maxSeverity as string | undefined) ?? "unknown";
      const critical = severity === "critical" || severity === "high";
      items.push({
        band: critical ? "critical" : "medium",
        kind: "vulnerable_dependency",
        title: `${dep.packageName} has known vulnerabilities (${severity})`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `A published advisory affects the version currently resolved. Upgrading is usually a version bump, which makes this a high-value, low-effort fix.`,
        effort: "S",
        confidence: 1,
      });
    } else if (dep.status === "suspicious") {
      const squat = meta.typosquatOf as string | undefined;
      items.push({
        band: squat ? "high" : "medium",
        kind: "suspicious_dependency",
        title: squat
          ? `${dep.packageName} closely resembles ${squat}`
          : `${dep.packageName} looks suspicious (new or very low usage)`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: squat
          ? `One character away from a widely-used package. Confirm you meant this one and not ${squat}.`
          : `Very few downloads or published very recently. Confirm it is the package you intended before relying on it.`,
        effort: "M",
        confidence: 0.8,
      });
    } else if (typeof meta.deprecated === "string") {
      items.push({
        band: "medium",
        kind: "deprecated_dependency",
        title: `${dep.packageName} is deprecated`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `The maintainer has marked this package deprecated: "${meta.deprecated.slice(0, 160)}" — it will not receive security fixes.`,
        effort: "M",
        confidence: 1,
      });
    } else if (dep.status === "unused") {
      items.push({
        band: "low",
        kind: "unused_dependency",
        title: `${dep.packageName} is declared but never imported`,
        location: dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: `Nothing in the repository imports it. Removing it shrinks install size and attack surface, and is a one-line change.`,
        effort: "S",
        confidence: 0.9,
      });
    }
  }

  for (const conflict of input.licenseConflicts ?? []) {
    items.push({
      band: conflict.severity === "high" ? "high" : "medium",
      kind: "license_conflict",
      title: `${conflict.packageName} licence (${conflict.packageLicense ?? "none declared"}) may conflict`,
      location: conflict.ecosystem === "npm" ? "package.json" : "requirements",
      why: conflict.reason,
      effort: "L",
      confidence: 0.7,
    });
  }

  for (const group of input.duplicates ?? []) {
    items.push({
      band: "low",
      kind: "duplicate_library",
      title: `${group.packages.join(" + ")} overlap in purpose`,
      location: group.ecosystem === "npm" ? "package.json" : "requirements",
      why: group.recommendation,
      effort: "M",
      confidence: 0.6,
    });
  }

  for (const finding of input.codeFindings) {
    items.push({
      band: "low",
      kind: "dead_code",
      title: `${finding.symbolName} appears unused`,
      location: `${finding.filePath}:${finding.lineStart}`,
      why: finding.reasoning?.trim()
        ? finding.reasoning
        : `Nothing outside its own file references this symbol.`,
      effort: "S",
      confidence: finding.confidence,
    });
  }

  items.sort(
    (a, b) =>
      BAND_ORDER[a.band] - BAND_ORDER[b.band] ||
      (KIND_ORDER[a.kind] ?? 99) - (KIND_ORDER[b.kind] ?? 99) ||
      b.confidence - a.confidence ||
      EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort] ||
      a.title.localeCompare(b.title),
  );

  return items
    .slice(0, input.limit ?? DEFAULT_LIMIT)
    .map((item, index) => ({ ...item, rank: index + 1 }));
}
