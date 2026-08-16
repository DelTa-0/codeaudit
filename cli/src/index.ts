#!/usr/bin/env node
// CodeAudit CLI — static scan of a local directory, with static analysis by
// default and LLM-backed dead-code review available via BYOK (--key/--url/
// --model or GROQ_API_KEY/OPENAI_API_KEY/CODEAUDIT_LLM_KEY).
// Deliberately limited: no scan history, no PR integration — those live in
// the CodeAudit platform.
import path from "node:path";
import fs from "node:fs";
import { execFileSync } from "node:child_process";
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
  reviewCandidatesWithLlm,
  suggestAlternatives,
  type DependencyVerdict,
  type DeadCodeCandidate,
  type ReviewedFinding,
  type ResolvedTree,
  type RankedFinding,
  type DuplicateGroup,
  type LicenseConflict,
  type SecretFinding,
  type AgentConfigFinding,
} from "@codeaudit/engine";
import { resolveLlmConfig, type LlmFlags } from "./llmConfig.js";
import { scanStaged, isGitRepo } from "./staged.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

/** Where the hosted dashboard actually lives. Referenced in the scan footer. */
const DASHBOARD_URL = "codeaudit.madhavaryal.info.np";
const DEFAULT_API_URL = `https://${DASHBOARD_URL}`;

function usage(): never {
  console.log(`Usage: codeorion scan [dir] [options]

Scans for hallucinated dependencies, leaked secrets, poisoned agent configs and
dead code. Runs locally; no account required.

Copy-paste examples (identical in bash, zsh, PowerShell and cmd):

  npx codeorion scan .
      Scan this directory.

  npx codeorion scan . --key gsk_YOUR_KEY
      Add real LLM review of dead-code candidates. A Groq key (gsk_…) or an
      OpenAI key (sk-…) needs nothing else — the endpoint is inferred.

  npx codeorion scan . --upload --token ca_YOUR_TOKEN
      Send the result to your dashboard. The token is per repository; copy it
      from that repo's page. Uploads to ${DEFAULT_API_URL}
      unless you pass --api.

  npx codeorion scan . --min-score 80 --json
      CI gate: machine-readable output, exit 1 below the threshold.

  npx codeorion scan --staged
      Pre-commit mode: check only what is staged for commit. Seconds, not
      minutes — secrets, poisoned agent configs, and dependencies this
      commit adds. See --staged below.

Options:
  --staged        scan staged content only, for use as a git pre-commit hook
  --json          machine-readable output (for CI)
  --min-score N   exit 1 if the score is below N
  --upload        send results to your dashboard (requires --token)
  --token T       per-repo CLI token (or set CODEAUDIT_TOKEN)
  --api URL       API base URL (or set CODEAUDIT_API_URL)
                  default: ${DEFAULT_API_URL}
  --key K         your LLM key for dead-code review (or set GROQ_API_KEY /
                  OPENAI_API_KEY / CODEAUDIT_LLM_KEY)
  --url URL       OpenAI-compatible base URL — only needed for a provider
                  other than Groq or OpenAI (or set CODEAUDIT_LLM_URL)
  --model M       model name (or set CODEAUDIT_LLM_MODEL). Required with a
                  custom --url; optional otherwise
  -h, --help      show this help

Without a key the scan still runs — dead-code candidates are static-only, with
a fixed confidence and no LLM verdict.

--staged is a deliberately narrow scan of the staged content itself (not the
working tree, which can differ). It reports secrets, agent-config poisoning
and newly added dependencies, and skips dead code and license checks: those
need whole-repo context and are not urgent at the commit boundary. Install it
as a hook with:

  npx codeorion install-hook

"git commit --no-verify" bypasses it, as with any hook.

Note: flags work in every shell. The VAR=value prefix used in many examples is
bash/zsh only; in PowerShell set it first, e.g. $env:GROQ_API_KEY="gsk_…".

Exit codes: 0 ok · 1 phantom deps found or score below --min-score · 2 usage/error`);
  process.exit(2);
}

