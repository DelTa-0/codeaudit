import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { conflict, notFound } from "../lib/errors.js";
import { parseRepoUrl } from "../lib/repoUrl.js";
import { assertCanAddRepo } from "../services/plans.js";
import { logAudit } from "../services/audit.js";

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
      const [repo] = await query(
        `INSERT INTO repositories (org_id, full_name, private)
         VALUES ($1, $2, false)
         RETURNING id, full_name, private, default_branch, webhook_enabled, latest_score, created_at`,
        [req.params.orgId, fullName],
      );
      await logAudit(req.params.orgId, req.user!.id, "repo.connected", fullName);
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
