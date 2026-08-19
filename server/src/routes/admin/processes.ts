import { Router } from "express";
import { query } from "../../db/pool.js";
import { badRequest, notFound } from "../../lib/errors.js";
import { getQueueSnapshot, queueByName } from "../../services/queueSnapshot.js";
import { readHeartbeat } from "../../services/workerHeartbeat.js";
import { logAudit } from "../../services/audit.js";

export const adminProcessesRouter = Router();

/** How many failed jobs to surface. Enough to see a pattern, not enough to hang the page. */
const FAILED_SAMPLE = 25;

adminProcessesRouter.get("/processes", async (_req, res, next) => {
  try {
    const [queues, worker, inFlight, recent, failedJobs] = await Promise.all([
      getQueueSnapshot(),
      readHeartbeat(),
      // Everything not yet terminal, oldest first: a scan that has been
      // "cloning" for forty minutes is the one you want at the top.
      query(
        `SELECT s.id, s.status, s.progress, s.trigger, s.branch, s.commit_sha, s.created_at,
                r.full_name AS repo, o.name AS org_name, o.id AS org_id,
                extract(epoch FROM now() - s.created_at)::int AS age_seconds
         FROM scan_jobs s
         JOIN repositories r ON r.id = s.repo_id
         JOIN organizations o ON o.id = s.org_id
         WHERE s.status IN ('pending','cloning','analyzing')
         ORDER BY s.created_at ASC LIMIT 50`,
      ),
      query(
        `SELECT s.id, s.status, s.trigger, s.error_message, s.created_at, s.completed_at,
                extract(epoch FROM s.completed_at - s.created_at)::int AS duration_seconds,
                r.full_name AS repo, o.name AS org_name
         FROM scan_jobs s
         JOIN repositories r ON r.id = s.repo_id
         JOIN organizations o ON o.id = s.org_id
         WHERE s.status IN ('complete','failed')
         ORDER BY s.completed_at DESC NULLS LAST LIMIT 25`,
      ),
      collectFailedJobs(),
    ]);

    // Throughput and reliability over the last day, which is what tells you
    // whether a queue depth of 40 is a backlog or a normal Tuesday.
    const [throughput] = await query<Record<string, string>>(
      `SELECT count(*) AS total,
              count(*) FILTER (WHERE status = 'complete') AS complete,
              count(*) FILTER (WHERE status = 'failed')   AS failed,
              coalesce(round(avg(extract(epoch FROM completed_at - created_at))
                FILTER (WHERE status = 'complete')), 0)   AS avg_seconds,
              coalesce(round(percentile_cont(0.95) WITHIN GROUP (
                ORDER BY extract(epoch FROM completed_at - created_at))
                FILTER (WHERE status = 'complete')), 0)   AS p95_seconds
       FROM scan_jobs WHERE created_at > now() - interval '1 day'`,
    );

    res.json({
      queues,
      worker,
      inFlight,
      recent,
      failedJobs,
      throughput: {
        total: Number(throughput.total),
        complete: Number(throughput.complete),
        failed: Number(throughput.failed),
        avgSeconds: Number(throughput.avg_seconds),
        p95Seconds: Number(throughput.p95_seconds),
      },
    });
  } catch (err) {
    next(err);
  }
});

async function collectFailedJobs() {
  const names = ["scan", "pr-comment", "autofix"];
  const out: {
    queue: string;
    id: string;
    name: string;
    reason: string | null;
    attempts: number;
    failedAt: string | null;
    data: unknown;
  }[] = [];
  for (const name of names) {
    const queue = queueByName(name);
    if (!queue) continue;
    try {
      const jobs = await queue.getFailed(0, FAILED_SAMPLE - 1);
      for (const job of jobs) {
        out.push({
          queue: name,
          id: String(job.id),
          name: job.name,
          reason: job.failedReason ? job.failedReason.slice(0, 500) : null,
          attempts: job.attemptsMade,
          failedAt: job.finishedOn ? new Date(job.finishedOn).toISOString() : null,
          // Job payloads here are ids, not content — safe to show, and the id
          // is what you need to correlate with the scan row.
          data: job.data,
        });
      }
    } catch {
      // Redis unreachable; the queue snapshot already reports it as such.
    }
  }
  return out.sort((a, b) => (b.failedAt ?? "").localeCompare(a.failedAt ?? "")).slice(0, FAILED_SAMPLE);
}

/**
 * Requeues one failed job. This is the single mutating action in the process
 * view, and it is the safe one: BullMQ's retry re-runs an idempotent processor
 * against a scan row that already exists.
 */
adminProcessesRouter.post("/processes/jobs/:queue/:jobId/retry", async (req, res, next) => {
  try {
    const queue = queueByName(req.params.queue);
    if (!queue) throw notFound("Unknown queue");
    const job = await queue.getJob(req.params.jobId);
    if (!job) throw notFound("Job not found");
    const state = await job.getState();
    if (state !== "failed") throw badRequest(`Only failed jobs can be retried (this one is ${state}).`);

    await job.retry();
    await logAudit(null, req.user!.id, "admin.job_retried", `${req.params.queue}:${req.params.jobId}`);
    res.json({ ok: true, queue: req.params.queue, jobId: req.params.jobId });
  } catch (err) {
    next(err);
  }
});
