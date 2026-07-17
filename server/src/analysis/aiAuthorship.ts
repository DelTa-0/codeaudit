import { simpleGit } from "simple-git";
import type { ReviewedFinding } from "@codeaudit/engine";

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
}

const AI_TRAILER_GREP =
  "co-authored-by: *(claude|github copilot|copilot|cursor|chatgpt|openai|devin|aider|gemini|windsurf)";
const AI_AUTHOR = /(\[bot\]|copilot|devin-ai|dependabot|renovate|claude|cursor-agent|aider)/i;
const MAX_COMMITS = "500";

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

    // AI-assisted commit hashes: trailer match (grep on body) ∪ bot authors.
    const trailerHashes = (
      await git.raw(["log", `-n`, MAX_COMMITS, "--format=%H", "-i", "-E", `--grep=${AI_TRAILER_GREP}`])
    )
      .split("\n")
      .filter(Boolean);
    const authors = (
      await git.raw(["log", "-n", MAX_COMMITS, "--format=%H%x02%an%x02%ae"])
    )
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\x02"));
    const aiHashes = new Set(trailerHashes);
    for (const [hash, name, email] of authors) {
      if (AI_AUTHOR.test(`${name} ${email}`)) aiHashes.add(hash);
    }
    const totalCommits = authors.length;
    if (totalCommits === 0) return null;

    // Files touched per commit.
    const nameOnly = await git.raw(["log", "-n", MAX_COMMITS, "--format=%x01%H", "--name-only"]);
    const fileStats = new Map<string, { ai: number; human: number }>();
    for (const chunk of nameOnly.split("\x01")) {
      const lines = chunk.split("\n").map((l) => l.trim()).filter(Boolean);
      if (lines.length < 2) continue;
      const [hash, ...files] = lines;
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

    return {
      aiCommits: aiHashes.size,
      totalCommits,
      shareOfFiles: trackedFiles ? Math.round((aiFiles / trackedFiles) * 1000) / 1000 : 0,
      aiFindingDensity: aiFiles ? Math.round((aiFindings / aiFiles) * 100 * 10) / 10 : 0,
      humanFindingDensity: humanFiles
        ? Math.round((humanFindings / humanFiles) * 100 * 10) / 10
        : 0,
      aiFiles,
      humanFiles,
    };
  } catch (err) {
    console.error("AI authorship analysis failed (non-fatal):", err);
    return null;
  }
}
