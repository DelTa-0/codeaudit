import { query, queryOne } from "../db/pool.js";
import { paymentRequired } from "../lib/errors.js";
import { config } from "../lib/config.js";

export interface PlanLimits {
  privateRepos: number;
  totalRepos: number;
  webhookScans: boolean;
  scansPerDay: number;
}

export const PLANS: Record<string, PlanLimits> = {
  free: { privateRepos: 1, totalRepos: 3, webhookScans: false, scansPerDay: 10 },
  pro: { privateRepos: 10, totalRepos: 25, webhookScans: true, scansPerDay: 200 },
  team: { privateRepos: Infinity, totalRepos: Infinity, webhookScans: true, scansPerDay: 2000 },
};

/**
 * What every org gets while `BETA_UNLIMITED_PLANS` is on: generous, but still
 * finite. Not `Infinity` on scans — a per-org daily ceiling is the abuse
 * brake that keeps one account from turning a free beta into a crypto-miner's
 * free CI. Webhook auto-scans are ON so beta users can try the full product,
 * including the merge gate and PR comments.
 */
const BETA_LIMITS: PlanLimits = {
  privateRepos: 25,
  totalRepos: 100,
  webhookScans: true,
  scansPerDay: 300,
};

/**
 * Pure plan resolution — the policy, with the database read lifted out so it
 * is testable without a connection and without env-import gymnastics. During
 * the public beta every org resolves to the generous BETA limits; otherwise
 * the stored plan applies (defaulting to free unless the subscription is
 * active).
 */
export function resolveOrgPlan(
  org: { plan: string; plan_status: string } | null,
  betaUnlimited: boolean,
): { plan: string; limits: PlanLimits } {
  if (betaUnlimited) return { plan: "beta", limits: BETA_LIMITS };
  const plan = org && org.plan_status === "active" ? org.plan : "free";
  return { plan, limits: PLANS[plan] ?? PLANS.free };
}

export async function getOrgPlan(orgId: string): Promise<{ plan: string; limits: PlanLimits }> {
  // Beta short-circuits the DB read entirely — no point querying a plan we are
  // not going to enforce.
  if (config.betaUnlimited) return resolveOrgPlan(null, true);
  const org = await queryOne<{ plan: string; plan_status: string }>(
    "SELECT plan, plan_status FROM organizations WHERE id = $1",
    [orgId],
  );
  return resolveOrgPlan(org, false);
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
