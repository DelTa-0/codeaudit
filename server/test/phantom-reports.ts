// The flywheel's intake upsert, against a real database. The behaviour worth
// guarding: N reports of one name are ONE row with a count — a table growing
// a row per report would let one noisy client bury the review queue, and the
// review queue is the human gate that keeps a poisoner out of the corpus.
// Run: npm run test:phantom-reports   (needs docker compose up -d postgres)
import { query, pool } from "../src/db/pool.js";
import { recordPhantomReport } from "../src/services/phantomReports.js";

const name = `test-phantom-${process.pid}`;
const checks: [string, boolean][] = [];

const first = await recordPhantomReport(name, "npm");
const second = await recordPhantomReport(name, "npm");
const third = await recordPhantomReport(name, "npm");
checks.push(
  ["the first report creates the row at count 1", first.reportCount === 1],
  ["repeat reports increment, never duplicate", second.reportCount === 2 && third.reportCount === 3],
);

const otherEco = await recordPhantomReport(name, "pypi");
checks.push(["the same name in another ecosystem is its own row", otherEco.reportCount === 1]);

const [row] = await query<{ n: string; review_state: string | null }>(
  "SELECT count(*)::text AS n, min(review_state) AS review_state FROM phantom_reports WHERE package_name = $1",
  [name],
);
checks.push(
  ["exactly two rows exist across both ecosystems", row.n === "2"],
  ["new reports start unreviewed — promotion is a human act, never automatic", row.review_state === null],
);

await query("DELETE FROM phantom_reports WHERE package_name = $1", [name]);

console.log("--- phantom reports ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
await pool.end();
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
