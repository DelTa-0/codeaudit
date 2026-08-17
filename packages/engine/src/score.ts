import type { DependencyVerdict } from "./registry.js";
import type { ReviewedFinding, ReviewStatus } from "./llm.js";
import type { AgentConfigFinding } from "./agentConfig.js";

/**
 * Scoring v2.
 *
 * v1 was `100 − Σ(count × weight)`, which had four problems that no choice of
 * weights could fix:
 *
 *  1. One number answered two incompatible questions. A leaked credential
 *     (−40, capped) and eight unused dependencies (−24) landed a repo in the
 *     same grade band, as if "rotate this key now" and "tidy up sometime"
 *     were comparable states.
 *  2. Linear penalties with no size normalisation. Seven phantom packages
 *     floored the score, so forty scored the same as seven; and a large repo
 *     accumulated unused deps and dead code purely by being large, making the
 *     score track repo size more than repo health.
 *  3. Hard caps flattened the top end — `min(40, secrets × 20)` scored two
 *     secrets and twenty identically.
 *  4. Because everything shared one additive budget, adding any detector
 *     silently moved every existing score. That, not caution, is why agent
 *     config shipped advisory-only: the architecture made scoring it a
 *     breaking change.
 *
 * v2 addresses each directly:
 *
 *  - **Three axes.** Security, supply chain and maintainability are scored
 *    separately, because they prompt different actions.
 *  - **The headline cannot exceed the security axis.** A weighted average
 *    alone lets a tidy codebase dilute a live credential. `min(security, …)`
 *    is the property that makes it safe to put everything in one number.
 *  - **Multiplicative retention, not subtraction.** Each category removes a
 *    *fraction* of what remains, so the score cannot go negative, never
 *    flattens (the twentieth secret still moves it, just less than the
 *    second), and one catastrophic category cannot be averaged away.
 *  - **Hygiene is normalised by repo size; security never is.** One secret in
 *    a 5,000-file repo is still one secret.
 */
export const SCORE_VERSION = 2;

export interface ScoreAxes {
  /** Live exposure and attack paths: secrets, phantoms, CVEs, agent hijacking. */
  security: number;
  /** Risk that is not yet an incident: typosquats, deprecation, licences. */
  supplyChain: number;
  /** Cost of ownership: unused deps, dead code, duplicate libraries. */
  maintainability: number;
}

export interface ScanSummary {
  score: number;
  grade: string;
  /** Which scoring scheme produced `score`. Stored so a step change in a
   *  trend chart is explainable rather than mysterious. */
  scoreVersion: number;
  axes: ScoreAxes;
  counts: {
    phantom: number;
    suspicious: number;
    unused: number;
    healthy: number;
    vulnerable: number;
    zombies: number;
    filesAnalyzed: number;
    secrets: number;
    agentConfig: number;
    deprecated: number;
    duplicates: number;
    licenseConflicts: number;
    /** Registered names that LLMs are documented to invent. */
    hallucinated: number;
    /** MCP servers whose command changed after they were approved. */
    mcpRedefined: number;
  };
  reviewStatus: ReviewStatus;
}

export interface ScoreInput {
  deps: DependencyVerdict[];
  zombies: ReviewedFinding[];
  filesAnalyzed: number;
  reviewStatus?: ReviewStatus;
  secretCount?: number;
  /** Typed, not counted: severity and category decide axis and weight. */
  agentConfig?: AgentConfigFinding[];
  duplicateCount?: number;
  licenseConflictCount?: number;
}

/**
 * Fractional damage from `n` findings of one kind.
 *
 * `max` is the ceiling this category can ever remove; `k` is the count at
 * which it reaches half that ceiling. Hyperbolic rather than capped: it is
 * monotonic forever, so more is always worse, but with diminishing weight —
 * the difference between zero and one finding is the one that matters most,
 * which matches how anyone actually triages.
 */
function damage(n: number, max: number, k: number): number {
  if (n <= 0) return 0;
  return (max * n) / (n + k);
}

/** Composes independent damages multiplicatively: 100 × Π(1 − pᵢ). */
function axisFrom(damages: number[]): number {
  return damages.reduce((retained, p) => retained * (1 - p), 1) * 100;
}

const SEVERITY_DAMAGE: Record<string, { max: number; k: number }> = {
  critical: { max: 0.7, k: 2 },
  high: { max: 0.45, k: 3 },
  medium: { max: 0.2, k: 4 },
};

const VULN_DAMAGE: Record<string, { max: number; k: number }> = {
  critical: { max: 0.6, k: 2 },
  high: { max: 0.35, k: 3 },
  medium: { max: 0.15, k: 4 },
  low: { max: 0.05, k: 6 },
  unknown: { max: 0.15, k: 4 },
};

/**
 * Which axis an agent-config category belongs to. Everything that can lead to
 * code execution or credential loss is security; an unverified package
 * reference is a supply-chain question.
 */
const AGENT_AXIS: Record<string, "security" | "supplyChain"> = {
  hidden_text: "security",
  instruction_injection: "security",
  credential_exfiltration: "security",
  dangerous_agent_config: "security",
  unverified_mcp_package: "supplyChain",
};

function countBySeverity(findings: AgentConfigFinding[]): Record<string, number> {
  const out: Record<string, number> = { critical: 0, high: 0, medium: 0 };
  for (const f of findings) out[f.severity] = (out[f.severity] ?? 0) + 1;
  return out;
}

