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
import { createHash } from "node:crypto";
import { classifyAgentSurface, type AgentConfigFinding, type AgentSurface } from "./agentConfig.js";
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

/**
 * An instruction file the agent trusts, and the content that was approved.
 *
 * The server entries answer "is this still the program we approved". This
 * answers the prior question for text: "is this still what we read". It is the
 * only check in this engine that never inspects the payload, which is exactly
 * why it reaches what detection cannot — a paraphrase sharing no keyword with
 * any rule, an acrostic spelled down the first column, a payload staged in a
 * second file. None of those survive "this is not the document you approved".
 */
export interface InstructionFileLockEntry {
  /** sha256 of the normalized content — see hashInstructionContent. */
  hash: string;
  /** Why this file is trusted, from classifyAgentSurface. */
  surface: AgentSurface;
  approvedAt: string;
}

export interface McpLock {
  version: 1;
  servers: Record<string, McpLockEntry>;
  /**
   * Approved instruction files, keyed by repo-relative path.
   *
   * Optional, and the absence is meaningful: a lock written before this
   * existed has no `files` key, and must stay silent rather than flagging
   * every instruction file in the repo as unapproved. An upgrade that shouts
   * at every existing user is an upgrade they turn off. Re-running the lock
   * command adds the key, which is the opt-in.
   */
  files?: Record<string, InstructionFileLockEntry>;
}

/**
 * Surfaces whose content is locked.
 *
 * `mcp_config` is deliberately absent: its servers already have identity
 * entries, and those are version-stripped so a routine version bump does not
 * churn approval. Hashing the file would reintroduce exactly that churn.
 *
 * `corroborate_only` (README, CONTRIBUTING) is absent too — read for context,
 * never obeyed as instructions, and edited constantly. Locking it would
 * produce a diff to review on nearly every commit, which is how a security
 * control trains people to click through it.
 */
const LOCKED_SURFACES: readonly AgentSurface[] = ["instructions", "skill", "permissions"];

/**
 * Content hash for approval comparison.
 *
 * Normalizes a leading BOM and CRLF line endings first. The same file checked
 * out on Windows is the same approval, and a hash that disagreed would report
 * drift on every Windows clone — false positives that would discredit the
 * whole mechanism within a day.
 */
