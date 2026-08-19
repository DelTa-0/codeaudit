import { Router } from "express";
import type { Request } from "express";
import { query, queryOne } from "../../db/pool.js";
import { readPage, readRangeDays } from "./pagination.js";

export const adminLogsRouter = Router();

/**
 * There is deliberately no endpoint here that deletes or edits a log row.
 *
 * An operator who can quietly erase their own trail has no trail, and the whole
 * value of the activity log rests on nobody being able to. Rows leave only via
 * the age-based retention sweep in the worker, which is time-based and
 * indiscriminate.
 */

interface Filter {
  where: string;
  params: unknown[];
}

function activityFilter(req: Request): Filter {
  const params: unknown[] = [];
  const where: string[] = [];

  const days = readRangeDays(req, 7);
  params.push(String(days));
  where.push(`a.created_at > now() - ($${params.length} || ' days')::interval`);

  const userId = String(req.query.userId ?? "").trim();
  if (userId) {
    params.push(userId);
    where.push(`a.user_id = $${params.length}`);
  }
  const orgId = String(req.query.orgId ?? "").trim();
  if (orgId) {
    params.push(orgId);
    where.push(`a.org_id = $${params.length}`);
  }
  const action = String(req.query.action ?? "").trim();
  if (action) {
    params.push(`${action}%`);
    where.push(`a.action ILIKE $${params.length}`);
  }
  const q = String(req.query.q ?? "").trim();
  if (q) {
    params.push(`%${q}%`);
    where.push(
      `(a.action ILIKE $${params.length} OR a.target ILIKE $${params.length}
        OR a.path ILIKE $${params.length} OR u.email ILIKE $${params.length})`,
    );
  }
  const outcome = String(req.query.outcome ?? "all");
  // "failed" means the request the entry describes did not succeed. This is the
  // filter you reach for during an incident, and it is only answerable because
  // the middleware records status alongside the action.
  if (outcome === "failed") where.push("a.status >= 400");
  if (outcome === "ok") where.push("(a.status IS NULL OR a.status < 400)");

  return { where: `WHERE ${where.join(" AND ")}`, params };
}

const ACTIVITY_SELECT = `SELECT a.id, a.action, a.target, a.metadata, a.ip, a.user_agent,
    a.method, a.path, a.status, a.duration_ms, a.created_at,
    a.user_id, u.email AS user_email, u.name AS user_name,
    a.org_id, o.name AS org_name
  FROM audit_log a
  LEFT JOIN users u ON u.id = a.user_id
  LEFT JOIN organizations o ON o.id = a.org_id`;

adminLogsRouter.get("/activity", async (req, res, next) => {
  try {
    const { limit, offset } = readPage(req);
    const { where, params } = activityFilter(req);
    const rows = await query(
      `${ACTIVITY_SELECT} ${where} ORDER BY a.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM audit_log a LEFT JOIN users u ON u.id = a.user_id ${where}`,
      params,
    );
    res.json({ rows, total: Number(total!.n), limit, offset });
  } catch (err) {
    next(err);
  }
});

/** The distinct actions present in the window, so the UI's filter is discovered, not hardcoded. */
adminLogsRouter.get("/activity/actions", async (req, res, next) => {
  try {
    const days = readRangeDays(req, 30);
    const rows = await query(
      `SELECT action, count(*) AS n FROM audit_log
       WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY action ORDER BY n DESC LIMIT 100`,
      [String(days)],
    );
    res.json(rows.map((r) => ({ action: r.action, count: Number(r.n) })));
  } catch (err) {
    next(err);
  }
});

/** Escapes one CSV field. Quotes everything — simpler than deciding per value, and never wrong. */
function csvCell(value: unknown): string {
  if (value === null || value === undefined) return '""';
  const s = value instanceof Date ? value.toISOString() : String(value);
  return `"${s.replace(/"/g, '""')}"`;
}

adminLogsRouter.get("/activity.csv", async (req, res, next) => {
  try {
    const { where, params } = activityFilter(req);
    // A bounded export. Anything larger is a database job, not a browser
    // download, and an unbounded one is a way to turn a click into an outage.
    const rows = await query<Record<string, unknown>>(
      `${ACTIVITY_SELECT} ${where} ORDER BY a.created_at DESC LIMIT 10000`,
      params,
    );
    const columns = [
      "created_at",
      "action",
      "target",
      "user_email",
      "org_name",
      "method",
      "path",
      "status",
      "duration_ms",
      "ip",
    ];
    const body = [
      columns.join(","),
      ...rows.map((r) => columns.map((c) => csvCell(r[c])).join(",")),
    ].join("\n");

    res.setHeader("content-type", "text/csv; charset=utf-8");
    res.setHeader("content-disposition", 'attachment; filename="codeaudit-activity.csv"');
    res.send(body);
  } catch (err) {
    next(err);
  }
});

adminLogsRouter.get("/events", async (req, res, next) => {
  try {
    const { limit, offset } = readPage(req);
    const params: unknown[] = [];
    const where: string[] = [];

    const days = readRangeDays(req, 7);
    params.push(String(days));
    where.push(`e.created_at > now() - ($${params.length} || ' days')::interval`);

    const level = String(req.query.level ?? "all");
    if (level === "problems") {
      where.push(`e.level IN ('warn','error')`);
    } else if (["debug", "info", "warn", "error"].includes(level)) {
      params.push(level);
      where.push(`e.level = $${params.length}`);
    }
    const source = String(req.query.source ?? "").trim();
    if (source) {
      params.push(source);
      where.push(`e.source = $${params.length}`);
    }
    const q = String(req.query.q ?? "").trim();
    if (q) {
      params.push(`%${q}%`);
      where.push(`(e.event ILIKE $${params.length} OR e.message ILIKE $${params.length})`);
    }
    const whereSql = `WHERE ${where.join(" AND ")}`;

    const rows = await query(
      `SELECT e.id, e.level, e.source, e.event, e.message, e.context,
              e.org_id, o.name AS org_name, e.user_id, u.email AS user_email,
              e.scan_job_id, e.created_at
       FROM system_events e
       LEFT JOIN organizations o ON o.id = e.org_id
       LEFT JOIN users u ON u.id = e.user_id
       ${whereSql}
       ORDER BY e.created_at DESC
       LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
      [...params, limit, offset],
    );
    const total = await queryOne<{ n: string }>(
      `SELECT count(*) AS n FROM system_events e ${whereSql}`,
      params,
    );

    res.json({ rows, total: Number(total!.n), limit, offset });
  } catch (err) {
    next(err);
  }
});

/** Sources and their counts in the window — again, discovered rather than hardcoded. */
adminLogsRouter.get("/events/sources", async (req, res, next) => {
  try {
    const days = readRangeDays(req, 30);
    const rows = await query(
      `SELECT source, level, count(*) AS n FROM system_events
       WHERE created_at > now() - ($1 || ' days')::interval
       GROUP BY source, level ORDER BY n DESC`,
      [String(days)],
    );
    res.json(rows.map((r) => ({ source: r.source, level: r.level, count: Number(r.n) })));
  } catch (err) {
    next(err);
  }
});
