import { Router } from "express";
import { query, queryOne } from "../../db/pool.js";
import { notFound } from "../../lib/errors.js";
import { readPage, readSort } from "./pagination.js";

export const adminOrgsRouter = Router();

/**
 * `stripe_customer_id` and `stripe_subscription_id` are omitted. They would be
 * mildly convenient for support and are exactly the sort of identifier that
 * should not be sitting in a dashboard, a CSV export, or a screenshot.
 */
const SORTABLE: Record<string, string> = {
  created_at: "o.created_at",
  name: "o.name",
  members: "member_count",
  repos: "repo_count",
  scans: "scan_count",
  last_activity: "last_activity",
};

adminOrgsRouter.get("/orgs", async (req, res, next) => {
  try {
    const { limit, offset } = readPage(req);
    const { orderBy, sort, dir } = readSort(req, SORTABLE, "created_at");
    const search = String(req.query.q ?? "").trim();
    const plan = String(req.query.plan ?? "all");

    const where: string[] = [];
    const params: unknown[] = [];
    if (search) {
      params.push(`%${search}%`);
      where.push(`(o.name ILIKE $${params.length} OR o.slug ILIKE $${params.length})`);
    }
    if (plan !== "all") {
      params.push(plan);
      where.push(`o.plan = $${params.length}`);
    }
    const whereSql = where.length ? `WHERE ${where.join(" AND ")}` : "";

    const rows = await query(
      `SELECT o.id, o.name, o.slug, o.plan, o.plan_status, o.created_at,
              (SELECT count(*) FROM org_members m WHERE m.org_id = o.id)  AS member_count,
              (SELECT count(*) FROM repositories r WHERE r.org_id = o.id) AS repo_count,
              (SELECT count(*) FROM scan_jobs s WHERE s.org_id = o.id)    AS scan_count,
              (SELECT max(s.created_at) FROM scan_jobs s WHERE s.org_id = o.id) AS last_activity,
              (SELECT u.email FROM org_members m JOIN users u ON u.id = m.user_id
                WHERE m.org_id = o.id AND m.role = 'owner'
                ORDER BY m.created_at LIMIT 1) AS owner_email
       FROM organizations o
       ${whereSql}
       ORDER BY ${orderBy}
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM organizations o ${whereSql}`,
      params,
    );

    res.json({ rows, total: Number(total!.n), limit, offset, sort, dir });
  } catch (err) {
    next(err);
  }
});

adminOrgsRouter.get("/orgs/:id", async (req, res, next) => {
  try {
    const org = await queryOne(
      `SELECT id, name, slug, plan, plan_status, created_at FROM organizations WHERE id = $1`,
      [req.params.id],
    );
    if (!org) throw notFound("Organization not found");

    const [members, repos, scans] = await Promise.all([
      query(
        `SELECT m.role, m.created_at AS joined_at, u.id AS user_id, u.email, u.name,
                u.last_seen_at, u.suspended_at IS NOT NULL AS suspended
         FROM org_members m JOIN users u ON u.id = m.user_id
         WHERE m.org_id = $1 ORDER BY m.created_at`,
        [req.params.id],
      ),
      // No cli_token, no badge_token — those are credentials, and the panel has
      // no reason to be able to read them.
      query(
        `SELECT id, full_name, private, default_branch, webhook_enabled,
                latest_score, created_at
         FROM repositories WHERE org_id = $1 ORDER BY created_at DESC LIMIT 100`,
        [req.params.id],
      ),
      queryOne<Record<string, string>>(
        `SELECT count(*) AS total,
                count(*) FILTER (WHERE created_at > now() - interval '30 days') AS last_30d,
                count(*) FILTER (WHERE status = 'failed') AS failed
         FROM scan_jobs WHERE org_id = $1`,
        [req.params.id],
      ),
    ]);

    res.json({
      org,
      members,
      repos,
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
