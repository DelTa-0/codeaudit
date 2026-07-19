import { Router } from "express";
import crypto from "node:crypto";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { notFound, unauthorized } from "../lib/errors.js";
import { logAudit } from "../services/audit.js";
import { config } from "../lib/config.js";

/** Authed management route — admin+ generates the per-repo CLI token. */
export const cliTokenRouter = Router();
cliTokenRouter.use(requireAuth);

cliTokenRouter.post("/repos/:repoId/cli-token", async (req, res, next) => {
  try {
    const repo = await queryOne<{ id: string; org_id: string; cli_token: string | null; role: string }>(
      `SELECT r.id, r.org_id, r.cli_token, m.role FROM repositories r
       JOIN org_members m ON m.org_id = r.org_id AND m.user_id = $2
       WHERE r.id = $1`,
      [req.params.repoId, req.user!.id],
    );
    if (!repo) throw notFound("Repository not found");
    if (repo.role === "developer") throw notFound("Repository not found"); // admin+ only

    let token = repo.cli_token;
    if (!token) {
      token = `ca_${crypto.randomBytes(20).toString("hex")}`;
      await query("UPDATE repositories SET cli_token = $2 WHERE id = $1", [repo.id, token]);
      await logAudit(repo.org_id, req.user!.id, "cli_token.created", repo.id);
    }
    res.json({
      token,
      usage: `CODEAUDIT_TOKEN=${token} npx codeaudit-scan scan . --upload --api ${config.apiUrl}`,
    });
  } catch (err) {
    next(err);
  }
});

/** Public upload route — authed by the per-repo CLI token, not a JWT. */
export const cliUploadRouter = Router();

const uploadLimiter = rateLimit({
  windowMs: 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many uploads. Try again in a minute." },
});

const uploadSchema = z.object({
  token: z.string().min(10).max(100),
  score: z.number().min(0).max(100),
  grade: z.string().max(2),
  counts: z.object({
    phantom: z.number().int().min(0),
    suspicious: z.number().int().min(0),
    unused: z.number().int().min(0),
    healthy: z.number().int().min(0),
    zombies: z.number().int().min(0),
    filesAnalyzed: z.number().int().min(0),
  }),
  branch: z.string().max(200).optional(),
  commitSha: z.string().max(64).optional(),
  dependencies: z
    .array(
      z.object({
        packageName: z.string().max(214),
        declaredVersion: z.string().max(100).nullable(),
        status: z.enum(["phantom", "unused", "healthy", "suspicious"]),
        ecosystem: z.enum(["npm", "pypi"]).default("npm"),
        registryMetadata: z.record(z.string(), z.unknown()).nullable().optional(),
      }),
    )
    .max(500),
  deadCodeCandidates: z
    .array(
      z.object({
        filePath: z.string().max(500),
        lineStart: z.number().int().nullable(),
        lineEnd: z.number().int().nullable(),
        symbolName: z.string().max(200).nullable(),
        findingType: z.string().max(40),
        confidence: z.number().min(0).max(1),
        reasoning: z.string().max(2000),
      }),
    )
    .max(200),
});

cliUploadRouter.post("/cli-scans", uploadLimiter, validateBody(uploadSchema), async (req, res, next) => {
  try {
    const body = req.body as z.infer<typeof uploadSchema>;
    const repo = await queryOne<{ id: string; org_id: string; full_name: string }>(
      "SELECT id, org_id, full_name FROM repositories WHERE cli_token = $1",
      [body.token],
    );
    if (!repo) throw unauthorized("Invalid CLI token");

    const summary = {
      score: body.score,
      grade: body.grade,
      counts: body.counts,
      source: "cli",
    };
    const [scan] = await query<{ id: string }>(
      `INSERT INTO scan_jobs (repo_id, org_id, trigger, branch, commit_sha, status, progress, summary, completed_at)
       VALUES ($1, $2, 'cli', $3, $4, 'complete', 'Complete (uploaded from CLI)', $5, now())
       RETURNING id`,
      [repo.id, repo.org_id, body.branch ?? null, body.commitSha ?? null, JSON.stringify(summary)],
    );

    for (const d of body.dependencies) {
      await query(
        `INSERT INTO dependency_findings (scan_job_id, package_name, ecosystem, declared_version, status, registry_metadata)
         VALUES ($1, $2, $6, $3, $4, $5)`,
        [
          scan.id,
          d.packageName,
          d.declaredVersion,
          d.status,
          d.registryMetadata ? JSON.stringify(d.registryMetadata) : null,
          d.ecosystem,
        ],
      );
    }
    for (const f of body.deadCodeCandidates) {
      await query(
        `INSERT INTO code_findings (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type, confidence_score, llm_reasoning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [scan.id, f.filePath, f.lineStart, f.lineEnd, f.symbolName, f.findingType, f.confidence, f.reasoning],
      );
    }
    await query("UPDATE repositories SET latest_score = $2 WHERE id = $1", [repo.id, body.score]);
    await logAudit(repo.org_id, null, "scan.cli_uploaded", repo.full_name, { scanId: scan.id });

    res.status(201).json({
      ok: true,
      scanId: scan.id,
      url: `${config.appUrl}/scans/${scan.id}`,
    });
  } catch (err) {
    next(err);
  }
});
