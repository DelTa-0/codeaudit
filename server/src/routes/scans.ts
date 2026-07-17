import { Router } from "express";
import rateLimit from "express-rate-limit";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { forbidden, notFound } from "../lib/errors.js";
import { assertCanScan } from "../services/plans.js";
import { scanQueue } from "../queue/index.js";
import { logAudit } from "../services/audit.js";

export const scansRouter = Router();
scansRouter.use(requireAuth);

const scanCreateLimiter = rateLimit({
  windowMs: 60_000,
  limit: 5,
  standardHeaders: true,
  legacyHeaders: false,
  keyGenerator: (req) => req.user?.id ?? req.ip ?? "anon",
  message: { error: "Too many scan requests. Try again in a minute." },
});

/** Membership-scoped repo lookup — the tenant-isolation gate for all scan routes. */
async function getRepoForUser(repoId: string, userId: string) {
  return queryOne<{ id: string; org_id: string; full_name: string; role: string }>(
    `SELECT r.id, r.org_id, r.full_name, m.role FROM repositories r
     JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
     WHERE r.id = $1`,
    [repoId, userId],
  );
}

async function getScanForUser(scanId: string, userId: string) {
  return queryOne<{ id: string; org_id: string; repo_id: string; role: string; status: string }>(
    `SELECT s.*, m.role FROM scan_jobs s
     JOIN org_members m ON m.org_id = s.org_id AND m.user_id = $2
     WHERE s.id = $1`,
    [scanId, userId],
  );
}

scansRouter.post("/repos/:repoId/scans", scanCreateLimiter, async (req, res, next) => {
  try {
    const repo = await getRepoForUser(req.params.repoId, req.user!.id);
    if (!repo) throw notFound("Repository not found");
    await assertCanScan(repo.org_id, "manual");
    const [scan] = await query<{ id: string }>(
      `INSERT INTO scan_jobs (repo_id, org_id, requested_by, trigger)
       VALUES ($1, $2, $3, 'manual') RETURNING id, status, created_at`,
      [repo.id, repo.org_id, req.user!.id],
    );
    await scanQueue.add("scan", { scanJobId: scan.id });
    await logAudit(repo.org_id, req.user!.id, "scan.requested", repo.full_name);
    res.status(201).json(scan);
  } catch (err) {
    next(err);
  }
});

scansRouter.get("/repos/:repoId/scans", async (req, res, next) => {
  try {
    const repo = await getRepoForUser(req.params.repoId, req.user!.id);
    if (!repo) throw notFound("Repository not found");
    const scans = await query(
      `SELECT id, trigger, branch, commit_sha, pr_number, status, progress, summary, error_message,
              created_at, completed_at
       FROM scan_jobs WHERE repo_id = $1 ORDER BY created_at DESC LIMIT 50`,
      [repo.id],
    );
    res.json(scans);
  } catch (err) {
    next(err);
  }
});

scansRouter.get("/scans/:scanId", async (req, res, next) => {
  try {
    const scan = await getScanForUser(req.params.scanId, req.user!.id);
    if (!scan) throw notFound("Scan not found");
    const { role, ...rest } = scan;
    res.json(rest);
  } catch (err) {
    next(err);
  }
});

scansRouter.get("/scans/:scanId/dependencies", async (req, res, next) => {
  try {
    const scan = await getScanForUser(req.params.scanId, req.user!.id);
    if (!scan) throw notFound("Scan not found");
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Number(req.query.per_page) || 50);
    const rows = await query(
      `SELECT id, package_name, ecosystem, declared_version, status, registry_metadata
       FROM dependency_findings WHERE scan_job_id = $1
       ORDER BY CASE status WHEN 'phantom' THEN 0 WHEN 'suspicious' THEN 1 WHEN 'unused' THEN 2 ELSE 3 END,
                package_name
       LIMIT $2 OFFSET $3`,
      [scan.id, perPage, (page - 1) * perPage],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

scansRouter.get("/scans/:scanId/code-findings", async (req, res, next) => {
  try {
    const scan = await getScanForUser(req.params.scanId, req.user!.id);
    if (!scan) throw notFound("Scan not found");
    const page = Math.max(1, Number(req.query.page) || 1);
    const perPage = Math.min(100, Number(req.query.per_page) || 50);
    const rows = await query(
      `SELECT id, file_path, line_start, line_end, symbol_name, finding_type,
              confidence_score, llm_reasoning
       FROM code_findings WHERE scan_job_id = $1
       ORDER BY confidence_score DESC NULLS LAST, file_path
       LIMIT $2 OFFSET $3`,
      [scan.id, perPage, (page - 1) * perPage],
    );
    res.json(rows);
  } catch (err) {
    next(err);
  }
});

scansRouter.delete("/scans/:scanId", async (req, res, next) => {
  try {
    const scan = await getScanForUser(req.params.scanId, req.user!.id);
    if (!scan) throw notFound("Scan not found");
    if (scan.role === "developer") throw forbidden("Requires admin role");
    await query("DELETE FROM scan_jobs WHERE id = $1", [scan.id]);
    await logAudit(scan.org_id, req.user!.id, "scan.deleted", scan.id);
    res.json({ ok: true });
  } catch (err) {
    next(err);
  }
});
