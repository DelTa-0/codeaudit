// Pre-commit mode: scan what is about to be committed.
//
// Lives in the engine (moved from cli/src) so BOTH front doors share it: the
// CLI's `scan --staged` / git hook, and codeorion-mcp's `audit_staged` tool —
// which lets an agent self-review its work before committing, with no hook
// installed. Two copies of "what counts as safe to commit" would drift.
//
// Deliberately not a full scan. A hook that runs on every `git commit` has a
// budget of a couple of seconds; the whole-repo path resolves lock trees,
// queries OSV for every dependency and optionally calls an LLM, which is
// tens of seconds. A hook that slow gets uninstalled, and an uninstalled hook
// catches nothing. So this checks only what is both fast and irreversible if
// it lands:
//
//   - secrets in staged content (no network, and a committed credential is
//     compromised even if the next commit removes it)
//   - agent-config poisoning in staged content (no network)
//   - dependencies this commit *adds* (bounded network — only the additions)
//
// Dead code, license conflicts and duplicate libraries are all deliberately
// absent: they need whole-repo context, none of them are urgent at the commit
// boundary, and blocking a commit on them is how a hook earns a permanent
// --no-verify in someone's muscle memory.
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
// Concrete modules, not "./index.js" — the index re-exports THIS file, and a
// module importing its own barrel is a cycle waiting to break at runtime.
import { scanTextForSecrets, isSecretScannablePath, type SecretFinding } from "./secrets.js";
import {
  classifyAgentSurface,
  scanAgentText,
  auditAgentJson,
  type AgentConfigFinding,
} from "./agentConfig.js";
import { parseManifest } from "./manifest.js";
import { parsePythonManifest } from "./python/manifest.js";
import { verifyPackage, type PackageVerifyResult } from "./verify.js";
import { diffMcpServers, extractMcpServers } from "./mcpDrift.js";
import { verifyMcpLock, type UnreviewedInstructionFile } from "./mcpLock.js";
import { loadPolicy, evaluatePackagePolicy, evaluateMcpPolicy, type PolicyViolation } from "./policy.js";
import { assessMcpServerProposal } from "./agentSurface.js";
import type { Ecosystem } from "./registry.js";

/** Manifests whose *added* dependency entries are worth a registry check. */
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt)$/i;
/** Skip generated/large blobs — a lockfile is not where a secret gets typed. */
const MAX_BLOB_BYTES = 512 * 1024;
/** Bound the network work so a big dependency bump cannot stall a commit. */
const MAX_NEW_DEPS_CHECKED = 25;

function git(args: string[], repoDir: string): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isGitRepo(repoDir: string = process.cwd()): boolean {
  try {
    git(["rev-parse", "--git-dir"], repoDir);
    return true;
  } catch {
    return false;
  }
}

/** Paths staged for commit (added/copied/modified — deletions cannot leak). */
export function stagedFiles(repoDir: string): string[] {
  const out = git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"], repoDir);
  return out.split("\0").filter(Boolean);
}

/**
 * The *staged* content of a file, which is not the same as what is on disk.
 * Staging a clean file and then editing it — or the reverse — is routine, and
 * a hook that reads the working tree would judge content that is not being
 * committed. `git show :path` is the only honest source here.
 */
function stagedBlob(file: string, repoDir: string): string | null {
  try {
    const raw = git(["show", `:${file}`], repoDir);
    return raw.length > MAX_BLOB_BYTES ? null : raw;
  } catch {
    return null; // unmerged, binary, or unreadable — nothing to scan
  }
}

/** Same file as of HEAD, or null when the commit adds it. */
function headBlob(file: string, repoDir: string): string | null {
  try {
    return git(["show", `HEAD:${file}`], repoDir);
  } catch {
    return null;
  }
}

/**
 * Runs the engine's real manifest parsers against blob content by writing it
 * to a scratch directory. Re-implementing package.json / requirements /
 * pyproject parsing here would mean a second set of rules to keep in sync,
 * and the diff-of-added-lines shortcut misreads `"build": "tsc"` in a
 * "scripts" block as a dependency named `build`.
 */
