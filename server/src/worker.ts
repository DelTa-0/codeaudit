import { Worker } from "bullmq";
import {
  redisConnection,
  prCommentQueue,
  type ScanJobData,
  type PrCommentJobData,
  type AutofixJobData,
} from "./queue/index.js";
import { processPrCommentJob } from "./queue/prComment.js";
import { processAutofixJob } from "./queue/autofix.js";
import {
  getInstallationToken,
  authenticatedCloneUrl,
  githubConfigured,
  createCheckRun,
} from "./services/github.js";
import { query, queryOne } from "./db/pool.js";
import { cloneRepoSandboxed, cleanupScanDir } from "./analysis/clone.js";
import { computeAiAuthorship } from "./analysis/aiAuthorship.js";
import {
  parseManifest,
  analyzeRepo,
  checkDependencies,
  findDeadCodeCandidates,
  reviewCandidatesWithLlm,
  computeSummary,
} from "@codeaudit/engine";
import { config } from "./lib/config.js";

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
    commit_sha: string | null;
    trigger: string;
  }>("SELECT * FROM scan_jobs WHERE id = $1", [scanJobId]);
  if (!scan) throw new Error(`scan_job ${scanJobId} not found`);

  const repo = await queryOne<{
    full_name: string;
    private: boolean;
    default_branch: string;
    installation_id: string | null;
    gate_enabled: boolean;
    min_score: string | null;
  }>(
    `SELECT r.full_name, r.private, r.default_branch, r.gate_enabled, r.min_score,
            gi.installation_id
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
    const zombies = await reviewCandidatesWithLlm(
      candidates,
      analysis,
      config.llm.apiKey
        ? { apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl, model: config.llm.model }
        : undefined,
    );
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

    await setStatus(scanJobId, "analyzing", "Attributing AI-assisted code");
    const aiStats = await computeAiAuthorship(dir, zombies);

    const summary = { ...computeSummary(deps, zombies, analysis.fileCount), ai: aiStats };
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

    // Merge gate: only when the repo owner opted in, and only reports —
    // blocking is the owner's branch-protection choice on GitHub.
    if (
      repo.gate_enabled &&
      repo.installation_id &&
      scan.commit_sha &&
      githubConfigured()
    ) {
      const threshold = repo.min_score !== null ? Number(repo.min_score) : 0;
      const passed = summary.score >= threshold;
      try {
        await createCheckRun(Number(repo.installation_id), repo.full_name, scan.commit_sha, {
          conclusion: passed ? "success" : "failure",
          title: `Score ${summary.score} (${summary.grade}) — threshold ${threshold}`,
          summary: `| Finding | Count |\n| --- | --- |\n| Phantom dependencies | ${summary.counts.phantom} |\n| Suspicious packages | ${summary.counts.suspicious} |\n| Unused dependencies | ${summary.counts.unused} |\n| Zombie code | ${summary.counts.zombies} |\n\nAutomated analysis — verify before acting. Configure or disable this check in CodeAudit repo settings.`,
        });
        console.log(`[gate] check run posted for ${repo.full_name}@${scan.commit_sha.slice(0, 7)}: ${passed ? "success" : "failure"}`);
      } catch (err) {
        console.error(`[gate] check run failed for ${repo.full_name} (does the App have Checks write permission?)`, err);
      }
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    await query(
      `UPDATE scan_jobs SET status = 'failed', progress = 'Failed',
         error_message = $2, completed_at = now() WHERE id = $1`,
      [scanJobId, message.slice(0, 1000)],
    );
    console.error(`[scan ${scanJobId}] failed:`, err);

    // A failed scan never blocks anyone's merge — report neutral if gated.
    if (repo.gate_enabled && repo.installation_id && scan.commit_sha && githubConfigured()) {
      try {
        await createCheckRun(Number(repo.installation_id), repo.full_name, scan.commit_sha, {
          conclusion: "neutral",
          title: "Scan failed — no verdict",
          summary: `The CodeAudit scan could not complete (${message.slice(0, 200)}). This check is neutral so it never blocks your merge on our failure.`,
        });
      } catch (checkErr) {
        console.error(`[gate] neutral check failed for ${repo.full_name}`, checkErr);
      }
    }
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

const autofixWorker = new Worker<AutofixJobData>(
  "autofix",
  async (job) => processAutofixJob(job.data.scanJobId, job.data.requestedBy),
  { connection: redisConnection, concurrency: 1 },
);
autofixWorker.on("failed", (job, err) => console.error(`autofix ${job?.id} failed`, err));

process.on("SIGINT", async () => {
  await Promise.all([worker.close(), prCommentWorker.close(), autofixWorker.close()]);
  process.exit(0);
});
