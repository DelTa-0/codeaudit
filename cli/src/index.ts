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
  -h, --help      show this help

Exit codes: 0 ok · 1 phantom deps found or score below --min-score · 2 usage/error`);
  process.exit(2);
}

interface CliArgs {
  dir: string;
  json: boolean;
  minScore: number | null;
}

function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "scan" || args.includes("-h") || args.includes("--help")) usage();

  let dir = ".";
  let json = false;
  let minScore: number | null = null;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
    else if (arg === "--min-score") {
      const value = Number(args.shift());
      if (!Number.isFinite(value)) usage();
      minScore = value;
    } else if (!arg.startsWith("-")) dir = arg;
    else usage();
  }
  return { dir: path.resolve(dir), json, minScore };
}

const statusColor: Record<string, string> = {
  phantom: RED,
  suspicious: YELLOW,
  unused: YELLOW,
  healthy: GREEN,
};

async function main() {
  const { dir, json, minScore } = parseArgs(process.argv.slice(2));
  if (!fs.existsSync(dir) || !fs.statSync(dir).isDirectory()) {
    console.error(`codeaudit: not a directory: ${dir}`);
    process.exit(2);
  }

  const manifest = parseManifest(dir);
  const analysis = analyzeRepo(dir);
  const deps = manifest ? await checkDependencies(manifest, analysis.importedPackages) : [];
  const candidates = findDeadCodeCandidates(analysis);

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

  const summary = computeSummary(deps, staticFindings, analysis.fileCount);
  const phantomCount = summary.counts.phantom;
  const belowMin = minScore !== null && summary.score < minScore;
  const exitCode = phantomCount > 0 || belowMin ? 1 : 0;

  if (json) {
    console.log(
      JSON.stringify(
        {
          score: summary.score,
          grade: summary.grade,
          counts: summary.counts,
          dependencies: deps,
          deadCodeCandidates: staticFindings,
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
      console.log(`  ${color}${d.status.padEnd(10)}${RESET} ${d.packageName}`);
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
    `${BOLD}Score: ${scoreColor}${summary.score} (${summary.grade})${RESET}  ${DIM}· ${analysis.fileCount} files analyzed${RESET}`,
  );
  if (phantomCount > 0)
    console.log(`${RED}${BOLD}${phantomCount} phantom dependenc${phantomCount === 1 ? "y" : "ies"} — remove before shipping${RESET}`);
  if (belowMin) console.log(`${RED}Score below --min-score ${minScore}${RESET}`);

  console.log(`\n${DIM}→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at codeaudit.dev${RESET}\n`);
  process.exit(exitCode);
}

main().catch((err) => {
  console.error("codeaudit: scan failed:", err instanceof Error ? err.message : err);
  process.exit(2);
});
