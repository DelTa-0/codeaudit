// What an AI agent can reach in this repository, and how exposed that is.
//
// agentConfig.ts answers "is anything in these files malicious". This answers
// the prior question: what is there at all. A repository's agent attack
// surface is the set of files an assistant reads as instructions, the servers
// it will start, and the skills it will load — and until you can enumerate
// them, "3 warnings" has no denominator.
//
// A deliberate limit runs through this file: **capabilities are read from the
// invocation, never guessed.** An MCP config declares a command to run; it
// does not declare what that command does once running. So a server that
// opens network sockets or writes files through its own logic is
// indistinguishable here from one that does neither, and this module does not
// pretend otherwise. It reports three things it can actually see:
//
//   - the invocation goes through a shell (visible in command/args)
//   - filesystem paths are handed over as arguments (visible as a grant)
//   - the package is unpinned (visible, and means today's audit is not
//     binding on tomorrow's code)
//
// Network access is deliberately NOT reported. Nothing in a config can show
// it, and a red "external network access" badge derived from a server's name
// would be a guess wearing the costume of a finding.
import fs from "node:fs";
import path from "node:path";
import { classifyAgentSurface, type AgentConfigFinding } from "./agentConfig.js";
import { extractMcpServers } from "./mcpDrift.js";

export type AgentRisk = "low" | "medium" | "high";

export interface McpServerInventory {
  name: string;
  filePath: string;
  command: string;
  args: string[];
  /** Registry package the server is fetched from, when the invocation shows one. */
  packageRef: string | null;
  /** Version-pinned. Unpinned means the reviewed code is not the code that runs. */
  pinned: boolean;
  /** Invocation runs through a shell — high confidence, read from the command. */
  shell: boolean;
  /** Paths handed to the server as arguments: a grant visible in the config. */
  filesystemPaths: string[];
  risk: AgentRisk;
  /** Plain-language reasons behind `risk`. Never empty for medium or high. */
  reasons: string[];
}

export interface AgentAttackSurface {
  instructionFiles: string[];
  skillFiles: string[];
  permissionFiles: string[];
  mcpConfigFiles: string[];
  mcpServers: McpServerInventory[];
  counts: {
    instructionFiles: number;
    skillFiles: number;
    permissionFiles: number;
    mcpServers: number;
    shellCapableServers: number;
    filesystemGrantingServers: number;
    unpinnedServers: number;
  };
  /** Agent-config health, 0-100. Derived from findings, not from counts —
   *  having many agent files is not itself a problem. */
  score: number;
  findingCounts: { critical: number; high: number; medium: number };
  /** Rendered next to the numbers so no surface has to re-derive the limits. */
  caveat: string;
}

