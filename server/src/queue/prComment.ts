import { queryOne } from "../db/pool.js";
import { upsertPrComment, githubConfigured } from "../services/github.js";
import type { ScanSummary } from "@codeaudit/engine";

export async function processPrCommentJob(scanJobId: string) {
  if (!githubConfigured()) return;

  const scan = await queryOne<{
    id: string;
    repo_id: string;
    pr_number: number | null;
    summary: ScanSummary | null;
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

  const s = scan.summary;
  const delta = prev ? (s.score - Number(prev.score)).toFixed(1) : null;
  const deltaText = delta === null ? "" : Number(delta) >= 0 ? ` (+${delta})` : ` (${delta})`;
  const vulnerable = s.counts.vulnerable ?? 0;
  const recommendation =
    s.counts.phantom > 0 || vulnerable > 0
      ? "🔴 **Request changes** — phantom dependencies and/or known vulnerabilities must be resolved before merge."
      : s.score < 60
        ? "🟡 **Review recommended** — health score below threshold."
        : "🟢 **Looks good** from a debt perspective.";

  const body = `## CodeAudit report

**Health score: ${s.score} (${s.grade})${deltaText}**

| Finding | Count |
| --- | --- |
| 🚨 Phantom dependencies | ${s.counts.phantom} |
| 🛡️ Known vulnerabilities | ${vulnerable} |
| ⚠️ Suspicious packages | ${s.counts.suspicious} |
| 📦 Unused dependencies | ${s.counts.unused} |
| 🧟 Zombie code | ${s.counts.zombies} |

${recommendation}`;

  await upsertPrComment(Number(repo.installation_id), repo.full_name, scan.pr_number, body);
  console.log(`[pr-comment] posted on ${repo.full_name}#${scan.pr_number}`);
}
