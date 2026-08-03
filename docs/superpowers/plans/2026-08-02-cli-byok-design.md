# CLI Bring-Your-Own-Key (BYOK) LLM Review Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let a CLI user supply their own LLM API key (Groq, OpenAI, or any OpenAI-compatible endpoint) so `npx codematrix` performs real LLM-backed dead-code review and phantom-package alternative suggestions locally, with zero-config behavior unchanged when no key is supplied.

**Architecture:** Replace the `openai` SDK in `packages/engine/src/llm.ts` with a ~40-line `fetch()` wrapper shared by server and CLI, fold the `"./llm"` export subpath back into the engine's main export (the SDK weight that justified the split is gone), add a pure key-resolution function to the CLI that implements a strict precedence order (`GROQ_API_KEY` → `OPENAI_API_KEY` → `--key`/`--url`/`--model`), and wire the CLI to call the same `reviewCandidatesWithLlm`/`suggestAlternatives` functions the hosted worker already uses.

**Tech Stack:** TypeScript, Node.js `fetch`/`AbortSignal.timeout`, `tsx` for running `.ts` test scripts directly, esbuild for the CLI bundle, Zod for server-side schema validation, Node's built-in `http` module for mock servers in tests (no new test-framework dependency — matches the existing plain-`console.log`/`process.exit` check-array convention in `server/test/*.ts`).

## Global Constraints

- No flags required for the common case (`GROQ_API_KEY` or `OPENAI_API_KEY` env var alone is enough).
- With no key supplied anywhere, CLI behavior is byte-for-byte unchanged from today (static-only, `reviewStatus: "skipped"`).
- The LLM key itself must never appear in `--json` output, `--upload` request bodies, logs, or any file on disk — only in the `Authorization` header of requests to the URL the user configured.
- A failed/misconfigured BYOK call must never crash the scan or change the CLI's exit-code contract (0/1/2); it degrades to the existing no-key fallback path.
- `--key` + neither a recognized env var nor `--url` → exit 2 with exact message: `codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY instead)`.
- `--key` + `--url` with no `--model` → exit 2 with exact message: `codeaudit: --url requires --model — there is no default model for a custom endpoint`.
- Flag wins over its corresponding env var (`--key` over `CODEAUDIT_LLM_KEY`, `--url` over `CODEAUDIT_LLM_URL`, `--model` over `CODEAUDIT_LLM_MODEL`) — matches existing `--token`/`CODEAUDIT_TOKEN` precedence.
- Server-side schema additions (`reviewStatus`, `llmReviewSource`) are optional fields — an older published CLI that doesn't send them must keep working exactly as today.
- Full existing ground-truth suites (`server/test/ground-truth.ts`, `server/test/ground-truth-python.ts`, `server/test/plan-limits.ts`) must stay green throughout — `llm.ts` is shared with the hosted worker, so a regression here is silent for CLI users and loud for hosted ones.
- Out of scope (do not implement): hosted dashboard BYOK, non-OpenAI-compatible providers, retrying with a different provider on failure.

---

### Task 1: Fetch-based `callChatCompletion` wrapper in the engine

