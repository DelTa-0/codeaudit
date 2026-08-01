import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanTextForSecrets, type SecretFinding } from "@codeaudit/engine";

const run = promisify(execFile);

const MAX_COMMITS = 100;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * Secrets that were committed and later deleted are still in the git objects
 * and still compromised — anyone who cloned has them. Deleting the line does
 * not help; only rotation does. That finding class is invisible to a
 * working-tree scan, which is the whole reason this exists.
 *
 * Lives server-side rather than in the engine because it shells out to git,
 * and the engine is deliberately subprocess-free. Detection itself is still
 * the engine's `scanTextForSecrets`, so there is one detector, not two.
 *
 * Best-effort: returns [] on any failure, like the rest of analysis/.
 */
export async function scanHistorySecrets(
  repoDir: string,
  headFingerprints: Set<string>,
): Promise<SecretFinding[]> {
  let stdout: string;
  try {
    const result = await run(
      "git",
      ["log", "-p", "--unified=0", "--no-color", `--max-count=${MAX_COMMITS}`],
      { cwd: repoDir, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const byFingerprint = new Map<string, SecretFinding>();
  let commit = "";
  let file = "";

  for (const line of stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7, 47).trim();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = line.slice(6).trim();
      continue;
    }
    // Added lines only: every secret ever introduced appears as one at some
    // point, so this is complete without walking whole trees.
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    for (const found of scanTextForSecrets(line.slice(1), file)) {
      const existing = byFingerprint.get(found.fingerprint);
      if (existing) {
        // git log is newest-first, so an earlier iteration saw a later commit.
        existing.firstSeenCommit = commit;
        continue;
      }
      byFingerprint.set(found.fingerprint, {
        ...found,
        firstSeenCommit: commit,
        lastSeenCommit: commit,
        removedFromHead: !headFingerprints.has(found.fingerprint),
      });
    }
  }

  return [...byFingerprint.values()].filter((f) => f.removedFromHead);
}
