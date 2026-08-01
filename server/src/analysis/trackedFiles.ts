import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const GIT_LS_FILES_TIMEOUT_MS = 30_000;
// `git ls-files -z` output for a very large monorepo can run to several MB —
// give it plenty of headroom rather than truncating and silently under-reporting.
const MAX_BUFFER_BYTES = 64 * 1024 * 1024;

/**
 * Repo-relative POSIX paths tracked by git in `repoDir` (working tree, not
 * history). Used to tell `findSecrets` which files are actually committed —
 * a credential in a tracked file is a leak; one in a gitignored `.env` is
 * correct practice.
 *
 * Best-effort: returns null on any git failure so the caller can fall back
 * to the engine's conservative default (skip `.env*` entirely) rather than
 * failing the whole scan.
 */
export async function listTrackedFiles(repoDir: string): Promise<Set<string> | null> {
  try {
    const { stdout } = await execFileAsync("git", ["ls-files", "-z"], {
      cwd: repoDir,
      timeout: GIT_LS_FILES_TIMEOUT_MS,
      maxBuffer: MAX_BUFFER_BYTES,
    });
    return new Set(stdout.split("\0").filter(Boolean));
  } catch (err) {
    console.error(
      `git ls-files failed for ${repoDir} (falling back to conservative secret scan):`,
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}
