// Ground-truth validation for codeaudit-mcp, mirroring server/test/ground-
// truth.ts's style: spawns the built server as a real child process and
// speaks JSON-RPC 2.0 over its stdio, exactly as an MCP client would. Runs
// with CODEAUDIT_TOKEN unset — only exercises the offline (fuzzy-match)
// path; the hosted-alternative path (hosted.ts) requires a real token and
// running API server, and is verified manually (see Task 2, Step 4).
// Run: npm run test:ground-truth
import { spawn } from "node:child_process";
import path from "node:path";
import readline from "node:readline";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const serverPath = path.join(here, "..", "dist", "index.js");

interface JsonRpcResponse {
  jsonrpc: "2.0";
  id?: number;
  result?: unknown;
  error?: { code: number; message: string };
}

function startServer(envOverrides: Record<string, string> = {}) {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CODEAUDIT_TOKEN: "", ...envOverrides },
  });
  const rl = readline.createInterface({ input: child.stdout });
  const pending = new Map<number, (res: JsonRpcResponse) => void>();
  rl.on("line", (line) => {
    if (!line.trim()) return;
    let msg: JsonRpcResponse;
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id === "number" && pending.has(msg.id)) {
      pending.get(msg.id)!(msg);
      pending.delete(msg.id);
    }
  });
  let nextId = 1;
  function send(method: string, params?: unknown): Promise<JsonRpcResponse> {
    const id = nextId++;
    return new Promise((resolve) => {
      pending.set(id, resolve);
      child.stdin.write(JSON.stringify({ jsonrpc: "2.0", id, method, params }) + "\n");
    });
  }
  function notify(method: string, params?: unknown) {
    child.stdin.write(JSON.stringify({ jsonrpc: "2.0", method, params }) + "\n");
  }
  return { child, send, notify };
}

async function callTool(send: ReturnType<typeof startServer>["send"], name: string, args: unknown) {
  const res = await send("tools/call", { name, arguments: args });
  const content = (res.result as { content?: { type: string; text: string }[] } | undefined)?.content;
  return JSON.parse(content?.[0]?.text ?? "null");
}

const { child, send, notify } = startServer();

await send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "ground-truth-test", version: "0.0.1" },
});
notify("notifications/initialized");

const checks: [string, boolean][] = [];

const phantomTypo = await callTool(send, "verify_package", { name: "tyepscript", ecosystem: "npm" });
checks.push(
  ["verify_package(tyepscript, npm): phantom", phantomTypo.status === "phantom"],
  ["verify_package(tyepscript, npm): suggests typescript", phantomTypo.alternatives?.[0]?.name === "typescript"],
);

const healthy = await callTool(send, "verify_package", { name: "lodash", ecosystem: "npm" });
checks.push(["verify_package(lodash, npm): not phantom", healthy.status !== "phantom"]);

const fakePypi = await callTool(send, "verify_package", { name: "totally-fake-pypi-pkg-xyz", ecosystem: "pypi" });
checks.push(["verify_package(totally-fake-pypi-pkg-xyz, pypi): phantom", fakePypi.status === "phantom"]);

const batch = await callTool(send, "verify_packages", {
  packages: [
    { name: "react-toolkitz", ecosystem: "npm" },
    { name: "requests", ecosystem: "pypi" },
  ],
});
checks.push(
  ["verify_packages: react-toolkitz phantom", batch[0]?.status === "phantom"],
  ["verify_packages: requests not phantom", batch[1]?.status !== "phantom"],
);

// "requests" is a poor probe for the npm-then-pypi guess fallback: npm's
// registry happens to have its own (unrelated, long-abandoned) package
// literally named "requests", so the guess resolves to npm before ever
// trying PyPI — confirmed live against registry.npmjs.org/requests
// returning 200. "djangorestframework" is PyPI-only (npm 404s on it), so
// it actually exercises the npm-miss -> PyPI-fallback path the guess logic
// is meant to test.
const guessed = await callTool(send, "verify_package", { name: "djangorestframework" });
checks.push([
  "verify_package with ecosystem omitted resolves 'djangorestframework' via pypi guess",
  guessed.ecosystem === "pypi" && guessed.status !== "phantom",
]);

// Degrade-path: hosted-alternative lookups must never block the offline
// verification result. Point CODEAUDIT_API_URL at an address that fails fast
// (connection refused) and set a dummy token so enrichWithHostedAlternatives
// actually attempts the hosted call, then confirm verify_package on a known
// phantom-with-no-fuzzy-match name still comes back correctly and promptly —
// a hung promise simply never producing this output is itself the failure.
const degraded = startServer({ CODEAUDIT_TOKEN: "dummy-token-for-degrade-path-test", CODEAUDIT_API_URL: "http://127.0.0.1:1" });
await degraded.send("initialize", {
  protocolVersion: "2024-11-05",
  capabilities: {},
  clientInfo: { name: "ground-truth-test", version: "0.0.1" },
});
degraded.notify("notifications/initialized");
const degradedResult = await callTool(degraded.send, "verify_package", { name: "react-toolkitz", ecosystem: "npm" });
checks.push([
  "verify_package still returns phantom when hosted-alternatives call fails (degrade path)",
  degradedResult?.status === "phantom",
]);
degraded.child.kill();

const AWS_MCP_TEST_KEY = "AKIA" + "3RTQ7ZK2WPLM5XDN";
const secretHit = await callTool(send, "scan_secrets", {
  content: `const k = "${AWS_MCP_TEST_KEY}";`,
  filePath: "src/config.ts",
});
checks.push(
  ["scan_secrets detects a hardcoded AWS-shaped key", secretHit.findingCount === 1],
  ["scan_secrets response does not contain the raw key", !JSON.stringify(secretHit).includes(AWS_MCP_TEST_KEY)],
  ["scan_secrets response does not contain a fingerprint field", !JSON.stringify(secretHit).includes("fingerprint")],
);

const templateFile = await callTool(send, "scan_secrets", {
  content: `const k = "${AWS_MCP_TEST_KEY}";`,
  filePath: ".env.example",
});
checks.push(["scan_secrets does not scan a .env.example path", templateFile.scanned === false]);

const envRef = await callTool(send, "scan_secrets", {
  content: "const k = process.env.API_KEY;",
  filePath: "src/config.ts",
});
checks.push(["scan_secrets does NOT fire on a process.env reference", envRef.findingCount === 0]);

console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
child.kill();
process.exit(failed ? 1 : 0);
