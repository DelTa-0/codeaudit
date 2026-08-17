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
  warnIfGithubAppMisconfigured,
} from "./services/github.js";
import { query, queryOne } from "./db/pool.js";
import { cloneRepoSandboxed, cleanupScanDir } from "./analysis/clone.js";
import { computeAiAuthorship } from "./analysis/aiAuthorship.js";
import { listTrackedFiles } from "./analysis/trackedFiles.js";
import { scanHistorySecrets } from "./analysis/historySecrets.js";
import {
  parseManifest,
  analyzeRepo,
  checkDependencies,
  findDeadCodeCandidates,
  computeSummary,
  detectEcosystems,
  parsePythonManifest,
  analyzePythonRepo,
  checkPythonDependencies,
  checkVulnerabilities,
  applyVulnerabilities,
  collectVulnTargets,
  resolveNpmTree,
  resolvePythonTree,
  findDuplicateLibraries,
  readProjectLicense,
  checkLicenseConflicts,
  rankFindings,
  findSecrets,
  findAgentConfigIssues,
  findMcpPackageRefs,
  verifyAgentConfigPackages,
  type DependencyVerdict,
  type DeadCodeCandidate,
  type ResolvedTree,
  type SecretFinding,
  type AgentConfigFinding,
} from "@codeaudit/engine";
import { reviewCandidatesWithLlm, suggestAlternatives } from "@codeaudit/engine";
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

    const ecosystems = detectEcosystems(dir);
    await setStatus(
      scanJobId,
      "analyzing",
      `Parsing source files (${ecosystems.join(" + ") || "no ecosystems detected"})`,
    );

    const deps: DependencyVerdict[] = [];
    const allCandidates: DeadCodeCandidate[] = [];
    // Merged per-file import context for the LLM across both analyzers.
    const mergedFileImportExports = new Map<string, string[]>();
    let fileCount = 0;

    let npmTree: ResolvedTree | null = null;
    let pyTree: ResolvedTree | null = null;

    if (ecosystems.includes("npm")) {
      const manifest = parseManifest(dir);
      const analysis = analyzeRepo(dir);
      npmTree = resolveNpmTree(dir);
      fileCount += analysis.fileCount;
      await setStatus(scanJobId, "analyzing", "Verifying dependencies against the npm registry");
      if (manifest)
        deps.push(
          ...(await checkDependencies(dir, manifest, analysis.importedPackages, {
            transitivelyRequired: npmTree?.transitivelyRequired,
          })),
        );
      allCandidates.push(...findDeadCodeCandidates(analysis));
      for (const [k, v] of analysis.fileImportExports) mergedFileImportExports.set(k, v);
    }

    if (ecosystems.includes("pypi")) {
      const pyManifest = parsePythonManifest(dir);
      const pyAnalysis = analyzePythonRepo(dir);
      pyTree = resolvePythonTree(dir);
      fileCount += pyAnalysis.fileCount;
      await setStatus(scanJobId, "analyzing", "Verifying dependencies against the PyPI registry");
      deps.push(
        ...(await checkPythonDependencies(dir, pyManifest, pyAnalysis.importedPackages, {
          transitivelyRequired: pyTree?.transitivelyRequired,
        })),
      );
      allCandidates.push(...findDeadCodeCandidates(pyAnalysis));
      for (const [k, v] of pyAnalysis.fileImportExports) mergedFileImportExports.set(k, v);
    }

    // Known-vulnerability lookup (OSV) — exact lockfile versions where we have
    // them (declared + transitive), coerced declared ranges otherwise. Attaches
    // CVE advisories and upgrades/adds "vulnerable" verdicts. Never throws.
    const vulnTargets = collectVulnTargets(deps, [
      { ecosystem: "npm", tree: npmTree },
      { ecosystem: "pypi", tree: pyTree },
    ]);
    if (vulnTargets.length) {
      await setStatus(scanJobId, "analyzing", "Checking dependencies against the OSV vulnerability database");
      applyVulnerabilities(deps, await checkVulnerabilities(vulnTargets));
    }

    // "Did you mean X?" for phantom packages the offline fuzzy match (in
    // registry.ts/python/registry.ts) couldn't pair with a spelling neighbor
    // — ask the LLM to infer intent from the name instead (e.g. "fastimagepro"
    // -> Pillow). Best-effort: skipped entirely when no LLM is configured.
    const phantomsNeedingAiSuggestion = deps.filter(
      (d) => d.status === "phantom" && !(d.registryMetadata as { alternatives?: unknown } | null)?.alternatives,
    );
    if (phantomsNeedingAiSuggestion.length && config.llm.apiKey) {
      await setStatus(scanJobId, "analyzing", "Looking for alternatives to non-existent packages");
      const aiSuggestions = await suggestAlternatives(
        phantomsNeedingAiSuggestion.map((d) => ({ packageName: d.packageName, ecosystem: d.ecosystem })),
        { apiKey: config.llm.apiKey, baseUrl: config.llm.baseUrl, model: config.llm.model },
      );
      for (const d of phantomsNeedingAiSuggestion) {
        const alternatives = aiSuggestions.get(d.packageName);
        if (alternatives?.length) d.registryMetadata = { ...(d.registryMetadata ?? {}), alternatives };
      }
    }

    for (const d of deps) {
      await query(
        `INSERT INTO dependency_findings
           (scan_job_id, package_name, ecosystem, declared_version, status, registry_metadata)
         VALUES ($1, $2, $3, $4, $5, $6)`,
        [
          scanJobId,
          d.packageName,
          d.ecosystem,
          d.declaredVersion,
          d.status,
          d.registryMetadata ? JSON.stringify(d.registryMetadata) : null,
        ],
      );
    }

    await setStatus(scanJobId, "analyzing", "Reviewing dead-code candidates");
    const { findings: zombies, reviewStatus } = await reviewCandidatesWithLlm(
      allCandidates,
      { fileImportExports: mergedFileImportExports },
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

    // Deliberately after the LLM pass and never part of its input: that call
    // already receives raw source in each candidate's `body`, and secrets must
    // not widen what leaves the machine. Persisted redacted — the raw value is
    // never written to the database.
    let secrets: ReturnType<typeof findSecrets> = [];
    try {
      const trackedFiles = await listTrackedFiles(dir);
      secrets = trackedFiles
        ? findSecrets(dir, { isTracked: (p) => trackedFiles.has(p) })
        : findSecrets(dir);
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] secret scan failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    for (const s of secrets) {
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning, detail)
         VALUES ($1, $2, $3, $3, $4, 'hardcoded_secret', 1.0, $5, $6)`,
        [
          scanJobId,
          s.filePath,
          s.line,
          s.provider,
          `A ${s.provider} appears to be hardcoded here. Rotate it, then move it to an environment variable.`,
          JSON.stringify({
            provider: s.provider,
            redacted: s.redacted,
            fingerprint: s.fingerprint,
            tier: s.tier,
          }),
        ],
      );
    }

    // Secrets that are gone from HEAD but still recoverable from git objects.
    // The recommendation differs fundamentally: you cannot fix these by
    // editing a file, only by rotating the credential.
    let historySecrets: SecretFinding[] = [];
    try {
      historySecrets = await scanHistorySecrets(dir, new Set(secrets.map((s) => s.fingerprint)));
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] history secret scan failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    for (const s of historySecrets) {
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning, detail)
         VALUES ($1, $2, $3, $3, $4, 'hardcoded_secret_history', 1.0, $5, $6)`,
        [
          scanJobId,
          s.filePath,
          s.line,
          s.provider,
          `A ${s.provider} was committed here and later removed. It is still recoverable from git history — rotate the credential; deleting the file does not revoke it.`,
          JSON.stringify({
            provider: s.provider,
            redacted: s.redacted,
            fingerprint: s.fingerprint,
            tier: s.tier,
            removedFromHead: true,
            firstSeenCommit: s.firstSeenCommit,
            lastSeenCommit: s.lastSeenCommit,
          }),
        ],
      );
    }

    // Agent-config auditing: prompt injection and unsafe MCP/permission
    // config in files the AI agent itself trusts as instructions. Placed
    // after the LLM review pass for the same reason as secrets, only more
    // so — these files contain text engineered specifically to hijack an
    // LLM, so this must never become the channel that feeds a poisoned
    // CLAUDE.md into that call. Two separate try/catches: a sync,
    // registry-free detector and a network-dependent MCP-package check, so
    // one failing (e.g. registry unreachable) never discards the other.
    let agentConfigFindings: AgentConfigFinding[] = [];
    try {
      agentConfigFindings = findAgentConfigIssues(dir);
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] agent-config scan failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    try {
      const mcpRefs = findMcpPackageRefs(dir);
      if (mcpRefs.length) {
        agentConfigFindings = [...agentConfigFindings, ...(await verifyAgentConfigPackages(mcpRefs))];
      }
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] MCP package verification failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    for (const f of agentConfigFindings) {
      const findingType =
        f.category === "dangerous_agent_config" || f.category === "unverified_mcp_package"
          ? "agent_config_risk"
          : "agent_instruction_injection";
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning, detail)
         VALUES ($1, $2, $3, $3, $4, $5, $6, $7, $8)`,
        [
          scanJobId,
          f.filePath,
          f.line,
          f.rule,
          findingType,
          f.tier === 1 ? 1.0 : 0.7,
          f.message,
          JSON.stringify({
            category: f.category,
            rule: f.rule,
            severity: f.severity,
            tier: f.tier,
            surface: f.surface,
            evidence: f.evidence,
          }),
        ],
      );
    }

    await setStatus(scanJobId, "analyzing", "Attributing AI-assisted code");
    const aiStats = await computeAiAuthorship(dir, zombies);

    // These now feed the score (v2 — see packages/engine/src/score.ts), on
    // their own axes rather than a shared additive budget, which is what made
    // scoring them safe. They must still be computed before the summary.
    // Best-effort, matching analysis/aiAuthorship.ts: advisory extras must
    // never be able to fail a scan that would otherwise have succeeded. A
    // failure here means the advisory data is absent, not that the scan broke.
    let duplicates: ReturnType<typeof findDuplicateLibraries> = [];
    let licenseConflicts: ReturnType<typeof checkLicenseConflicts> = [];
    let priorities: ReturnType<typeof rankFindings> = [];
    try {
      duplicates = findDuplicateLibraries(deps);
      licenseConflicts = checkLicenseConflicts(deps, readProjectLicense(dir));
      priorities = rankFindings({
        deps,
        codeFindings: zombies,
        duplicates,
        licenseConflicts,
        secrets: [...secrets, ...historySecrets],
        agentConfig: agentConfigFindings,
      });
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] advisory analysis failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    const summary = {
      ...computeSummary({
        deps,
        zombies,
        filesAnalyzed: fileCount,
        reviewStatus,
        secretCount: secrets.length + historySecrets.length,
        agentConfig: agentConfigFindings,
        duplicateCount: duplicates.length,
        licenseConflictCount: licenseConflicts.length,
      }),
      ai: aiStats,
      priorities,
      advisories: { duplicates, licenseConflicts },
    };
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
      `[scan ${scanJobId}] ${repo.full_name} complete — score ${summary.score} (${summary.counts.secrets ?? 0} secrets, ${summary.counts.agentConfig ?? 0} agent-config, ${summary.counts.phantom} phantom, ${summary.counts.unused} unused, ${zombies.length} zombies)`,
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
          summary: `| Finding | Count |\n| --- | --- |\n| 🔑 Hardcoded secrets | ${summary.counts.secrets ?? 0} |\n| 🤖 Agent config risks | ${summary.counts.agentConfig ?? 0} |\n| Phantom dependencies | ${summary.counts.phantom} |\n| Suspicious packages | ${summary.counts.suspicious} |\n| Unused dependencies | ${summary.counts.unused} |\n| Zombie code | ${summary.counts.zombies} |\n\nAutomated analysis — verify before acting. Configure or disable this check in CodeAudit repo settings.`,
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

warnIfGithubAppMisconfigured();

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

// SIGTERM is what actually arrives in production — Docker, ECS and Render all
// send it on stop, and only SIGINT was handled, so every deploy killed the
// in-flight scan instead of letting BullMQ release it back to the queue.
// SIGINT is kept for Ctrl-C in local dev.
async function shutdown(signal: string) {
  console.log(`${signal} received, draining workers…`);
  await Promise.all([worker.close(), prCommentWorker.close(), autofixWorker.close()]);
  process.exit(0);
}

process.on("SIGINT", () => void shutdown("SIGINT"));
process.on("SIGTERM", () => void shutdown("SIGTERM"));