export function computeSummary(input: ScoreInput): ScanSummary {
  const {
    deps,
    zombies,
    filesAnalyzed,
    reviewStatus = "skipped",
    secretCount = 0,
    agentConfig = [],
    duplicateCount = 0,
    licenseConflictCount = 0,
  } = input;

  const vulnerable = deps.filter((d) => d.status === "vulnerable");
  const phantom = deps.filter((d) => d.status === "phantom");
  const suspicious = deps.filter((d) => d.status === "suspicious");
  const unused = deps.filter((d) => d.status === "unused");
  const deprecated = deps.filter((d) => typeof d.registryMetadata?.deprecated === "string");
  const hallucinated = deps.filter((d) => d.registryMetadata?.hallucinated != null);
  const mcpRedefined = agentConfig.filter((f) => f.rule === "mcp_server_redefined");

  const counts = {
    phantom: phantom.length,
    suspicious: suspicious.length,
    unused: unused.length,
    healthy: deps.filter((d) => d.status === "healthy").length,
    vulnerable: vulnerable.length,
    zombies: zombies.length,
    filesAnalyzed,
    secrets: secretCount,
    agentConfig: agentConfig.length,
    deprecated: deprecated.length,
    duplicates: duplicateCount,
    licenseConflicts: licenseConflictCount,
    hallucinated: hallucinated.length,
    mcpRedefined: mcpRedefined.length,
  };

  // --- Security -----------------------------------------------------------
  // Absolute counts, never normalised by repo size.
  const vulnBySeverity: Record<string, number> = {};
  for (const d of vulnerable) {
    const sev = (d.registryMetadata?.maxSeverity as string | undefined) ?? "unknown";
    vulnBySeverity[sev] = (vulnBySeverity[sev] ?? 0) + 1;
  }
  const securityAgent = countBySeverity(
    agentConfig.filter((f) => AGENT_AXIS[f.category] === "security" && f.rule !== "mcp_server_redefined"),
  );

  const security = axisFrom([
    damage(secretCount, 0.8, 1),
    damage(phantom.length, 0.6, 2),
    // Scored separately from `suspicious`: a registered hallucinated name is a
    // deliberately planted target, not a package that merely looks unpopular.
    damage(hallucinated.length, 0.55, 2),
    // Silent by construction — approval binds to the server name, not the
    // command — so a single occurrence is weighted like a critical finding.
    damage(mcpRedefined.length, 0.65, 1),
    ...Object.entries(vulnBySeverity).map(([sev, n]) =>
      damage(n, (VULN_DAMAGE[sev] ?? VULN_DAMAGE.unknown).max, (VULN_DAMAGE[sev] ?? VULN_DAMAGE.unknown).k),
    ),
    ...Object.entries(securityAgent).map(([sev, n]) => damage(n, SEVERITY_DAMAGE[sev].max, SEVERITY_DAMAGE[sev].k)),
  ]);

  // --- Supply chain -------------------------------------------------------
  // `suspicious` excludes the hallucinated ones already charged to security,
  // so a single package is never billed twice.
  const suspiciousOnly = suspicious.filter((d) => d.registryMetadata?.hallucinated == null).length;
  const supplyAgent = countBySeverity(agentConfig.filter((f) => AGENT_AXIS[f.category] === "supplyChain"));

  const supplyChain = axisFrom([
    damage(suspiciousOnly, 0.4, 3),
    damage(deprecated.length, 0.25, 4),
    damage(licenseConflictCount, 0.2, 3),
    ...Object.entries(supplyAgent).map(([sev, n]) => damage(n, SEVERITY_DAMAGE[sev].max, SEVERITY_DAMAGE[sev].k)),
  ]);

  // --- Maintainability ----------------------------------------------------
  // Size-normalised via k, so a large repo is not punished for being large.
  // A 40-dependency project reaches half damage at 4 unused; a 400-dependency
  // one needs 40. Without this the score tracked repo size more than health.
  const totalDeps = deps.length || 1;
  const unusedK = Math.max(2, totalDeps * 0.1);
  const zombieK = Math.max(3, filesAnalyzed * 0.02);
  // Confidence-weighted: a low-confidence static candidate should not cost the
  // same as one an LLM pass confirmed.
  const zombieWeight = zombies.reduce((acc, z) => acc + (z.confidence ?? 0.5), 0);

  const maintainability = axisFrom([
    damage(unused.length, 0.55, unusedK),
    damage(zombieWeight, 0.45, zombieK),
    damage(duplicateCount, 0.25, 3),
  ]);

  const axes: ScoreAxes = {
    security: round1(security),
    supplyChain: round1(supplyChain),
    maintainability: round1(maintainability),
  };

  // The `min` is the load-bearing half. A weighted average alone would let a
  // clean, well-maintained codebase carry a repo that is actively leaking a
  // credential into a good grade.
  const blended = 0.5 * security + 0.3 * supplyChain + 0.2 * maintainability;
  const score = round1(Math.max(0, Math.min(100, Math.min(security, blended))));

  const grade = score >= 90 ? "A" : score >= 75 ? "B" : score >= 60 ? "C" : score >= 40 ? "D" : "F";

  return { score, grade, scoreVersion: SCORE_VERSION, axes, counts, reviewStatus };
}

function round1(n: number): number {
  return Math.round(n * 10) / 10;
}
