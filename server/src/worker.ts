import { Worker } from "bullmq";
import {
  redisConnection,
  prCommentQueue,
  type ScanJobData,
  type PrCommentJobData,
} from "./queue/index.js";
import { processPrCommentJob } from "./queue/prComment.js";
import { getInstallationToken, authenticatedCloneUrl, githubConfigured } from "./services/github.js";
import { query, queryOne } from "./db/pool.js";
import { cloneRepoSandboxed, cleanupScanDir } from "./analysis/clone.js";
import { parseManifest } from "./analysis/manifest.js";
import { analyzeRepo } from "./analysis/imports.js";
import { checkDependencies } from "./analysis/registry.js";
import { findDeadCodeCandidates } from "./analysis/deadcode.js";
import { reviewCandidatesWithLlm } from "./analysis/llm.js";
import { computeSummary } from "./analysis/score.js";

async function setStatus(scanJobId: string, status: string, progress: string) {
  await query("UPDATE scan_jobs SET status = $2, progress = $3 WHERE id = $1", [
    scanJobId,
    status,
    progress,
  ]);
}

async function processScanJob(scanJobId: string) {
  const scan = await queryOne<{
    id: string;
    repo_id: string;
    org_id: string;
    branch: string | null;
    trigger: string;
  }>("SELECT * FROM scan_jobs WHERE id = $1", [scanJobId]);
  if (!scan) throw new Error(`scan_job ${scanJobId} not found`);

  const repo = await queryOne<{
    full_name: string;
    private: boolean;
    default_branch: string;
    installation_id: string | null;
  }>(
    `SELECT r.full_name, r.private, r.default_branch, gi.installation_id
     FROM repositories r LEFT JOIN github_installations gi ON gi.id = r.installation_id
     WHERE r.id = $1`,
    [scan.repo_id],
  );
  if (!repo) throw new Error(`repository for scan ${scanJobId} not found`);

  let cloneUrl = `https://github.com/${repo.full_name}.git`;
  if (repo.private) {
    if (!repo.installation_id || !githubConfigured())
      throw new Error("Private repository requires a linked GitHub App installation");
    const token = await getInstallationToken(Number(repo.installation_id));
    cloneUrl = authenticatedCloneUrl(repo.full_name, token);
  }

  try {
    await setStatus(scanJobId, "cloning", "Cloning repository");
    const dir = await cloneRepoSandboxed(cloneUrl, scanJobId, scan.branch ?? undefined);

    await setStatus(scanJobId, "analyzing", "Parsing source files");
    const manifest = parseManifest(dir);
    const analysis = analyzeRepo(dir);

    await setStatus(scanJobId, "analyzing", "Verifying dependencies against npm registry");
    const deps = manifest
      ? await checkDependencies(manifest, analysis.importedPackages)
      : [];
    for (const d of deps) {
      await query(
        `INSERT INTO dependency_findings
           (scan_job_id, package_name, ecosystem, declared_version, status, registry_metadata)
         VALUES ($1, $2, 'npm', $3, $4, $5)`,
        [
          scanJobId,
          d.packageName,
          d.declaredVersion,
          d.status,
          d.registryMetadata ? JSON.stringify(d.registryMetadata) : null,
        ],
      );
    }

    await setStatus(scanJobId, "analyzing", "Reviewing dead-code candidates");
    const candidates = findDeadCodeCandidates(analysis);
    const zombies = await reviewCandidatesWithLlm(candidates, analysis);
    for (const z of zombies) {
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
        [
          scanJobId,
          z.filePath,
          z.lineStart,
          z.lineEnd,
          z.symbolName,
          z.findingType,
          z.confidence,
          z.reasoning,
        ],
      );
    }

    const summary = computeSummary(deps, zombies, analysis.fileCount);
    await query(
      `UPDATE scan_jobs SET status = 'complete', progress = 'Complete',
         summary = $2, completed_at = now() WHERE id = $1`,
      [scanJobId, JSON.stringify(summary)],
    );
    await query("UPDATE repositories SET latest_score = $2 WHERE id = $1", [
      scan.repo_id,
      summary.score,
    ]);
    console.log(
      `[scan ${scanJobId}] ${repo.full_name} complete — score ${summary.score} (${summary.counts.phantom} phantom, ${summary.counts.unused} unused, ${zombies.length} zombies)`,
    );

    const scanRow = await queryOne<{ pr_number: number | null }>(
      "SELECT pr_number FROM scan_jobs WHERE id = $1",
      [scanJobId],
    );
    if (scanRow?.pr_number) await prCommentQueue.add("pr-comment", { scanJobId });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE scan_jobs SET status = 'failed', progress = 'Failed',
         error_message = $2, completed_at = now() WHERE id = $1`,
      [scanJobId, message.slice(0, 1000)],
    );
    console.error(`[scan ${scanJobId}] failed:`, err);
  } finally {
    cleanupScanDir(scanJobId);
  }
}

const worker = new Worker<ScanJobData>(
  "scan",
  async (job) => processScanJob(job.data.scanJobId),
  { connection: redisConnection, concurrency: 2 },
);

worker.on("ready", () => console.log("Scan worker ready"));
worker.on("failed", (job, err) => console.error(`job ${job?.id} failed`, err));

const prCommentWorker = new Worker<PrCommentJobData>(
  "pr-comment",
  async (job) => processPrCommentJob(job.data.scanJobId),
  { connection: redisConnection, concurrency: 2 },
);
prCommentWorker.on("failed", (job, err) => console.error(`pr-comment ${job?.id} failed`, err));

process.on("SIGINT", async () => {
  await Promise.all([worker.close(), prCommentWorker.close()]);
  process.exit(0);
});