interface CliArgs {
  dir: string;
  json: boolean;
  staged: boolean;
  minScore: number | null;
  upload: boolean;
  token: string | null;
  apiUrl: string;
  llmFlags: LlmFlags;
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command === "install-hook") installHook(); // never returns
  if (command !== "scan" || args.includes("-h") || args.includes("--help")) usage();

  let dir = ".";
  let json = false;
  let staged = false;
  let minScore: number | null = null;
  let upload = false;
  let token: string | null = process.env.CODEAUDIT_TOKEN ?? null;
  // Defaults to the hosted API, not localhost. A published CLI defaulting to
  // http://localhost:4000 meant `--upload` without `--api` posted to a port on
  // the user's own machine with nothing listening, and the upload just failed.
  let apiUrl = process.env.CODEAUDIT_API_URL ?? DEFAULT_API_URL;
  let key: string | null = null;
  let url: string | null = null;
  let model: string | null = null;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
    else if (arg === "--staged") staged = true;
    else if (arg === "--upload") upload = true;
    else if (arg === "--token") token = args.shift() ?? null;
    else if (arg === "--api") apiUrl = args.shift() ?? apiUrl;
    else if (arg === "--key") key = args.shift() ?? null;
    else if (arg === "--url") url = args.shift() ?? null;
    else if (arg === "--model") model = args.shift() ?? null;
    else if (arg === "--min-score") {
      const value = Number(args.shift());
      if (!Number.isFinite(value)) usage();
      minScore = value;
    } else if (!arg.startsWith("-")) dir = arg;
    else usage();
  }
  return { dir: path.resolve(dir), json, staged, minScore, upload, token, apiUrl, llmFlags: { key, url, model } };
}

/**
 * Writes .git/hooks/pre-commit. Refuses to clobber an existing hook — someone
 * else's hook is not ours to overwrite, and silently replacing it would
 * disable whatever checks that project already relies on.
 */
function installHook(): never {
  let hooksDir: string;
  try {
    hooksDir = path.join(
      execFileSync("git", ["rev-parse", "--git-dir"], { encoding: "utf8" }).trim(),
      "hooks",
    );
  } catch {
    console.error("codeorion: not a git repository — run this from inside one.");
    process.exit(2);
  }
  const hookPath = path.join(hooksDir, "pre-commit");
  if (fs.existsSync(hookPath)) {
    const existing = fs.readFileSync(hookPath, "utf8");
    if (existing.includes("codeorion scan --staged")) {
      console.log(`codeorion: hook already installed at ${hookPath}`);
      process.exit(0);
    }
    console.error(
      `codeorion: ${hookPath} already exists and is not ours — not overwriting.\n` +
        `Add this line to it yourself:\n\n  npx codeorion scan --staged || exit 1\n`,
    );
    process.exit(2);
  }
  fs.mkdirSync(hooksDir, { recursive: true });
  fs.writeFileSync(
    hookPath,
    `#!/bin/sh\n# Installed by \`codeorion install-hook\`. Bypass once with \`git commit --no-verify\`.\nnpx codeorion scan --staged || exit 1\n`,
  );
  // No-op on Windows, required everywhere else.
  try {
    fs.chmodSync(hookPath, 0o755);
  } catch {
    /* best effort */
  }
  console.log(`codeorion: installed pre-commit hook at ${hookPath}`);
  process.exit(0);
}

async function uploadResults(
  apiUrl: string,
  token: string,
  summary: { score: number; grade: string; counts: Record<string, number> },
  deps: unknown[],
  candidates: ReviewedFinding[],
  priorities: RankedFinding[],
  advisories: { duplicates: DuplicateGroup[]; licenseConflicts: LicenseConflict[] },
  reviewStatus: "full" | "partial" | "skipped",
): Promise<{ ok: boolean; url?: string; error?: string }> {
  try {
    const res = await fetch(`${apiUrl.replace(/\/$/, "")}/api/cli-scans`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        token,
        score: summary.score,
        grade: summary.grade,
        counts: summary.counts,
        reviewStatus,
        // Present only when review actually happened — an older server that
        // doesn't know this field ignores it (see uploadSchema in
        // server/src/routes/cliScans.ts, which makes both fields optional).
        ...(reviewStatus !== "skipped" ? { llmReviewSource: "cli-byok" as const } : {}),
        dependencies: (deps as {
          packageName: string;
          declaredVersion: string | null;
          status: string;
          registryMetadata: Record<string, unknown> | null;
        }[]).slice(0, 500),
        deadCodeCandidates: candidates.slice(0, 200).map((c) => ({
          filePath: c.filePath,
          lineStart: c.lineStart,
          lineEnd: c.lineEnd,
          symbolName: c.symbolName,
          findingType: c.findingType,
          confidence: c.confidence,
          reasoning: c.reasoning,
        })),
        priorities: priorities.slice(0, 20),
        advisories: {
          duplicates: advisories.duplicates.slice(0, 50),
          licenseConflicts: advisories.licenseConflicts.slice(0, 50),
        },
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const data = (await res.json().catch(() => ({}))) as { url?: string; error?: string };
    if (!res.ok) return { ok: false, error: data.error ?? `upload failed (${res.status})` };
    return { ok: true, url: data.url };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : "upload failed" };
  }
}

