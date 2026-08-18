// Regression guard for the free-tier boundary. This exists because the real
// PLANS table was once replaced wholesale with a "// TESTING:" override that
// gave every tier team-level (effectively unlimited) limits — a live billing
// regression that sat in the codebase, not just an untested feature. See
// docs/known-issues.md / docs/roadmap.md. This test fails loudly if the free
// tier ever again becomes indistinguishable from a paid one.
// Run: npm run test:plan-limits
import { PLANS, resolveOrgPlan } from "../src/services/plans.js";

const checks: [string, boolean][] = [
  ["free.totalRepos is finite and > 0", Number.isFinite(PLANS.free.totalRepos) && PLANS.free.totalRepos > 0],
  ["free.privateRepos is finite and > 0", Number.isFinite(PLANS.free.privateRepos) && PLANS.free.privateRepos > 0],
  ["free.scansPerDay is finite and > 0", Number.isFinite(PLANS.free.scansPerDay) && PLANS.free.scansPerDay > 0],
  ["free.webhookScans is false (Pro+ feature)", PLANS.free.webhookScans === false],
  ["pro allows strictly more repos than free", PLANS.pro.totalRepos > PLANS.free.totalRepos],
  ["pro allows strictly more scans/day than free", PLANS.pro.scansPerDay > PLANS.free.scansPerDay],
  ["team is not more restrictive than pro", PLANS.team.totalRepos >= PLANS.pro.totalRepos],
];

// --- beta override: the tiers stay defined, enforcement is lifted ---------
// resolveOrgPlan is pure, so both branches are checked with no DB and no env.
const betaPlan = resolveOrgPlan(null, true);
const freeFallback = resolveOrgPlan(null, false);
const paidActive = resolveOrgPlan({ plan: "pro", plan_status: "active" }, false);
const paidLapsed = resolveOrgPlan({ plan: "pro", plan_status: "canceled" }, false);
checks.push(
  ["beta mode reports the beta plan regardless of stored plan", betaPlan.plan === "beta"],
  ["beta mode lifts the free repo cap well above 3", betaPlan.limits.totalRepos >= 50],
  ["beta mode enables webhook scans for everyone", betaPlan.limits.webhookScans === true],
  // The abuse brake: generous is not infinite.
  ["beta mode keeps a finite daily scan ceiling", Number.isFinite(betaPlan.limits.scansPerDay) && betaPlan.limits.scansPerDay > 0],
  ["without beta, no org falls back to free", freeFallback.plan === "free"],
  ["without beta, an active paid plan is honoured", paidActive.plan === "pro" && paidActive.limits.webhookScans === true],
  // A lapsed subscription must drop to free, or a cancelled card keeps its perks.
  ["without beta, a non-active paid plan drops to free", paidLapsed.plan === "free"],
);

console.log("--- plan limit checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
