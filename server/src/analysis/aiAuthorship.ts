import fs from "node:fs";
import path from "node:path";
import { simpleGit } from "simple-git";
import type { ReviewedFinding } from "@codeaudit/engine";

export interface HotspotFile {
  path: string;
  /** number of commits (within the window) that touched this file — churn */
  commits: number;
  /** current size in lines — a cheap complexity proxy */
  lines: number;
  /** normalized churn × size, 0-1 — higher = more debt-risky */
  score: number;
  /** majority AI-authored */
  ai: boolean;
  /** already carries a flagged finding (dead code, etc.) */
  hasFinding: boolean;
}

export interface AiAuthorshipStats {
  aiCommits: number;
  totalCommits: number;
  /** share of tracked files whose commits are majority AI-assisted (0-1) */
  shareOfFiles: number;
  /** findings per 100 files, split by majority authorship of the finding's file */
  aiFindingDensity: number;
  humanFindingDensity: number;
  aiFiles: number;
  humanFiles: number;
  /** dependency-bump/CI bot commits, excluded from both buckets (transparency) */
  automationCommits: number;
  /**
   * Whether the AI-vs-human density comparison has enough files on both sides
   * to mean anything. Below this the UI must not present a verdict — small
   * buckets make the ratio pure noise.
   */
  comparable: boolean;
  /** top change-frequency × size files, cross-referenced with AI authorship */
  hotspots: HotspotFile[];
  /**
   * How much this attribution is actually worth on THIS repository.
   *
   * Authorship is inferred from Co-Authored-By trailers and bot author names.
   * That is high precision and low recall: a trailer proves an assistant was
   * involved, but Copilot inline completion, Cursor tab-completion and pasted
   * chat output leave no trailer at all. So "no AI found" and "AI used without
   * recording it" are the same observation, and a UI that renders both as 0%
   * is asserting something the data cannot support.
   */
  attribution: AttributionCoverage;
}

export interface AttributionCoverage {
  /** Commits actually inspected, after excluding automation. */
  commitsExamined: number;
  /** Commits carrying an AI marker. Zero is the ambiguous case. */
  aiMarkedCommits: number;
  /**
   * History ran out before the window did — the clone is shallow (--depth 100
   * in analysis/clone.ts) or the commit cap was reached. "Introduced N commits
   * ago" answers are bounded by this window, not by the repository.
   */
  historyTruncated: boolean;
  /**
   * - `none`   no marker anywhere. Report as UNAVAILABLE, never as zero risk.
   * - `low`    a handful of markers; directional at best.
   * - `usable` enough marked commits to say something.
   */
  level: "none" | "low" | "usable";
  /** One sentence the UI can show verbatim, so honesty is not re-derived per surface. */
  caveat: string;
}

/** Minimum files in BOTH buckets before a density comparison is shown. */
const MIN_FILES_FOR_COMPARISON = 5;

const HOTSPOT_LIMIT = 8;
const LOCKFILE_BASENAMES = new Set([
  "package-lock.json",
  "yarn.lock",
  "pnpm-lock.yaml",
  "bun.lock",
  "bun.lockb",
  "poetry.lock",
  "Cargo.lock",
  "composer.lock",
  "Gemfile.lock",
  "go.sum",
]);

/**
 * Generated/derived files. They can show high churn (codegen reruns on every
 * route or schema change) and large size, which lands them at the top of a
 * churn × size ranking — but "refactor this" is meaningless advice for a file
 * a tool rewrites. Caught in the wild: TanStack Router's `routeTree.gen.ts`.
 */
const GENERATED_FILE_PATTERN = /(\.gen\.[jt]sx?$|\.generated\.|\.min\.js$|^dist\/|\/dist\/)/;

/** Cheap line count for a repo file; 0 for missing/binary/oversized files. */
function countLines(repoDir: string, file: string): number {
  try {
    const full = path.join(repoDir, file);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > 2_000_000) return 0; // skip huge/generated
    const buf = fs.readFileSync(full);
    if (buf.includes(0)) return 0; // binary (contains a NUL byte)
    return buf.toString("utf8").split("\n").length;
  } catch {
    return 0;
  }
}

/**
 * Rank files by churn (commit count) × current size — the "hotspot" heuristic:
 * frequently-changed large files concentrate defect risk. Reuses the per-file
 * commit counts already gathered for AI-authorship, so the only added cost is
 * a line count per candidate file. Lockfiles and generated blobs are excluded.
 */