const statusColor: Record<string, string> = {
  phantom: RED,
  vulnerable: RED,
  suspicious: YELLOW,
  unused: YELLOW,
  healthy: GREEN,
};

/**
 * Pre-commit output. Separate from the full-scan renderer on purpose: at a
 * commit prompt the only useful information is what is blocking and where,
 * and a scan that finds nothing should say so in one line rather than
 * printing a report nobody reads on every commit.
 */
async function runStaged(json: boolean): Promise<never> {
  if (!isGitRepo()) {
    console.error("codeorion: --staged needs a git repository.");
    process.exit(2);
  }
  const report = await scanStaged();
  const blocking =
    report.secrets.length +
    report.agentConfig.filter((f) => f.severity === "critical" || f.severity === "high").length +
    report.newDependencies.filter((d) => d.status === "phantom" || d.status === "vulnerable").length;
  const exitCode = blocking > 0 ? 1 : 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          staged: true,
          fileCount: report.fileCount,
          // `fingerprint` is dedup-internal and never leaves the process — same
          // rule as the full scan's JSON output.
          secrets: report.secrets.map(({ fingerprint: _fingerprint, ...s }) => s),
          agentConfig: report.agentConfig,
          newDependencies: report.newDependencies,
          dependenciesNotChecked: report.dependenciesNotChecked,
          blocking,
          exitCode,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }

  if (!report.fileCount) {
    console.log(`${DIM}codeorion: nothing staged.${RESET}`);
    process.exit(0);
  }

  for (const s of report.secrets) {
    console.log(`${RED}secret${RESET}   ${s.provider}  ${DIM}${s.filePath}:${s.line}${RESET}  ${s.redacted}`);
  }
  for (const f of report.agentConfig) {
    const color = f.severity === "critical" || f.severity === "high" ? RED : YELLOW;
    console.log(`${color}agent${RESET}    ${f.rule}  ${DIM}${f.filePath}:${f.line}${RESET}`);
    console.log(`         ${DIM}${f.message}${RESET}`);
  }
  for (const d of report.newDependencies) {
    const color = d.status === "phantom" || d.status === "vulnerable" ? RED : YELLOW;
    console.log(`${color}${d.status.padEnd(9)}${RESET}${d.name} ${DIM}(${d.ecosystem}, added by this commit)${RESET}`);
    console.log(`         ${DIM}${d.reason}${RESET}`);
  }
  if (report.dependenciesNotChecked > 0) {
    console.log(
      `${DIM}         ${report.dependenciesNotChecked} further added dependencies not checked (cap reached) — run a full scan.${RESET}`,
    );
  }

  if (exitCode === 0) {
    const warned = report.agentConfig.length + report.newDependencies.length + report.secrets.length;
    console.log(
      warned > 0
        ? `${DIM}codeorion: ${report.fileCount} staged file(s), nothing blocking.${RESET}`
        : `${GREEN}codeorion${RESET} ${DIM}${report.fileCount} staged file(s) clean.${RESET}`,
    );
  } else {
    console.log(
      `\n${RED}codeorion: commit blocked${RESET} ${DIM}— ${blocking} blocking finding(s). ` +
        `Fix them, or bypass with \`git commit --no-verify\`.${RESET}`,
    );
  }
  process.exit(exitCode);
}

