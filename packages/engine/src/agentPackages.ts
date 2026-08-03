// Recomposes the existing single-package guardrail (`verify.ts`) against
// packages referenced from an MCP server config, rather than adding new
// detection logic — the same "recompose, don't invent" seam `verify.ts`
// itself documents for the MCP pre-install tool.
//
// Kept out of `agentConfig.ts` on purpose: that module is pure, sync, and
// offline, matching the "./agentConfig" subpath export used by the MCP
// server's offline `audit_agent_config` tool. This module needs the network
// (registry lookups via `verifyPackage`), so importing it stays an explicit,
// separate choice for any caller that wants that enrichment.
import { verifyPackage } from "./verify.js";
import type { AgentConfigFinding, McpPackageRef } from "./agentConfig.js";

/**
 * Verifies packages an MCP config points at. Zero new detection: translates
 * `verifyPackage`'s existing verdicts into agent-config findings. A phantom
 * package here is slopsquat bait of exactly the kind `verify.ts` already
 * exists to catch — an agent config naming a name that doesn't exist.
 */
export async function verifyAgentConfigPackages(refs: McpPackageRef[]): Promise<AgentConfigFinding[]> {
  const findings: AgentConfigFinding[] = [];

  for (const ref of refs) {
    let result: Awaited<ReturnType<typeof verifyPackage>>;
    try {
      result = await verifyPackage(ref.packageName, ref.ecosystem);
    } catch {
      // Registry unreachable — never fail the scan for one unresolved ref.
      continue;
    }

    if (result.status === "phantom") {
      findings.push({
        filePath: ref.filePath,
        line: ref.line,
        category: "unverified_mcp_package",
        rule: "mcp_package_phantom",
        severity: "critical",
        tier: 1,
        surface: "mcp_config",
        message: `MCP server "${ref.serverKey}" runs "${ref.packageName}", which does not exist on ${ref.ecosystem}. Every start attempts to fetch a name that isn't there — an attacker-registerable target.`,
        evidence: ref.packageName,
      });
    } else if (result.status === "suspicious" && result.typosquatOf) {
      findings.push({
        filePath: ref.filePath,
        line: ref.line,
        category: "unverified_mcp_package",
        rule: "mcp_package_typosquat",
        severity: "high",
        tier: 1,
        surface: "mcp_config",
        message: `MCP server "${ref.serverKey}" runs "${ref.packageName}", suspiciously close to the popular package "${result.typosquatOf}" (edit distance ${result.typosquatDistance}).`,
        evidence: ref.packageName,
      });
    } else if (result.status === "suspicious" || result.status === "vulnerable") {
      const detail = result.status === "vulnerable"
        ? `has ${result.vulnerabilities?.length ?? 0} known vulnerabilit${(result.vulnerabilities?.length ?? 0) === 1 ? "y" : "ies"} (max severity ${result.maxSeverity})`
        : "looks suspicious (low downloads or very recently published)";
      findings.push({
        filePath: ref.filePath,
        line: ref.line,
        category: "unverified_mcp_package",
        rule: "mcp_package_suspicious",
        severity: "medium",
        tier: 1,
        surface: "mcp_config",
        message: `MCP server "${ref.serverKey}" runs "${ref.packageName}", which ${detail}.`,
        evidence: ref.packageName,
      });
    }
  }

  return findings;
}