const SHELL_COMMANDS = new Set(["sh", "bash", "zsh", "dash", "cmd", "cmd.exe", "powershell", "pwsh"]);
const SHELL_METACHAR = /[;&|`$(){}<>]/;
const EXCLUDED_DIR = /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv)\//;
const MAX_FILE_BYTES = 512 * 1024;

/** An argument that is a filesystem path being handed to the server. */
function looksLikePath(arg: string): boolean {
  if (arg.startsWith("-")) return false;
  return arg.startsWith("/") || arg.startsWith("~") || /^[A-Za-z]:[\\/]/.test(arg) || arg.startsWith("./");
}

/** Package specifier from an `npx`/`uvx` invocation, versions stripped. */
function packageFromInvocation(command: string, args: string[]): { ref: string | null; pinned: boolean } {
  if (command !== "npx" && command !== "uvx") return { ref: null, pinned: true };
  const spec = args.find((a) => !a.startsWith("-")) ?? null;
  if (!spec) return { ref: null, pinned: true };
  const at = spec.lastIndexOf("@");
  const pinned = at > 0 && /^[\d~^><=v]/.test(spec.slice(at + 1));
  return { ref: pinned ? spec.slice(0, at) : spec, pinned };
}

function assessServer(
  name: string,
  filePath: string,
  command: string,
  args: string[],
): McpServerInventory {
  const shell =
    SHELL_COMMANDS.has(command.toLowerCase().split(/[\\/]/).pop() ?? "") ||
    args.some((a) => SHELL_METACHAR.test(a));
  const filesystemPaths = args.filter(looksLikePath);
  const { ref, pinned } = packageFromInvocation(command, args);

  const reasons: string[] = [];
  if (shell) reasons.push("starts through a shell, so its arguments are executable, not just data");
  if (filesystemPaths.length)
    reasons.push(
      `granted ${filesystemPaths.length} filesystem path${filesystemPaths.length === 1 ? "" : "s"} as arguments`,
    );
  if (!pinned && ref)
    reasons.push(`runs an unpinned package (${ref}), so reviewing it today does not bind what runs tomorrow`);

  // Shell is the only single fact severe enough to be high on its own: it
  // turns the config into an execution primitive. Everything else is
  // cumulative — one soft signal is worth noting, two is worth reviewing.
  const risk: AgentRisk = shell ? "high" : reasons.length >= 2 ? "medium" : reasons.length === 1 ? "medium" : "low";

  return { name, filePath, command, args, packageRef: ref, pinned, shell, filesystemPaths, risk, reasons };
}

function damage(n: number, max: number, k: number): number {
  return n <= 0 ? 0 : (max * n) / (n + k);
}

/**
 * Enumerates the agent surface and scores its configuration health.
 *
 * The score is driven by findings, never by inventory size: a repository with
 * eight instruction files and no problems is not less safe than one with two.
 * Counting surface area as damage would push teams toward hiding
 * configuration rather than fixing it.
 */
export function analyzeAgentSurface(
  repoDir: string,
  findings: AgentConfigFinding[],
): AgentAttackSurface {
  const instructionFiles: string[] = [];
  const skillFiles: string[] = [];
  const permissionFiles: string[] = [];
  const mcpConfigFiles: string[] = [];
  const mcpServers: McpServerInventory[] = [];

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
      if (!surface || surface === "corroborate_only") continue;

      if (surface === "instructions") instructionFiles.push(rel);
      else if (surface === "skill") skillFiles.push(rel);
      else if (surface === "permissions") permissionFiles.push(rel);
      else if (surface === "mcp_config") {
        mcpConfigFiles.push(rel);
        try {
          if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
          const text = fs.readFileSync(full, "utf8");
          for (const [name, spec] of extractMcpServers(text)) {
            mcpServers.push(assessServer(name, rel, spec.command, spec.args));
          }
        } catch {
          // unreadable or non-UTF8 — the file is still counted as present
        }
      }
    }
  }

  const findingCounts = { critical: 0, high: 0, medium: 0 };
  for (const f of findings) findingCounts[f.severity]++;

  // Same multiplicative shape as the health axes (see score.ts): composes
  // without going negative, and never flattens.
  const retained =
    (1 - damage(findingCounts.critical, 0.7, 2)) *
    (1 - damage(findingCounts.high, 0.45, 3)) *
    (1 - damage(findingCounts.medium, 0.2, 4));

  return {
    instructionFiles,
    skillFiles,
    permissionFiles,
    mcpConfigFiles,
    mcpServers,
    counts: {
      instructionFiles: instructionFiles.length,
      skillFiles: skillFiles.length,
      permissionFiles: permissionFiles.length,
      mcpServers: mcpServers.length,
      shellCapableServers: mcpServers.filter((s) => s.shell).length,
      filesystemGrantingServers: mcpServers.filter((s) => s.filesystemPaths.length > 0).length,
      unpinnedServers: mcpServers.filter((s) => !s.pinned && s.packageRef).length,
    },
    score: Math.round(retained * 1000) / 10,
    findingCounts,
    caveat:
      "Capabilities are read from each server's invocation, not from what it does once running — " +
      "an MCP config cannot declare that. Shell execution and filesystem paths handed over as " +
      "arguments are visible here; network access is not, and is deliberately not guessed.",
  };
}
