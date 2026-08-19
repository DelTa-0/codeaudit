import { Router } from "express";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, queryOne } from "../../db/pool.js";
import { validateBody } from "../../middleware/validate.js";
import { badRequest, forbidden, notFound, unauthorized } from "../../lib/errors.js";
import { logAudit } from "../../services/audit.js";
import { logEvent } from "../../services/systemEvents.js";
import { readPage, readSort } from "./pagination.js";
import type { Request } from "express";

export const adminUsersRouter = Router();

/**
 * The columns any admin user query may select.
 *
 * Written out rather than `SELECT *` on purpose: `users` also holds
 * `password_hash`, and the difference between an allow-list and a wildcard is
 * whether adding a secret column tomorrow quietly starts publishing it.
 */
const USER_COLUMNS = `u.id, u.email, u.name, u.avatar_url, u.platform_role,
  u.created_at, u.last_seen_at, u.suspended_at, u.suspended_reason,
  u.github_user_id IS NOT NULL AS github_linked,
  u.password_hash IS NOT NULL AS has_password`;

const SORTABLE: Record<string, string> = {
  created_at: "u.created_at",
  last_seen_at: "u.last_seen_at",
  email: "u.email",
  orgs: "org_count",
  scans: "scan_count",
};

adminUsersRouter.get("/users", async (req, res, next) => {
  try {
    const { limit, offset } = readPage(req);
    const { orderBy, sort, dir } = readSort(req, SORTABLE, "created_at");
    const search = String(req.query.q ?? "").trim();
    const status = String(req.query.status ?? "all");

    const where: string[] = [];
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(u.email ILIKE $${params.length} OR u.name ILIKE $${params.length})`);
    }
    if (status === "suspended") where.push("u.suspended_at IS NOT NULL");
    if (status === "active") where.push("u.suspended_at IS NULL");
    if (status === "admin") where.push("u.platform_role = 'admin'");
    if (status === "online") where.push("u.last_seen_at > now() - interval '5 minutes'");
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await query(
      `SELECT ${USER_COLUMNS},
              (SELECT count(*) FROM org_members m WHERE m.user_id = u.id) AS org_count,
              (SELECT count(*) FROM scan_jobs s WHERE s.requested_by = u.id) AS scan_count
       FROM users u
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM users u ${whereSql}`,
      params,
    );

    res.json({ rows, total: Number(total!.n), limit, offset, sort, dir });
  } catch (err) {
    next(err);
  }
});

adminUsersRouter.get("/users/:id", async (req, res, next) => {
  try {
    const user = await queryOne(`SELECT ${USER_COLUMNS} FROM users u WHERE u.id = $1`, [
      req.params.id,
    ]);
    if (!user) throw notFound("User not found");

    const [orgs, activity, scans] = await Promise.all([
      query(
        `SELECT o.id, o.name, o.slug, o.plan, o.plan_status, m.role, m.created_at AS joined_at,
                (SELECT count(*) FROM repositories r WHERE r.org_id = o.id) AS repo_count
         FROM org_members m JOIN organizations o ON o.id = m.org_id
         WHERE m.user_id = $1 ORDER BY m.created_at`,
        [req.params.id],
      ),
      query(
        `SELECT id, action, target, status, method, path, ip, created_at
         FROM audit_log WHERE user_id = $1 ORDER BY created_at DESC LIMIT 50`,
        [req.params.id],
      ),
      queryOne<Record<string, string>>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d,
                count(*) FILTER (WHERE status = 'failed') AS failed
         FROM scan_jobs WHERE requested_by = $1`,
        [req.params.id],
      ),
    ]);

    res.json({
      user,
      orgs,
      activity,
      scans: {
        total: Number(scans!.total),
        last30d: Number(scans!.last_30d),
        failed: Number(scans!.failed),
      },
    });
  } catch (err) {
    next(err);
  }
});

/**
 * Re-checks the calling admin's own password.
 *
 * Granting platform admin is the one action in the product that can be used to
 * grant it again, so a borrowed or stolen JWT must not be enough on its own. A
 * bearer token proves "this session was authenticated at some point in the last
 * seven days"; this proves someone who knows the password is at the keyboard
 * now.
 */