**Files:**
- Modify: `packages/engine/src/llm.ts:1-44` (add the function; do not wire it into `reviewFileBatch`/`suggestAlternativesBatch` yet — that's Task 2)
- Test: `server/test/llm-protocol.ts` (new)
- Modify: `server/package.json:9` (add `test:llm-protocol` script)

**Interfaces:**
- Produces: `callChatCompletion(config: LlmConfig, messages: { role: "system" | "user"; content: string }[]): Promise<string>`, exported from `packages/engine/src/llm.ts`. On a non-2xx response it throws an `Error` with two extra properties attached: `status: number` and `headers: Record<string, string>` — this is the exact shape `reviewFileBatch`'s existing retry logic (`packages/engine/src/llm.ts:151-168`) already reads off caught errors (`err.status`, `err.headers["retry-after"]`), so Task 2 must not need to change that logic.
- Consumes: nothing from other tasks — this is a leaf function.

- [ ] **Step 1: Write the failing protocol-shape test**

Create `server/test/llm-protocol.ts`:

```ts
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
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

Run:
```bash
npm run build --workspace @codeaudit/engine
```
```bash
cd server && npx tsx test/llm-protocol.ts
```
Expected: FAIL (TypeScript error or runtime error) — `callChatCompletion` is not exported from `@codeaudit/engine` yet.

- [ ] **Step 3: Implement `callChatCompletion` and export it**

In `packages/engine/src/llm.ts`, add this function after the `LlmConfig` interface (around line 10, before `ReviewedFinding`):

```ts
/**
 * The one HTTP operation both reviewFileBatch and suggestAlternativesBatch
 * need: a single non-streaming chat-completion call. Exported (not just
 * internal) specifically so its wire-format handling — success parsing,
 * error status/headers propagation — can be tested against a mock HTTP
 * server without going through the batching/retry logic around it.
 */
export async function callChatCompletion(
  config: LlmConfig,
  messages: { role: "system" | "user"; content: string }[],
): Promise<string> {
  const res = await fetch(`${config.baseUrl.replace(/\/$/, "")}/chat/completions`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${config.apiKey}`,
      "content-type": "application/json",
    },
    body: JSON.stringify({ model: config.model, messages, temperature: 0, max_tokens: 2000 }),
    signal: AbortSignal.timeout(60_000),
  });
  if (!res.ok) {
    // Preserve the shape reviewFileBatch's existing retry logic already reads
    // off caught errors (err.status, err.headers["retry-after"]) — that logic
    // was written against openai SDK error objects and must not need to
    // change when the SDK is removed (see Task 2).
    const err = new Error(`LLM request failed: ${res.status}`) as Error & {
      status: number;
      headers: Record<string, string>;
    };
    err.status = res.status;
    err.headers = Object.fromEntries(res.headers.entries());
    throw err;
  }
  const data = (await res.json()) as { choices?: { message?: { content?: string } }[] };
  return data.choices?.[0]?.message?.content ?? "";
}
```

Do not remove the `import OpenAI from "openai"` line or change `getClient`/`reviewFileBatch`/`suggestAlternativesBatch` yet — that happens in Task 2. This step only adds the new function alongside the old code so the test can pass in isolation.

In `packages/engine/src/index.ts`, change line 35 from:
```ts
export type { ReviewedFinding } from "./llm.js";
```
to:
```ts
export { callChatCompletion, type LlmConfig, type ReviewedFinding } from "./llm.js";
```

(`LlmConfig` was previously only reachable via the `"./llm"` subpath import — exporting it from `"."` here is required for the test's `import { callChatCompletion, type LlmConfig } from "@codeaudit/engine"` to resolve. This is safe early because `llm.ts` itself doesn't change its `openai` dependency yet, so `packages/engine`'s main `"."` export briefly re-exports a file that imports `openai` — resolved fully by the end of Task 2, when the `"./llm"` split and the SDK both go away together.)

- [ ] **Step 4: Add the test script and run it**

In `server/package.json`, add after line 9 (`"test:ground-truth-python": "tsx test/ground-truth-python.ts",`):
```json
    "test:llm-protocol": "tsx test/llm-protocol.ts",
```

Run:
```bash
npm run build --workspace @codeaudit/engine
```
```bash
npm run test:llm-protocol --workspace server
```
Expected: all 5 checks PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add packages/engine/src/llm.ts packages/engine/src/index.ts server/test/llm-protocol.ts server/package.json
git commit -m "feat(engine): add fetch-based callChatCompletion wrapper with protocol test"
```

---

### Task 2: Replace the `openai` SDK, remove the `"./llm"` export split

**Files:**
- Modify: `packages/engine/src/llm.ts` (rewrite `getClient`, `reviewFileBatch`, `suggestAlternativesBatch` to use `callChatCompletion`; remove the `openai` import)
- Modify: `packages/engine/package.json` (remove `openai` dependency, remove `"./llm"` export entry)
- Modify: `server/package.json` (remove unused `openai` dependency)
- Modify: `server/src/worker.ts:47` (import path)
- Modify: `server/src/routes/mcpAlternatives.ts:8` (import path)
- Modify: `cli/build.mjs` (stale comment referencing the `"./llm"` subpath split)

**Interfaces:**
- Consumes: `callChatCompletion` from Task 1.
- Produces: `reviewCandidatesWithLlm` and `suggestAlternatives` keep their exact existing signatures (`packages/engine/src/llm.ts:204-208`, `:341-344`) — no caller changes needed beyond the import path.

- [ ] **Step 1: Rewrite `llm.ts` to drop the `openai` client**

In `packages/engine/src/llm.ts`, replace line 1:
```ts
import OpenAI from "openai";
```
with nothing (delete the line — no replacement import needed).

Replace the `getClient` function (currently lines 41-44):
```ts
function getClient(llm: LlmConfig | undefined): OpenAI | null {
  if (!llm?.apiKey) return null;
  return new OpenAI({ apiKey: llm.apiKey, baseURL: llm.baseUrl });
}
```
with:
```ts
function getClient(llm: LlmConfig | undefined): LlmConfig | null {
  if (!llm?.apiKey) return null;
  return llm;
}
```

Replace the `reviewFileBatch` function signature and its call site (currently lines 96-102 and 122-133):
```ts
async function reviewFileBatch(
  client: OpenAI,
  model: string,
  filePath: string,
  candidates: DeadCodeCandidate[],
  importExports: string[],
): Promise<{ findings: ReviewedFinding[]; failed: boolean }> {
```
with:
```ts
async function reviewFileBatch(
  client: LlmConfig,
  model: string,
  filePath: string,
  candidates: DeadCodeCandidate[],
  importExports: string[],
): Promise<{ findings: ReviewedFinding[]; failed: boolean }> {
```

and replace the try block's request (currently):
```ts
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 2000,
      });
      const raw = completion.choices[0]?.message?.content ?? "";
```
with:
```ts
      const raw = await callChatCompletion(client, [
        { role: "system", content: SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ]);
```

Replace the `suggestAlternativesBatch` function signature and its call site (currently lines 284-305):
```ts
async function suggestAlternativesBatch(
  client: OpenAI,
  model: string,
  targets: { packageName: string; ecosystem: Ecosystem }[],
): Promise<Map<string, AlternativeSuggestion[]>> {
  const result = new Map<string, AlternativeSuggestion[]>();
  const userPrompt = targets
    .map((t) => `<name registry="${t.ecosystem}">${t.packageName}</name>`)
    .join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const completion = await client.chat.completions.create({
        model,
        messages: [
          { role: "system", content: ALTERNATIVES_SYSTEM_PROMPT },
          { role: "user", content: userPrompt },
        ],
        temperature: 0,
        max_tokens: 1500,
      });
      const raw = completion.choices[0]?.message?.content ?? "";
```
with:
```ts
async function suggestAlternativesBatch(
  client: LlmConfig,
  model: string,
  targets: { packageName: string; ecosystem: Ecosystem }[],
): Promise<Map<string, AlternativeSuggestion[]>> {
  const result = new Map<string, AlternativeSuggestion[]>();
  const userPrompt = targets
    .map((t) => `<name registry="${t.ecosystem}">${t.packageName}</name>`)
    .join("\n");

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const raw = await callChatCompletion(client, [
        { role: "system", content: ALTERNATIVES_SYSTEM_PROMPT },
        { role: "user", content: userPrompt },
      ]);
```

`model` is now unused as a parameter passed to a client call inside these two functions (it's already baked into `client: LlmConfig`'s `.model` field via `callChatCompletion`), but both functions are called elsewhere as `reviewFileBatch(client!, llm!.model, filePath, ...)` and `suggestAlternativesBatch(client!, llm!.model, batch)`. Leave the `model` parameter in the signature unused rather than changing call sites — `callChatCompletion` reads `config.model` off the `client: LlmConfig` argument directly, so `model` becomes dead going forward. Since this file is not itself a CLI candidate for dead-code scanning (it's the engine, not a scanned repo), leaving one unused parameter is acceptable; do not delete it, because it would require touching both call sites and the retry-loop closures for no behavioral gain. (If a linter flags it, prefix with underscore: `_model`. Do not do this unless `npm run build --workspace @codeaudit/engine` actually errors on it — `tsc` alone does not error on unused parameters without `noUnusedParameters` enabled, and this project's `tsconfig.json` does not set it.)

- [ ] **Step 2: Remove `openai` from `packages/engine/package.json`**

In `packages/engine/package.json`, remove the `"./llm"` export entry (lines 13-16):
```json
    "./llm": {
      "types": "./dist/llm.d.ts",
      "default": "./dist/llm.js"
    },
```
and remove the `openai` dependency (line 28):
```json
    "openai": "^4.77.0",
```

The file should read:
```json
{
  "name": "@codeaudit/engine",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "main": "dist/index.js",
  "types": "dist/index.d.ts",
  "exports": {
    ".": {
      "types": "./dist/index.d.ts",
      "default": "./dist/index.js"
    },
    "./secrets": {
      "types": "./dist/secrets.d.ts",
      "default": "./dist/secrets.js"
    }
  },
  "scripts": {
    "build": "tsc -p tsconfig.json"
  },
  "dependencies": {
    "@babel/parser": "^7.26.0",
    "@babel/traverse": "^7.26.0",
    "smol-toml": "^1.7.0"
  },
  "devDependencies": {
    "@types/babel__traverse": "^7.20.6",
    "@types/node": "^22.10.0",
    "typescript": "^5.7.0"
  }
}
```

- [ ] **Step 3: Remove the now-unused `openai` dependency from `server/package.json`**

Server never imported `openai` directly (confirmed: only reached it through `@codeaudit/engine/llm`'s re-export). Remove line 24 (`"openai": "^4.77.0",`) from `server/package.json`'s `dependencies`.

- [ ] **Step 4: Update import sites**

In `server/src/worker.ts:47`, change:
```ts
import { reviewCandidatesWithLlm, suggestAlternatives } from "@codeaudit/engine/llm";
```
to:
```ts
import { reviewCandidatesWithLlm, suggestAlternatives } from "@codeaudit/engine";
```

In `server/src/routes/mcpAlternatives.ts:8`, change:
```ts
import { suggestAlternatives } from "@codeaudit/engine/llm";
```
to:
```ts
import { suggestAlternatives } from "@codeaudit/engine";
```

- [ ] **Step 5: Update the stale comment in `cli/build.mjs`**

Replace the file's top comment block (currently lines 1-6):
```js
// Bundles the CLI into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npm publish` ships a package
// that works standalone via `npx codematrix`, without needing the monorepo's
// workspace linking or any of its own dependencies resolved on the consumer's
// machine. @codeaudit/engine's "./llm" subpath (which pulls in the "openai"
// SDK) is never imported by the CLI, so it never enters this bundle either.
```
with:
```js
// Bundles the CLI into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npm publish` ships a package
// that works standalone via `npx codematrix`, without needing the monorepo's
// workspace linking or any of its own dependencies resolved on the consumer's
// machine. @codeaudit/engine's LLM review functions are plain fetch() calls
// (no SDK), so BYOK review (see docs/superpowers/specs/2026-08-02-cli-byok-design.md)
// can reach them from this bundle without adding heavy dependencies.
```

- [ ] **Step 6: Reinstall dependencies, rebuild, run every existing suite**

```bash
npm install
```
```bash
npm run build:engine
```
```bash
npm run test:ground-truth --workspace server
```
```bash
npm run test:ground-truth-python --workspace server
```
```bash
npm run test:plan-limits --workspace server
```
```bash
npm run test:llm-protocol --workspace server
```
Expected: every suite reports all checks PASS, exit code 0. `npm install` should show `openai` removed from `node_modules` (or at least no longer listed as a direct dependency of `@codeaudit/engine` or `server` in `package-lock.json`).

```bash
npm run typecheck --workspace server
```
Expected: no type errors (confirms `worker.ts`/`mcpAlternatives.ts` import path changes compile).

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/llm.ts packages/engine/package.json server/package.json server/src/worker.ts server/src/routes/mcpAlternatives.ts cli/build.mjs package-lock.json
git commit -m "refactor(engine): remove openai SDK, fold ./llm export back into main entry"
```

---

### Task 3: CLI key-resolution module

**Files:**
- Create: `cli/src/llmConfig.ts`
- Test: `cli/test/llm-config.ts`
- Modify: `cli/package.json` (add `test:llm-config` script)

**Interfaces:**
- Produces: `resolveLlmConfig(flags: LlmFlags, env: NodeJS.ProcessEnv): ResolveLlmConfigResult`, `type LlmFlags = { key: string | null; url: string | null; model: string | null }`, `type ResolvedLlmConfig = { apiKey: string; baseUrl: string; model: string; source: "groq" | "openai" | "custom" }`, `type ResolveLlmConfigResult = { ok: true; config: ResolvedLlmConfig | null } | { ok: false; error: string }` — all exported from `cli/src/llmConfig.ts`. Task 4 consumes `resolveLlmConfig` and its result type directly.

- [ ] **Step 1: Write the failing test**

Create `cli/test/llm-config.ts`:

```ts
// Flag/env precedence checks for the CLI's BYOK key resolution. Pure-function
// tests — no network, no process spawning.
// Run: npm run test:llm-config
import { resolveLlmConfig } from "../src/llmConfig.js";

const checks: [string, boolean][] = [];

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, {});
  checks.push(["no key anywhere resolves to ok with null config (static-only, unchanged)", r.ok === true && r.config === null]);
}

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, { GROQ_API_KEY: "groq-secret" });
  checks.push([
    "GROQ_API_KEY alone resolves to the groq provider",
    r.ok === true && r.config?.source === "groq" && r.config.apiKey === "groq-secret" && r.config.model === "llama-3.3-70b-versatile",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: null, url: null, model: null },
    { GROQ_API_KEY: "groq-secret", OPENAI_API_KEY: "openai-secret" },
  );
  checks.push(["GROQ_API_KEY is chosen over OPENAI_API_KEY when both are set", r.ok === true && r.config?.source === "groq"]);
}

{
  const r = resolveLlmConfig({ key: null, url: null, model: null }, { OPENAI_API_KEY: "openai-secret" });
  checks.push([
    "OPENAI_API_KEY alone resolves to the openai provider",
    r.ok === true && r.config?.source === "openai" && r.config.apiKey === "openai-secret" && r.config.model === "gpt-4o-mini",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: "flag-key", url: "https://example.com/v1", model: "flag-model" },
    { CODEAUDIT_LLM_KEY: "env-key", CODEAUDIT_LLM_URL: "https://env.example.com/v1", CODEAUDIT_LLM_MODEL: "env-model" },
  );
  checks.push([
    "--key/--url/--model override their corresponding CODEAUDIT_LLM_* env vars",
    r.ok === true &&
      r.config?.apiKey === "flag-key" &&
      r.config.baseUrl === "https://example.com/v1" &&
      r.config.model === "flag-model" &&
      r.config.source === "custom",
  ]);
}

{
  const r = resolveLlmConfig(
    { key: null, url: null, model: null },
    { CODEAUDIT_LLM_KEY: "env-key", CODEAUDIT_LLM_URL: "https://env.example.com/v1", CODEAUDIT_LLM_MODEL: "env-model" },
  );
  checks.push([
    "CODEAUDIT_LLM_KEY/_URL/_MODEL env vars alone resolve a custom provider",
    r.ok === true && r.config?.source === "custom" && r.config.apiKey === "env-key",
  ]);
}

{
  const r = resolveLlmConfig({ key: "flag-key", url: null, model: null }, {});
  checks.push([
    "bare --key with no --url and no recognized env var exits with the documented message",
    r.ok === false && r.error === "codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY instead)",
  ]);
}

{
  const r = resolveLlmConfig({ key: "flag-key", url: "https://example.com/v1", model: null }, {});
  checks.push([
    "--key + --url with no --model exits with the documented message",
    r.ok === false && r.error === "codeaudit: --url requires --model — there is no default model for a custom endpoint",
  ]);
}

console.log("--- LLM key-resolution checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run the test to verify it fails**

```bash
npx tsx cli/test/llm-config.ts
```
Expected: FAIL — `cli/src/llmConfig.ts` does not exist yet (module not found error).

- [ ] **Step 3: Implement `resolveLlmConfig`**

Create `cli/src/llmConfig.ts`:

```ts
// BYOK key resolution for the CLI. Resolution order (first match wins):
// 1. GROQ_API_KEY env var -> Groq (free, this project's documented default)
// 2. OPENAI_API_KEY env var -> OpenAI (paid)
// 3. --key (or CODEAUDIT_LLM_KEY) + --url (or CODEAUDIT_LLM_URL), requiring
//    --model (or CODEAUDIT_LLM_MODEL) since there's no default model for an
//    arbitrary endpoint
// 4. --key with neither a recognized env var nor --url -> hard error, so a
//    user is never billed by a provider they didn't knowingly choose
export interface LlmFlags {
  key: string | null;
  url: string | null;
  model: string | null;
}

export interface ResolvedLlmConfig {
  apiKey: string;
  baseUrl: string;
  model: string;
  source: "groq" | "openai" | "custom";
}

export type ResolveLlmConfigResult =
  | { ok: true; config: ResolvedLlmConfig | null }
  | { ok: false; error: string };

const GROQ_BASE_URL = "https://api.groq.com/openai/v1";
const GROQ_MODEL = "llama-3.3-70b-versatile";
const OPENAI_BASE_URL = "https://api.openai.com/v1";
const OPENAI_MODEL = "gpt-4o-mini";

export function resolveLlmConfig(flags: LlmFlags, env: NodeJS.ProcessEnv): ResolveLlmConfigResult {
  if (env.GROQ_API_KEY) {
    return { ok: true, config: { apiKey: env.GROQ_API_KEY, baseUrl: GROQ_BASE_URL, model: GROQ_MODEL, source: "groq" } };
  }
  if (env.OPENAI_API_KEY) {
    return { ok: true, config: { apiKey: env.OPENAI_API_KEY, baseUrl: OPENAI_BASE_URL, model: OPENAI_MODEL, source: "openai" } };
  }

  const key = flags.key ?? env.CODEAUDIT_LLM_KEY ?? null;
  if (!key) return { ok: true, config: null };

  const url = flags.url ?? env.CODEAUDIT_LLM_URL ?? null;
  if (!url) {
    return { ok: false, error: "codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY instead)" };
  }

  const model = flags.model ?? env.CODEAUDIT_LLM_MODEL ?? null;
  if (!model) {
    return { ok: false, error: "codeaudit: --url requires --model — there is no default model for a custom endpoint" };
  }

  return { ok: true, config: { apiKey: key, baseUrl: url, model, source: "custom" } };
}
```

- [ ] **Step 4: Add the test script and run it**

In `cli/package.json`, add to `"scripts"` (after `"build"`):
```json
    "test:llm-config": "tsx test/llm-config.ts",
```
This needs `tsx` as a dev dependency of `cli` — add it to `cli/package.json`'s `devDependencies` (it's already a dev dependency of `server`, so the version string matches):
```json
    "tsx": "^4.19.0",
```

Run:
```bash
npm install
```
```bash
npm run test:llm-config --workspace codematrix
```
Expected: all 8 checks PASS, exit code 0.

- [ ] **Step 5: Commit**

```bash
git add cli/src/llmConfig.ts cli/test/llm-config.ts cli/package.json package-lock.json
git commit -m "feat(cli): add pure BYOK key-resolution function with precedence tests"
```

---

### Task 4: Wire the CLI — flags, help text, and the BYOK review pipeline

**Files:**
- Modify: `cli/src/index.ts` (flags, `main()`, output)

**Interfaces:**
- Consumes: `resolveLlmConfig`, `LlmFlags`, `ResolveLlmConfigResult` from Task 3 (`cli/src/llmConfig.ts`); `reviewCandidatesWithLlm`, `suggestAlternatives`, `LlmConfig` now importable from `@codeaudit/engine` (Task 2's export-subpath fold).
- Produces: `--upload` payload gains `reviewStatus` (already CLI-computed) and `llmReviewSource: "cli-byok"` (sent only when `reviewStatus !== "skipped"`) — read by Task 5. `--json` output gains a top-level `reviewStatus` field.

- [ ] **Step 1: Extend `usage()` help text**

In `cli/src/index.ts`, replace the `usage()` function body (currently lines 44-57):
```ts
function usage(): never {
  console.log(`Usage: codematrix scan [dir] [options]

Options:
  --json          machine-readable output (for CI)
  --min-score N   exit 1 if the score is below N
  --upload        send results to your CodeAudit dashboard (requires a token)
  --token T       per-repo CLI token (or set CODEAUDIT_TOKEN)
  --api URL       API base URL (or set CODEAUDIT_API_URL, default http://localhost:4000)
  -h, --help      show this help

Exit codes: 0 ok · 1 phantom deps found or score below --min-score · 2 usage/error`);
  process.exit(2);
}
```
with:
```ts
function usage(): never {
  console.log(`Usage: codematrix scan [dir] [options]

Options:
  --json          machine-readable output (for CI)
  --min-score N   exit 1 if the score is below N
  --upload        send results to your CodeAudit dashboard (requires a token)
  --token T       per-repo CLI token (or set CODEAUDIT_TOKEN)
  --api URL       API base URL (or set CODEAUDIT_API_URL, default http://localhost:4000)
  --key T         your own LLM API key for real dead-code review (or set GROQ_API_KEY / OPENAI_API_KEY)
  --url URL       OpenAI-compatible base URL for --key (or set CODEAUDIT_LLM_URL; required with a bare --key)
  --model M       model name for --url (or set CODEAUDIT_LLM_MODEL; required alongside a custom --url)
  -h, --help      show this help

Without a key, dead-code candidates are static-only (fixed confidence, no LLM verdict).
Set GROQ_API_KEY for free LLM-backed review with zero other flags.

Exit codes: 0 ok · 1 phantom deps found or score below --min-score · 2 usage/error`);
  process.exit(2);
}
```

- [ ] **Step 2: Add flag parsing**

Add the import at the top of `cli/src/index.ts`, after the existing `@codeaudit/engine` import block (after line 35):
```ts
import { resolveLlmConfig, type LlmFlags } from "./llmConfig.js";
```

Extend `CliArgs` (currently lines 59-66):
```ts
interface CliArgs {
  dir: string;
  json: boolean;
  minScore: number | null;
  upload: boolean;
  token: string | null;
  apiUrl: string;
}
```
to:
```ts
interface CliArgs {
  dir: string;
  json: boolean;
  minScore: number | null;
  upload: boolean;
  token: string | null;
  apiUrl: string;
  llmFlags: LlmFlags;
}
```

Extend `parseArgs` (currently lines 68-93):
```ts
function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "scan" || args.includes("-h") || args.includes("--help")) usage();

  let dir = ".";
  let json = false;
  let minScore: number | null = null;
  let upload = false;
  let token: string | null = process.env.CODEAUDIT_TOKEN ?? null;
  let apiUrl = process.env.CODEAUDIT_API_URL ?? "http://localhost:4000";
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
    else if (arg === "--upload") upload = true;
    else if (arg === "--token") token = args.shift() ?? null;
    else if (arg === "--api") apiUrl = args.shift() ?? apiUrl;
    else if (arg === "--min-score") {
      const value = Number(args.shift());
      if (!Number.isFinite(value)) usage();
      minScore = value;
    } else if (!arg.startsWith("-")) dir = arg;
    else usage();
  }
  return { dir: path.resolve(dir), json, minScore, upload, token, apiUrl };
}
```
to:
```ts
function parseArgs(argv: string[]): CliArgs {
  const args = [...argv];
  const command = args.shift();
  if (command !== "scan" || args.includes("-h") || args.includes("--help")) usage();

  let dir = ".";
  let json = false;
  let minScore: number | null = null;
  let upload = false;
  let token: string | null = process.env.CODEAUDIT_TOKEN ?? null;
  let apiUrl = process.env.CODEAUDIT_API_URL ?? "http://localhost:4000";
  let key: string | null = null;
  let url: string | null = null;
  let model: string | null = null;
  while (args.length) {
    const arg = args.shift()!;
    if (arg === "--json") json = true;
    else if (arg === "--upload") upload = true;
    else if (arg === "--token") token = args.shift() ?? null;
    else if (arg === "--api") apiUrl = args.shift() ?? apiUrl;
    else if (arg === "--key") key = args.shift() ?? null;
    else if (arg === "--url") url = args.shift() ?? null;
    else if (arg === "--model") model = args.shift() ?? null;
    else if (arg === "--min-score") {
      const value = Number(args.shift());
      if (!Number.isFinite(value)) usage();
      minScore = value;
    } else if (!arg.startsWith("-")) dir = arg;
    else usage();
  }
  return { dir: path.resolve(dir), json, minScore, upload, token, apiUrl, llmFlags: { key, url, model } };
}
```

- [ ] **Step 3: Resolve the LLM config at the top of `main()` and handle a hard error**

In `cli/src/index.ts`, replace the destructure at the top of `main()` (currently line 153):
```ts
  const { dir, json, minScore, upload, token, apiUrl } = parseArgs(process.argv.slice(2));
```
with:
```ts
  const { dir, json, minScore, upload, token, apiUrl, llmFlags } = parseArgs(process.argv.slice(2));
  const llmResolution = resolveLlmConfig(llmFlags, process.env);
  if (!llmResolution.ok) {
    console.error(llmResolution.error);
    process.exit(2);
  }
  const llm = llmResolution.config;
```

- [ ] **Step 4: Import the LLM review functions and replace the static-only findings block**

Add to the `@codeaudit/engine` import block (currently lines 7-35), inserting `reviewCandidatesWithLlm` and `suggestAlternatives` alongside the existing named imports (add these two lines after `findSecrets,` on line 26):
```ts
  reviewCandidatesWithLlm,
  suggestAlternatives,
```

Now merge per-file import/export context across ecosystems, matching `server/src/worker.ts`'s pattern. Replace the ecosystem-detection block (currently lines 163-195):
```ts
  const ecosystems = detectEcosystems(dir);
  const deps: DependencyVerdict[] = [];
  const candidates: DeadCodeCandidate[] = [];
  let npmTree: ResolvedTree | null = null;
  let pyTree: ResolvedTree | null = null;
  let fileCount = 0;

  if (ecosystems.includes("npm")) {
    const manifest = parseManifest(dir);
    const analysis = analyzeRepo(dir);
    npmTree = resolveNpmTree(dir);
    fileCount += analysis.fileCount;
    if (manifest)
      deps.push(
        ...(await checkDependencies(dir, manifest, analysis.importedPackages, {
          transitivelyRequired: npmTree?.transitivelyRequired,
        })),
      );
    candidates.push(...findDeadCodeCandidates(analysis));
  }

  if (ecosystems.includes("pypi")) {
    const pyManifest = parsePythonManifest(dir);
    const pyAnalysis = analyzePythonRepo(dir);
    pyTree = resolvePythonTree(dir);
    fileCount += pyAnalysis.fileCount;
    deps.push(
      ...(await checkPythonDependencies(dir, pyManifest, pyAnalysis.importedPackages, {
        transitivelyRequired: pyTree?.transitivelyRequired,
      })),
    );
    candidates.push(...findDeadCodeCandidates(pyAnalysis));
  }
```
with:
```ts
  const ecosystems = detectEcosystems(dir);
  const deps: DependencyVerdict[] = [];
  const candidates: DeadCodeCandidate[] = [];
  const mergedFileImportExports = new Map<string, string[]>();
  let npmTree: ResolvedTree | null = null;
  let pyTree: ResolvedTree | null = null;
  let fileCount = 0;

  if (ecosystems.includes("npm")) {
    const manifest = parseManifest(dir);
    const analysis = analyzeRepo(dir);
    npmTree = resolveNpmTree(dir);
    fileCount += analysis.fileCount;
    if (manifest)
      deps.push(
        ...(await checkDependencies(dir, manifest, analysis.importedPackages, {
          transitivelyRequired: npmTree?.transitivelyRequired,
        })),
      );
    candidates.push(...findDeadCodeCandidates(analysis));
    for (const [k, v] of analysis.fileImportExports) mergedFileImportExports.set(k, v);
  }

  if (ecosystems.includes("pypi")) {
    const pyManifest = parsePythonManifest(dir);
    const pyAnalysis = analyzePythonRepo(dir);
    pyTree = resolvePythonTree(dir);
    fileCount += pyAnalysis.fileCount;
    deps.push(
      ...(await checkPythonDependencies(dir, pyManifest, pyAnalysis.importedPackages, {
        transitivelyRequired: pyTree?.transitivelyRequired,
      })),
    );
    candidates.push(...findDeadCodeCandidates(pyAnalysis));
    for (const [k, v] of pyAnalysis.fileImportExports) mergedFileImportExports.set(k, v);
  }
```

Replace the static-findings block (currently lines 208-217):
```ts
  const polyglot = ecosystems.length > 1;

  // Static-only findings: candidates at fixed confidence, no LLM verdict.
  const staticFindings: ReviewedFinding[] = candidates.map((c) => ({
    filePath: c.filePath,
    lineStart: c.lineStart,
    lineEnd: c.lineEnd,
    symbolName: c.name,
    findingType: c.findingType,
    confidence: 0.5,
    reasoning: "candidate — LLM verification available on codeaudit.dev",
  }));
```
with:
```ts
  const polyglot = ecosystems.length > 1;

  // With a BYOK key resolved, reach the same LLM review path the hosted
  // worker uses (server/src/worker.ts) — additive to the CLI's existing
  // static-only behavior, never a replacement: with `llm === null` this is
  // byte-for-byte the old static-only path.
  const { findings: staticFindings, reviewStatus } = await reviewCandidatesWithLlm(
    candidates,
    { fileImportExports: mergedFileImportExports },
    llm ? { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model } : undefined,
  );
```

`reviewCandidatesWithLlm`'s no-key fallback path (`packages/engine/src/llm.ts:211-219`) already produces the exact same `confidence: 0.5` shape the old inline map produced, but with reasoning text `"Static analysis found no references. LLM review skipped (no API key configured)."` instead of `"candidate — LLM verification available on codeaudit.dev"`. This is an intentional, small behavior change — the new message is more accurate (it explains *why* review didn't happen) and matches what the hosted worker already says for a no-key scan, so CLI and hosted output are consistent. This is a copy change only; it does not affect scoring, exit codes, or `--json` shape beyond the `reasoning` string value.

- [ ] **Step 5: Wire phantom-alternative AI suggestions**

After the vulnerability-lookup block (currently lines 197-204, ending `applyVulnerabilities(deps, await checkVulnerabilities(vulnTargets));\n  }`), insert:
```ts

  // "Did you mean X?" for phantom packages with no offline fuzzy match —
  // same best-effort, optional path the hosted worker uses
  // (server/src/worker.ts). No-op when llm is null.
  if (llm) {
    const phantomsNeedingAiSuggestion = deps.filter(
      (d) => d.status === "phantom" && !(d.registryMetadata as { alternatives?: unknown } | null)?.alternatives,
    );
    if (phantomsNeedingAiSuggestion.length) {
      const aiSuggestions = await suggestAlternatives(
        phantomsNeedingAiSuggestion.map((d) => ({ packageName: d.packageName, ecosystem: d.ecosystem })),
        { apiKey: llm.apiKey, baseUrl: llm.baseUrl, model: llm.model },
      );
      for (const d of phantomsNeedingAiSuggestion) {
        const alternatives = aiSuggestions.get(d.packageName);
        if (alternatives?.length) d.registryMetadata = { ...(d.registryMetadata ?? {}), alternatives };
      }
    }
  }
```

- [ ] **Step 6: Fix the `computeSummary` call and remove the stale `"skipped"` literal**

Currently line 245:
```ts
  const summary = computeSummary(deps, staticFindings, fileCount, "skipped", secrets.length);
```
Change to:
```ts
  const summary = computeSummary(deps, staticFindings, fileCount, reviewStatus, secrets.length);
```

- [ ] **Step 7: Surface `reviewStatus` in `--json` output and note the provider in human output**

In the `--json` output block (currently lines 258-281), add `reviewStatus` to the emitted object. Replace:
```ts
  if (json) {
    console.log(
      JSON.stringify(
        {
          score: summary.score,
          grade: summary.grade,
          counts: summary.counts,
          dependencies: deps,
          deadCodeCandidates: staticFindings,
          priorities,
          advisories: { duplicates, licenseConflicts },
          // `fingerprint` is a dedup-internal hash (see secrets.ts) that must
          // never be rendered into CLI output, an export, or a PR comment —
          // it exists only to recognize the same credential across scans.
          secrets: secrets.map(({ fingerprint: _fingerprint, ...s }) => s),
          upload: uploadResult,
          exitCode,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }
```
with:
```ts
  if (json) {
    console.log(
      JSON.stringify(
        {
          score: summary.score,
          grade: summary.grade,
          counts: summary.counts,
          reviewStatus,
          dependencies: deps,
          deadCodeCandidates: staticFindings,
          priorities,
          advisories: { duplicates, licenseConflicts },
          // `fingerprint` is a dedup-internal hash (see secrets.ts) that must
          // never be rendered into CLI output, an export, or a PR comment —
          // it exists only to recognize the same credential across scans.
          secrets: secrets.map(({ fingerprint: _fingerprint, ...s }) => s),
          upload: uploadResult,
          exitCode,
        },
        null,
        2,
      ),
    );
    process.exit(exitCode);
  }
```

In the human-readable output, replace the dead-code section header (currently lines 338-344):
```ts
  if (staticFindings.length) {
    console.log(`${BOLD}Dead-code candidates${RESET} ${DIM}(static analysis only)${RESET}`);
    for (const f of staticFindings) {
      console.log(`  ${YELLOW}candidate${RESET}  ${f.symbolName}  ${DIM}${f.filePath}:${f.lineStart}${RESET}`);
    }
    console.log();
  }
```
with:
```ts
  if (staticFindings.length) {
    const reviewLabel =
      reviewStatus === "full"
        ? `LLM-reviewed via ${llm?.source ?? "your key"}`
        : reviewStatus === "partial"
          ? "partially LLM-reviewed — some batches fell back to static analysis"
          : "static analysis only";
    console.log(`${BOLD}Dead-code candidates${RESET} ${DIM}(${reviewLabel})${RESET}`);
    for (const f of staticFindings) {
      const confidenceNote = reviewStatus !== "skipped" ? ` ${DIM}(${Math.round(f.confidence * 100)}% confidence)${RESET}` : "";
      console.log(`  ${YELLOW}candidate${RESET}  ${f.symbolName}  ${DIM}${f.filePath}:${f.lineStart}${RESET}${confidenceNote}`);
    }
    console.log();
  }
```

This reads `llm?.source`, so `ResolvedLlmConfig`'s `source` field (Task 3) must remain accessible on `llm` at this point in `main()` — it already is, since `llm` is `llmResolution.config` and was never reassigned.

- [ ] **Step 8: Rebuild and manually smoke-test both paths**

```bash
npm run build:engine
```
```bash
npm run build --workspace codematrix
```

Static-only path (no key) — must be unchanged in shape:
```bash
node cli/dist/index.js scan server/test/fixture --json
```
Expected: valid JSON, `"reviewStatus": "skipped"`, `deadCodeCandidates[].reasoning` reads `"Static analysis found no references. LLM review skipped (no API key configured)."`.

Bad-flag paths:
```bash
node cli/dist/index.js scan server/test/fixture --key sk-fake
```
Expected: prints `codeaudit: --key requires --url (or set GROQ_API_KEY / OPENAI_API_KEY instead)` to stderr, exit code 2.

```bash
node cli/dist/index.js scan server/test/fixture --key sk-fake --url https://example.com/v1
```
Expected: prints `codeaudit: --url requires --model — there is no default model for a custom endpoint` to stderr, exit code 2.

- [ ] **Step 9: Run every existing ground-truth suite again (regression check)**

```bash
npm run test:ground-truth --workspace server
```
```bash
npm run test:ground-truth-python --workspace server
```
```bash
npm run test:plan-limits --workspace server
```
Expected: all green. These exercise `findDeadCodeCandidates`/`checkDependencies` directly, not the CLI, but confirm the engine-level refactor in Task 2 didn't regress anything Task 4 depends on.

- [ ] **Step 10: Commit**

```bash
git add cli/src/index.ts
git commit -m "feat(cli): wire --key/--url/--model flags to LLM-backed dead-code review"
```

---

### Task 5: Upload provenance — CLI payload and server schema

**Files:**
- Modify: `cli/src/index.ts` (`uploadResults` function and its call site)
- Modify: `server/src/routes/cliScans.ts` (`uploadSchema`, summary construction)

**Interfaces:**
- Consumes: `reviewStatus` (Task 4, already in scope in `main()`) and `llm?.source` to derive `llmReviewSource`.
- Produces: `summary.llmReviewSource` stored in the `scan_jobs.summary` JSONB column, read by Task 7 (`web/src/pages/ScanDetail.tsx`).

- [ ] **Step 1: Add `reviewStatus`/`llmReviewSource` to the CLI's upload payload**

In `cli/src/index.ts`, extend `uploadResults`'s signature (currently lines 95-103):
```ts
async function uploadResults(
  apiUrl: string,
  token: string,
  summary: { score: number; grade: string; counts: Record<string, number> },
  deps: unknown[],
  candidates: ReviewedFinding[],
  priorities: RankedFinding[],
  advisories: { duplicates: DuplicateGroup[]; licenseConflicts: LicenseConflict[] },
): Promise<{ ok: boolean; url?: string; error?: string }> {
```
to:
```ts
async function uploadResults(
  apiUrl: string,
  token: string,
  summary: { score: number; grade: string; counts: Record<string, number> },
  deps: unknown[],
  candidates: ReviewedFinding[],
  priorities: RankedFinding[],
  advisories: { duplicates: DuplicateGroup[]; licenseConflicts: LicenseConflict[] },
  reviewStatus: "full" | "partial" | "skipped",
): Promise<{ ok: boolean; url?: string; error?: string }> {
```

In the same function's `fetch` body (currently lines 108-133), add the two provenance fields to the JSON payload. Replace:
```ts
      body: JSON.stringify({
        token,
        score: summary.score,
        grade: summary.grade,
        counts: summary.counts,
        dependencies: (deps as {
```
with:
```ts
      body: JSON.stringify({
        token,
        score: summary.score,
        grade: summary.grade,
        counts: summary.counts,
        reviewStatus,
        // Present only when review actually happened — an older server that
        // doesn't know this field ignores it (see uploadSchema in
        // server/src/routes/cliScans.ts, which makes both fields optional).
        ...(reviewStatus !== "skipped" ? { llmReviewSource: "cli-byok" as const } : {}),
        dependencies: (deps as {
```

Update the call site (currently lines 251-256):
```ts
  let uploadResult: { ok: boolean; url?: string; error?: string } | null = null;
  if (upload && token) {
    uploadResult = await uploadResults(apiUrl, token, summary, deps, staticFindings, priorities, {
      duplicates,
      licenseConflicts,
    });
  }
```
to:
```ts
  let uploadResult: { ok: boolean; url?: string; error?: string } | null = null;
  if (upload && token) {
    uploadResult = await uploadResults(
      apiUrl,
      token,
      summary,
      deps,
      staticFindings,
      priorities,
      { duplicates, licenseConflicts },
      reviewStatus,
    );
  }
```

**Hard constraint check:** `llm.apiKey` must never be referenced anywhere in this function or its call site — confirm by inspection that neither `uploadResults`'s new body nor the call site above touches `llm.apiKey`, `llm.baseUrl`, or any property of `llm` other than what already flowed into `staticFindings`/`deps` (which never carry the key either — `reviewCandidatesWithLlm`'s `ReviewedFinding` shape has no key field, see `packages/engine/src/llm.ts:12-20`).

- [ ] **Step 2: Add the optional fields to the server's `uploadSchema`**

In `server/src/routes/cliScans.ts`, add two optional fields to `uploadSchema` (currently lines 53-141). Insert after the `counts` field's closing `}),` (after line 70) and before `branch`:
```ts
  reviewStatus: z.enum(["full", "partial", "skipped"]).optional(),
  llmReviewSource: z.literal("cli-byok").optional(),
```

- [ ] **Step 3: Store both fields in the persisted summary**

In `server/src/routes/cliScans.ts`, replace the `summary` object construction (currently lines 152-169):
```ts
    const summary = {
      score: body.score,
      grade: body.grade,
      counts: body.counts,
      source: "cli",
      reviewStatus: "skipped",
      // Optional — older published CLIs don't send these, and the schema
      // caps each array independently of whatever the CLI itself sliced to.
      ...(body.priorities ? { priorities: body.priorities.slice(0, 20) } : {}),
      ...(body.advisories
        ? {
            advisories: {
              duplicates: body.advisories.duplicates.slice(0, 50),
              licenseConflicts: body.advisories.licenseConflicts.slice(0, 50),
            },
          }
        : {}),
    };
```
with:
```ts
    const summary = {
      score: body.score,
      grade: body.grade,
      counts: body.counts,
      source: "cli",
      // Older published CLIs (pre-BYOK) don't send reviewStatus at all —
      // default to "skipped", which was always true for them.
      reviewStatus: body.reviewStatus ?? "skipped",
      // Present only when the CLI's own reviewStatus said review happened.
      // This is the CLI's self-report, not a platform-verified fact — the
      // dashboard cannot confirm an arbitrary CLI run's claim is honest (see
      // web/src/pages/ScanDetail.tsx's banner copy, Task 7).
      ...(body.llmReviewSource ? { llmReviewSource: body.llmReviewSource } : {}),
      // Optional — older published CLIs don't send these, and the schema
      // caps each array independently of whatever the CLI itself sliced to.
      ...(body.priorities ? { priorities: body.priorities.slice(0, 20) } : {}),
      ...(body.advisories
        ? {
            advisories: {
              duplicates: body.advisories.duplicates.slice(0, 50),
              licenseConflicts: body.advisories.licenseConflicts.slice(0, 50),
            },
          }
        : {}),
    };
```

- [ ] **Step 4: Typecheck and rerun ground-truth suites**

```bash
npm run typecheck --workspace server
```
Expected: no type errors.

```bash
npm run test:ground-truth --workspace server
```
```bash
npm run test:ground-truth-python --workspace server
```
Expected: both green (this task doesn't touch analysis logic, only upload plumbing, but confirms nothing else broke).

- [ ] **Step 5: Commit**

```bash
git add cli/src/index.ts server/src/routes/cliScans.ts
git commit -m "feat(cli,server): thread reviewStatus/llmReviewSource through --upload"
```

---

### Task 6: End-to-end redaction test

**Files:**
- Test: `cli/test/byok-redaction.ts` (new)
- Modify: `cli/package.json` (add `test:byok-redaction` script, add it to `prepublishOnly`)

**Interfaces:**
- Consumes: the built `cli/dist/index.js` (spawned as a child process, matching the existing convention in `mcp/test/ground-truth.ts` of spawning a built artifact rather than importing source directly — the CLI is CJS-bundled and calls `process.exit`, so it cannot be `import`ed into a test process safely).

- [ ] **Step 1: Write the test**

Create `cli/test/byok-redaction.ts`:

```ts
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
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it to verify it fails before the CLI is built with Task 4's changes**

If Task 4 and Task 5 are already committed (they must be, since this task depends on them), first confirm the test fails on a stale build to prove it's actually exercising the code:
```bash
npm run test:llm-config --workspace codematrix
```
This is a sanity check only — skip straight to Step 3 if the build is already current.

- [ ] **Step 3: Build and run**

```bash
npm run build:engine
```
```bash
npm run build --workspace codematrix
```

Add the test script to `cli/package.json`'s `"scripts"` (after `"test:llm-config"`):
```json
    "test:byok-redaction": "tsx test/byok-redaction.ts",
```

Update `prepublishOnly` (currently):
```json
    "prepublishOnly": "npm run build && npm run test:ground-truth --prefix ../server && npm run test:ground-truth-python --prefix ../server"
```
to:
```json
    "prepublishOnly": "npm run build && npm run test:ground-truth --prefix ../server && npm run test:ground-truth-python --prefix ../server && npm run test:llm-config && npm run test:byok-redaction"
```

Run:
```bash
npm run test:byok-redaction --workspace codematrix
```
Expected: all checks PASS, exit code 0.

- [ ] **Step 4: Commit**

```bash
git add cli/test/byok-redaction.ts cli/package.json
git commit -m "test(cli): add end-to-end BYOK redaction guard spawning the built CLI"
```

---

### Task 7: Web dashboard — rewrite the `reviewStatus` banner

**Files:**
- Modify: `web/src/lib/api.ts` (`ScanSummary` type)
- Modify: `web/src/pages/ScanDetail.tsx` (banner copy, lines 267-279)

**Interfaces:**
- Consumes: `summary.llmReviewSource` (Task 5, stored server-side; already optional in the `ScanSummary` shape returned by the API).

- [ ] **Step 1: Add `llmReviewSource` to the `ScanSummary` type**

In `web/src/lib/api.ts`, extend `ScanSummary` (currently lines 93-111). Locate the `reviewStatus` line:
```ts
  /** "skipped" means zombie findings are unfiltered static candidates (no LLM verdict) — score is noisier. */
  reviewStatus?: "full" | "partial" | "skipped";
```
and add directly after it:
```ts
  /** Present only when reviewStatus !== "skipped" AND the review was a CLI user's own key, not the platform's — self-reported by the CLI, never platform-verified. */
  llmReviewSource?: "cli-byok";
```

- [ ] **Step 2: Rewrite the banner**

In `web/src/pages/ScanDetail.tsx`, replace the banner block (currently lines 271-279):
```tsx
            {scan.summary.reviewStatus && scan.summary.reviewStatus !== "full" && (
              <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                Static-only score — dead-code findings weren't verified by the LLM, so this score
                is noisier than an LLM-verified scan.
                {scan.summary.reviewStatus === "skipped"
                  ? " No LLM is configured for this scan (expected for CLI uploads, or when the server has no model API key set)."
                  : " Some batches could not be reviewed — most often the model provider's rate limit or daily token quota. Expand a finding below to see the exact reason, and re-run the scan once the quota resets."}
              </p>
            )}
```
with:
```tsx
            {scan.summary.reviewStatus === "full" && scan.summary.llmReviewSource === "cli-byok" && (
              <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                LLM-reviewed with the uploader's own API key, not the platform's — this is the CLI
                user's self-report and has not been independently verified by CodeAudit.
              </p>
            )}
            {scan.summary.reviewStatus && scan.summary.reviewStatus !== "full" && (
              <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                Static-only score — dead-code findings weren't verified by the LLM, so this score
                is noisier than an LLM-verified scan.
                {scan.summary.reviewStatus === "skipped"
                  ? " No LLM is configured for this scan (the server has no model API key set, or a CLI upload ran without a BYOK key — see codematrix scan --help)."
                  : " Some batches could not be reviewed — most often the model provider's rate limit or daily token quota. Expand a finding below to see the exact reason, and re-run the scan once the quota resets."}
              </p>
            )}
```

The old `"skipped"` copy said "expected for CLI uploads" as a blanket statement — inaccurate now that CLI uploads can be genuinely LLM-reviewed via BYOK. The rewritten copy narrows that to "a CLI upload ran without a BYOK key," which stays true, and the new `cli-byok` branch above it makes the self-reported/unverified distinction explicit rather than implying platform-verified confidence for a claim the dashboard cannot check.

- [ ] **Step 3: Typecheck**

```bash
npm run build --workspace web
```
Expected: no type errors (this runs `tsc --noEmit` before `vite build`).

- [ ] **Step 4: Manual visual check**

Start the dev server and view a scan detail page (any existing scan with `reviewStatus` set) to confirm the banner still renders correctly for the `"skipped"`/`"partial"` cases (no visual regression), since a `cli-byok` scan isn't easy to produce by hand without running the real pipeline end-to-end:
```bash
npm run dev --workspace web
```
Navigate to `http://localhost:5173/scans/<any-existing-scan-id>` and visually confirm the banner renders with the updated copy.

- [ ] **Step 5: Commit**

```bash
git add web/src/lib/api.ts web/src/pages/ScanDetail.tsx
git commit -m "feat(web): distinguish self-reported BYOK review from platform-verified in the scan banner"
```

---

### Task 8: Documentation

**Files:**
- Modify: `cli/README.md` (flags table, new "LLM review" section)
- Modify: `README.md` (CLI section framing, lines 269-284)
- Modify: `docs/decisions.md` (new entry)

**Interfaces:** none — this task changes no code.

- [ ] **Step 1: Update `cli/README.md`'s options table**

Replace the table (currently lines 39-46):
```markdown
| Option          | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--json`        | Machine-readable output — one JSON object on stdout, for CI parsing                                                           |
| `--min-score N` | Exit `1` if the health score is below `N`                                                                                     |
| `--upload`      | Send results to your CodeAudit dashboard (requires a token; see [Uploading results](#uploading-results))                      |
| `--token T`     | Per-repo CLI token for `--upload` (or set `CODEAUDIT_TOKEN`)                                                                  |
| `--api URL`     | API base URL for `--upload` (or set `CODEAUDIT_API_URL`; defaults to `http://localhost:4000`, only relevant if you self-host) |
| `-h`, `--help`  | Show usage                                                                                                                    |
```
with:
```markdown
| Option          | Description                                                                                                                   |
| --------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `--json`        | Machine-readable output — one JSON object on stdout, for CI parsing                                                           |
| `--min-score N` | Exit `1` if the health score is below `N`                                                                                     |
| `--upload`      | Send results to your CodeAudit dashboard (requires a token; see [Uploading results](#uploading-results))                      |
| `--token T`     | Per-repo CLI token for `--upload` (or set `CODEAUDIT_TOKEN`)                                                                  |
| `--api URL`     | API base URL for `--upload` (or set `CODEAUDIT_API_URL`; defaults to `http://localhost:4000`, only relevant if you self-host) |
| `--key T`       | Your own LLM API key for real dead-code review (or set `GROQ_API_KEY` / `OPENAI_API_KEY`; see [LLM review](#llm-review-optional-bring-your-own-key)) |
| `--url URL`     | OpenAI-compatible base URL for `--key` (or set `CODEAUDIT_LLM_URL`; required alongside a bare `--key`)                        |
| `--model M`     | Model name for `--url` (or set `CODEAUDIT_LLM_MODEL`; required alongside a custom `--url`)                                   |
| `-h`, `--help`  | Show usage                                                                                                                    |
```

Add a new section after "## Uploading results" (after line 161, before "## Guarding against phantom packages"):
```markdown
## LLM review (optional, bring-your-own-key)

By default, dead-code candidates are static analysis only — a fixed 0.5
confidence and no verdict. Supply your own LLM API key and the CLI performs
the same LLM-backed review the hosted dashboard does, entirely on your
machine:

```bash
GROQ_API_KEY=gsk_xxxxx npx codematrix scan .
```

[Groq](https://console.groq.com) has a free tier and is the zero-config
default. `OPENAI_API_KEY` also works out of the box. Any other
OpenAI-compatible endpoint (a local Ollama, a self-hosted proxy, Anthropic
via an OpenAI-compatible shim) works with `--key`/`--url`/`--model`:

```bash
npx codematrix scan . --key sk-xxxxx --url https://api.openai.com/v1 --model gpt-4o-mini
```

`--url` is required whenever `--key` isn't one of the two recognized env
vars above — the CLI never guesses a provider it wasn't told about. Your key
is used only in the request to the endpoint you configured: it is never
included in `--json` output, never sent as part of `--upload`, and never
written to disk.

With a key configured, dead-code candidates get real confidence scores and
reasoning, and phantom-package findings with no offline spelling match may
get an AI-suggested real alternative (e.g. `fastimagepro` → Pillow/imageio).
```

- [ ] **Step 2: Update root `README.md`'s CLI section**

Replace the paragraph (currently lines 271-275):
```markdown
A deliberately **limited, funnel-oriented** local scanner — static analysis
only (phantom/unused/suspicious dependencies + dead-code *candidates*), no
LLM review, no history, no PR integration. Those stay platform-only so the
CLI drives adoption of the SaaS rather than replacing it.
```
with:
```markdown
A **funnel-oriented** local scanner — static analysis (phantom/unused/
suspicious dependencies + dead-code *candidates*) by default, no scan
history or PR integration. Those stay platform-only so the CLI drives
adoption of the SaaS rather than replacing it. LLM-backed dead-code review is
available with a bring-your-own-key flag (`--key`/`--url`/`--model`, or
`GROQ_API_KEY`/`OPENAI_API_KEY`) — see [`cli/README.md`](cli/README.md#llm-review-optional-bring-your-own-key).
```

- [ ] **Step 3: Add a `docs/decisions.md` entry**

Append a new section at the end of `docs/decisions.md`, after the existing `.env` and secrets section:
```markdown

## CLI BYOK: fetch() instead of the openai SDK

The CLI's LLM review (dead-code confidence scores, phantom-package
alternatives) was previously platform-only specifically to keep the `openai`
SDK (8.7MB) out of the CLI's esbuild bundle — see the `"./llm"` export
subpath split, above. Bring-your-own-key needed the CLI to reach an LLM,
which directly conflicted with that boundary.

Rather than bundle `openai` into the CLI or maintain a second implementation
of the same prompt/parsing logic, `packages/engine/src/llm.ts` was rewritten
against a ~40-line `fetch()` wrapper (`callChatCompletion`) that both the
server and the CLI share. The `"./llm"` export subpath was removed — the
reason for its existence (keeping the SDK out of the CLI) no longer applies
once there's no SDK to keep out. Full design: `docs/superpowers/specs/
2026-08-02-cli-byok-design.md`.
```

- [ ] **Step 4: Commit**

```bash
git add cli/README.md README.md docs/decisions.md
git commit -m "docs: document CLI BYOK LLM review and the openai SDK removal"
```

---

### Task 9: Final full-suite verification

**Files:** none — verification only.

**Interfaces:** none.

- [ ] **Step 1: Clean install and full build**

```bash
npm install
```
```bash
npm run build
```
```bash
npm run build:cli
```
Expected: all three succeed with no errors.

- [ ] **Step 2: Run every test suite**

```bash
npm run test:ground-truth --workspace server
```
```bash
npm run test:ground-truth-python --workspace server
```
```bash
npm run test:plan-limits --workspace server
```
```bash
npm run test:llm-protocol --workspace server
```
```bash
npm run test:llm-config --workspace codematrix
```
```bash
npm run test:byok-redaction --workspace codematrix
```
Expected: every suite reports all checks PASS, exit code 0 for each.

- [ ] **Step 3: Typecheck server and web**

```bash
npm run typecheck --workspace server
```
```bash
npm run build --workspace web
```
Expected: no type errors.

- [ ] **Step 4: Confirm `openai` is gone from the dependency tree where it should be**

```bash
grep -r '"openai"' packages/engine/package.json server/package.json
```
Expected: no output (both files no longer declare it).

```bash
npm ls openai 2>&1 | head -5
```
Expected: either "empty" or shows `openai` only as a dependency of some other unrelated package already in the tree — not of `@codeaudit/engine`, `server`, or `codematrix`.

- [ ] **Step 5: Final manual smoke test of the full BYOK flow against a real free-tier provider (optional but recommended)**

If a Groq API key is available:
```bash
GROQ_API_KEY=<real-key> node cli/dist/index.js scan server/test/fixture
```
Expected: human-readable output shows `Dead-code candidates (LLM-reviewed via groq)`, each candidate line shows a confidence percentage, exit code reflects whether phantom deps were found in the fixture (expected: `1`, since the fixture has `react-toolkitz`/`tyepscript` as known phantoms).

- [ ] **Step 6: Update the spec's status and commit**

In `docs/superpowers/specs/2026-08-02-cli-byok-design.md`, change the frontmatter `status: approved` to `status: implemented`.

```bash
git add docs/superpowers/specs/2026-08-02-cli-byok-design.md
git commit -m "chore: mark CLI BYOK spec as implemented"
```
