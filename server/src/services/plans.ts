import { query, queryOne } from "../db/pool.js";
import { paymentRequired } from "../lib/errors.js";

export interface PlanLimits {
  privateRepos: number;
  totalRepos: number;
  webhookScans: boolean;
  scansPerDay: number;
}

// TESTING: Stripe/plan-limit gate temporarily disabled — every tier gets team-level
// limits so the product can be exercised end-to-end without billing. Orgs still
// display their real plan name in the UI; only the enforced limits are unified.
// Revert by restoring the commented values below once billing testing resumes.
export const PLANS: Record<string, PlanLimits> = {
  free: { privateRepos: Infinity, totalRepos: Infinity, webhookScans: true, scansPerDay: Infinity },
  pro: { privateRepos: Infinity, totalRepos: Infinity, webhookScans: true, scansPerDay: Infinity },
  team: { privateRepos: Infinity, totalRepos: Infinity, webhookScans: true, scansPerDay: Infinity },
};
// const PLANS_PRODUCTION: Record<string, PlanLimits> = {
//   free: { privateRepos: 1, totalRepos: 3, webhookScans: false, scansPerDay: 10 },
//   pro: { privateRepos: 10, totalRepos: 25, webhookScans: true, scansPerDay: 200 },
//   team: { privateRepos: Infinity, totalRepos: Infinity, webhookScans: true, scansPerDay: 2000 },
// };

export async function getOrgPlan(orgId: string): Promise<{ plan: string; limits: PlanLimits }> {
  const org = await queryOne<{ plan: string; plan_status: string }>(
    "SELECT plan, plan_status FROM organizations WHERE id = $1",
    [orgId],
  );
  const plan = org && org.plan_status === "active" ? org.plan : "free";
  return { plan, limits: PLANS[plan] ?? PLANS.free };
}

export async function assertCanAddRepo(orgId: string, isPrivate: boolean) {
  const { plan, limits } = await getOrgPlan(orgId);
  const [counts] = await query<{ total: string; priv: string }>(
    `SELECT count(*) AS total, count(*) FILTER (WHERE private) AS priv
     FROM repositories WHERE org_id = $1`,
    [orgId],
  );
  if (Number(counts.total) >= limits.totalRepos)
    throw paymentRequired(`The ${plan} plan allows ${limits.totalRepos} repositories. Upgrade to add more.`);
  if (isPrivate && Number(counts.priv) >= limits.privateRepos)
    throw paymentRequired(`The ${plan} plan allows ${limits.privateRepos} private repositories. Upgrade to add more.`);
}

export async function assertCanScan(orgId: string, trigger: string) {
  const { plan, limits } = await getOrgPlan(orgId);
  if (trigger !== "manual" && !limits.webhookScans)
    throw paymentRequired(`Webhook-triggered scans require the Pro plan.`);
  const [row] = await query<{ n: string }>(
    "SELECT count(*) AS n FROM scan_jobs WHERE org_id = $1 AND created_at > now() - interval '1 day'",
    [orgId],
  );
  if (Number(row.n) >= limits.scansPerDay)
    throw paymentRequired(`Daily scan limit reached for the ${plan} plan (${limits.scansPerDay}/day).`);
}