function computeHotspots(
  repoDir: string,
  fileCommits: Map<string, number>,
  isAiFile: (path: string) => boolean,
  findingFiles: Set<string>,
): HotspotFile[] {
  const rows: HotspotFile[] = [];
  for (const [file, commits] of fileCommits) {
    if (LOCKFILE_BASENAMES.has(path.basename(file))) continue;
    if (GENERATED_FILE_PATTERN.test(file)) continue;
    const lines = countLines(repoDir, file);
    if (lines === 0) continue; // gone, binary, or generated
    rows.push({
      path: file,
      commits,
      lines,
      score: commits * lines, // normalized below
      ai: isAiFile(file),
      hasFinding: findingFiles.has(file),
    });
  }
  const maxRaw = rows.reduce((m, r) => Math.max(m, r.score), 0) || 1;
  for (const r of rows) r.score = Math.round((r.score / maxRaw) * 1000) / 1000;
  return rows.sort((a, b) => b.score - a.score).slice(0, HOTSPOT_LIMIT);
}

const AI_TRAILER_GREP =
  "co-authored-by: *(claude|github copilot|copilot|cursor|chatgpt|openai|devin|aider|gemini|windsurf)";
/**
 * Authors whose commits are AI-*generated code*. Deliberately excludes
 * dependency-bump automation (dependabot, renovate, greenkeeper): those are
 * scripted version bumps, not generated code, and counting them inflated the
 * "AI-touched" share while dragging manifests/lockfiles into the AI bucket.
 * The generic `[bot]` catch-all is gone for the same reason — it swept up
 * every CI/release bot indiscriminately.
 */
const AI_AUTHOR = /(copilot|devin-ai|claude|cursor-agent|aider|codex|windsurf)/i;
/** Pure automation — tracked separately so it never counts as AI authorship. */
const AUTOMATION_AUTHOR = /(dependabot|renovate|greenkeeper|semantic-release|github-actions)/i;
const MAX_COMMITS = "500";
/** Below this many AI-marked commits the split is directional, not evidence. */
const MIN_AI_COMMITS_FOR_CONFIDENCE = 3;

export function describeCoverage(
  aiMarkedCommits: number,
  commitsExamined: number,
  historyTruncated: boolean,
): AttributionCoverage {
  const level: AttributionCoverage["level"] =
    aiMarkedCommits === 0 ? "none" : aiMarkedCommits < MIN_AI_COMMITS_FOR_CONFIDENCE ? "low" : "usable";
  const window = historyTruncated
    ? ` Only the most recent ${commitsExamined} commits were available (shallow clone), so older work is not represented.`
    : "";
  const caveat =
    level === "none"
      ? `No AI attribution markers were found in ${commitsExamined} commits. This does not mean no AI was used — assistants that complete code inline (Copilot, Cursor tab-completion) and pasted chat output leave no trace in git.${window}`
      : level === "low"
        ? `Only ${aiMarkedCommits} of ${commitsExamined} commits carry an AI marker, so this split is directional rather than evidence. Assistants that complete inline leave no marker.${window}`
        : `Based on ${aiMarkedCommits} of ${commitsExamined} commits carrying an AI marker. Assistants that complete code inline leave no marker, so this is a floor, not a total.${window}`;
  return { commitsExamined, aiMarkedCommits, historyTruncated, level, caveat };
}

/**
 * Which commits carry an AI marker.
 *
 * Exported because dependency attribution needs exactly the same answer, and
 * two independent copies of "what counts as an AI commit" would drift — the
 * authorship card and a per-dependency verdict disagreeing about the same
 * commit is the kind of inconsistency nobody can debug from the UI.
 */
