import { queryOne } from "../db/pool.js";
import { upsertPrComment, githubConfigured } from "../services/github.js";
import type { ScanSummary, RankedFinding } from "@codeaudit/engine";
import type { FindingDelta } from "../services/findingLifecycle.js";

/**
 * Package names reach this comment as raw JSON keys from the scanned repo's
 * package.json, file paths come from its git tree, and reasoning text can come
 * from an LLM — all attacker-influencable, and this comment is posted publicly
 * on the pull request. Collapse whitespace so nothing can forge new lines,
 * table rows or list items, and escape the metacharacters that would let a
 * crafted name smuggle in a link, an image, or fake report structure.
 * Mirrors the escaping already applied to exported reports (docs/decisions.md).
 */
function mdSafe(value: string, max = 200): string {
  const collapsed = String(value).replace(/\s+/g, " ").trim();
  const escaped = collapsed
    .replace(/[\\`*[\]|<>~]/g, "\\$&")
    // Only the FIRST character can open a block construct once whitespace is
    // collapsed to a single line, so escaping it there closes heading,
    // blockquote, thematic-break and Setext-underline forgery while leaving
    // ordinary names like "date-fns" readable.
    .replace(/^([#>\-=+])/, "\\$1");
  return escaped.length > max ? `${escaped.slice(0, max - 1)}…` : escaped;
}

/**
 * Builds the comment markdown. Extracted from the job so the most
 * attacker-visible output in the product can be tested without a database, a
 * queue, or a GitHub installation.
 */
export function buildPrCommentBody(
  s: PrCommentSummary,
  previousScore: number | null,
): string {
  const delta = previousScore === null ? null : (s.score - previousScore).toFixed(1);
  const deltaText = delta === null ? "" : Number(delta) >= 0 ? ` (+${delta})` : ` (${delta})`;
  const vulnerable = s.counts.vulnerable ?? 0;
  const secretCount = s.counts.secrets ?? 0;
  const agentConfigCount = s.counts.agentConfig ?? 0;
  const recommendation =
    secretCount > 0 || s.counts.phantom > 0 || vulnerable > 0
      ? "🔴 **Request changes** — hardcoded secrets, phantom dependencies, and/or known vulnerabilities must be resolved before merge."
      : s.findingDelta?.reintroduced
        ? "🟡 **Review recommended** — a previously fixed finding has come back."
        : s.score < 60
        ? "🟡 **Review recommended** — health score below threshold."
        : "🟢 **Looks good** from a debt perspective.";

  // What actually changed, not just how many findings exist. A reviewer's
  // question is "did this PR make it worse", and a score delta alone cannot
  // answer it: -3 could be one new vulnerability or four dead-code
  // candidates. Reintroduced is called out separately because a returning
  // finding means a previous fix regressed, which "new" would disguise.
  const fd = s.findingDelta;
  const deltaLines: string[] = [];
  if (fd) {
    if (fd.new > 0) deltaLines.push(`🆕 **${fd.new}** new`);
    if (fd.reintroduced > 0) deltaLines.push(`♻️ **${fd.reintroduced}** reintroduced`);
    if (fd.resolved > 0) deltaLines.push(`✅ **${fd.resolved}** resolved`);
  }
  const changed = deltaLines.length
    ? `
**Since the last scan of the base branch:** ${deltaLines.join(" · ")} · ${fd!.openTotal} open in total
`
    : fd
      ? `
**Since the last scan of the base branch:** no change · ${fd.openTotal} open in total
`
      : "";

  // Lead with the ranked top three rather than a bare tally — a reviewer
  // should see what to act on first, not just how many findings exist.
  const topPriorities = (s.priorities ?? []).slice(0, 3);
  const fixFirst = topPriorities.length
    ? `\n**Fix first**\n\n${topPriorities
        .map(
          (p) =>
            `${p.rank}. **${mdSafe(p.title)}** \`${p.band}\` · effort ${p.effort}${p.location ? ` · \`${mdSafe(p.location, 120)}\`` : ""}\n   ${mdSafe(p.why, 300)}`,
        )
        .join("\n")}\n`
    : "";

  return `## CodeAudit report

**Health score: ${s.score} (${s.grade})${deltaText}**
${changed}${fixFirst}
| Finding | Count |
| --- | --- |
| 🔑 Hardcoded secrets | ${secretCount} |
| 🤖 Agent config risks | ${agentConfigCount} |
| 🚨 Phantom dependencies | ${s.counts.phantom} |
| 🛡️ Known vulnerabilities | ${vulnerable} |
| ⚠️ Suspicious packages | ${s.counts.suspicious} |
| 📦 Unused dependencies | ${s.counts.unused} |
| 🧟 Zombie code | ${s.counts.zombies} |

${recommendation}`;
}

/** The summary shape this comment needs, including the cross-scan delta. */
export type PrCommentSummary = ScanSummary & {
  priorities?: RankedFinding[];
  findingDelta?: FindingDelta;
};

export async function processPrCommentJob(scanJobId: string) {
  if (!githubConfigured()) return;

  const scan = await queryOne<{
    id: string;
    repo_id: string;
    pr_number: number | null;
    summary: PrCommentSummary | null;
  }>("SELECT id, repo_id, pr_number, summary FROM scan_jobs WHERE id = $1", [scanJobId]);
  if (!scan?.pr_number || !scan.summary) return;

  const repo = await queryOne<{ full_name: string; installation_id: string | null }>(
    `SELECT r.full_name, gi.installation_id
     FROM repositories r LEFT JOIN github_installations gi ON gi.id = r.installation_id
     WHERE r.id = $1`,
    [scan.repo_id],
  );
  if (!repo?.installation_id) return;

  const prev = await queryOne<{ score: string }>(
    `SELECT (summary->>'score') AS score FROM scan_jobs
     WHERE repo_id = $1 AND status = 'complete' AND id != $2 AND pr_number IS NULL
     ORDER BY created_at DESC LIMIT 1`,
    [scan.repo_id, scan.id],
  );

  const body = buildPrCommentBody(scan.summary, prev ? Number(prev.score) : null);

  await upsertPrComment(Number(repo.installation_id), repo.full_name, scan.pr_number, body);
  console.log(`[pr-comment] posted on ${repo.full_name}#${scan.pr_number}`);
}
