import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { execFile } from "node:child_process";
import { conflict, notFound, badRequest } from "../lib/errors.js";
import { parseRepoUrl } from "../lib/repoUrl.js";
import { assertCanAddRepo } from "../services/plans.js";
import { logAudit } from "../services/audit.js";
import { listFindingLifecycle, setFindingState } from "../services/findingLifecycle.js";
import { githubConfigured, listInstallationRepos } from "../services/github.js";

/**
 * Repos can be connected either by pasting a URL (this file) or via the
 * GitHub App repo picker (routes/github.ts). If the org already has an App
 * installation that covers this repo, link it here too — otherwise PR
 * comments and private cloning silently have nothing to work with even
 * though the org is already set up for it.
 */
async function findInstallationMatch(orgId: string, fullName: string) {
  if (!githubConfigured()) return null;
  const installations = await query<{ id: string; installation_id: string }>(
    "SELECT id, installation_id FROM github_installations WHERE org_id = $1",
    [orgId],
  );
  for (const inst of installations) {
    try {
      const repos = await listInstallationRepos(Number(inst.installation_id));
      const match = repos.find((r) => r.fullName.toLowerCase() === fullName.toLowerCase());
      if (match) return { installationRowId: inst.id, match };
    } catch (err) {
      console.error(`installation ${inst.installation_id} lookup failed, skipping`, err);
    }
  }
  return null;
}

export const reposRouter = Router();
reposRouter.use(requireAuth);

reposRouter.get("/orgs/:orgId/repos", requireOrgRole("developer"), async (req, res, next) => {
  try {
    const repos = await query(
      `SELECT r.id, r.full_name, r.private, r.default_branch, r.webhook_enabled, r.latest_score,
              r.created_at,
              (SELECT s.status FROM scan_jobs s WHERE s.repo_id = r.id ORDER BY s.created_at DESC LIMIT 1) AS last_scan_status,
              (SELECT s.created_at FROM scan_jobs s WHERE s.repo_id = r.id ORDER BY s.created_at DESC LIMIT 1) AS last_scan_at
       FROM repositories r WHERE r.org_id = $1 ORDER BY r.created_at DESC`,
      [req.params.orgId],
    );
    res.json(repos);
  } catch (err) {
    next(err);
  }
});

/**
 * Does a public repo exist? `git ls-remote` rather than the GitHub API:
 * unauthenticated API calls are capped at 60/hour per IP, which one busy
 * launch afternoon would exhaust for every user behind this server at once.
 * ls-remote has no such quota. GIT_TERMINAL_PROMPT=0 makes git fail instead
 * of hanging on the credential prompt GitHub answers missing repos with.
 *
 * Fails OPEN on timeout/git-missing: a network blip must not block
 * connecting a real repo, and a nonexistent one still fails cleanly at scan
 * time — now with a human-readable message (see worker.ts humanizeScanError).
 */
function publicRepoExists(fullName: string): Promise<boolean> {
  return new Promise((resolve) => {
    execFile(
      "git",
      ["ls-remote", "--exit-code", `https://github.com/${fullName}.git`, "HEAD"],
      { timeout: 10_000, env: { ...process.env, GIT_TERMINAL_PROMPT: "0" } },
      (err) => resolve(err === null || err.killed === true),
    );
  });
}

const connectSchema = z.object({ url: z.string().min(1).max(500) });

