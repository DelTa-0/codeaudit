#!/usr/bin/env node
// CodeAudit CLI — static scan of a local directory, with static analysis by
// default and LLM-backed dead-code review available via BYOK (--key/--url/
// --model or GROQ_API_KEY/OPENAI_API_KEY/CODEAUDIT_LLM_KEY).
// Deliberately limited: no scan history, no PR integration — those live in
// the CodeAudit platform.
import path from "node:path";
import fs from "node:fs";
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
} from "@codeaudit/engine";
import { resolveLlmConfig, type LlmFlags } from "./llmConfig.js";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

function usage(): never {
  console.log(`Usage: codematrix scan [dir] [options]

Options:
  --json          machine-readable output (for CI)
  --min-score N   exit 1 if the score is below N
  --upload        send results to your CodeAudit dashboard (requires a token)
  --token T       per-repo CLI token (or set CODEAUDIT_TOKEN)
  --api URL       API base URL (or set CODEAUDIT_API_URL, default http://localhost:4000)
  --key T         your own LLM API key for real dead-code review (or set GROQ_API_KEY / OPENAI_API_KEY / CODEAUDIT_LLM_KEY)
  --url URL       OpenAI-compatible base URL for --key (or set CODEAUDIT_LLM_URL; required with a bare --key)
  --model M       model name for --url (or set CODEAUDIT_LLM_MODEL; required alongside a custom --url)
  -h, --help      show this help

Without a key, dead-code candidates are static-only (fixed confidence, no LLM verdict).
Set GROQ_API_KEY for free LLM-backed review with zero other flags.

Exit codes: 0 ok · 1 phantom deps found or score below --min-score · 2 usage/error`);
  process.exit(2);
}

interface CliArgs {
  dir: string;
  json: boolean;
  minScore: number | null;
  upload: boolean;
  token: string | null;
  apiUrl: string;
  llmFlags: LlmFlags;
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "scan" || args.includes("-h") || args.includes("--help")) usage();

  let dir = ".";
  let json = false;
  let minScore: number | null = null;
  let upload = false;
  let token: string | null = process.env.CODEAUDIT_TOKEN ?? null;
  let apiUrl = process.env.CODEAUDIT_API_URL ?? "http://localhost:4000";
  let key: string | null = null;
  let url: string | null = null;
  let model: string | null = null;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
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
  return { dir: path.resolve(dir), json, minScore, upload, token, apiUrl, llmFlags: { key, url, model } };
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

async function main() {
  const { dir, json, minScore, upload, token, apiUrl, llmFlags } = parseArgs(process.argv.slice(2));
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
  try {
    duplicates = findDuplicateLibraries(deps);
    licenseConflicts = checkLicenseConflicts(deps, readProjectLicense(dir));
    secrets = findSecrets(dir);
    priorities = rankFindings({
      deps,
      codeFindings: staticFindings,
      duplicates,
      licenseConflicts,
      secrets,
      limit: 5,
    });
  } catch (err) {
    console.error(
      "codeaudit: advisory analysis failed (continuing without it):",
      err instanceof Error ? err.message : err,
    );
  }
  const summary = computeSummary(deps, staticFindings, fileCount, reviewStatus, secrets.length);
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

  console.log(`\n${DIM}→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at codeaudit.dev${RESET}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("codeaudit: scan failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