function dependencyNames(file: string, content: string | null): Set<string> {
  const names = new Set<string>();
  if (content === null) return names;
  const base = path.basename(file);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeorion-staged-"));
  try {
    fs.writeFileSync(path.join(dir, base), content);
    if (/^package\.json$/i.test(base)) {
      const manifest = parseManifest(dir);
      for (const n of Object.keys(manifest?.dependencies ?? {})) names.add(n);
      for (const n of Object.keys(manifest?.devDependencies ?? {})) names.add(n);
    } else {
      for (const n of Object.keys(parsePythonManifest(dir)?.dependencies ?? {})) names.add(n);
    }
  } catch {
    // Unparseable staged manifest (mid-edit JSON, say) — no additions to
    // report rather than a crashed hook.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return names;
}

function ecosystemFor(file: string): Ecosystem {
  return /package\.json$/i.test(file) ? "npm" : "pypi";
}

export interface StagedReport {
  fileCount: number;
  secrets: SecretFinding[];
  agentConfig: AgentConfigFinding[];
  /** Only packages this commit introduces, and only ones that look wrong. */
  newDependencies: PackageVerifyResult[];
  /** Additions beyond MAX_NEW_DEPS_CHECKED, reported rather than hidden. */
  dependenciesNotChecked: number;
  /** Violations of the repo's .codeorion-policy.json. Blocking — a policy the
   *  scan merely mentions is advice wearing a policy's name. Empty when the
   *  repo has no policy file. */
  policyViolations: PolicyViolation[];
  /** True when codeorion-mcp.lock exists and was checked. */
  lockChecked: boolean;
  /**
   * Instruction files the agent will trust that carry no approval record.
   *
   * Not blocking, and that is the design. The question it answers — has
   * anyone here read this file — is the one question about an instruction
   * file that can be answered without judging its contents, which is what
   * makes it reliable where detection is not. Charging it as a blocker on a
   * repository that never opted in would spend that reliability on noise.
   */
  unreviewedInstructionFiles: UnreviewedInstructionFile[];
}

export async function scanStaged(repoDir: string = process.cwd()): Promise<StagedReport> {
  const files = stagedFiles(repoDir);
  const secrets: SecretFinding[] = [];
  const agentConfig: AgentConfigFinding[] = [];
  const added: { name: string; ecosystem: Ecosystem }[] = [];

  for (const file of files) {
    const content = stagedBlob(file, repoDir);
    if (content === null) continue;

    if (isSecretScannablePath(file)) secrets.push(...scanTextForSecrets(content, file));

    const surface = classifyAgentSurface(file);
    if (surface) {
      agentConfig.push(
        ...(surface === "mcp_config" || surface === "permissions"
          ? auditAgentJson(content, file, surface)
          : scanAgentText(content, file, surface)),
      );
      // The commit boundary is the exact point where an MCP redefinition is
      // still catchable: HEAD is what the team already approved, the staged
      // blob is what they are about to trust instead.
      if (surface === "mcp_config") {
        agentConfig.push(...diffMcpServers(headBlob(file, repoDir), content, file));
      }
    }

    if (MANIFEST_RE.test(file)) {
      const before = dependencyNames(file, headBlob(file, repoDir));
      const ecosystem = ecosystemFor(file);
      for (const name of dependencyNames(file, content)) {
        if (!before.has(name)) added.push({ name, ecosystem });
      }
    }
  }

  const toCheck = added.slice(0, MAX_NEW_DEPS_CHECKED);
  const verdicts = await Promise.all(
    toCheck.map((d) =>
      // A registry outage must not block a commit — an unreachable registry is
      // not evidence against the package.
      verifyPackage(d.name, d.ecosystem).catch(() => null),
    ),
  );

  // The lockfile check runs against the working tree's configs — the staged
  // blob comparison above already covers redefinition-vs-HEAD; the lock adds
  // redefinition-vs-what-the-team-approved, which survives history rewrites.
  const lock = verifyMcpLock(repoDir);
  agentConfig.push(...lock.findings);

  // Policy: evaluated over EVERY verified addition, healthy ones included — a
  // deny-listed or licence-forbidden package is usually perfectly healthy on
  // the registry, which is precisely why it needs a policy to catch it.
  const policyViolations: PolicyViolation[] = [];
  const policy = loadPolicy(repoDir);
  if (policy) {
    for (const v of verdicts) {
      if (v) policyViolations.push(...evaluatePackagePolicy(v, policy));
    }
    for (const file of files) {
      if (classifyAgentSurface(file) !== "mcp_config") continue;
      const content = stagedBlob(file, repoDir);
      if (!content) continue;
      for (const [name, spec] of extractMcpServers(content)) {
        const { server } = assessMcpServerProposal({ name, command: spec.command, args: spec.args });
        policyViolations.push(...evaluateMcpPolicy(server, policy));
      }
    }
  }

  return {
    fileCount: files.length,
    secrets,
    agentConfig,
    newDependencies: verdicts.filter(
      (v): v is PackageVerifyResult => v !== null && v.status !== "healthy",
    ),
    dependenciesNotChecked: added.length - toCheck.length,
    policyViolations,
    lockChecked: lock.hasLock,
    unreviewedInstructionFiles: lock.unreviewed,
  };
}
