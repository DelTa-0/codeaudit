import { Router } from "express";
import { query, queryOne } from "../../db/pool.js";
import { getQueueSnapshot } from "../../services/queueSnapshot.js";
import { readHeartbeat } from "../../services/workerHeartbeat.js";

export const overviewRouter = Router();

/** Presence window. Long enough to survive a page read, short enough to mean "now". */
const ONLINE_WINDOW = "5 minutes";

overviewRouter.get("/overview", async (_req, res, next) => {
  try {
    // Four independent aggregates, issued together. Each is a single pass over
    // a table that is small at this scale; splitting them keeps every one
    // readable and lets Postgres pick a plan per table.
    const [users, orgsAndRepos, scans, events, series, recentErrors, heartbeat, queues] =
      await Promise.all([
        queryOne<Record<string, string>>(
          `SELECT
             count(*) FILTER (WHERE last_seen_at > now() - interval '${ONLINE_WINDOW}') AS online_now,
             count(*) FILTER (WHERE last_seen_at > now() - interval '1 day')   AS active_today,
             count(*) FILTER (WHERE last_seen_at > now() - interval '7 days')  AS active_week,
             count(*) FILTER (WHERE last_seen_at > now() - interval '30 days') AS active_month,
             count(*)                                                          AS total,
             count(*) FILTER (WHERE created_at > now() - interval '1 day')     AS new_today,
             count(*) FILTER (WHERE created_at > now() - interval '7 days')    AS new_week,
             count(*) FILTER (WHERE suspended_at IS NOT NULL)                  AS suspended,
             count(*) FILTER (WHERE platform_role = 'admin')                   AS admins
           FROM users`,
        ),
        queryOne<Record<string, string>>(
          `SELECT
             (SELECT count(*) FROM organizations) AS orgs,
             (SELECT count(*) FROM organizations WHERE plan <> 'free' AND plan_status = 'active') AS paid_orgs,
             (SELECT count(*) FROM repositories) AS repos,
             (SELECT count(*) FROM repositories WHERE private) AS private_repos`,
        ),
        queryOne<Record<string, string>>(
          `SELECT
             count(*)                                                            AS total,
             count(*) FILTER (WHERE created_at > now() - interval '1 day')        AS today,
             count(*) FILTER (WHERE status = 'failed'
                              AND created_at > now() - interval '1 day')          AS failed_today,
             count(*) FILTER (WHERE status IN ('pending','cloning','analyzing'))  AS in_flight
           FROM scan_jobs`,
        ),
        queryOne<Record<string, string>>(
          `SELECT
             count(*) FILTER (WHERE level = 'error' AND created_at > now() - interval '1 day') AS errors_today,
             count(*) FILTER (WHERE level = 'warn'  AND created_at > now() - interval '1 day') AS warnings_today,
             count(*) FILTER (WHERE level = 'error' AND created_at > now() - interval '1 hour') AS errors_hour
           FROM system_events`,
        ),
        // Fourteen days of daily counts, gap-filled by generate_series so the
        // sparkline shows a quiet day as a zero rather than closing the gap and
        // implying continuity that was not there.
        query<{
          day: string;
          signups: string;
          scans: string;
          scan_failures: string;
          errors: string;
        }>(
          `WITH days AS (
             SELECT generate_series((now() - interval '13 days')::date, now()::date, interval '1 day')::date AS day
           )
           SELECT d.day,
                  coalesce(u.n, 0)      AS signups,
                  coalesce(s.n, 0)      AS scans,
                  coalesce(s.failed, 0) AS scan_failures,
                  coalesce(e.n, 0)      AS errors
           FROM days d
           LEFT JOIN (SELECT created_at::date AS day, count(*) AS n
                        FROM users WHERE created_at > now() - interval '14 days' GROUP BY 1) u ON u.day = d.day
           LEFT JOIN (SELECT created_at::date AS day, count(*) AS n,
                             count(*) FILTER (WHERE status = 'failed') AS failed
                        FROM scan_jobs WHERE created_at > now() - interval '14 days' GROUP BY 1) s ON s.day = d.day
           LEFT JOIN (SELECT created_at::date AS day, count(*) AS n
                        FROM system_events WHERE level = 'error'
                         AND created_at > now() - interval '14 days' GROUP BY 1) e ON e.day = d.day
           ORDER BY d.day`,
        ),
        query(
          `SELECT id, level, source, event, message, created_at
           FROM system_events
           WHERE level IN ('warn','error')
           ORDER BY created_at DESC LIMIT 8`,
        ),
        readHeartbeat(),
        getQueueSnapshot(),
      ]);

    res.json({
      users: {
        onlineNow: Number(users!.online_now),
        activeToday: Number(users!.active_today),
        activeWeek: Number(users!.active_week),
        activeMonth: Number(users!.active_month),
        total: Number(users!.total),
        newToday: Number(users!.new_today),
        newWeek: Number(users!.new_week),
        suspended: Number(users!.suspended),
        admins: Number(users!.admins),
      },
      orgs: {
        total: Number(orgsAndRepos!.orgs),
        paid: Number(orgsAndRepos!.paid_orgs),
      },
      repos: {
        total: Number(orgsAndRepos!.repos),
        private: Number(orgsAndRepos!.private_repos),
      },
      scans: {
        total: Number(scans!.total),
        today: Number(scans!.today),
        failedToday: Number(scans!.failed_today),
        inFlight: Number(scans!.in_flight),
      },
      events: {
        errorsToday: Number(events!.errors_today),
        warningsToday: Number(events!.warnings_today),
        errorsLastHour: Number(events!.errors_hour),
      },
      queues,
      worker: heartbeat,
      series: series.map((r) => ({
        day: r.day,
        signups: Number(r.signups),
        scans: Number(r.scans),
        scanFailures: Number(r.scan_failures),
        errors: Number(r.errors),
      })),
      recentProblems: recentErrors,
    });
  } catch (err) {
    next(err);
  }
});
