// Run our own detectors against this repository.
//
// This exists because of a real miss. A scan of this repo reported five
// hardcoded secrets, and every one was a false positive — including
// packages/engine/src/secrets.ts, where the *detector's own comment* quoting
// "-----BEGIN RSA PRIVATE KEY-----" was reported as a leaked private key.
//
// The fixture suites never caught it, and could not have: fixtures contain
// realistic secrets, and the false positives came from prose *about* secrets —
// design documents, explanatory comments, test assertions. That whole class is
// invisible to a fixture and obvious to a self-scan.
//
// It is also the check that matters most for the product's credibility. A
// security tool that cannot scan its own repository cleanly is not one anyone
// should point at theirs.
//
// Deliberately offline: secret and agent-config detection do no network I/O,
// so this is hermetic and can block CI, unlike the registry-backed suites.
// Run: npm run test:self-scan
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findSecrets, findAgentConfigIssues } from "@codeaudit/engine";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");

const secrets = findSecrets(repoRoot);
const agentFindings = findAgentConfigIssues(repoRoot);
const severe = agentFindings.filter((f) => f.severity === "critical" || f.severity === "high");

console.log("--- self scan ---");
if (secrets.length) {
  console.log("secrets reported:");
  for (const s of secrets) console.log(`  ${s.provider}  ${s.filePath}:${s.line}  ${s.redacted}`);
}
if (severe.length) {
  console.log("critical/high agent-config findings:");
  for (const f of severe) console.log(`  ${f.severity} ${f.rule}  ${f.filePath}:${f.line}`);
}

const checks: [string, boolean][] = [
  // Zero, not "few". This repository contains no credentials, so any finding
  // here is a false positive by definition — which makes it the cleanest
  // possible precision regression test.
  ["this repository scans clean for secrets", secrets.length === 0],
  // Medium findings are allowed through: mcp_package_suspicious fires on our
  // own codeorion-mcp because it genuinely is new with low downloads. That is
  // a correct finding, and special-casing self-reference is the wrong instinct
  // for a security tool — so the gate is on critical/high only.
  ["this repository has no critical or high agent-config findings", severe.length === 0],
];

let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(
    `${failed} check(s) failed — a detector has regressed in precision, or something real was committed. ` +
      `Read the listing above before assuming it is a false positive.`,
  );
  process.exit(1);
}
