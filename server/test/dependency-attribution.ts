// Dependency attribution against a real git repository built here, because
// the behaviour under test is entirely about reading history correctly.
//
// The case worth protecting is the three-valued AI verdict. "unlikely" must
// only ever be claimed on a repository that has enough AI markers for their
// absence to mean something — otherwise an unmarked commit gets reported as
// human when the truth is that inline completions leave no trace, and the
// whole AI-risk story is built on a number that quietly invents confidence.
// Run: npm run test:dependency-attribution
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { attributeDependencies } from "../src/analysis/dependencyAttribution.js";
import { collectAiCommitHashes, describeCoverage } from "../src/analysis/aiAuthorship.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "codeaudit-attr-test-"));
const git = (...args: string[]) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });

git("init", "-q");
git("config", "user.email", "t@t.t");
git("config", "user.name", "Alice Human");

function manifest(deps: Record<string, string>) {
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name: "t", dependencies: deps }));
}
function commit(message: string) {
  git("add", "-A");
  git("commit", "-q", "-m", message);
}
const AI_TRAILER = "\n\nCo-Authored-By: Claude Opus 5 <noreply@anthropic.com>";

manifest({ lodash: "^4.0.0" });
commit("initial deps");
manifest({ lodash: "^4.0.0", express: "^4.0.0" });
commit("add express");
manifest({ lodash: "^4.0.0", express: "^4.0.0", axios: "^1.0.0" });
commit(`add axios${AI_TRAILER}`);

async function attribute() {
  const { ai, commits } = await collectAiCommitHashes(dir);
  const usable = describeCoverage(ai.size, commits.length, false).level === "usable";
  const map = await attributeDependencies(dir, {
    aiCommits: ai,
    attributionUsable: usable,
    commitOrder: commits.map(([sha]) => sha),
  });
  return { map, usable, aiCount: ai.size, total: commits.length };
}

const checks: [string, boolean][] = [];

// --- weak coverage: absence of a marker proves nothing ---------------------
const weak = await attribute();
const weakExpress = weak.map.get("express");
const weakAxios = weak.map.get("axios");
const weakLodash = weak.map.get("lodash");
checks.push(
  ["the introducing commit is identified", weakAxios?.introducedCommit !== null],
  ["the introducing author is captured", weakExpress?.introducedAuthor === "Alice Human"],
  ["an AI-trailered introduction reads as likely", weakAxios?.aiAssisted === "likely"],
  // The honesty rule: one marked commit is not enough to make silence mean
  // "human", so an unmarked introduction stays unknown.
  ["with weak coverage an unmarked introduction is unknown, not unlikely", weakExpress?.aiAssisted === "unknown"],
  // Present at the first visible commit — with a shallow clone that means
  // "older than we can see", never "this is where it came from".
  ["a dependency present at the oldest visible commit predates history", weakLodash?.predatesHistory === true],
  ["a predating dependency claims no commit or author", weakLodash?.introducedCommit === null && weakLodash?.introducedAuthor === null],
  ["a predating dependency makes no AI claim", weakLodash?.aiAssisted === "unknown"],
);

// --- usable coverage: absence starts to mean something ---------------------
for (let i = 1; i <= 3; i++) {
  fs.writeFileSync(path.join(dir, `f${i}.txt`), `x${i}`);
  commit(`ai work ${i}${AI_TRAILER}`);
}
const strong = await attribute();
const strongExpress = strong.map.get("express");
const strongAxios = strong.map.get("axios");
checks.push(
  ["enough markers makes coverage usable", strong.usable === true],
  ["with usable coverage an unmarked introduction becomes unlikely", strongExpress?.aiAssisted === "unlikely"],
  ["a marked introduction stays likely regardless of coverage", strongAxios?.aiAssisted === "likely"],
  // Measured over the whole log, not the manifest's own revisions: three
  // unrelated commits landed after axios, so "commits ago" must move.
  ["commits-ago counts repository commits, not manifest revisions", strongAxios?.commitsAgo === 3],
  ["an older dependency reports a larger distance", (strongExpress?.commitsAgo ?? 0) > (strongAxios?.commitsAgo ?? 0)],
);

fs.rmSync(dir, { recursive: true, force: true });

console.log("--- dependency attribution ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
