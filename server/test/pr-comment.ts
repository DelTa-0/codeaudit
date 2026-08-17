// The PR comment is the most attacker-visible output in the product: package
// names, file paths and LLM reasoning all reach it from a scanned repository
// and it is posted publicly. These checks cover the new cross-scan delta and
// re-assert the escaping that stops a crafted name forging report structure.
// Run: npm run test:pr-comment
import { buildPrCommentBody, type PrCommentSummary } from "../src/queue/prComment.js";

const base: PrCommentSummary = {
  score: 76,
  grade: "B",
  scoreVersion: 2,
  axes: { security: 76, supplyChain: 90, maintainability: 88 },
  counts: {
    phantom: 0, suspicious: 0, unused: 2, healthy: 10, vulnerable: 0, zombies: 1,
    filesAnalyzed: 50, secrets: 0, agentConfig: 0, deprecated: 0, duplicates: 0,
    licenseConflicts: 0, hallucinated: 0, mcpRedefined: 0,
  },
  reviewStatus: "full",
} as unknown as PrCommentSummary;

const withDelta = (d: Partial<NonNullable<PrCommentSummary["findingDelta"]>>): PrCommentSummary => ({
  ...base,
  findingDelta: { new: 0, resolved: 0, reintroduced: 0, persisting: 0, openTotal: 0, byKind: {}, ...d },
});

const noDelta = buildPrCommentBody(base, 82);
const mixed = buildPrCommentBody(withDelta({ new: 2, resolved: 1, openTotal: 7 }), 82);
const regressed = buildPrCommentBody(withDelta({ reintroduced: 1, openTotal: 4 }), 82);
const quiet = buildPrCommentBody(withDelta({ persisting: 3, openTotal: 3 }), 82);

const checks: [string, boolean][] = [
  ["a scan with no delta data omits the change line entirely", !noDelta.includes("Since the last scan")],
  ["the score delta still renders", noDelta.includes("(-6.0)")],
  ["new findings are reported", mixed.includes("**2** new")],
  ["resolved findings are reported", mixed.includes("**1** resolved")],
  ["the open total is reported", mixed.includes("7 open in total")],
  // A returning finding means an earlier fix regressed. Folding it into "new"
  // would tell the reviewer to fix something they already thought was done.
  ["a reintroduced finding is named as such, not as new", regressed.includes("**1** reintroduced") && !regressed.includes("**1** new")],
  ["a reintroduction escalates the recommendation", regressed.includes("previously fixed finding has come back")],
  ["an unchanged scan says so rather than showing zeros", quiet.includes("no change") && quiet.includes("3 open in total")],
];

// Escaping regression: a crafted package name must not forge report structure.
const hostile = buildPrCommentBody(
  {
    ...base,
    priorities: [
      {
        rank: 1, band: "critical", kind: "phantom_dependency",
        title: "## Fake heading\n| forged | row |",
        location: "src/a.ts", why: "x", effort: "S", confidence: 1,
      },
    ],
  } as unknown as PrCommentSummary,
  82,
);
checks.push(
  ["a crafted finding title cannot forge a heading", !hostile.includes("\n## Fake heading")],
  ["a crafted finding title cannot forge a table row", !/\n\| forged \| row \|/.test(hostile)],
);

console.log("--- pr comment ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
if (failed) { console.error(`${failed} check(s) failed`); process.exit(1); }
