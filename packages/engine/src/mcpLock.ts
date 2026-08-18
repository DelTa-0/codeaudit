// The MCP lockfile: approval as a *repository* artifact.
//
// Every MCP client binds a user's approval to a server's name, and existing
// mitigations pin what a name runs per client machine (Invariant's mcp-scan
// hashes tool descriptions locally). That protects one laptop. It does not
// protect the teammate who clones the repo tomorrow, and it leaves "what did
// we approve?" with no answer that survives a reimage.
//
// codeorion-mcp.lock commits the answer. One entry per approved server,
// keyed by name, carrying the version-stripped invocation identity — the same
// identity rule mcpDrift and assessMcpServerProposal use, so "the same
// program" has exactly one definition across the pre-install check, the
// history detector and this file. A config that drifts from the lock fails
// the staged scan and CI; bringing the lock up to date is a diff a human
// reviews, which is the entire point.
//
// Deliberately NOT signed. A signature would claim tamper-evidence this file
// cannot deliver (whoever can edit the config can edit the lock in the same
// commit); what it actually delivers is *visibility* — the change shows up as
// a lockfile diff instead of hiding inside a config nobody re-reads.
import fs from "node:fs";
import path from "node:path";
import { classifyAgentSurface, type AgentConfigFinding } from "./agentConfig.js";
import { extractMcpServers, invocationIdentity } from "./mcpDrift.js";

export const MCP_LOCK_FILENAME = "codeorion-mcp.lock";

export interface McpLockEntry {
  /** Version-stripped invocation identity — see mcpDrift.invocationIdentity. */
  identity: string;
  /** Config file the server was approved in, repo-relative. */
  configFile: string;
  /** sha256 of the server's tool descriptions, when captured (see
   *  hashToolDescriptions in agentConfig.ts). Optional: descriptions are only
   *  observable from a running server, and this file never requires one. */
  toolsHash?: string;
  approvedAt: string;
}

export interface McpLock {
  version: 1;
  servers: Record<string, McpLockEntry>;
}

const EXCLUDED_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv)\//;

/** Every MCP config file in the repo, with its parsed servers. */
function collectConfigs(repoDir: string): { file: string; servers: Map<string, { command: string; args: string[] }> }[] {
  const out: { file: string; servers: Map<string, { command: string; args: string[] }> }[] = [];
  const stack = [repoDir];
  while (stack.length) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(repoDir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!EXCLUDED_DIR.test(`${rel}/`)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || classifyAgentSurface(rel) !== "mcp_config") continue;
      try {
        out.push({ file: rel, servers: extractMcpServers(fs.readFileSync(full, "utf8")) });
      } catch {
        // unreadable — verify() reports nothing for it rather than crashing
      }
    }
  }
  return out;
}

export function readMcpLock(repoDir: string): McpLock | null {
  try {
    const raw = fs.readFileSync(path.join(repoDir, MCP_LOCK_FILENAME), "utf8");
    const doc = JSON.parse(raw) as McpLock;
    if (doc.version !== 1 || typeof doc.servers !== "object") return null;
    return doc;
  } catch {
    return null;
  }
}

/**
 * Builds a lock from the configs as they stand — the "I approve what is here
 * now" operation. Existing entries' approvedAt survives when the identity is
 * unchanged, so re-running the command does not rewrite history.
 */
export function buildMcpLock(repoDir: string, previous?: McpLock | null): McpLock {
  const now = new Date().toISOString();
  const servers: Record<string, McpLockEntry> = {};
  for (const { file, servers: found } of collectConfigs(repoDir)) {
    for (const [name, spec] of found) {
      const identity = invocationIdentity(spec.command, spec.args);
      const prior = previous?.servers[name];
      servers[name] = {
        identity,
        configFile: file,
        ...(prior?.toolsHash ? { toolsHash: prior.toolsHash } : {}),
        approvedAt: prior && prior.identity === identity ? prior.approvedAt : now,
      };
    }
  }
  return { version: 1, servers };
}

export function writeMcpLock(repoDir: string, lock: McpLock): void {
  fs.writeFileSync(path.join(repoDir, MCP_LOCK_FILENAME), JSON.stringify(lock, null, 2) + "\n");
}

/**
 * Compares the repo's MCP configs against the committed lock.
 *
 * Absent lock = silent no-op: the lockfile is opt-in, and a warning nagging
 * every repo that never asked for one trains people to ignore the tool.
 *
 * Three finding shapes, in severity order:
 *  - identity mismatch: an approved name now runs a different program. The
 *    exact silent-redefinition case the lock exists to catch — critical.
 *  - unapproved server: present in a config, absent from the lock — high.
 *  - stale entry: in the lock, gone from every config. Informational only, so
 *    it is NOT a finding — removing a server is not an attack, and reporting
 *    it as one would be noise. It surfaces through `stale` instead.
 */
export function verifyMcpLock(
  repoDir: string,
): { findings: AgentConfigFinding[]; stale: string[]; hasLock: boolean } {
  const lock = readMcpLock(repoDir);
  if (!lock) return { findings: [], stale: [], hasLock: false };

  const findings: AgentConfigFinding[] = [];
  const seen = new Set<string>();

  for (const { file, servers } of collectConfigs(repoDir)) {
    for (const [name, spec] of servers) {
      seen.add(name);
      const identity = invocationIdentity(spec.command, spec.args);
      const entry = lock.servers[name];
      if (!entry) {
        findings.push({
          filePath: file,
          line: 1,
          category: "dangerous_agent_config",
          rule: "mcp_server_unapproved",
          severity: "high",
          tier: 1,
          surface: "mcp_config",
          message:
            `MCP server "${name}" is not in ${MCP_LOCK_FILENAME}. Every server here was approved ` +
            `into the lock deliberately; an addition that skips it has skipped review. Run the ` +
            `lock update and commit the diff if this server is intended.`,
          evidence: `not in lock`,
        });
      } else if (entry.identity !== identity) {
        findings.push({
          filePath: file,
          line: 1,
          category: "dangerous_agent_config",
          rule: "mcp_server_lock_mismatch",
          severity: "critical",
          tier: 1,
          surface: "mcp_config",
          message:
            `MCP server "${name}" no longer runs what ${MCP_LOCK_FILENAME} approved. Approval binds ` +
            `to the name, so clients will execute the new program without prompting anyone. Treat ` +
            `as an incident until a human confirms the change and re-locks.`,
          // Identities are version-stripped invocation strings, already free
          // of secrets by construction — but keep them short.
          evidence: `approved: ${entry.identity.slice(0, 120)} → now: ${identity.slice(0, 120)}`,
        });
      }
    }
  }

  const stale = Object.keys(lock.servers).filter((name) => !seen.has(name));
  return { findings, stale, hasLock: true };
}
