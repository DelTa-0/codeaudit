import { Router, raw } from "express";
import { query, queryOne } from "../db/pool.js";
import { verifyWebhookSignature } from "../services/github.js";
import { scanQueue } from "../queue/index.js";
import { getOrgPlan } from "../services/plans.js";

export const webhooksRouter = Router();

// Raw body is required for HMAC verification — mounted before express.json().
webhooksRouter.post("/github", raw({ type: "*/*", limit: "1mb" }), async (req, res) => {
  if (!verifyWebhookSignature(req.body as Buffer, req.headers["x-hub-signature-256"] as string)) {
    return res.status(401).json({ error: "Invalid signature" });
  }

  const event = req.headers["x-github-event"] as string;
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse((req.body as Buffer).toString("utf8"));
  } catch {
    return res.status(400).json({ error: "Invalid JSON" });
  }

  try {
    switch (event) {
      case "installation": {
        const installation = payload.installation as {
          id: number;
          account?: { login?: string };
        };
        const action = payload.action as string;
        if (action === "deleted") {
          await query("DELETE FROM github_installations WHERE installation_id = $1", [
            installation.id,
          ]);
        }
        // "created" is recorded when a signed-in user completes the install flow
        // (POST /api/github/installations) so we know which org owns it.
        break;
      }
      case "push": {
        const repoFullName = (payload.repository as { full_name: string }).full_name;
        const ref = payload.ref as string; // refs/heads/<branch>
        const branch = ref?.replace("refs/heads/", "");
        const sha = payload.after as string;
        await enqueueWebhookScan(repoFullName, "push", { branch, sha });
        break;
      }
      case "pull_request": {
        const action = payload.action as string;
        if (!["opened", "synchronize", "reopened"].includes(action)) break;
        const pr = payload.pull_request as {
          number: number;
          head: { ref: string; sha: string };
        };
        const repoFullName = (payload.repository as { full_name: string }).full_name;
        await enqueueWebhookScan(repoFullName, "pull_request", {
          branch: pr.head.ref,
          sha: pr.head.sha,
          prNumber: pr.number,
        });
        break;
      }
    }
    res.json({ ok: true });
  } catch (err) {
    console.error("webhook handling failed", err);
    // Always 200 after signature check so GitHub doesn't disable the hook.
    res.json({ ok: false });
  }
});

async function enqueueWebhookScan(
  repoFullName: string,
  trigger: "push" | "pull_request",
  opts: { branch?: string; sha?: string; prNumber?: number },
) {
  const repos = await query<{ id: string; org_id: string }>(
    "SELECT id, org_id FROM repositories WHERE full_name = $1 AND webhook_enabled = true",
    [repoFullName],
  );
  for (const repo of repos) {
    const { limits } = await getOrgPlan(repo.org_id);
    if (!limits.webhookScans) continue; // plan downgraded since enabling
    const [scan] = await query<{ id: string }>(
      `INSERT INTO scan_jobs (repo_id, org_id, trigger, branch, commit_sha, pr_number)
       VALUES ($1, $2, $3, $4, $5, $6) RETURNING id`,
      [repo.id, repo.org_id, trigger, opts.branch ?? null, opts.sha ?? null, opts.prNumber ?? null],
    );
    await scanQueue.add("scan", { scanJobId: scan.id });
  }
}
