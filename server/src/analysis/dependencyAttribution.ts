// Where each dependency came from.
//
// The scan already knows a package is unused, suspicious or vulnerable. What
// it cannot say is the thing that decides what to do about it: who added this,
// when, and was an assistant involved. "axios, unused" is a chore; "axios,
// unused, added twelve commits ago by an AI-assisted commit, never imported"
// is a story about how the codebase is accumulating debt.
//
// Implementation note: the obvious approach — `git log -S<name>` per package —
// is one git invocation per dependency, so fifty dependencies means fifty
// process spawns. This walks the manifest's own history once instead
// (typically a few dozen commits at most) and diffs the dependency set between
// consecutive revisions, which is O(manifest commits) rather than
// O(dependencies) and gives the introducing commit for every package in a
// single pass.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { simpleGit, type SimpleGit } from "simple-git";
import { parseManifest, parsePythonManifest } from "@codeaudit/engine";

export interface DependencyAttribution {
  packageName: string;
  introducedCommit: string | null;
  introducedAuthor: string | null;
  introducedAt: string | null;
  /**
   * Repository commits between the introduction and HEAD.
   *
   * Counted over the whole log, not over the manifest's own history. Measuring
   * manifest revisions made a dependency added before three unrelated commits
   * still report "1 commit ago", which reads as "just added" and is the
   * opposite of the truth.
   */
  commitsAgo: number | null;
  /**
   * Deliberately three-valued.
   *
   * "unlikely" is only ever claimed when this repository has enough AI markers
   * for their absence to mean something (attribution level "usable"). In a
   * repository where nothing is marked, an unmarked commit is not evidence of
   * a human — inline completions leave no trace — so the honest answer is
   * "unknown". Saying "unlikely" there would manufacture confidence the data
   * cannot support, which is the same trap as reporting 0% AI.
   */
  aiAssisted: "likely" | "unlikely" | "unknown";
  /**
   * Present already in the oldest commit we can see. The clone is shallow
   * (--depth 100), so this is "older than our window", never "original".
   */
  predatesHistory: boolean;
}

/** Manifests whose dependency lists are worth attributing. */
const MANIFESTS = ["package.json", "requirements.txt", "pyproject.toml"];

/** Bounded like the rest of the history work — see analysis/clone.ts. */
const MAX_MANIFEST_COMMITS = 200;

async function depNamesAt(git: SimpleGit, sha: string, manifest: string): Promise<Set<string>> {
  const names = new Set<string>();
  let content: string;
  try {
    content = await git.raw(["show", `${sha}:${manifest}`]);
  } catch {
    return names; // file did not exist at that commit
  }
  // Reuse the engine's real parsers rather than re-implementing three manifest
  // formats here; a second set of parsing rules would drift from the ones that
  // produce the findings being attributed.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeaudit-attr-"));
  try {
    fs.writeFileSync(path.join(dir, path.basename(manifest)), content);
    if (manifest.endsWith("package.json")) {
      const parsed = parseManifest(dir);
      for (const n of Object.keys(parsed?.dependencies ?? {})) names.add(n);
      for (const n of Object.keys(parsed?.devDependencies ?? {})) names.add(n);
    } else {
      for (const n of Object.keys(parsePythonManifest(dir)?.dependencies ?? {})) names.add(n);
    }
  } catch {
    // Unparseable revision (mid-merge conflict markers, say) — contributes
    // nothing rather than aborting the walk.
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  return names;
}

/**
 * Attributes every dependency to the commit that introduced it.
 *
 * Best-effort throughout: a repository with no git history, an unreadable
 * manifest or a shallow clone yields fewer attributions, never an error. The
 * caller treats a missing attribution as "unknown", which is the truthful
 * rendering anyway.
 */
export async function attributeDependencies(
  repoDir: string,
  options: {
    aiCommits: Set<string>;
    attributionUsable: boolean;
    /** Full log, newest first — position in it is the "N commits ago" answer. */
    commitOrder?: string[];
  },
): Promise<Map<string, DependencyAttribution>> {
  const distanceFromHead = new Map<string, number>();
  (options.commitOrder ?? []).forEach((sha, i) => distanceFromHead.set(sha, i));
  const out = new Map<string, DependencyAttribution>();
  const git = simpleGit(repoDir);

  for (const manifest of MANIFESTS) {
    let log: string;
    try {
      log = await git.raw([
        "log",
        `--max-count=${MAX_MANIFEST_COMMITS}`,
        "--format=%H%x02%an%x02%aI",
        "--reverse",
        "--",
        manifest,
      ]);
    } catch {
      continue;
    }
    const commits = log
      .split("\n")
      .filter(Boolean)
      .map((line) => line.split("\x02"));
    if (!commits.length) continue;

    const total = commits.length;
    let previous = new Set<string>();
    for (let i = 0; i < total; i++) {
      const [sha, author, isoDate] = commits[i];
      const current = await depNamesAt(git, sha, manifest);
      for (const name of current) {
        if (previous.has(name) || out.has(name)) continue;
        // Everything present at the first commit we can see was introduced at
        // or before it. With a shallow clone that is nearly always "before".
        const predatesHistory = i === 0;
        out.set(name, {
          packageName: name,
          introducedCommit: predatesHistory ? null : sha,
          introducedAuthor: predatesHistory ? null : author,
          introducedAt: predatesHistory ? null : isoDate,
          // Falls back to manifest distance only when the caller gave us no
          // full log to measure against.
          commitsAgo: predatesHistory ? null : (distanceFromHead.get(sha) ?? total - 1 - i),
          aiAssisted: predatesHistory
            ? "unknown"
            : aiVerdict(sha, options.aiCommits, options.attributionUsable),
          predatesHistory,
        });
      }
      previous = current;
    }
  }
  return out;
}

function aiVerdict(
  sha: string,
  aiCommits: Set<string>,
  attributionUsable: boolean,
): DependencyAttribution["aiAssisted"] {
  if (aiCommits.has(sha)) return "likely";
  return attributionUsable ? "unlikely" : "unknown";
}
