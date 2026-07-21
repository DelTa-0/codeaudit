import type { DependencyVerdict } from "./registry.js";
import type { ReviewedFinding, ReviewStatus } from "./llm.js";

export interface ScanSummary {
  score: number;
  grade: string;
  counts: {
    phantom: number;
    suspicious: number;
    unused: number;
    healthy: number;
    vulnerable: number;
    zombies: number;
    filesAnalyzed: number;
  };
  /** Whether zombie/dead-code findings got a real LLM verdict. "skipped" is
   * expected for the static-only CLI edition; "partial" on a hosted scan
   * means some findings are unfiltered because their LLM batch failed. */
  reviewStatus: ReviewStatus;
}

/** Weighted health score: phantom deps are critical, unused medium, zombies informational. */
export function computeSummary(
  deps: DependencyVerdict[],
  zombies: ReviewedFinding[],
  filesAnalyzed: number,
  reviewStatus: ReviewStatus = "skipped",
): ScanSummary {
  const vulnerable = deps.filter((d) => d.status === "vulnerable");
  const counts = {
    phantom: deps.filter((d) => d.status === "phantom").length,
    suspicious: deps.filter((d) => d.status === "suspicious").length,
    unused: deps.filter((d) => d.status === "unused").length,
    healthy: deps.filter((d) => d.status === "healthy").length,
    vulnerable: vulnerable.length,
    zombies: zombies.length,
    filesAnalyzed,
  };

  // Vulnerability penalty is per-package by its highest-severity advisory —
  // a known CVE is weighted like a phantom dep (critical) down to informational
  // (low), mirroring the severity philosophy of the other categories.
  const VULN_PENALTY: Record<string, number> = {
    critical: 20,
    high: 10,
    medium: 4,
    low: 1,
    unknown: 4,
  };
  const vulnPenalty = vulnerable.reduce((acc, d) => {
    const sev = (d.registryMetadata?.maxSeverity as string | undefined) ?? "unknown";
    return acc + (VULN_PENALTY[sev] ?? VULN_PENALTY.unknown);
  }, 0);

  let score = 100;
  score -= counts.phantom * 15;
  score -= counts.suspicious * 6;
  score -= counts.unused * 3;
  score -= vulnPenalty;
  score -= Math.min(20, zombies.reduce((acc, z) => acc + z.confidence * 1.5, 0));
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  const grade =
    score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  return { score, grade, counts, reviewStatus };
}
