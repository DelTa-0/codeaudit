import { Router } from "express";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, notFound } from "../lib/errors.js";
import { config } from "../lib/config.js";
import {
  githubConfigured,
  listInstallationRepos,
  listAppInstallations,
  getInstallation,
} from "../services/github.js";
import { assertCanAddRepo, getOrgPlan } from "../services/plans.js";
import { logAudit } from "../services/audit.js";
import { paymentRequired } from "../lib/errors.js";

export const githubRouter = Router();
githubRouter.use(requireAuth);

githubRouter.get("/github/install-url", (_req, res) => {
  if (!config.github.appId)
    return res.status(501).json({ error: "GitHub App is not configured (set GITHUB_APP_ID)" });
  // The slug was hardcoded to "codeaudit", which the codeaudit -> codeorion
  // rename left pointing at an app that does not exist — the install button
  // rendered fine and landed the user on a GitHub 404. It cannot be derived
  // from the App ID, so it has to be configured.
  if (!config.github.slug)
    return res
      .status(501)
      .json({ error: "GitHub App slug is not configured (set GITHUB_APP_SLUG)" });
  // After install GitHub redirects back with installation_id.
  res.json({ url: `https://github.com/apps/${config.github.slug}/installations/new` });
});

/**
 * Installations this user could claim but hasn't linked yet.
 *
 * Installing the App on GitHub creates nothing on our side — the install
 * carries no CodeAudit identity, so an org owner has to claim it. Before the
 * Setup URL existed there was no way to do that at all, which stranded every
 * installation made up to that point; installing straight from GitHub still
 * strands one today.
 *
 * The filter is the security boundary: only installations whose GitHub account
 * id equals the caller's own github_user_id are offered, so claiming requires
 * having proved control of that account through OAuth. Matching on account
 * *login* would be wrong — logins are renameable and can be re-registered.
 */
githubRouter.get(
  "/orgs/:orgId/claimable-installations",
  requireOrgRole("admin"),
  async (req, res, next) => {
    try {
      if (!githubConfigured()) return res.json([]);
      const me = await queryOne<{ github_user_id: string | null }>(
        "SELECT github_user_id FROM users WHERE id = $1",
        [req.user!.id],
      );
      // No linked GitHub identity means nothing is provably theirs to claim.
      if (!me?.github_user_id) return res.json([]);

      const [all, linked] = await Promise.all([
        listAppInstallations(),
        query<{ installation_id: string }>("SELECT installation_id FROM github_installations", []),
      ]);
      const alreadyLinked = new Set(linked.map((r) => String(r.installation_id)));
      const mine = all.filter(
        (i) =>
          i.accountId !== null &&
          String(i.accountId) === String(me.github_user_id) &&
          !alreadyLinked.has(String(i.installationId)),
      );
      res.json(mine);
    } catch (err) {
      next(err);
    }
  },
);

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
      // Best-effort: the metadata only drives dashboard copy, so a GitHub API
      // blip must not stop the installation from being linked.
      let meta: { accountLogin: string | null; repositorySelection: string | null } = {
        accountLogin: null,
        repositorySelection: null,
      };
      try {
        meta = await getInstallation(installationId);
      } catch (err) {
        console.error(`[github] could not read installation ${installationId}:`, err);
      }
      // This endpoint is also the landing point for setup_action=update — the
      // user coming back after changing which repositories the App can see —
      // so the columns are refreshed on conflict, not just on first insert.
      // COALESCE keeps previously recorded values when the lookup above failed.
      const [row] = await query(
        `INSERT INTO github_installations (org_id, installation_id, account_login, repository_selection)
         VALUES ($1, $2, $3, $4)
         ON CONFLICT (installation_id) DO UPDATE SET org_id = EXCLUDED.org_id,
           account_login = COALESCE(EXCLUDED.account_login, github_installations.account_login),
           repository_selection =
             COALESCE(EXCLUDED.repository_selection, github_installations.repository_selection)
         RETURNING id, installation_id, account_login, repository_selection`,
        [req.params.orgId, installationId, meta.accountLogin, meta.repositorySelection],
      );
      await logAudit(req.params.orgId, req.user!.id, "github.installation_linked", String(installationId));
      res.status(201).json(row);
    } catch (err) {
      next(err);
    }
  },
);

