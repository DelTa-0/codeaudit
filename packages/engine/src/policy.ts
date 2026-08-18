// Repo-scoped guardrail policy: turning advice into enforcement.
//
// Every verdict this engine produces is advisory until something refuses to
// proceed on it, and the industry consensus on slopsquatting is blunt about
// where the refusal belongs: inside the agent loop, before the install runs —
// not in a scanner that reads the wreckage afterwards. Machine-level policy
// engines exist (Microsoft's agent governance toolkit, ThreatLocker), but
// they configure a *machine*. This configures a *repository*, travels with
// the clone, and needs no infrastructure at all.
//
// The policy is deliberately small. Every knob here is one a maintainer can
// defend in review ("no packages younger than 30 days" is a position; a
// 40-key YAML schema is a liability). Anything not expressed here is simply
// not policy — the detectors keep their own defaults.
import fs from "node:fs";
import path from "node:path";
import type { PackageVerifyResult } from "./verify.js";

export const POLICY_FILENAME = ".codeorion-policy.json";

export interface CodeorionPolicy {
  /** Refuse packages younger than this. New names are the slopsquat window. */
  minAgeDays?: number;
  /** Refuse packages below this download floor (weekly npm / monthly PyPI). */
  minDownloads?: number;
  /** Names that may never be added, exact match, case-insensitive. */
  denyPackages?: string[];
  /** When set, a package's licence must be in this list (exact, case-insensitive). */
  allowLicenses?: string[];
  /** Licences that may never be introduced. Ignored when allowLicenses is set. */
  denyLicenses?: string[];
  /** Refuse MCP servers running unpinned packages. */
  forbidUnpinnedMcp?: boolean;
  /** Refuse MCP servers whose invocation goes through a shell. */
  forbidShellMcp?: boolean;
}

export interface PolicyViolation {
  rule: string;
  message: string;
}

/** Absent or unparseable file = no policy. A malformed policy must fail open
 *  loudly at authoring time (the CLI validates), not silently harden CI. */
export function loadPolicy(repoDir: string): CodeorionPolicy | null {
  try {
    const raw = fs.readFileSync(path.join(repoDir, POLICY_FILENAME), "utf8");
    const doc = JSON.parse(raw) as CodeorionPolicy;
    return doc && typeof doc === "object" ? doc : null;
  } catch {
    return null;
  }
}

/**
 * Evaluates one package verdict against the policy. Pure — the caller decides
 * whether a violation warns or blocks, because that differs by surface (a
 * staged commit blocks; a report lists).
 */
export function evaluatePackagePolicy(
  pkg: PackageVerifyResult,
  policy: CodeorionPolicy,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  const name = pkg.name;

  if (policy.denyPackages?.some((d) => d.toLowerCase() === name.toLowerCase())) {
    violations.push({
      rule: "policy_deny_package",
      message: `${name} is on this project's deny list (${POLICY_FILENAME}).`,
    });
  }
  // Age/download floors only apply to packages that exist — a phantom is
  // already a harder verdict than any policy could add.
  if (pkg.exists && policy.minAgeDays !== undefined && pkg.ageDays !== null && pkg.ageDays < policy.minAgeDays) {
    violations.push({
      rule: "policy_min_age",
      message: `${name} is ${pkg.ageDays} days old; this project requires ${policy.minAgeDays}. Freshly registered names are the slopsquatting window.`,
    });
  }
  if (
    pkg.exists &&
    policy.minDownloads !== undefined &&
    pkg.weeklyDownloads !== null &&
    pkg.weeklyDownloads < policy.minDownloads
  ) {
    violations.push({
      rule: "policy_min_downloads",
      message: `${name} has ${pkg.weeklyDownloads} ${pkg.downloadsPeriod}ly downloads; this project requires ${policy.minDownloads}.`,
    });
  }
  if (pkg.exists && pkg.license) {
    const lic = pkg.license.toLowerCase();
    if (policy.allowLicenses?.length) {
      if (!policy.allowLicenses.some((a) => a.toLowerCase() === lic)) {
        violations.push({
          rule: "policy_license_not_allowed",
          message: `${name} is licensed ${pkg.license}, which is not in this project's allowed licence list.`,
        });
      }
    } else if (policy.denyLicenses?.some((d) => d.toLowerCase() === lic)) {
      violations.push({
        rule: "policy_license_denied",
        message: `${name} is licensed ${pkg.license}, which this project's policy forbids.`,
      });
    }
  }
  return violations;
}

/**
 * Evaluates an MCP server's visible invocation facts against the policy.
 * Takes the two booleans rather than the inventory type to stay import-light —
 * callers already have both from assessServer/analyzeAgentSurface.
 */
export function evaluateMcpPolicy(
  server: { name: string; shell: boolean; pinned: boolean; packageRef: string | null },
  policy: CodeorionPolicy,
): PolicyViolation[] {
  const violations: PolicyViolation[] = [];
  if (policy.forbidShellMcp && server.shell) {
    violations.push({
      rule: "policy_forbid_shell_mcp",
      message: `MCP server "${server.name}" launches through a shell, which this project's policy forbids.`,
    });
  }
  if (policy.forbidUnpinnedMcp && server.packageRef && !server.pinned) {
    violations.push({
      rule: "policy_forbid_unpinned_mcp",
      message: `MCP server "${server.name}" runs unpinned package "${server.packageRef}"; this project requires pinned versions.`,
    });
  }
  return violations;
}
