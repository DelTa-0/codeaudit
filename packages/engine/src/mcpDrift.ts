// MCP server redefinition ("MCPoison"-shaped) detection.
//
// Every other check in agentConfig.ts judges a file by its contents right now.
// This one cannot: the attack it detects is invisible in any single revision.
//
// The trust model an MCP config relies on binds a user's approval to a
// server's *name*, not to what that name runs. So an attacker with commit
// access lands an innocuous server, waits for the team to approve it once,
// and then changes the `command` in a later commit. No approval prompt fires
// again, and every teammate executes the new command. The poisoned revision
// looks completely ordinary on its own — `npx some-tool` is not a finding —
// which is why content scanning alone can never see it. Only the *change*
// is evidence.
//
// This is deliberately a separate module from agentConfig.ts: everything
// there is a pure function of text and stays trivially testable, whereas this
// needs git. Keeping the dependency out of that file preserves the property.
import { execFileSync } from "node:child_process";
import type { AgentConfigFinding } from "./agentConfig.js";
import { redactSnippet, classifyAgentSurface } from "./agentConfig.js";

/** How a single MCP server is invoked. */
export interface McpServerSpec {
  name: string;
  command: string;
  args: string[];
}

/** Shell metacharacters that turn an argument into arbitrary execution. */
const SHELL_ISH = /[;&|`$(){}<>]|\bcurl\b|\bwget\b|\bbash\b|\bsh\s+-c\b|\beval\b/;

/**
 * Reads the `mcpServers` map out of any of the config shapes we recognise.
 * Returns an empty map for unparseable JSON rather than throwing — a config
 * mid-edit is not a security finding.
 */
export function extractMcpServers(text: string): Map<string, McpServerSpec> {
  const servers = new Map<string, McpServerSpec>();
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return servers;
  }
  if (!doc || typeof doc !== "object") return servers;
  // `.mcp.json` and Claude settings use `mcpServers`; VS Code's own format
  // uses `servers`. Both appear in real repositories.
  const record = doc as Record<string, unknown>;
  const block = (record.mcpServers ?? record.servers) as Record<string, unknown> | undefined;
  if (!block || typeof block !== "object") return servers;

  for (const [name, raw] of Object.entries(block)) {
    if (!raw || typeof raw !== "object") continue;
    const entry = raw as { command?: unknown; args?: unknown };
    servers.set(name, {
      name,
      command: typeof entry.command === "string" ? entry.command : "",
      args: Array.isArray(entry.args) ? entry.args.filter((a): a is string => typeof a === "string") : [],
    });
  }
  return servers;
}

function invocation(spec: McpServerSpec): string {
  return [spec.command, ...spec.args].join(" ").trim();
}

/**
 * Strips a trailing version specifier from a package-like argument, so
 * `codeorion-mcp@1.2.2` and `codeorion-mcp@1.2.3` compare equal. Scoped names
 * keep their leading `@` — only a version `@` after the name is removed.
 *
 * This exists because the first version of this detector flagged every pinned
 * version bump as a redefinition, which it found four times in this very
 * repository. Bumping a pinned package is the healthy thing to do, and a
 * detector that fires on it trains people to ignore it. The attack this rule
 * is for is a change to *what runs* — a different binary, a different package,
 * a shell — not a new release of the same one. Malicious-version risk is real
 * but belongs to the registry and pinning checks, which already cover it.
 */
function stripVersion(arg: string): string {
  const at = arg.lastIndexOf("@");
  if (at <= 0) return arg; // no `@`, or a leading scope marker only
  const suffix = arg.slice(at + 1);
  // Only treat it as a version when it looks like one, so a path or an email
  // shaped argument is left alone.
  return /^[\d~^><=v][\w.\-+*]*$|^(latest|next|beta|alpha)$/i.test(suffix) ? arg.slice(0, at) : arg;
}

/** Invocation reduced to package/binary identity, ignoring versions. */
function identity(spec: McpServerSpec): string {
  return [spec.command, ...spec.args.map(stripVersion)].join(" ").trim();
}

/**
 * Compares two revisions of one MCP config and reports servers whose
 * invocation changed. A server that is *added* is not reported here — that is
 * a first approval, which the user is prompted for and which
 * `auditAgentJson` already inspects on its contents. Only redefinition of an
 * already-present name is the silent case.
 */
export function diffMcpServers(
  beforeText: string | null,
  afterText: string,
  filePath: string,
): AgentConfigFinding[] {
  if (beforeText === null) return [];
  const before = extractMcpServers(beforeText);
  const after = extractMcpServers(afterText);
  const findings: AgentConfigFinding[] = [];

  for (const [name, spec] of after) {
    const previous = before.get(name);
    if (!previous) continue;
    const wasInvocation = invocation(previous);
    const nowInvocation = invocation(spec);
    // Identity, not the raw string: a version bump of the same package is a
    // dependency update, not a redefinition. See stripVersion.
    if (identity(previous) === identity(spec)) continue;

    // A redefinition that introduces shell syntax is the fully-weaponised
    // form; a plain command swap is still the same class of change, since
    // approval was never re-requested either way.
    const gainedShell = SHELL_ISH.test(nowInvocation) && !SHELL_ISH.test(wasInvocation);
    findings.push({
      filePath,
      line: 1,
      category: "dangerous_agent_config",
      rule: "mcp_server_redefined",
      severity: gainedShell ? "critical" : "high",
      tier: 1,
      surface: "mcp_config",
      message:
        `MCP server "${name}" changed what it runs without being re-approved` +
        (gainedShell ? ", and the new command contains shell syntax" : "") +
        `. Approval is bound to the server name, not its command, so a machine that ` +
        `already trusted "${name}" will execute the new one silently. Confirm this ` +
        `change was intended before running any agent against this checkout.`,
      // redactSnippet, not the raw command: this finding reaches a dashboard,
      // a PR comment and another model's context, same as every other one.
      evidence: `was: ${redactSnippet(wasInvocation)} → now: ${redactSnippet(nowInvocation)}`,
    });
  }
  return findings;
}

// --- git-backed history scan (full repo) -----------------------------------

/** Revisions of one file to walk back through. Bounded: the hosted worker
 *  clones with --depth 100, so a deeper walk would silently find nothing. */
const MAX_REVISIONS = 20;

function git(repoDir: string, args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 16 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

/**
 * Walks each MCP config file's history and reports any server redefined
 * between consecutive revisions.
 *
 * Silent no-op when the directory is not a git checkout, or when history is
 * unavailable — a scan of an exported tarball should lose this one detector,
 * not fail.
 */
export function findMcpDrift(repoDir: string): AgentConfigFinding[] {
  let mcpConfigPaths: string[];
  try {
    // `git ls-files` rather than a directory walk: it is already scoped to
    // tracked files, and an untracked config has no history to compare against
    // anyway.
    mcpConfigPaths = git(repoDir, ["ls-files"])
      .split("\n")
      .filter((p) => p && classifyAgentSurface(p) === "mcp_config");
  } catch {
    return []; // not a git checkout — this detector simply does not apply
  }

  const findings: AgentConfigFinding[] = [];
  for (const filePath of mcpConfigPaths) {
    let revisions: string[];
    try {
      revisions = git(repoDir, [
        "log",
        `--max-count=${MAX_REVISIONS}`,
        "--format=%H",
        "--",
        filePath,
      ])
        .split("\n")
        .filter(Boolean);
    } catch {
      continue; // not a repo, or no history for this path
    }
    // Newest first. Compare each revision against the one before it.
    for (let i = 0; i < revisions.length - 1; i++) {
      let after: string;
      let before: string;
      try {
        after = git(repoDir, ["show", `${revisions[i]}:${filePath}`]);
        before = git(repoDir, ["show", `${revisions[i + 1]}:${filePath}`]);
      } catch {
        continue;
      }
      findings.push(...diffMcpServers(before, after, filePath));
    }
  }
  // One row per server, not one per revision pair. A server rewritten across
  // four commits is one thing to go and look at; four identical-looking rows
  // just inflate the count and, now that this feeds the score, the penalty.
  const seen = new Set<string>();
  return findings.filter((f) => {
    const key = `${f.filePath}::${f.message}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
