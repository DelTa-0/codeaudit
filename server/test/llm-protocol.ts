// Protocol-shape test for callChatCompletion: verifies wire format handling
// (success parsing, error status + headers propagation) against a local
// mock HTTP server. This is NOT a model-quality test — no live API call.
// Run: npm run test:llm-protocol
import http from "node:http";
import { callChatCompletion, type LlmConfig } from "@codeaudit/engine";

function startMockServer(
  handler: (req: http.IncomingMessage, res: http.ServerResponse) => void,
): Promise<{ url: string; close: () => Promise<void> }> {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") throw new Error("expected AddressInfo");
      resolve({
        url: `http://127.0.0.1:${address.port}`,
        close: () => new Promise((r) => server.close(() => r())),
      });
    });
  });
}

const checks: [string, boolean][] = [];

// --- success: parses choices[0].message.content ---
{
  const mock = await startMockServer((_req, res) => {
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "hello from mock" } }] }));
  });
  const config: LlmConfig = { apiKey: "test-key", baseUrl: mock.url, model: "test-model" };
  const result = await callChatCompletion(config, [{ role: "user", content: "hi" }]);
  checks.push(["success response parses choices[0].message.content", result === "hello from mock"]);
  await mock.close();
}

// --- 429: caught error has status === 429 and headers reflects retry-after ---
{
  const mock = await startMockServer((_req, res) => {
    res.writeHead(429, { "retry-after": "5" });
    res.end("rate limited");
  });
  const config: LlmConfig = { apiKey: "test-key", baseUrl: mock.url, model: "test-model" };
  let caught: (Error & { status?: number; headers?: Record<string, string> }) | null = null;
  try {
    await callChatCompletion(config, [{ role: "user", content: "hi" }]);
  } catch (err) {
    caught = err as Error & { status?: number; headers?: Record<string, string> };
  }
  checks.push([
    "429 response produces caught error with status === 429",
    caught !== null && caught.status === 429,
  ]);
  checks.push([
    "429 response's retry-after header is readable off the caught error",
    caught !== null && caught.headers?.["retry-after"] === "5",
  ]);
  await mock.close();
}

// --- 500: caught error has status === 500 ---
{
  const mock = await startMockServer((_req, res) => {
    res.writeHead(500);
    res.end("internal error");
  });
  const config: LlmConfig = { apiKey: "test-key", baseUrl: mock.url, model: "test-model" };
  let caught: (Error & { status?: number }) | null = null;
  try {
    await callChatCompletion(config, [{ role: "user", content: "hi" }]);
  } catch (err) {
    caught = err as Error & { status?: number };
  }
  checks.push(["500 response produces caught error with status === 500", caught !== null && caught.status === 500]);
  await mock.close();
}

// --- Authorization header carries the configured API key ---
{
  let receivedAuth: string | undefined;
  const mock = await startMockServer((req, res) => {
    receivedAuth = req.headers.authorization;
    res.writeHead(200, { "content-type": "application/json" });
    res.end(JSON.stringify({ choices: [{ message: { content: "ok" } }] }));
  });
  const config: LlmConfig = { apiKey: "distinctive-test-key-abc123", baseUrl: mock.url, model: "test-model" };
  await callChatCompletion(config, [{ role: "user", content: "hi" }]);
  checks.push([
    "request carries the configured key as a Bearer token",
    receivedAuth === "Bearer distinctive-test-key-abc123",
  ]);
  await mock.close();
}

console.log("--- LLM protocol-shape checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
// process.exit() here races libuv's handle cleanup against AbortSignal.timeout's
// internal timer on Windows (`Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)`
// in src/win/async.c) — setting exitCode and letting the event loop drain
// naturally avoids the crash while still producing the right process exit code.
process.exitCode = failed ? 1 : 0;
