import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { githubConfigured, listInstallationRepos } from "../services/github.js";
import { assertCanAddRepo, getOrgPlan } from "../services/plans.js";
import { logAudit } from "../services/audit.js";
import { paymentRequired } from "../lib/errors.js";

export const githubRouter = Router();
githubRouter.use(requireAuth);

githubRouter.get("/github/install-url", (_req, res) => {
  if (!config.github.appId)
    return res.status(501).json({ error: "GitHub App is not configured (set GITHUB_APP_ID)" });
  // App slug install page; after install GitHub redirects back with installation_id.
  res.json({ url: `https://github.com/apps/codeaudit/installations/new` });
});

const linkSchema = z.object({ installationId: z.number().int().positive() });

/** Links a completed App installation to the caller's org. */
githubRouter.post(
  "/orgs/:orgId/installations",
  requireOrgRole("admin"),
  validateBody(linkSchema),
  async (req, res, next) => {
    try {
      if (!githubConfigured()) throw badRequest("GitHub App is not configured on this server");
      const { installationId } = req.body as z.infer<typeof linkSchema>;
      const [row] = await query(
        `INSERT INTO github_installations (org_id, installation_id)
         VALUES ($1, $2)
         ON CONFLICT (installation_id) DO UPDATE SET org_id = EXCLUDED.org_id
         RETURNING id, installation_id, account_login`,
        [req.params.orgId, installationId],
      );
      await logAudit(req.params.orgId, req.user!.id, "github.installation_linked", String(installationId));
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  },
);

/** Repo picker: lists repos accessible to the org's installation. */
githubRouter.get(
  "/orgs/:orgId/github-repos",
  requireOrgRole("developer"),
  async (req, res, next) => {
    try {
      const inst = await queryOne<{ id: string; installation_id: string }>(
        "SELECT id, installation_id FROM github_installations WHERE org_id = $1",
        [req.params.orgId],
      );
      if (!inst) throw notFound("No GitHub App installation linked to this organization");
      const repos = await listInstallationRepos(Number(inst.installation_id));
      res.json(repos);
    } catch (err) {
      next(err);
    }
  },
);

const connectGithubSchema = z.object({
  githubRepoId: z.number().int().positive(),
  fullName: z.string().min(3).max(200).regex(/^[\w.-]+\/[\w.-]+$/),
  private: z.boolean(),
  defaultBranch: z.string().min(1).max(100),
});

/** Connects an installation repo (incl. private) to the org. */
githubRouter.post(
  "/orgs/:orgId/github-repos",
  requireOrgRole("admin"),
  validateBody(connectGithubSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof connectGithubSchema>;
      const inst = await queryOne<{ id: string }>(
        "SELECT id FROM github_installations WHERE org_id = $1",
        [req.params.orgId],
      );
      if (!inst) throw notFound("No GitHub App installation linked to this organization");
      await assertCanAddRepo(req.params.orgId, body.private);
      const [repo] = await query(
        `INSERT INTO repositories (org_id, installation_id, github_repo_id, full_name, private, default_branch)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (org_id, full_name) DO UPDATE SET installation_id = EXCLUDED.installation_id,
           github_repo_id = EXCLUDED.github_repo_id, private = EXCLUDED.private
         RETURNING *`,
        [req.params.orgId, inst.id, body.githubRepoId, body.fullName, body.private, body.defaultBranch],
      );
      await logAudit(req.params.orgId, req.user!.id, "repo.connected", body.fullName);
      res.status(201).json(repo);
    } catch (err) {
      next(err);
    }
  },
);

const webhookToggleSchema = z.object({ enabled: z.boolean() });

githubRouter.patch(
  "/repos/:repoId/webhook",
  validateBody(webhookToggleSchema),
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
      const { enabled } = req.body as z.infer<typeof webhookToggleSchema>;
      if (enabled) {
        const { limits, plan } = await getOrgPlan(repo.org_id);
        if (!limits.webhookScans)
          throw paymentRequired(`Webhook auto-scans require the Pro plan (current: ${plan}).`);
      }
      await query("UPDATE repositories SET webhook_enabled = $2 WHERE id = $1", [
        repo.id,
        enabled,
      ]);
      res.json({ ok: true, enabled });
    } catch (err) {
      next(err);
    }
  },
);
