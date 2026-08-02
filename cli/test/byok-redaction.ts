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
  const parsed = JSON.parse(result.stdout) as { reviewStatus: string };
  checks.push(["reviewStatus is full (mock LLM responded successfully)", parsed.reviewStatus === "full"]);
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

await llmMock.close();
await uploadMock.close();

console.log("--- BYOK redaction checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exitCode = failed ? 1 : 0;
