#!/usr/bin/env node
// CodeAudit CLI — static-only scan of a local directory.
// Deliberately limited: no LLM verdicts, no history, no PR integration —
// those live in the CodeAudit platform.
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
  type DependencyVerdict,
  type DeadCodeCandidate,
  type ReviewedFinding,
} from "@codeaudit/engine";

const RESET = "\x1b[0m";
const BOLD = "\x1b[1m";
const RED = "\x1b[31m";
const YELLOW = "\x1b[33m";
const GREEN = "\x1b[32m";
const DIM = "\x1b[2m";

function usage(): never {
  console.log(`Usage: codeaudit scan [dir] [options]

Options:
  --json          machine-readable output (for CI)
  --min-score N   exit 1 if the score is below N
  --upload        send results to your CodeAudit dashboard (requires a token)
  --token T       per-repo CLI token (or set CODEAUDIT_TOKEN)
  --api URL       API base URL (or set CODEAUDIT_API_URL, default http://localhost:4000)
  -h, --help      show this help

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
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
    else if (arg === "--upload") upload = true;
    else if (arg === "--token") token = args.shift() ?? null;
    else if (arg === "--api") apiUrl = args.shift() ?? apiUrl;
    else if (arg === "--min-score") {
      const value = Number(args.shift());
      if (!Number.isFinite(value)) usage();
      minScore = value;
    } else if (!arg.startsWith("-")) dir = arg;
    else usage();
  }
  return { dir: path.resolve(dir), json, minScore, upload, token, apiUrl };
}

async function uploadResults(
  apiUrl: string,
  token: string,
  summary: { score: number; grade: string; counts: Record<string, number> },
  deps: unknown[],
  candidates: ReviewedFinding[],
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
  suspicious: YELLOW,
  unused: YELLOW,
  healthy: GREEN,
};

async function main() {
  const { dir, json, minScore, upload, token, apiUrl } = parseArgs(process.argv.slice(2));
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
  let fileCount = 0;

  if (ecosystems.includes("npm")) {
    const manifest = parseManifest(dir);
    const analysis = analyzeRepo(dir);
    fileCount += analysis.fileCount;
    if (manifest) deps.push(...(await checkDependencies(manifest, analysis.importedPackages)));
    candidates.push(...findDeadCodeCandidates(analysis));
  }

  if (ecosystems.includes("pypi")) {
    const pyManifest = parsePythonManifest(dir);
    const pyAnalysis = analyzePythonRepo(dir);
    fileCount += pyAnalysis.fileCount;
    deps.push(...(await checkPythonDependencies(dir, pyManifest, pyAnalysis.importedPackages)));
    candidates.push(...findDeadCodeCandidates(pyAnalysis));
  }

  const polyglot = ecosystems.length > 1;

  // Static-only findings: candidates at fixed confidence, no LLM verdict.
  const staticFindings: ReviewedFinding[] = candidates.map((c) => ({
    filePath: c.filePath,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    symbolName: c.name,
    findingType: c.findingType,
    confidence: 0.5,
    reasoning: "candidate — LLM verification available on codeaudit.dev",
  }));

  const summary = computeSummary(deps, staticFindings, fileCount);
  const phantomCount = summary.counts.phantom;
  const belowMin = minScore !== null && summary.score < minScore;
  const exitCode = phantomCount > 0 || belowMin ? 1 : 0;

  let uploadResult: { ok: boolean; url?: string; error?: string } | null = null;
  if (upload && token) {
    uploadResult = await uploadResults(apiUrl, token, summary, deps, staticFindings);
  }

  if (json) {
    console.log(
      JSON.stringify(
        {
          score: summary.score,
          grade: summary.grade,
          counts: summary.counts,
          dependencies: deps,
          deadCodeCandidates: staticFindings,
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

  const interesting = deps
    .filter((d) => d.status !== "healthy")
    .sort((a, b) => a.status.localeCompare(b.status));
  if (interesting.length) {
    console.log(`${BOLD}Dependencies${RESET}`);
    for (const d of interesting) {
      const color = statusColor[d.status] ?? "";
      const eco = polyglot ? `${DIM}${d.ecosystem.padEnd(5)}${RESET} ` : "";
      console.log(`  ${color}${d.status.padEnd(10)}${RESET} ${eco}${d.packageName}`);
    }
    console.log(`  ${DIM}${summary.counts.healthy} healthy packages not shown${RESET}\n`);
  } else {
    console.log(`${GREEN}All ${deps.length} dependencies healthy${RESET}\n`);
  }

  if (staticFindings.length) {
    console.log(`${BOLD}Dead-code candidates${RESET} ${DIM}(static analysis only)${RESET}`);
    for (const f of staticFindings) {
      console.log(`  ${YELLOW}candidate${RESET}  ${f.symbolName}  ${DIM}${f.filePath}:${f.lineStart}${RESET}`);
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