async function requirePasswordConfirmation(req: Request, password: string) {
  const me = await queryOne<{ password_hash: string | null }>(
    "SELECT password_hash FROM users WHERE id = $1",
    [req.user!.id],
  );
  // A GitHub-only admin account has no password to re-check, so it cannot clear
  // this gate. That is deliberate: an operator account should have a password.
  if (!me?.password_hash)
    throw badRequest(
      "This action needs a password confirmation, and this account has no password set.",
    );
  if (!(await bcrypt.compare(password, me.password_hash)))
    throw unauthorized("Password confirmation failed");
}

const roleSchema = z.object({
  platformRole: z.enum(["user", "admin"]),
  password: z.string().min(1, "Password confirmation is required"),
  reason: z.string().max(500).optional(),
});

adminUsersRouter.patch("/users/:id/role", validateBody(roleSchema), async (req, res, next) => {
  try {
    const { platformRole, password, reason } = req.body as z.infer<typeof roleSchema>;
    // Self-demotion is refused, not because it is dangerous but because it is
    // how you end up with zero operators and no way back in.
    if (req.params.id === req.user!.id)
      throw forbidden("You cannot change your own platform role. Ask another admin.");
    await requirePasswordConfirmation(req, password);

    const target = await queryOne<{ id: string; email: string; platform_role: string }>(
      "SELECT id, email, platform_role FROM users WHERE id = $1",
      [req.params.id],
    );
    if (!target) throw notFound("User not found");

    await query("UPDATE users SET platform_role = $2 WHERE id = $1", [req.params.id, platformRole]);
    await logAudit(null, req.user!.id, "admin.platform_role_changed", target.email, {
      from: target.platform_role,
      to: platformRole,
      reason: reason ?? null,
    });
    // Also a system event: a change to who can operate the platform is worth
    // seeing in the error/warning stream, not only in the actor's own history.
    await logEvent({
      level: "warn",
      source: "api",
      event: "admin.platform_role_changed",
      message: `${req.user!.email} set ${target.email} to platform role "${platformRole}"`,
      userId: req.user!.id,
      context: { targetUserId: target.id, from: target.platform_role, to: platformRole },
    });

    res.json({ id: target.id, platformRole });
  } catch (err) {
    next(err);
  }
});

const suspensionSchema = z.object({
  suspended: z.boolean(),
  password: z.string().min(1, "Password confirmation is required"),
  reason: z.string().max(500).optional(),
});

adminUsersRouter.patch(
  "/users/:id/suspension",
  validateBody(suspensionSchema),
  async (req, res, next) => {
    try {
      const { suspended, password, reason } = req.body as z.infer<typeof suspensionSchema>;
      if (req.params.id === req.user!.id) throw forbidden("You cannot suspend your own account.");
      await requirePasswordConfirmation(req, password);

      const target = await queryOne<{ id: string; email: string; platform_role: string }>(
        "SELECT id, email, platform_role FROM users WHERE id = $1",
        [req.params.id],
      );
      if (!target) throw notFound("User not found");
      // Suspending a peer operator is a bigger decision than the panel should
      // make quietly available; revoke the role first, deliberately, then
      // suspend.
      if (suspended && target.platform_role === "admin")
        throw forbidden("Revoke this account's platform admin role before suspending it.");

      await query(
        `UPDATE users SET suspended_at = CASE WHEN $2 THEN now() ELSE NULL END,
                          suspended_reason = CASE WHEN $2 THEN $3 ELSE NULL END
         WHERE id = $1`,
        [req.params.id, suspended, reason ?? null],
      );
      await logAudit(
        null,
        req.user!.id,
        suspended ? "admin.user_suspended" : "admin.user_reinstated",
        target.email,
        { reason: reason ?? null },
      );
      await logEvent({
        level: "warn",
        source: "api",
        event: suspended ? "admin.user_suspended" : "admin.user_reinstated",
        message: `${req.user!.email} ${suspended ? "suspended" : "reinstated"} ${target.email}`,
        userId: req.user!.id,
        context: { targetUserId: target.id, reason: reason ?? null },
      });

      res.json({ id: target.id, suspended });
    } catch (err) {
      next(err);
    }
  },
);