/**
 * Repo picker: every repo the org's installations can see, plus what those
 * installations are.
 *
 * Reconfiguring repository access sends the user through the same GitHub
 * screen as a first install, which also lets them install on a *second*
 * account. Listing a single installation — which is what this did, with no
 * ORDER BY, so "single" meant "whichever row Postgres returned first" — would
 * then hide the other account's repositories with no hint as to why.
 */
githubRouter.get(
  "/orgs/:orgId/github-repos",
  requireOrgRole("developer"),
  async (req, res, next) => {
    try {
      const installs = await query<{
        installation_id: string;
        account_login: string | null;
        repository_selection: string | null;
      }>(
        `SELECT installation_id, account_login, repository_selection
         FROM github_installations WHERE org_id = $1 ORDER BY created_at`,
        [req.params.orgId],
      );
      if (installs.length === 0)
        throw notFound("No GitHub App installation linked to this organization");

      const perInstall = await Promise.all(
        installs.map(async (inst) => {
          const installationId = Number(inst.installation_id);
          try {
            const repos = await listInstallationRepos(installationId);
            return repos.map((r) => ({ ...r, installationId }));
          } catch (err) {
            // One revoked or suspended installation must not blank the picker
            // for the others — the same tolerance repos.ts already applies.
            console.error(`[github] listing repos for installation ${installationId} failed:`, err);
            return [];
          }
        }),
      );

      // The same repo can be reachable through two installations (a user
      // install and an org install); the first one wins so the list has one
      // row per repository.
      const seen = new Set<number>();
      const repos = perInstall.flat().filter((r) => {
        if (seen.has(r.githubRepoId)) return false;
        seen.add(r.githubRepoId);
        return true;
      });

      res.json({
        installations: installs.map((i) => ({
          installationId: Number(i.installation_id),
          accountLogin: i.account_login,
          repositorySelection: i.repository_selection,
        })),
        repos,
      });
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
  // Which installation the picker sourced this repo from. Optional so a tab
  // loaded before this field existed keeps working; scoped to the org below,
  // so it cannot be used to borrow another org's installation.
  installationId: z.number().int().positive().optional(),
});

/** Connects an installation repo (incl. private) to the org. */
githubRouter.post(
  "/orgs/:orgId/github-repos",
  requireOrgRole("admin"),
  validateBody(connectGithubSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof connectGithubSchema>;
      const inst = body.installationId
        ? await queryOne<{ id: string }>(
            "SELECT id FROM github_installations WHERE org_id = $1 AND installation_id = $2",
            [req.params.orgId, body.installationId],
          )
        : await queryOne<{ id: string }>(
            "SELECT id FROM github_installations WHERE org_id = $1 ORDER BY created_at",
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

const gateSchema = z.object({
  enabled: z.boolean(),
  minScore: z.number().min(0).max(100).nullable().optional(),
});

/** Merge-gate settings — opt-in per repo; the check only reports, blocking is
 * decided by the owner's own GitHub branch-protection rules. */
githubRouter.patch("/repos/:repoId/gate", validateBody(gateSchema), async (req, res, next) => {
  try {
    const repo = await queryOne<{ id: string; org_id: string; role: string }>(
      `SELECT r.id, r.org_id, m.role FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    if (repo.role === "developer") throw notFound("Repository not found");
    const { enabled, minScore } = req.body as z.infer<typeof gateSchema>;
    await query("UPDATE repositories SET gate_enabled = $2, min_score = $3 WHERE id = $1", [
      repo.id,
      enabled,
      minScore ?? null,
    ]);
    await logAudit(repo.org_id, req.user!.id, "gate.updated", repo.id, { enabled, minScore });
    res.json({ ok: true, enabled, minScore: minScore ?? null });
  } catch (err) {
    next(err);
  }
});

const autofixToggleSchema = z.object({ enabled: z.boolean() });

/** Autofix opt-in toggle — enabling this only allows a human to REQUEST a fix
 * PR later; nothing runs automatically. */
githubRouter.patch(
  "/repos/:repoId/autofix",
  validateBody(autofixToggleSchema),
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
      const { enabled } = req.body as z.infer<typeof autofixToggleSchema>;
      await query("UPDATE repositories SET autofix_enabled = $2 WHERE id = $1", [
        repo.id,
        enabled,
      ]);
      await logAudit(repo.org_id, req.user!.id, "autofix.toggled", repo.id, { enabled });
      res.json({ ok: true, enabled });
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
