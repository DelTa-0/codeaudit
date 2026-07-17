import { Worker } from "bullmq";
import { redisConnection, type ScanJobData } from "./queue/index.js";
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

  const repo = await queryOne<{ full_name: string; private: boolean; default_branch: string }>(
    "SELECT full_name, private, default_branch FROM repositories WHERE id = $1",
    [scan.repo_id],
  );
  if (!repo) throw new Error(`repository for scan ${scanJobId} not found`);

  // M4 adds installation-token clone URLs for private repos.
  const cloneUrl = `https://github.com/${repo.full_name}.git`;

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

process.on("SIGINT", async () => {
  await worker.close();
  process.exit(0);
});
