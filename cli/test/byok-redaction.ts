// End-to-end guard: with a BYOK key configured, the key must reach the LLM
// endpoint's Authorization header and nowhere else — not --json output, not
// the --upload request body. Spawns the built CLI as a real child process
// (same convention as mcp/test/ground-truth.ts) against two local mock HTTP
// servers: one standing in for the OpenAI-compatible chat-completions
// endpoint, one standing in for the CodeAudit --upload API.
// Requires: npm run build (cli) to have produced dist/index.js.
// Run: npm run test:byok-redaction
import http from "node:http";
import { spawn } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const cliPath = path.join(here, "..", "dist", "index.js");
// Reuses the server workspace's existing ground-truth fixture — it already
// has a dead-code candidate (zombieFormatter) and doesn't need its own copy.
const fixtureDir = path.join(here, "..", "..", "server", "test", "fixture");
// A tiny fixture with genuinely zero dead-code candidates (every symbol is
// called from within its own file) — used to regression-test that a no-key
// scan with zero candidates reports reviewStatus "skipped", not "full".
const zeroCandidatesFixtureDir = path.join(here, "fixture-zero-candidates");
const FAKE_KEY = "distinctive-fake-byok-key-9f8e7d6c5b4a";

function startMockServer(
  handler: (req: http.IncomingMessage, body: string, res: http.ServerResponse) => void,
): Promise<{ port: number; close: () => Promise<void>; requests: { authorization?: string; body: string }[] }> {
  const requests: { authorization?: string; body: string }[] = [];
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      let body = "";
      req.on("data", (chunk) => (body += chunk));
      req.on("end", () => {
        requests.push({ authorization: req.headers.authorization, body });
        handler(req, body, res);
      });
    });
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
      resolve({ port: address.port, close: () => new Promise((r) => server.close(() => r())), requests });
    });
  });
}

function runCli(args: string[], env: Record<string, string>): Promise<{ stdout: string; stderr: string; exitCode: number | null }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [cliPath, ...args], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (chunk) => (stdout += chunk));
    child.stderr.on("data", (chunk) => (stderr += chunk));
    child.on("close", (exitCode) => resolve({ stdout, stderr, exitCode }));
  });
}

const checks: [string, boolean][] = [];

// --- mock LLM endpoint: always returns a valid, minimal completion ---
const llmMock = await startMockServer((_req, _body, res) => {
  res.writeHead(200, { "content-type": "application/json" });
  res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
});

// --- mock upload endpoint: accepts anything, echoes a fake scan URL ---
const uploadMock = await startMockServer((_req, _body, res) => {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, scanId: "fake-scan-id", url: "http://localhost/scans/fake-scan-id" }));
});

// --- mock upload endpoint dedicated to the zero-candidates run (kept
// separate so its captured requests aren't mixed with run 2's) ---
const uploadMockZero = await startMockServer((_req, _body, res) => {
  res.writeHead(201, { "content-type": "application/json" });
  res.end(JSON.stringify({ ok: true, scanId: "fake-scan-id-zero", url: "http://localhost/scans/fake-scan-id-zero" }));
});

// --- mock LLM endpoint that always fails (500) — stands in for a
// misconfigured/unreachable BYOK provider ---
const llmMockFailing = await startMockServer((_req, _body, res) => {
  res.writeHead(500, { "content-type": "application/json" });
  res.end(JSON.stringify({ error: "internal error" }));
});

// --- run 1: --json with a BYOK key, no upload ---
{
  const result = await runCli(
    ["scan", fixtureDir, "--json", "--key", FAKE_KEY, "--url", `http://127.0.0.1:${llmMock.port}`, "--model", "test-model"],
    {},
  );
  checks.push(["--json run exits 0 or 1 (never a crash/usage error)", result.exitCode === 0 || result.exitCode === 1]);
  checks.push(["--json stdout never contains the raw key", !result.stdout.includes(FAKE_KEY)]);
  checks.push(["the mock LLM endpoint was actually called", llmMock.requests.length > 0]);
  checks.push([
    "the mock LLM endpoint received the key as a Bearer token",
    llmMock.requests.some((r) => r.authorization === `Bearer ${FAKE_KEY}`),
  ]);
  checks.push([
    "the mock LLM endpoint's request body never contains the raw key (only the Authorization header should)",
    llmMock.requests.every((r) => !r.body.includes(FAKE_KEY)),
  ]);
  const parsed = JSON.parse(result.stdout) as { reviewStatus: string };
  checks.push(["reviewStatus is full (mock LLM responded successfully)", parsed.reviewStatus === "full"]);
  checks.push(["--json stderr never contains the raw key", !result.stderr.includes(FAKE_KEY)]);
}

