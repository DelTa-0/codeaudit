import { Router } from "express";
import crypto from "node:crypto";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth, requireOrgRole } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, conflict, notFound } from "../lib/errors.js";
import { logAudit } from "../services/audit.js";

export const orgsRouter = Router();
orgsRouter.use(requireAuth);

orgsRouter.post(
  "/",
  validateBody(z.object({ name: z.string().min(1).max(100) })),
  async (req, res, next) => {
    try {
      const { name } = req.body as { name: string };
      const slug = `${name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, 40)}-${crypto.randomBytes(3).toString("hex")}`;
      const [org] = await query<{ id: string }>(
        "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id, name, slug, plan",
        [name, slug],
      );
      await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
        org.id,
        req.user!.id,
      ]);
      await logAudit(org.id, req.user!.id, "org.created", name);
      res.status(201).json(org);
    } catch (err) {
      next(err);
    }
  },
);

orgsRouter.get("/:orgId", requireOrgRole("developer"), async (req, res, next) => {
  try {
    const org = await queryOne(
      "SELECT id, name, slug, plan, plan_status, created_at FROM organizations WHERE id = $1",
      [req.params.orgId],
    );
    if (!org) throw notFound();
    res.json({ ...org, role: req.orgRole });
  } catch (err) {
    next(err);
  }
});

orgsRouter.get("/:orgId/members", requireOrgRole("developer"), async (req, res, next) => {
  try {
    const members = await query(
      `SELECT m.id, m.role, m.created_at, u.id AS user_id, u.email, u.name, u.avatar_url
       FROM org_members m JOIN users u ON u.id = m.user_id
       WHERE m.org_id = $1 ORDER BY m.created_at`,
      [req.params.orgId],
    );
    res.json(members);
  } catch (err) {
    next(err);
  }
});

const inviteSchema = z.object({
  email: z.string().email(),
  role: z.enum(["admin", "developer"]),
});

orgsRouter.post(
  "/:orgId/invites",
  requireOrgRole("admin"),
  validateBody(inviteSchema),
  async (req, res, next) => {
    try {
      const { email, role } = req.body as z.infer<typeof inviteSchema>;
      const existingMember = await queryOne(
        `SELECT m.id FROM org_members m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 AND u.email = $2`,
        [req.params.orgId, email],
      );
      if (existingMember) throw conflict("User is already a member");

      const token = crypto.randomBytes(24).toString("hex");
      const [invite] = await query(
        `INSERT INTO invites (org_id, email, role, token, invited_by, expires_at)
         VALUES ($1, $2, $3, $4, $5, now() + interval '7 days')
         RETURNING id, email, role, token, expires_at`,
        [req.params.orgId, email, role, token, req.user!.id],
      );
      await logAudit(req.params.orgId, req.user!.id, "member.invited", email, { role });
      // Local dev "email transport": the invite link is logged and returned.
      console.log(`[invite] ${email} -> /invites/${token}`);
      res.status(201).json(invite);
    } catch (err) {
      next(err);
    }
  },
);

orgsRouter.post("/invites/:token/accept", async (req, res, next) => {
  try {
    const invite = await queryOne<{ id: string; org_id: string; email: string; role: string }>(
      `SELECT id, org_id, email, role FROM invites
       WHERE token = $1 AND accepted_at IS NULL AND expires_at > now()`,
      [req.params.token],
    );
    if (!invite) throw notFound("Invite not found or expired");
    const me = await queryOne<{ email: string }>("SELECT email FROM users WHERE id = $1", [
      req.user!.id,
    ]);
    if (me?.email.toLowerCase() !== invite.email.toLowerCase())
      throw badRequest("This invite was issued for a different email address");

    await query(
      `INSERT INTO org_members (org_id, user_id, role, invited_by)
       VALUES ($1, $2, $3, NULL) ON CONFLICT (org_id, user_id) DO NOTHING`,
      [invite.org_id, req.user!.id, invite.role],
    );
    await query("UPDATE invites SET accepted_at = now() WHERE id = $1", [invite.id]);
    await logAudit(invite.org_id, req.user!.id, "member.joined", me!.email);
    res.json({ orgId: invite.org_id });
  } catch (err) {
    next(err);
  }
});

const roleSchema = z.object({ role: z.enum(["admin", "developer"]) });

orgsRouter.patch(
  "/:orgId/members/:memberId",
  requireOrgRole("owner"),
  validateBody(roleSchema),
  async (req, res, next) => {
    try {
      const target = await queryOne<{ role: string }>(
        "SELECT role FROM org_members WHERE id = $1 AND org_id = $2",
        [req.params.memberId, req.params.orgId],
      );
      if (!target) throw notFound("Member not found");
      if (target.role === "owner") throw badRequest("Cannot change the owner's role");
      const { role } = req.body as z.infer<typeof roleSchema>;
      await query("UPDATE org_members SET role = $1 WHERE id = $2", [role, req.params.memberId]);
      await logAudit(req.params.orgId, req.user!.id, "member.role_changed", req.params.memberId, {
        role,
      });
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

orgsRouter.delete(
  "/:orgId/members/:memberId",
  requireOrgRole("owner"),
  async (req, res, next) => {
    try {
      const target = await queryOne<{ role: string }>(
        "SELECT role FROM org_members WHERE id = $1 AND org_id = $2",
        [req.params.memberId, req.params.orgId],
      );
      if (!target) throw notFound("Member not found");
      if (target.role === "owner") throw badRequest("Cannot remove the owner");
      await query("DELETE FROM org_members WHERE id = $1", [req.params.memberId]);
      await logAudit(req.params.orgId, req.user!.id, "member.removed", req.params.memberId);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);