reposRouter.post(
  "/orgs/:orgId/repos",
  requireOrgRole("admin"),
  validateBody(connectSchema),
  async (req, res, next) => {
    try {
      const { fullName } = parseRepoUrl((req.body as { url: string }).url);
      await assertCanAddRepo(req.params.orgId, false);
      const existing = await queryOne(
        "SELECT id FROM repositories WHERE org_id = $1 AND full_name = $2",
        [req.params.orgId, fullName],
      );
      if (existing) throw conflict("Repository is already connected");
      const linked = await findInstallationMatch(req.params.orgId, fullName);
      // Connect-time existence check, but only for repos no installation
      // covers: an installation match already proves existence, and a private
      // repo visible to the App would FAIL a public probe — probing first
      // would wrongly reject exactly the repos the App exists to unlock.
      // Without this, a typo'd URL connected fine and then failed its first
      // scan with raw git stderr, which reads as a product bug.
      if (!linked && !(await publicRepoExists(fullName))) {
        throw badRequest(
          `github.com/${fullName} was not found, or is private. Check the spelling — and if it is private, install the GitHub App on it instead of pasting the URL.`,
        );
      }
      const [repo] = await query(
        `INSERT INTO repositories (org_id, installation_id, github_repo_id, full_name, private, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6)
         RETURNING id, full_name, private, default_branch, webhook_enabled, latest_score, created_at`,
        [
          req.params.orgId,
          linked?.installationRowId ?? null,
          linked?.match.githubRepoId ?? null,
          fullName,
          linked?.match.private ?? false,
          linked?.match.defaultBranch ?? "main",
        ],
      );
      await logAudit(req.params.orgId, req.user!.id, "repo.connected", fullName, {
        installationLinked: Boolean(linked),
      });
      res.status(201).json(repo);
    } catch (err) {
      next(err);
    }
  },
);

reposRouter.get("/repos/:repoId", async (req, res, next) => {
  try {
    const repo = await queryOne<{ org_id: string }>(
      `SELECT r.* FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    const trend = await query(
      `SELECT id, created_at, (summary->>'score')::numeric AS score
       FROM scan_jobs WHERE repo_id = $1 AND status = 'complete'
       ORDER BY created_at DESC LIMIT 30`,
      [req.params.repoId],
    );
    res.json({ ...repo, trend: trend.reverse() });
  } catch (err) {
    next(err);
  }
});

/** Findings that outlive scans, with their history. Any member can read. */
reposRouter.get("/repos/:repoId/findings", async (req, res, next) => {
  try {
    const repo = await queryOne<{ id: string }>(
      `SELECT r.id FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    res.json(await listFindingLifecycle(req.params.repoId));
  } catch (err) {
    next(err);
  }
});

const findingStateSchema = z.object({
  state: z.enum(["open", "ignored", "acknowledged"]),
  note: z.string().max(500).optional(),
});

/**
 * Dismiss or restore a finding. This endpoint exists because a false
 * positive with no dismiss button costs the product its credibility on the
 * second scan: the user sees the same wrong finding again and stops reading
 * the report. Scans never overwrite these states (reconcileFindings only
 * touches `open`/`fixed`), so a dismissal survives every future scan.
 *
 * Admin+ only, same as the merge-gate and autofix toggles: silencing a
 * finding changes what the whole team sees.
 */
reposRouter.patch(
  "/repos/:repoId/findings/:findingId",
  validateBody(findingStateSchema),
  async (req, res, next) => {
    try {
      const repo = await queryOne<{ id: string; org_id: string; role: string }>(
        `SELECT r.id, r.org_id, m.role FROM repositories r
         JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
         WHERE r.id = $1`,
        [req.params.repoId, req.user!.id],
      );
      if (!repo) throw notFound("Repository not found");
      if (repo.role === "developer") throw notFound("Repository not found");
      const { state, note } = req.body as z.infer<typeof findingStateSchema>;
      const row = await setFindingState(req.params.repoId, req.params.findingId, state, note ?? null);
      if (!row) throw notFound("Finding not found");
      await logAudit(repo.org_id, req.user!.id, "finding.state_changed", row.finding_key, {
        state,
        ...(note ? { note } : {}),
      });
      res.json(row);
    } catch (err) {
      next(err);
    }
  },
);

reposRouter.delete("/repos/:repoId", async (req, res, next) => {
  try {
    const repo = await queryOne<{ id: string; org_id: string; full_name: string; role: string }>(
      `SELECT r.id, r.org_id, r.full_name, m.role FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    if (repo.role === "developer") throw notFound("Repository not found"); // admins+ only
    await query("DELETE FROM repositories WHERE id = $1", [repo.id]);
    await logAudit(repo.org_id, req.user!.id, "repo.removed", repo.full_name);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
