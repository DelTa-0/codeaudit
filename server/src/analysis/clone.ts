import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { simpleGit } from "simple-git";

const SCAN_ROOT = path.join(os.tmpdir(), "codeaudit-scans");
const CLONE_TIMEOUT_MS = 60_000;
const MAX_REPO_BYTES = 200 * 1024 * 1024; // 200 MB
const MAX_FILE_COUNT = 20_000;

/**
 * Shallow-clones a repo into an isolated per-job temp directory.
 * NEVER executes any code from the repo — clone only, static reads after.
 * Caller MUST call cleanupScanDir in a finally block.
 */
export async function cloneRepoSandboxed(
  cloneUrl: string,
  jobId: string,
  ref?: string,
): Promise<string> {
  const dir = path.join(SCAN_ROOT, jobId);
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });

  const git = simpleGit({ timeout: { block: CLONE_TIMEOUT_MS } });
  // Depth 100 (not 1) so AI-authorship attribution has commit history to read.
  const args = ["--depth", "100", "--single-branch"];
  if (ref) args.push("--branch", ref);
  await git.clone(cloneUrl, dir, args);

  enforceRepoLimits(dir);
  return dir;
}

function enforceRepoLimits(dir: string) {
  let totalBytes = 0;
  let fileCount = 0;
  const stack = [dir];
  while (stack.length) {
    const current = stack.pop()!;
    for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
      if (entry.name === ".git") continue;
      const full = path.join(current, entry.name);
      if (entry.isDirectory()) {
        stack.push(full);
      } else if (entry.isFile()) {
        fileCount += 1;
        totalBytes += fs.statSync(full).size;
        if (fileCount > MAX_FILE_COUNT)
          throw new Error(`Repository exceeds the ${MAX_FILE_COUNT}-file limit`);
        if (totalBytes > MAX_REPO_BYTES)
          throw new Error(`Repository exceeds the ${MAX_REPO_BYTES / 1024 / 1024} MB size limit`);
      }
    }
  }
}

export function cleanupScanDir(jobId: string) {
  try {
    fs.rmSync(path.join(SCAN_ROOT, jobId), { recursive: true, force: true });
  } catch (err) {
    console.error(`cleanup failed for ${jobId}`, err);
  }
}