export async function collectAiCommitHashes(repoDir: string): Promise<{
  ai: Set<string>;
  automation: Set<string>;
  /** [hash, authorName, authorEmail] per commit, in log order. */
  commits: string[][];
}> {
  const git = simpleGit(repoDir);
  const trailerHashes = (
    await git.raw(["log", `-n`, MAX_COMMITS, "--format=%H", "-i", "-E", `--grep=${AI_TRAILER_GREP}`])
  )
    .split("\n")
    .filter(Boolean);
  const commits = (await git.raw(["log", "-n", MAX_COMMITS, "--format=%H%x02%an%x02%ae"]))
    .split("\n")
    .filter(Boolean)
    .map((line) => line.split("\x02"));
  const ai = new Set(trailerHashes);
  const automation = new Set<string>();
  for (const [hash, name, email] of commits) {
    const who = `${name} ${email}`;
    if (AUTOMATION_AUTHOR.test(who)) {
      // Scripted dependency bumps etc. — never AI authorship, and excluded
      // from the human baseline too so they don't skew either bucket.
      automation.add(hash);
      ai.delete(hash);
      continue;
    }
    if (AI_AUTHOR.test(who)) ai.add(hash);
  }
  return { ai, automation, commits };
}

/**
 * Attributes files to AI-assisted vs human commits from the (shallow,
 * depth-100) clone's history. Heuristic: a commit is AI-assisted when its
 * message carries a known assistant Co-Authored-By trailer or its author
 * matches a bot pattern. Best-effort — returns null on any git failure.
 */
export async function computeAiAuthorship(
  repoDir: string,
  findings: ReviewedFinding[],
): Promise<AiAuthorshipStats | null> {
  try {
    const git = simpleGit(repoDir);

    const {
      ai: aiHashes,
      automation: automationHashes,
      commits: authors,
    } = await collectAiCommitHashes(repoDir);
    const totalCommits = authors.length - automationHashes.size;
    if (totalCommits === 0) return null;

    // A shallow clone cannot see past its depth, and the commit cap can bite
    // before that. Either way the window — not the repository — bounds every
    // "N commits ago" answer downstream, so it has to be reported rather than
    // silently assumed to be the whole history.
    let historyTruncated = authors.length >= Number(MAX_COMMITS);
    try {
      historyTruncated =
        historyTruncated ||
        (await git.raw(["rev-parse", "--is-shallow-repository"])).trim() === "true";
    } catch {
      // Older git without the flag — leave the cap-based answer.
    }

    // Files touched per commit.
    const nameOnly = await git.raw(["log", "-n", MAX_COMMITS, "--format=%x01%H", "--name-only"]);
    const fileStats = new Map<string, { ai: number; human: number }>();
    for (const chunk of nameOnly.split("\x01")) {
      const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const [hash, ...files] = lines;
      if (automationHashes.has(hash)) continue; // bump bots skew neither bucket
      const isAi = aiHashes.has(hash);
      for (const file of files) {
        const entry = fileStats.get(file) ?? { ai: 0, human: 0 };
        if (isAi) entry.ai++;
        else entry.human++;
        fileStats.set(file, entry);
      }
    }

    let aiFiles = 0;
    let humanFiles = 0;
    for (const [, entry] of fileStats) {
      if (entry.ai > entry.human) aiFiles++;
      else humanFiles++;
    }
    const trackedFiles = aiFiles + humanFiles;
    const isAiFile = (path: string) => {
      const entry = fileStats.get(path);
      return entry ? entry.ai > entry.human : false;
    };

    const aiFindings = findings.filter((f) => isAiFile(f.filePath)).length;
    const humanFindings = findings.length - aiFindings;

    const fileCommits = new Map<string, number>();
    for (const [file, entry] of fileStats) fileCommits.set(file, entry.ai + entry.human);
    const findingFiles = new Set(findings.map((f) => f.filePath));
    const hotspots = computeHotspots(repoDir, fileCommits, isAiFile, findingFiles);

    return {
      aiCommits: aiHashes.size,
      totalCommits,
      attribution: describeCoverage(aiHashes.size, totalCommits, historyTruncated),
      shareOfFiles: trackedFiles ? Math.round((aiFiles / trackedFiles) * 1000) / 1000 : 0,
      aiFindingDensity: aiFiles ? Math.round((aiFindings / aiFiles) * 100 * 10) / 10 : 0,
      humanFindingDensity: humanFiles
        ? Math.round((humanFindings / humanFiles) * 100 * 10) / 10
        : 0,
      aiFiles,
      humanFiles,
      automationCommits: automationHashes.size,
      comparable: aiFiles >= MIN_FILES_FOR_COMPARISON && humanFiles >= MIN_FILES_FOR_COMPARISON,
      hotspots,
    };
  } catch (err) {
    console.error("AI authorship analysis failed (non-fatal):", err);
    return null;
  }
}
