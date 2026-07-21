// Regression guard for the free-tier boundary. This exists because the real
// PLANS table was once replaced wholesale with a "// TESTING:" override that
// gave every tier team-level (effectively unlimited) limits — a live billing
// regression that sat in the codebase, not just an untested feature. See
// docs/known-issues.md / docs/roadmap.md. This test fails loudly if the free
// tier ever again becomes indistinguishable from a paid one.
// Run: npm run test:plan-limits
import { PLANS } from "../src/services/plans.js";

const checks: [string, boolean][] = [
  ["free.totalRepos is finite and > 0", Number.isFinite(PLANS.free.totalRepos) && PLANS.free.totalRepos > 0],
  ["free.privateRepos is finite and > 0", Number.isFinite(PLANS.free.privateRepos) && PLANS.free.privateRepos > 0],
  ["free.scansPerDay is finite and > 0", Number.isFinite(PLANS.free.scansPerDay) && PLANS.free.scansPerDay > 0],
  ["free.webhookScans is false (Pro+ feature)", PLANS.free.webhookScans === false],
  ["pro allows strictly more repos than free", PLANS.pro.totalRepos > PLANS.free.totalRepos],
  ["pro allows strictly more scans/day than free", PLANS.pro.scansPerDay > PLANS.free.scansPerDay],
  ["team is not more restrictive than pro", PLANS.team.totalRepos >= PLANS.pro.totalRepos],
];

console.log("--- plan limit checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