async function main() {
  const { dir, json, staged, minScore, upload, token, apiUrl, llmFlags } = parseArgs(process.argv.slice(2));
  if (staged) await runStaged(json);
  const llmResolution = resolveLlmConfig(llmFlags, process.env);
  if (!llmResolution.ok) {
    console.error(llmResolution.error);
    process.exit(2);
  }
  const llm = llmResolution.config;
  if (upload && !token) {
    console.error("codeaudit: --upload requires a token (--token or CODEAUDIT_TOKEN). Generate one in your repo settings.");
    process.exit(2);
  }
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`codeaudit: not a directory: ${dir}`);
    process.exit(2);
  }

  const ecosystems = detectEcosystems(dir);
  const deps: DependencyVerdict[] = [];
  const candidates: DeadCodeCandidate[] = [];
  const mergedFileImportExports = new Map<string, string[]>();
  let npmTree: ResolvedTree | null = null;
  let pyTree: ResolvedTree | null = null;
  let fileCount = 0;

  if (ecosystems.includes("npm")) {
    const manifest = parseManifest(dir);
    const analysis = analyzeRepo(dir);
    npmTree = resolveNpmTree(dir);
    fileCount += analysis.fileCount;
    if (manifest)
      deps.push(
        ...(await checkDependencies(dir, manifest, analysis.importedPackages, {
          transitivelyRequired: npmTree?.transitivelyRequired,
        })),
      );
    candidates.push(...findDeadCodeCandidates(analysis));
    for (const [k, v] of analysis.fileImportExports) mergedFileImportExports.set(k, v);
  }

  if (ecosystems.includes("pypi")) {
    const pyManifest = parsePythonManifest(dir);
    const pyAnalysis = analyzePythonRepo(dir);
    pyTree = resolvePythonTree(dir);
    fileCount += pyAnalysis.fileCount;
    deps.push(
      ...(await checkPythonDependencies(dir, pyManifest, pyAnalysis.importedPackages, {
        transitivelyRequired: pyTree?.transitivelyRequired,
      })),
    );
    candidates.push(...findDeadCodeCandidates(pyAnalysis));
    for (const [k, v] of pyAnalysis.fileImportExports) mergedFileImportExports.set(k, v);
  }

  // Known-vulnerability lookup (OSV) — static/HTTP, so the CLI runs it too.
  const vulnTargets = collectVulnTargets(deps, [
    { ecosystem: "npm", tree: npmTree },
    { ecosystem: "pypi", tree: pyTree },
  ]);
  if (vulnTargets.length) {
    applyVulnerabilities(deps, await checkVulnerabilities(vulnTargets));
  }

  // "Did you mean X?" for phantom packages with no offline fuzzy match —
  // same best-effort, optional path the hosted worker uses
  // (server/src/worker.ts). No-op when llm is null.
  if (llm) {
    const phantomsNeedingAiSuggestion = deps.filter(
      (d) => d.status === "phantom" && !(d.registryMetadata as { alternatives?: unknown } | null)?.alternatives,
    );
    if (phantomsNeedingAiSuggestion.length) {
      const aiSuggestions = await suggestAlternatives(
        phantomsNeedingAiSuggestion.map((d) => ({ packageName: d.packageName, ecosystem: d.ecosystem })),
        { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model },
      );
      for (const d of phantomsNeedingAiSuggestion) {
        const alternatives = aiSuggestions.get(d.packageName);
        if (alternatives?.length) d.registryMetadata = { ...(d.registryMetadata ?? {}), alternatives };
      }
    }
  }

  const polyglot = ecosystems.length > 1;

  // With a BYOK key resolved, reach the same LLM review path the hosted
  // worker uses (server/src/worker.ts) — additive to the CLI's existing
  // static-only behavior, never a replacement: with `llm === null` this is
  // byte-for-byte the old static-only path.
  const { findings: staticFindings, reviewStatus } = await reviewCandidatesWithLlm(
    candidates,
    { fileImportExports: mergedFileImportExports },
    llm ? { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model } : undefined,
  );

  // Advisory-only, matching the worker's guarding (server/src/worker.ts): an
  // unexpected throw here must not change the CLI's documented exit-code
  // contract (0/1/2). A failure means the advisory data is absent, not that
  // the scan broke.
  let duplicates: ReturnType<typeof findDuplicateLibraries> = [];
  let licenseConflicts: ReturnType<typeof checkLicenseConflicts> = [];
  let priorities: ReturnType<typeof rankFindings> = [];
  let secrets: ReturnType<typeof findSecrets> = [];
  let agentConfigFindings: AgentConfigFinding[] = [];
  try {
    duplicates = findDuplicateLibraries(deps);
    licenseConflicts = checkLicenseConflicts(deps, readProjectLicense(dir));
    secrets = findSecrets(dir);
    agentConfigFindings = findAgentConfigIssues(dir);
  } catch (err) {
    console.error(
      "codeaudit: advisory analysis failed (continuing without it):",
      err instanceof Error ? err.message : err,
    );
  }
  // Separate try: this needs the network, so one timeout must not discard the
  // sync advisory data (duplicates/licenseConflicts/secrets) collected above.
  try {
    const mcpRefs = findMcpPackageRefs(dir);
    if (mcpRefs.length) {
      agentConfigFindings = [...agentConfigFindings, ...(await verifyAgentConfigPackages(mcpRefs))];
    }
  } catch (err) {
    console.error(
      "codeaudit: MCP package verification failed (continuing without it):",
      err instanceof Error ? err.message : err,
    );
  }
  try {
    priorities = rankFindings({
      deps,
      codeFindings: staticFindings,
      duplicates,
      licenseConflicts,
      secrets,
      agentConfig: agentConfigFindings,
      limit: 5,
    });
  } catch (err) {
    console.error(
      "codeaudit: prioritization failed (continuing without it):",
      err instanceof Error ? err.message : err,
    );
  }
  const summary = computeSummary(
    deps,
    staticFindings,
    fileCount,
    reviewStatus,
    secrets.length,
    agentConfigFindings.length,
  );
  const phantomCount = summary.counts.phantom;
  const belowMin = minScore !== null && summary.score < minScore;
  const exitCode = phantomCount > 0 || belowMin ? 1 : 0;

  let uploadResult: { ok: boolean; url?: string; error?: string } | null = null;
  if (upload && token) {
    uploadResult = await uploadResults(
      apiUrl,
      token,
      summary,
      deps,
      staticFindings,
      priorities,
      { duplicates, licenseConflicts },
      reviewStatus,
    );
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          score: summary.score,
          grade: summary.grade,
          counts: summary.counts,
          reviewStatus,
          dependencies: deps,
          deadCodeCandidates: staticFindings,
          priorities,
          advisories: { duplicates, licenseConflicts },
          // `fingerprint` is a dedup-internal hash (see secrets.ts) that must
          // never be rendered into CLI output, an export, or a PR comment —
          // it exists only to recognize the same credential across scans.
          secrets: secrets.map(({ fingerprint: _fingerprint, ...s }) => s),
          agentConfig: agentConfigFindings,
          upload: uploadResult,
          exitCode,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }

  console.log(`\n${BOLD}CodeAudit${RESET} ${DIM}· static scan of ${dir}${RESET}\n`);

  if (secrets.length) {
    console.log(`${BOLD}${RED}Secrets${RESET}`);
    for (const s of secrets as SecretFinding[]) {
      console.log(`  ${RED}${s.provider}${RESET}  ${DIM}${s.filePath}:${s.line}${RESET}  ${s.redacted}`);
    }
    console.log();
  }

  const AGENT_SEVERITY_COLOR: Record<string, string> = { critical: RED, high: RED, medium: YELLOW };
  if (agentConfigFindings.length) {
    console.log(`${BOLD}${RED}Agent config${RESET}`);
    for (const f of agentConfigFindings) {
      const color = AGENT_SEVERITY_COLOR[f.severity] ?? "";
      console.log(`  ${color}${f.severity.toUpperCase().padEnd(8)}${RESET} ${f.rule}  ${DIM}${f.filePath}:${f.line}${RESET}`);
      console.log(`      ${DIM}${f.message}${RESET}`);
    }
    console.log();
  }

  const BAND_COLOR: Record<string, string> = { critical: RED, high: RED, medium: YELLOW, low: DIM };
  if (priorities.length) {
    console.log(`${BOLD}Fix first${RESET}`);
    for (const p of priorities) {
      const color = BAND_COLOR[p.band] ?? "";
      console.log(`  ${color}${String(p.rank).padStart(2)}. ${p.band.toUpperCase().padEnd(8)}${RESET} ${p.title} ${DIM}[${p.effort}]${RESET}`);
      console.log(`      ${DIM}${p.why}${RESET}`);
      if (p.location) console.log(`      ${DIM}${p.location}${RESET}`);
    }
    console.log();
  }

  // `deprecated` is stored as registryMetadata.deprecated, not as a status —
  // status stays "healthy" so it never moves the score (score.ts is
  // untouched). Without this, a deprecated package is hidden from the table
  // and counted in "N healthy packages not shown" while Fix first calls it
  // deprecated a few lines above — a visible self-contradiction.
  const isDeprecated = (d: DependencyVerdict) => typeof d.registryMetadata?.deprecated === "string";
  const interesting = deps
    .filter((d) => d.status !== "healthy" || isDeprecated(d))
    .sort((a, b) => a.status.localeCompare(b.status));
  if (interesting.length) {
    console.log(`${BOLD}Dependencies${RESET}`);
    for (const d of interesting) {
      const deprecated = isDeprecated(d);
      const label = deprecated && d.status === "healthy" ? "deprecated" : d.status;
      // The status colour wins whenever the status is not "healthy" — a
      // package that is BOTH deprecated and vulnerable must render red, not
      // yellow, or it loses its severity cue. Yellow-for-deprecated only
      // applies when there is no other status colour to preserve.
      const color = deprecated && d.status === "healthy" ? YELLOW : (statusColor[d.status] ?? "");
      const eco = polyglot ? `${DIM}${d.ecosystem.padEnd(5)}${RESET} ` : "";
      const alternatives = (d.registryMetadata as { alternatives?: { name: string }[] } | null)?.alternatives;
      const suggestion = alternatives?.length
        ? ` ${DIM}(did you mean ${alternatives.map((a) => a.name).join(", ")}?)${RESET}`
        : "";
      const deprecatedMarker = deprecated && d.status !== "healthy" ? ` ${DIM}(deprecated)${RESET}` : "";
      console.log(`  ${color}${label.padEnd(10)}${RESET} ${eco}${d.packageName}${suggestion}${deprecatedMarker}`);
    }
    const shownHealthy = interesting.filter((d) => d.status === "healthy").length;
    console.log(`  ${DIM}${summary.counts.healthy - shownHealthy} healthy packages not shown${RESET}\n`);
  } else {
    console.log(`${GREEN}All ${deps.length} dependencies healthy${RESET}\n`);
  }

  if (staticFindings.length) {
    const reviewLabel =
      reviewStatus === "full"
        ? `LLM-reviewed via ${llm?.source ?? "your key"}`
        : reviewStatus === "partial"
          ? "partially LLM-reviewed — some batches fell back to static analysis"
          : "static analysis only";
    console.log(`${BOLD}Dead-code candidates${RESET} ${DIM}(${reviewLabel})${RESET}`);
    for (const f of staticFindings) {
      const confidenceNote = reviewStatus !== "skipped" ? ` ${DIM}(${Math.round(f.confidence * 100)}% confidence)${RESET}` : "";
      console.log(`  ${YELLOW}candidate${RESET}  ${f.symbolName}  ${DIM}${f.filePath}:${f.lineStart}${RESET}${confidenceNote}`);
    }
    console.log();
  }

  const scoreColor = summary.score >= 75 ? GREEN : summary.score >= 50 ? YELLOW : RED;
  console.log(
    `${BOLD}Score: ${scoreColor}${summary.score} (${summary.grade})${RESET}  ${DIM}· ${fileCount} files analyzed (${ecosystems.join(" + ") || "no ecosystems detected"})${RESET}`,
  );
  if (phantomCount > 0)
    console.log(`${RED}${BOLD}${phantomCount} phantom dependenc${phantomCount === 1 ? "y" : "ies"} — remove before shipping${RESET}`);
  if (belowMin) console.log(`${RED}Score below --min-score ${minScore}${RESET}`);

  if (uploadResult) {
    if (uploadResult.ok)
      console.log(`${GREEN}✓ Uploaded to your CodeAudit dashboard${RESET}${uploadResult.url ? ` ${DIM}${uploadResult.url}${RESET}` : ""}`);
    else console.log(`${RED}✗ Upload failed: ${uploadResult.error}${RESET}`);
  }

  // NOT codeaudit.dev — that is an unrelated, competing code-scanning product.
  // The URL was missed by the codeaudit -> codeorion rename sweep and shipped
  // in codeorion@1.0.0, pointing every CLI user at a competitor's homepage.
  console.log(`\n${DIM}→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at ${DASHBOARD_URL}${RESET}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("codeaudit: scan failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
