// Pre-commit mode: scan what is about to be committed.
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
import {
  scanTextForSecrets,
  isSecretScannablePath,
  classifyAgentSurface,
  scanAgentText,
  auditAgentJson,
  parseManifest,
  parsePythonManifest,
  verifyPackage,
  type SecretFinding,
  type AgentConfigFinding,
  type Ecosystem,
  type PackageVerifyResult,
} from "@codeaudit/engine";

/** Manifests whose *added* dependency entries are worth a registry check. */
const MANIFEST_RE = /(^|\/)(package\.json|pyproject\.toml|requirements[\w.-]*\.txt)$/i;
/** Skip generated/large blobs — a lockfile is not where a secret gets typed. */
const MAX_BLOB_BYTES = 512 * 1024;
/** Bound the network work so a big dependency bump cannot stall a commit. */
const MAX_NEW_DEPS_CHECKED = 25;

function git(args: string[]): string {
  return execFileSync("git", args, {
    encoding: "utf8",
    maxBuffer: 64 * 1024 * 1024,
    stdio: ["ignore", "pipe", "pipe"],
  });
}

export function isGitRepo(): boolean {
  try {
    git(["rev-parse", "--git-dir"]);
    return true;
  } catch {
    return false;
  }
}

/** Paths staged for commit (added/copied/modified — deletions cannot leak). */
export function stagedFiles(): string[] {
  const out = git(["diff", "--cached", "--name-only", "--diff-filter=ACM", "-z"]);
  return out.split("\0").filter(Boolean);
}

/**
 * The *staged* content of a file, which is not the same as what is on disk.
 * Staging a clean file and then editing it — or the reverse — is routine, and
 * a hook that reads the working tree would judge content that is not being
 * committed. `git show :path` is the only honest source here.
 */
function stagedBlob(file: string): string | null {
  try {
    const raw = git(["show", `:${file}`]);
    return raw.length > MAX_BLOB_BYTES ? null : raw;
  } catch {
    return null; // unmerged, binary, or unreadable — nothing to scan
  }
}

/** Same file as of HEAD, or null when the commit adds it. */
function headBlob(file: string): string | null {
  try {
    return git(["show", `HEAD:${file}`]);
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
}

export async function scanStaged(): Promise<StagedReport> {
  const files = stagedFiles();
  const secrets: SecretFinding[] = [];
  const agentConfig: AgentConfigFinding[] = [];
  const added: { name: string; ecosystem: Ecosystem }[] = [];

  for (const file of files) {
    const content = stagedBlob(file);
    if (content === null) continue;

    if (isSecretScannablePath(file)) secrets.push(...scanTextForSecrets(content, file));

    const surface = classifyAgentSurface(file);
    if (surface) {
      agentConfig.push(
        ...(surface === "mcp_config" || surface === "permissions"
          ? auditAgentJson(content, file, surface)
          : scanAgentText(content, file, surface)),
      );
    }

    if (MANIFEST_RE.test(file)) {
      const before = dependencyNames(file, headBlob(file));
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

  return {
    fileCount: files.length,
    secrets,
    agentConfig,
    newDependencies: verdicts.filter(
      (v): v is PackageVerifyResult => v !== null && v.status !== "healthy",
    ),
    dependenciesNotChecked: added.length - toCheck.length,
  };
}
