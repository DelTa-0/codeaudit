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
  } catch (err) {
    // Distinguishable from a genuinely clean history: an oversized or failed
    // `git log` returns no findings, and without this line that is
    // indistinguishable from "there were none".
    console.error(
      "[history-secrets] git log failed or exceeded the output limit; history not scanned:",
      err instanceof Error ? err.message : err,
    );
    return [];
  }

  const byFingerprint = new Map<string, SecretFinding>();
  let commit = "";
  let file = "";
  let addedLineNumber = 0;

  for (const line of stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7, 47).trim();
      continue;
    }
    if (/^\+\+\+ (b\/|\/dev\/null)/.test(line)) {
      file = line.startsWith("+++ b/") ? line.slice(6).trim() : "";
      addedLineNumber = 0;
      continue;
    }
    // `@@ -old,count +new,count @@` — with --unified=0 there are no context
    // lines, so the header's new-file start is the exact line of the next
    // added line, and each added line advances it by one. Without this every
    // history finding reports line 1, because the engine's detector receives
    // one line at a time and numbers it relative to that input.
    const hunk = /^@@ -\d+(?:,\d+)? \+(\d+)(?:,\d+)? @@/.exec(line);
    if (hunk) {
      addedLineNumber = Number(hunk[1]);
      continue;
    }
    // Added lines only: every secret ever introduced appears as one at some
    // point, so this is complete without walking whole trees.
    if (!line.startsWith("+")) continue;

    for (const found of scanTextForSecrets(line.slice(1), file)) {
      const finding = { ...found, line: addedLineNumber || found.line };
      const existing = byFingerprint.get(finding.fingerprint);
      if (existing) {
        // git log is newest-first, so an earlier iteration saw a later commit.
        existing.firstSeenCommit = commit;
        continue;
      }
      byFingerprint.set(finding.fingerprint, {
        ...finding,
        firstSeenCommit: commit,
        lastSeenCommit: commit,
        removedFromHead: !headFingerprints.has(finding.fingerprint),
      });
    }
    addedLineNumber++;
  }

  return [...byFingerprint.values()].filter((f) => f.removedFromHead);
}
