import { query, queryOne } from "../db/pool.js";
import {
  githubConfigured,
  getDefaultBranchSha,
  createBranch,
  getFileContents,
  updateFile,
  createPullRequest,
  listOpenPullsByHeadPrefix,
} from "../services/github.js";
import { logAudit } from "../services/audit.js";

const BRANCH_PREFIX = "codeaudit/";
const MAX_REMOVALS = 10;

/**
 * Opens a PR removing unused dependencies found by a scan.
 * Consent model: runs only when (a) the repo owner enabled autofix AND
 * (b) a human explicitly clicked the button (requestedBy). Only ever opens
 * a PR on a new branch — never touches existing branches, never merges.
 */
export async function processAutofixJob(scanJobId: string, requestedBy: string) {
  if (!githubConfigured()) return;

  const scan = await queryOne<{ id: string; repo_id: string; org_id: string }>(
    "SELECT id, repo_id, org_id FROM scan_jobs WHERE id = $1",
    [scanJobId],
  );
  if (!scan) return;

  const repo = await queryOne<{
    full_name: string;
    default_branch: string;
    autofix_enabled: boolean;
    installation_id: string | null;
  }>(
    `SELECT r.full_name, r.default_branch, r.autofix_enabled, gi.installation_id
     FROM repositories r LEFT JOIN github_installations gi ON gi.id = r.installation_id
     WHERE r.id = $1`,
    [scan.repo_id],
  );
  if (!repo?.autofix_enabled || !repo.installation_id) {
    console.log(`[autofix ${scanJobId}] skipped — autofix disabled or no installation`);
    return;
  }
  const installationId = Number(repo.installation_id);

  const unused = await query<{ package_name: string }>(
    `SELECT package_name FROM dependency_findings
     WHERE scan_job_id = $1 AND status = 'unused'
     ORDER BY package_name LIMIT $2`,
    [scanJobId, MAX_REMOVALS],
  );
  if (unused.length === 0) {
    console.log(`[autofix ${scanJobId}] no unused dependencies to remove`);
    return;
  }

  // One CodeAudit fix PR at a time — don't spam.
  const openPrs = await listOpenPullsByHeadPrefix(installationId, repo.full_name, BRANCH_PREFIX);
  if (openPrs.length > 0) {
    console.log(`[autofix ${scanJobId}] skipped — CodeAudit PR #${openPrs[0]} already open`);
    return;
  }

  const baseSha = await getDefaultBranchSha(installationId, repo.full_name, repo.default_branch);
  const { content, sha: fileSha } = await getFileContents(
    installationId,
    repo.full_name,
    "package.json",
    repo.default_branch,
  );

  const manifest = JSON.parse(content) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const removed: string[] = [];
  for (const { package_name } of unused) {
    if (manifest.dependencies && package_name in manifest.dependencies) {
      delete manifest.dependencies[package_name];
      removed.push(package_name);
    } else if (manifest.devDependencies && package_name in manifest.devDependencies) {
      delete manifest.devDependencies[package_name];
      removed.push(package_name);
    }
  }
  if (removed.length === 0) {
    console.log(`[autofix ${scanJobId}] nothing to remove — package.json changed since scan`);
    return;
  }

  const requester = await queryOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [
    requestedBy,
  ]);

  const branchName = `${BRANCH_PREFIX}remove-unused-deps-${scanJobId.slice(0, 8)}`;
  await createBranch(installationId, repo.full_name, branchName, baseSha);
  await updateFile(installationId, repo.full_name, "package.json", {
    branch: branchName,
    message: `chore: remove ${removed.length} unused ${removed.length === 1 ? "dependency" : "dependencies"}\n\nRequested via CodeAudit by ${requester?.email ?? "a repo admin"}.`,
    content: JSON.stringify(manifest, null, 2) + "\n",
    sha: fileSha,
  });

  const pr = await createPullRequest(installationId, repo.full_name, {
    title: `chore: remove ${removed.length} unused ${removed.length === 1 ? "dependency" : "dependencies"}`,
    head: branchName,
    base: repo.default_branch,
    body: `CodeAudit's scan found these packages declared in \`package.json\` but never imported anywhere in the codebase:

${removed.map((p) => `- \`${p}\``).join("\n")}

**This PR was requested by ${requester?.email ?? "a repo admin"}** from the scan report — CodeAudit only proposes changes; reviewing and merging is your decision.

> Automated analysis — verify before acting (e.g. packages used via CLI scripts or config files won't show as imports). Configure or disable auto-fix in CodeAudit repo settings.`,
  });

  await logAudit(scan.org_id, requestedBy, "autofix.pr_opened", repo.full_name, {
    pr: pr.number,
    removed,
  });
  console.log(`[autofix ${scanJobId}] opened PR #${pr.number} on ${repo.full_name} removing: ${removed.join(", ")}`);
}