export function hashInstructionContent(content: string): string {
  const normalized = content.replace(/^\uFEFF/, "").replace(/\r\n/g, "\n");
  return createHash("sha256").update(normalized).digest("hex");
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

interface InstructionFileScan {
  file: string;
  surface: AgentSurface;
  hash: string;
  lines: number;
}

/**
 * An instruction file with no approval record — the agent will read it as
 * instructions and nobody in this repository has said they read it first.
 *
 * Deliberately not a finding. "Is this file suspicious" cannot be answered
 * reliably; "has anyone approved this file" always can, because it is a
 * lookup rather than a judgement. Reporting it as informational is what lets
 * the answer be trustworthy: a repository that never asked for a lock is not
 * handed a critical on first run, which is the move that teaches people to
 * ignore the tool.
 */
export interface UnreviewedInstructionFile {
  file: string;
  surface: AgentSurface;
  /** So a reviewer can size the job before starting it. */
  lines: number;
}

export interface McpLockVerification {
  findings: AgentConfigFinding[];
  /** Lock entries — servers and files — no longer present in the repo. */
  stale: string[];
  hasLock: boolean;
  /**
   * Instruction files carrying no approval. Populated whether or not a lock
   * exists: a freshly cloned repository is the case detection is weakest on
   * and silence there reads as approval.
   */
  unreviewed: UnreviewedInstructionFile[];
  /** Whether any instruction-file approval has been recorded at all. */
  reviewRecorded: boolean;
}

/** Every locked instruction surface in the repo, with its content hash. */
function collectInstructionFiles(repoDir: string): InstructionFileScan[] {
  const out: InstructionFileScan[] = [];
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
      if (!entry.isFile()) continue;
      const surface = classifyAgentSurface(rel);
      if (!surface || !LOCKED_SURFACES.includes(surface)) continue;
      try {
        const content = fs.readFileSync(full, "utf8");
        out.push({
          file: rel,
          surface,
          hash: hashInstructionContent(content),
          // Trailing newline excluded so the number matches what a reviewer
          // sees in their editor — this figure exists to size a reading job,
          // not to describe a byte stream.
          lines: content ? content.replace(/\n$/, "").split("\n").length : 0,
        });
      } catch {
        // unreadable — reported by nothing rather than crashing the scan
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
  const files: Record<string, InstructionFileLockEntry> = {};
  for (const { file, surface, hash } of collectInstructionFiles(repoDir)) {
    const prior = previous?.files?.[file];
    files[file] = {
      hash,
      surface,
      approvedAt: prior && prior.hash === hash ? prior.approvedAt : now,
    };
  }
  return { version: 1, servers, files };
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
export function verifyMcpLock(repoDir: string): McpLockVerification {
  const lock = readMcpLock(repoDir);
  const instructionFiles = collectInstructionFiles(repoDir);
  const asUnreviewed = (f: InstructionFileScan): UnreviewedInstructionFile => ({
    file: f.file,
    surface: f.surface,
    lines: f.lines,
  });

  // No lock: nothing has been approved, so everything the agent will read as
  // instructions is unreviewed. Reported, never charged as a finding.
  if (!lock) {
    return {
      findings: [],
      stale: [],
      hasLock: false,
      unreviewed: instructionFiles.map(asUnreviewed),
      reviewRecorded: false,
    };
  }

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

  // Instruction files. Skipped entirely when the lock predates the feature —
  // see McpLock.files for why absence has to mean silence.
  if (lock.files) {
    const present = new Set<string>();
    for (const { file, surface, hash } of instructionFiles) {
      present.add(file);
      const entry = lock.files[file];
      if (!entry) {
        findings.push({
          filePath: file,
          line: 1,
          category: "dangerous_agent_config",
          rule: "instruction_file_unapproved",
          severity: "high",
          tier: 1,
          surface,
          message:
            `${file} is trusted as agent instructions but is not in ${MCP_LOCK_FILENAME}. ` +
            `Every file there was read and approved deliberately; one that skips the lock has ` +
            `skipped review. Read it, then re-lock and commit the diff.`,
          evidence: "not in lock",
        });
      } else if (entry.hash !== hash) {
        findings.push({
          filePath: file,
          line: 1,
          category: "dangerous_agent_config",
          rule: "instruction_file_modified",
          severity: "critical",
          tier: 1,
          surface,
          message:
            `${file} has changed since it was approved in ${MCP_LOCK_FILENAME}. Every agent ` +
            `session in this repo reads it as instructions, so a change here rewrites what the ` +
            `assistant does before anyone reviews a line of code. Read the diff, then re-lock.`,
          // Hash prefixes only. Quoting the changed text would put an
          // unreviewed payload into the response — and this finding travels
          // into another model's context window.
          evidence: `approved ${entry.hash.slice(0, 12)} → now ${hash.slice(0, 12)}`,
        });
      }
    }
    // Removal is not an attack. Reported alongside stale server names so a
    // re-lock diff shows everything the lock still claims and the repo lost.
    stale.push(...Object.keys(lock.files).filter((file) => !present.has(file)));
  }

  // Unreviewed is computed the same way whether or not the lock records
  // files: a pre-feature lock has approved no instruction file, so all of
  // them are unreviewed even though none of them is a finding.
  const approved = lock.files ?? {};
  const unreviewed = instructionFiles.filter((f) => !approved[f.file]).map(asUnreviewed);

  return {
    findings,
    stale,
    hasLock: true,
    unreviewed,
    reviewRecorded: lock.files !== undefined,
  };
}
