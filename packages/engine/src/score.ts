import type { DependencyVerdict } from "./registry.js";
import type { ReviewedFinding } from "./llm.js";

export interface ScanSummary {
  score: number;
  grade: string;
  counts: {
    phantom: number;
    suspicious: number;
    unused: number;
    healthy: number;
    zombies: number;
    filesAnalyzed: number;
  };
}

/** Weighted health score: phantom deps are critical, unused medium, zombies informational. */
export function computeSummary(
  deps: DependencyVerdict[],
  zombies: ReviewedFinding[],
  filesAnalyzed: number,
): ScanSummary {
  const counts = {
    phantom: deps.filter((d) => d.status === "phantom").length,
    suspicious: deps.filter((d) => d.status === "suspicious").length,
    unused: deps.filter((d) => d.status === "unused").length,
    healthy: deps.filter((d) => d.status === "healthy").length,
    zombies: zombies.length,
    filesAnalyzed,
  };

  let score = 100;
  score -= counts.phantom * 15;
  score -= counts.suspicious * 6;
  score -= counts.unused * 3;
  score -= Math.min(20, zombies.reduce((acc, z) => acc + z.confidence * 1.5, 0));
  score = Math.max(0, Math.min(100, Math.round(score * 10) / 10));

  const grade =
    score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  return { score, grade, counts };
}
