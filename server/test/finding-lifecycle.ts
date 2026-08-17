// Finding lifecycle across scans — runs against a real database, because the
// behaviour under test IS the SQL: which rows a scan is allowed to change, and
// which it must leave alone.
//
// The case that matters most is the third one. A scan must never reopen or
// resolve a finding a human has ignored; if it could, dismissing a false
// positive would last exactly until the next push, and nobody would use the
// feature twice.
//
// Run: npm run test:finding-lifecycle   (needs docker compose up -d postgres)
import { query, pool } from "../src/db/pool.js";
import { reconcileFindings } from "../src/services/findingLifecycle.js";
import {
  dependencyFindingIdentity,
  deadCodeFindingIdentity,
  agentConfigFindingIdentity,
  type FindingIdentity,
} from "@codeaudit/engine";

const checks: [string, boolean][] = [];
const suffix = process.pid;

const [org] = await query<{ id: string }>(
  "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
  [`lifecycle-test-${suffix}`, `lifecycle-test-${suffix}`],
);
const [repo] = await query<{ id: string }>(
  "INSERT INTO repositories (org_id, full_name) VALUES ($1, $2) RETURNING id",
  [org.id, `test/lifecycle-${suffix}`],
);

async function newScan(): Promise<string> {
  const [row] = await query<{ id: string }>(
    "INSERT INTO scan_jobs (repo_id, org_id, trigger, status) VALUES ($1, $2, 'manual', 'complete') RETURNING id",
    [repo.id, org.id],
  );
  return row.id;
}

const axiosUnused = dependencyFindingIdentity({
  packageName: "axios",
  ecosystem: "npm",
  status: "unused",
});
const deadHelper = deadCodeFindingIdentity({ filePath: "src/a.ts", symbolName: "helper" });
const injection = agentConfigFindingIdentity({
  filePath: "CLAUDE.md",
  rule: "instruction_injection",
});

// --- scan 1: everything is new -------------------------------------------
const d1 = await reconcileFindings(repo.id, await newScan(), [axiosUnused, deadHelper, injection]);
checks.push(
  ["first scan reports every finding as new", d1.new === 3],
  ["first scan resolves nothing", d1.resolved === 0],
  ["first scan reintroduces nothing", d1.reintroduced === 0],
  ["open total reflects the three findings", d1.openTotal === 3],
  ["the delta is broken down by kind", d1.byKind.dependency?.new === 1 && d1.byKind.dead_code?.new === 1],
);

// --- scan 2: the dependency is removed, the rest persist ------------------
const d2 = await reconcileFindings(repo.id, await newScan(), [deadHelper, injection]);
checks.push(
  ["a finding absent from the next scan is resolved", d2.resolved === 1],
  ["resolution is attributed to the right kind", d2.byKind.dependency?.resolved === 1],
  ["findings still present are persisting, not new", d2.persisting === 2 && d2.new === 0],
  ["open total drops as findings are fixed", d2.openTotal === 2],
);

// --- scan 3: the dependency comes back -----------------------------------
const d3 = await reconcileFindings(repo.id, await newScan(), [axiosUnused, deadHelper, injection]);
checks.push(
  // The distinction that matters: a returning finding is a regressed fix, not
  // a new problem. Counting it as "new" would hide that the fix failed.
  ["a fixed finding that returns is reintroduced, not new", d3.reintroduced === 1 && d3.new === 0],
  ["reintroduction is attributed by kind", d3.byKind.dependency?.reintroduced === 1],
);

const [axiosRow] = await query<{
  state: string;
  times_seen: number;
  times_reintroduced: number;
  fixed_at: string | null;
  reintroduced_at: string | null;
}>(
  "SELECT state, times_seen, times_reintroduced, fixed_at, reintroduced_at FROM finding_lifecycle WHERE repo_id = $1 AND finding_key = $2",
  [repo.id, axiosUnused.key],
);
checks.push(
  ["a reintroduced finding is open again", axiosRow.state === "open"],
  ["reintroduction count is recorded", Number(axiosRow.times_reintroduced) === 1],
  ["fixed_at is cleared on reintroduction", axiosRow.fixed_at === null],
  ["reintroduced_at is stamped", axiosRow.reintroduced_at !== null],
  // Counts scans that SAW it, not scans that ran: seen in 1 and 3, absent
  // from 2. That is what makes it usable as "how long has this been around".
  ["sightings count only the scans that saw it", Number(axiosRow.times_seen) === 2],
);

// --- scan 4: a human ignores the dead-code finding ------------------------
await query("UPDATE finding_lifecycle SET state = 'ignored', note = $3 WHERE repo_id = $1 AND finding_key = $2", [
  repo.id,
  deadHelper.key,
  "framework entry point",
]);
// Still present — must stay ignored, not be flipped back to open.
const d4 = await reconcileFindings(repo.id, await newScan(), [axiosUnused, deadHelper, injection]);
const [ignoredStillPresent] = await query<{ state: string; note: string | null }>(
  "SELECT state, note FROM finding_lifecycle WHERE repo_id = $1 AND finding_key = $2",
  [repo.id, deadHelper.key],
);
checks.push(
  ["a scan does not reopen a finding a human ignored", ignoredStillPresent.state === "ignored"],
  ["the human's note survives a rescan", ignoredStillPresent.note === "framework entry point"],
  ["an ignored finding is not counted as open", d4.openTotal === 2],
);

// --- scan 5: the ignored finding disappears -------------------------------
const d5 = await reconcileFindings(repo.id, await newScan(), [axiosUnused, injection]);
const [ignoredGone] = await query<{ state: string }>(
  "SELECT state FROM finding_lifecycle WHERE repo_id = $1 AND finding_key = $2",
  [repo.id, deadHelper.key],
);
checks.push(
  // Claiming credit for "fixing" something that was dismissed would inflate
  // the resolved count with work nobody did.
  ["an ignored finding going away is not counted as resolved", d5.resolved === 0],
  ["an ignored finding stays ignored rather than becoming fixed", ignoredGone.state === "ignored"],
);

// --- identity: status is part of a dependency's identity ------------------
const axiosVulnerable = dependencyFindingIdentity({
  packageName: "axios",
  ecosystem: "npm",
  status: "vulnerable",
});
const d6 = await reconcileFindings(repo.id, await newScan(), [axiosVulnerable, injection]);
checks.push(
  // "axios is unused" and "axios has a CVE" are different problems with
  // different fixes; collapsing them would silently reclassify a cleanup as a
  // security issue.
  ["the same package with a new status is a new finding", d6.new === 1],
  ["the previous status of that package resolves", d6.resolved === 1],
);

// --- duplicate identities within one scan ---------------------------------
const d7 = await reconcileFindings(repo.id, await newScan(), [
  axiosVulnerable,
  axiosVulnerable,
  injection,
]);
checks.push(["the same finding reported twice in one scan counts once", d7.persisting === 2]);

await query("DELETE FROM organizations WHERE id = $1", [org.id]);

console.log("--- finding lifecycle ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
await pool.end();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