// --- run 2: --upload with the same key, separately verify the upload body ---
{
  const result = await runCli(
    [
      "scan",
      fixtureDir,
      "--upload",
      "--token",
      "ca_faketokenfaketokenfaketoken12",
      "--api",
      `http://127.0.0.1:${uploadMock.port}`,
      "--key",
      FAKE_KEY,
      "--url",
      `http://127.0.0.1:${llmMock.port}`,
      "--model",
      "test-model",
    ],
    {},
  );
  checks.push(["--upload run exits 0 or 1 (never a crash/usage error)", result.exitCode === 0 || result.exitCode === 1]);
  checks.push(["--upload console output never contains the raw key", !result.stdout.includes(FAKE_KEY) && !result.stderr.includes(FAKE_KEY)]);
  const uploadBody = uploadMock.requests.at(-1)?.body ?? "";
  checks.push(["the --upload request body never contains the raw key", !uploadBody.includes(FAKE_KEY)]);
  checks.push(["the --upload request body carries llmReviewSource: cli-byok", uploadBody.includes('"llmReviewSource":"cli-byok"')]);
  checks.push(['the --upload request body carries reviewStatus: "full"', uploadBody.includes('"reviewStatus":"full"')]);
}

// --- run 3: zero dead-code candidates, NO key/url/model at all, --upload ---
// Regression test for the bug where reviewCandidatesWithLlm's zero-candidate
// early return hardcoded reviewStatus "full" regardless of whether an LLM
// was configured — which let a no-key scan with nothing to review upload
// llmReviewSource: "cli-byok", falsely claiming a BYOK review never
// performed. Fixed in packages/engine/src/llm.ts to check getClient(llm).
{
  const result = await runCli(
    [
      "scan",
      zeroCandidatesFixtureDir,
      "--upload",
      "--token",
      "ca_faketokenfaketokenfaketoken12",
      "--api",
      `http://127.0.0.1:${uploadMockZero.port}`,
    ],
    {},
  );
  checks.push(["zero-candidates no-key --upload run exits 0 or 1 (never a crash/usage error)", result.exitCode === 0 || result.exitCode === 1]);
  const uploadBodyZero = uploadMockZero.requests.at(-1)?.body ?? "";
  checks.push(['zero-candidates no-key upload body carries reviewStatus: "skipped"', uploadBodyZero.includes('"reviewStatus":"skipped"')]);
  checks.push(["zero-candidates no-key upload body does NOT carry llmReviewSource (no LLM was ever contacted)", !uploadBodyZero.includes('"llmReviewSource"')]);
}

// --- run 4: a real (fake) BYOK key configured, but the LLM endpoint always
// fails (500) — the LLM-failure path must never crash the scan or change
// the CLI's documented exit-code contract (never exit 2, never throw), and
// reviewStatus must land on "partial" (not "full", not a crash). ---
{
  const result = await runCli(
    [
      "scan",
      fixtureDir,
      "--json",
      "--key",
      FAKE_KEY,
      "--url",
      `http://127.0.0.1:${llmMockFailing.port}`,
      "--model",
      "test-model",
    ],
    {},
  );
  checks.push(["LLM-failure run exits 0 or 1, never 2, never crashes", result.exitCode === 0 || result.exitCode === 1]);
  let parsedFailure: { reviewStatus?: string } | null = null;
  try {
    parsedFailure = JSON.parse(result.stdout) as { reviewStatus?: string };
  } catch {
    parsedFailure = null;
  }
  checks.push(["LLM-failure run produced parseable JSON output", parsedFailure !== null]);
  checks.push(['LLM-failure run reports reviewStatus "partial" (not "full", not a crash)', parsedFailure?.reviewStatus === "partial"]);
  checks.push(["LLM-failure run stdout never contains the raw key", !result.stdout.includes(FAKE_KEY)]);
  checks.push(["LLM-failure run stderr never contains the raw key", !result.stderr.includes(FAKE_KEY)]);
}

await llmMock.close();
await uploadMock.close();
await uploadMockZero.close();
await llmMockFailing.close();

console.log("--- BYOK redaction checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exitCode = failed ? 1 : 0;
