# codeaudit-mcp AI Agent Guardrails Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship `codeaudit-mcp`, a stdio MCP server exposing `verify_package`/`verify_packages` tools so AI coding agents (Claude Code, Cursor, Cline, etc.) can check whether a package is real and trustworthy before installing it.

**Architecture:** A new `mcp/` workspace depends directly on `@codeaudit/engine` for a new single-package verification primitive (`verifyPackage`), reusing existing registry/typosquat/vuln logic — no new detection algorithms. The MCP layer adds ecosystem guessing and batching on top. When `CODEAUDIT_TOKEN` is set, phantom packages with no offline fuzzy match get an additional hosted LLM-alternative lookup via a new server endpoint; without a token, everything runs fully offline exactly like the existing CLI.

**Tech Stack:** TypeScript (NodeNext), `@modelcontextprotocol/sdk`, `zod`, esbuild (bundled standalone publish, mirroring `cli/`), Express + `express-rate-limit` (server route).

## Global Constraints

- Node.js `>=18` (matches `cli/package.json`'s `engines.node`).
- `packages/engine/` stays LLM-free and heavy-dependency-free — the new `verify.ts` module must not import from `./llm.js` or pull in `openai`. Hosted LLM calls happen server-side only, reached via HTTP from `mcp/`.
- New MCP-server code is bundled standalone via esbuild before publish, exactly like `cli/build.mjs` — no `node_modules` dependency at install time for `npx codeaudit-mcp` consumers.
- The new server endpoint is authenticated by the existing per-repo `cli_token` (the `ca_...` token from `cliScans.ts`), not a JWT — same pattern as `cliUploadRouter`, since the MCP server runs locally with no browser session.
- All new dependency-verdict-shaped statuses reuse the existing string union `"phantom" | "healthy" | "suspicious" | "vulnerable"` (the `DependencyVerdict` statuses minus `"unused"`, which doesn't apply outside a whole-repo scan) — never invent a new status vocabulary.

---

### Task 1: Engine — single-package verification primitive

**Files:**
- Modify: `packages/engine/src/registry.ts` (export the existing private `checkNpmPackage`)
- Modify: `packages/engine/src/python/registry.ts` (export the existing private `checkPyPiPackage`)
- Create: `packages/engine/src/verify.ts`
- Modify: `packages/engine/src/index.ts` (export `verifyPackage`, `PackageVerifyResult`)
- Modify: `server/test/ground-truth.ts` (add npm-side checks)
- Modify: `server/test/ground-truth-python.ts` (add PyPI-side checks)

**Interfaces:**
- Consumes: `checkNpmPackage(name: string): Promise<{exists: boolean; meta: Record<string, unknown> | null}>` (existing, in `registry.ts`); `checkPyPiPackage(name: string): Promise<{exists: boolean; meta: Record<string, unknown> | null}>` (existing, in `python/registry.ts`); `fuzzyAlternative(name, ecosystem)` and `checkTyposquat(name, ecosystem)` (existing, `typosquat.ts`); `normalizePyPiName(name)` (existing, exported, `python/aliases.ts`); `checkVulnerabilities(packages: {name, version, ecosystem}[])` (existing, exported, `vulns.ts`); `AlternativeSuggestion`, `Ecosystem` types (existing, `registry.ts`).
- Produces: `verifyPackage(rawName: string, ecosystem: Ecosystem): Promise<PackageVerifyResult>` and `interface PackageVerifyResult { name: string; ecosystem: Ecosystem; exists: boolean; status: "phantom" | "healthy" | "suspicious" | "vulnerable"; weeklyDownloads: number | null; ageDays: number | null; latestVersion: string | null; typosquatOf?: string; typosquatDistance?: number; alternatives?: AlternativeSuggestion[]; vulnerabilities?: VulnAdvisory[]; maxSeverity?: VulnSeverity }` — both exported from `@codeaudit/engine`'s main entry (Task 5 and Task 6 import these).

- [ ] **Step 1: Export `checkNpmPackage` from registry.ts**

In `packages/engine/src/registry.ts`, change:

```ts
async function checkNpmPackage(name: string) {
```

to:

```ts
export async function checkNpmPackage(name: string) {
```

- [ ] **Step 2: Export `checkPyPiPackage` from python/registry.ts**

In `packages/engine/src/python/registry.ts`, change:

```ts
async function checkPyPiPackage(name: string) {
```

to:

```ts
export async function checkPyPiPackage(name: string) {
```

- [ ] **Step 3: Write the failing checks in the ground-truth scripts**

In `server/test/ground-truth.ts`, add this import to the existing `import { ... } from "@codeaudit/engine";` block (append `verifyPackage,` to the named imports), then insert the following immediately before the line `console.log("--- checks ---");` at the end of the file:

```ts
// --- Single-package verification primitive (offline path, for codeaudit-mcp) ---
const verifyPhantomTypo = await verifyPackage("tyepscript", "npm");
const verifyHealthy = await verifyPackage("lodash", "npm");
const verifyMadeUp = await verifyPackage("react-toolkitz", "npm");
checks.push(
  ["verifyPackage(tyepscript) is phantom", verifyPhantomTypo.status === "phantom"],
  ["verifyPackage(tyepscript) suggests typescript", verifyPhantomTypo.alternatives?.[0]?.name === "typescript"],
  ["verifyPackage(lodash) is not phantom", verifyHealthy.status !== "phantom"],
  ["verifyPackage(lodash) reports a latestVersion", typeof verifyHealthy.latestVersion === "string"],
  ["verifyPackage(react-toolkitz) is phantom with NO alternative", verifyMadeUp.status === "phantom" && !verifyMadeUp.alternatives],
);
```

In `server/test/ground-truth-python.ts`, add `checkPythonDependencies` import already exists — append `verifyPackage,` to the existing named-import block from `@codeaudit/engine`, then insert this immediately before `console.log("--- checks ---");` at the end of the file:

```ts
// --- Single-package verification primitive (offline path, for codeaudit-mcp) ---
const verifyPhantomTypoPy = await verifyPackage("reqeusts", "pypi");
const verifyHealthyPy = await verifyPackage("requests", "pypi");
checks.push(
  ["verifyPackage(reqeusts, pypi) is phantom", verifyPhantomTypoPy.status === "phantom"],
  ["verifyPackage(reqeusts, pypi) suggests requests", verifyPhantomTypoPy.alternatives?.[0]?.name === "requests"],
  ["verifyPackage(requests, pypi) is not phantom", verifyHealthyPy.status !== "phantom"],
);
```

- [ ] **Step 4: Run the ground-truth scripts to verify they fail (verifyPackage doesn't exist yet)**

Run: `cd server && npm run test:ground-truth`
Expected: fails to run — `verifyPackage` is not exported from `@codeaudit/engine` (TypeScript/import error), or `npm run build:engine` fails first because `verify.ts` doesn't exist yet. Either failure mode confirms the test is exercising code that doesn't exist yet.

- [ ] **Step 5: Create `packages/engine/src/verify.ts`**

```ts
// Single-package, ad-hoc verification primitive — used by codeaudit-mcp to
// answer "is this ONE package (that an agent is about to install) real and
// trustworthy?" without needing a whole repo/manifest/import-graph context.
// Recomposes the same checks a full scan runs (registry existence, fuzzy
// "did you mean", typosquat, downloads/age, known CVEs) rather than adding
// new detection logic. No LLM import here — hosted LLM-based alternative
// suggestions are a separate, server-side concern (see mcp/src/hosted.ts).
import { checkNpmPackage, type AlternativeSuggestion, type Ecosystem } from "./registry.js";
import { checkPyPiPackage } from "./python/registry.js";
import { normalizePyPiName } from "./python/aliases.js";
import { checkTyposquat, fuzzyAlternative } from "./typosquat.js";
import { checkVulnerabilities, type VulnAdvisory, type VulnSeverity } from "./vulns.js";

export interface PackageVerifyResult {
  name: string;
  ecosystem: Ecosystem;
  exists: boolean;
  status: "phantom" | "healthy" | "suspicious" | "vulnerable";
  weeklyDownloads: number | null;
  ageDays: number | null;
  latestVersion: string | null;
  typosquatOf?: string;
  typosquatDistance?: number;
  alternatives?: AlternativeSuggestion[];
  vulnerabilities?: VulnAdvisory[];
  maxSeverity?: VulnSeverity;
}

const SUSPICIOUS_DOWNLOADS: Record<Ecosystem, number> = { npm: 50, pypi: 200 };
const SUSPICIOUS_AGE_DAYS = 90;
const ESTABLISHED_DOWNLOADS = 100_000;

/**
 * Verifies one package name against its registry. Mirrors the per-package
 * logic inside registry.ts's/python/registry.ts's checkDependencies loops,
 * but for a single ad-hoc name with no manifest/import-graph context.
 */
export async function verifyPackage(rawName: string, ecosystem: Ecosystem): Promise<PackageVerifyResult> {
  const name = ecosystem === "pypi" ? normalizePyPiName(rawName) : rawName;
  const { exists, meta } = ecosystem === "npm" ? await checkNpmPackage(name) : await checkPyPiPackage(name);

  if (!exists) {
    const alternative = fuzzyAlternative(name, ecosystem);
    return {
      name,
      ecosystem,
      exists: false,
      status: "phantom",
      weeklyDownloads: null,
      ageDays: null,
      latestVersion: null,
      alternatives: alternative ? [alternative] : undefined,
    };
  }

  const weekly = (meta?.weeklyDownloads as number | null) ?? null;
  const created = meta?.created ? new Date(meta.created as string) : null;
  const ageDays = created ? Math.round((Date.now() - created.getTime()) / 86_400_000) : null;
  const lowDownloads = weekly !== null && weekly < SUSPICIOUS_DOWNLOADS[ecosystem];
  const veryNew = ageDays !== null && ageDays < SUSPICIOUS_AGE_DAYS;

  const result: PackageVerifyResult = {
    name,
    ecosystem,
    exists: true,
    status: lowDownloads || veryNew ? "suspicious" : "healthy",
    weeklyDownloads: weekly,
    ageDays,
    latestVersion: (meta?.latest as string | null) ?? null,
  };

  const established = weekly !== null && weekly >= ESTABLISHED_DOWNLOADS;
  const squat = checkTyposquat(name, ecosystem);
  if (squat && (result.status === "suspicious" || (squat.distance === 1 && !established))) {
    result.status = "suspicious";
    result.typosquatOf = squat.suspectedTarget;
    result.typosquatDistance = squat.distance;
  }

  if (result.latestVersion) {
    const vulns = await checkVulnerabilities([{ name, version: result.latestVersion, ecosystem }]);
    if (vulns.length) {
      result.status = "vulnerable";
      result.vulnerabilities = vulns[0].advisories;
      result.maxSeverity = vulns[0].maxSeverity;
    }
  }

  return result;
}
```

- [ ] **Step 6: Export from `packages/engine/src/index.ts`**

Add this line to `packages/engine/src/index.ts` (anywhere alongside the other exports, e.g. after the `checkTyposquat` export line):

```ts
export { verifyPackage, type PackageVerifyResult } from "./verify.js";
```

- [ ] **Step 7: Build the engine and run both ground-truth suites**

Run: `npm run build:engine`
Expected: no TypeScript errors.

Run: `cd server && npm run test:ground-truth`
Expected: every line prints `PASS`, including the five new `verifyPackage(...)` checks. Exit code 0.

Run: `cd server && npm run test:ground-truth-python`
Expected: every line prints `PASS`, including the three new `verifyPackage(..., pypi)` checks. Exit code 0.

- [ ] **Step 8: Commit**

```bash
git add packages/engine/src/registry.ts packages/engine/src/python/registry.ts packages/engine/src/verify.ts packages/engine/src/index.ts server/test/ground-truth.ts server/test/ground-truth-python.ts
git commit -m "Add single-package verification primitive for codeaudit-mcp"
```

---

### Task 2: Server — hosted alternatives endpoint

**Files:**
- Create: `server/src/routes/mcpAlternatives.ts`
- Modify: `server/src/index.ts`

**Interfaces:**
- Consumes: `suggestAlternatives(targets: {packageName: string; ecosystem: Ecosystem}[], llm?: LlmConfig): Promise<Map<string, AlternativeSuggestion[]>>` (existing, `@codeaudit/engine/llm`); `queryOne` (existing, `server/src/db/pool.js`); `unauthorized` (existing, `server/src/lib/errors.js`); `validateBody` (existing, `server/src/middleware/validate.js`); `config.llm` (existing, `server/src/lib/config.js`).
- Produces: `mcpAlternativesRouter` (Express `Router`), mounted at `POST /api/mcp/alternatives`. Response body: `{ alternatives: Record<string, AlternativeSuggestion[]> }`. Consumed by Task 4's `mcp/src/hosted.ts`.

- [ ] **Step 1: Create the route file**

```ts
import { Router } from "express";
import rateLimit from "express-rate-limit";
import { z } from "zod";
import { queryOne } from "../db/pool.js";
import { validateBody } from "../middleware/validate.js";
import { unauthorized } from "../lib/errors.js";
import { config } from "../lib/config.js";
import { suggestAlternatives } from "@codeaudit/engine/llm";

/**
 * Public route for codeaudit-mcp — authed by the same per-repo CLI token as
 * cliUploadRouter (see routes/cliScans.ts), not a JWT: the MCP server runs
 * locally with no browser session to carry a user's cookie/JWT.
 */
export const mcpAlternativesRouter = Router();

const alternativesLimiter = rateLimit({
  windowMs: 60_000,
  limit: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests. Try again in a minute." },
});

const alternativesSchema = z.object({
  token: z.string().min(10).max(100),
  packages: z
    .array(
      z.object({
        packageName: z.string().max(214),
        ecosystem: z.enum(["npm", "pypi"]),
      }),
    )
    .min(1)
    .max(50),
});

mcpAlternativesRouter.post(
  "/mcp/alternatives",
  alternativesLimiter,
  validateBody(alternativesSchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof alternativesSchema>;
      const repo = await queryOne<{ id: string }>("SELECT id FROM repositories WHERE cli_token = $1", [
        body.token,
      ]);
      if (!repo) throw unauthorized("Invalid CLI token");

      if (!config.llm.apiKey) {
        res.json({ alternatives: {} });
        return;
      }

      const suggestions = await suggestAlternatives(body.packages, {
        apiKey: config.llm.apiKey,
        baseUrl: config.llm.baseUrl,
        model: config.llm.model,
      });
      const alternatives: Record<string, unknown> = {};
      for (const [name, alts] of suggestions) alternatives[name] = alts;
      res.json({ alternatives });
    } catch (err) {
      next(err);
    }
  },
);
```

- [ ] **Step 2: Mount the router**

In `server/src/index.ts`, add the import next to the other route imports:

```ts
import { mcpAlternativesRouter } from "./routes/mcpAlternatives.js";
```

And add this line next to `app.use("/api", cliUploadRouter); // no JWT — authed by per-repo CLI token`:

```ts
app.use("/api", mcpAlternativesRouter); // no JWT — authed by per-repo CLI token
```

- [ ] **Step 3: Typecheck the server**

Run: `npm run build --workspace server`
Expected: no TypeScript errors.

- [ ] **Step 4: Manual smoke test against the dev stack**

This repo has no HTTP-level test harness for any route (confirmed: `billing.ts`, `scans.ts`, etc. have zero automated tests — only pure-function "ground-truth" scripts exist). Verify by hand instead, matching how every other route in this codebase is checked:

Run: `docker compose up -d && npm run migrate && npm run dev:api` (from repo root)

In another terminal, create a repository row and CLI token through the normal product flow (register → connect a repo → `POST /repos/:repoId/cli-token`, as documented in the README's CLI section), then:

```bash
curl -s -X POST http://localhost:4000/api/mcp/alternatives \
  -H "content-type: application/json" \
  -d '{"token":"<the ca_... token>","packages":[{"packageName":"fastimagepro","ecosystem":"pypi"}]}'
```

Expected: `{"alternatives":{}}` if no `XAI_API_KEY`/Groq key is configured in `server/.env` (degrade-gracefully path), or `{"alternatives":{"fastimagepro":[{...}]}}` if one is configured. Also verify an invalid token returns `401`:

```bash
curl -s -X POST http://localhost:4000/api/mcp/alternatives \
  -H "content-type: application/json" \
  -d '{"token":"not-a-real-token-not-a-real-token","packages":[{"packageName":"x","ecosystem":"npm"}]}'
```

Expected: `{"error":"Invalid CLI token"}` with HTTP 401.

- [ ] **Step 5: Commit**

```bash
git add server/src/routes/mcpAlternatives.ts server/src/index.ts
git commit -m "Add hosted alternatives endpoint for codeaudit-mcp"
```

---

### Task 3: mcp/ workspace scaffold

**Files:**
- Create: `mcp/package.json`
- Create: `mcp/tsconfig.json`
- Create: `mcp/build.mjs`
- Modify: `package.json` (root — add workspace + build script)

**Interfaces:**
- Consumes: nothing yet (scaffold only).
- Produces: the `mcp` npm workspace, `npm run build:mcp` at the repo root, an esbuild pipeline that bundles `mcp/src/index.ts` (created in Task 5) into `mcp/dist/index.js`. Task 4/5 write into `mcp/src/`; Task 6 builds and runs against `mcp/dist/index.js`.

- [ ] **Step 1: Create `mcp/package.json`**

```json
{
  "name": "codeaudit-mcp",
  "version": "0.1.0",
  "type": "module",
  "description": "MCP server for AI coding agents (Claude Code, Cursor, Cline, etc.) to verify a package is real and trustworthy before installing it.",
  "keywords": [
    "mcp",
    "model-context-protocol",
    "ai-agent",
    "guardrails",
    "slopsquatting",
    "supply-chain-security",
    "hallucination"
  ],
  "author": "CodeAudit",
  "license": "MIT",
  "homepage": "https://github.com/DelTa-0/codeaudit",
  "repository": {
    "type": "git",
    "url": "git+https://github.com/DelTa-0/codeaudit.git",
    "directory": "mcp"
  },
  "bugs": "https://github.com/DelTa-0/codeaudit/issues",
  "engines": {
    "node": ">=18"
  },
  "bin": {
    "codeaudit-mcp": "dist/index.js"
  },
  "files": [
    "dist"
  ],
  "scripts": {
    "build": "tsc --noEmit -p tsconfig.json && node build.mjs",
    "test:ground-truth": "tsx test/ground-truth.ts",
    "prepublishOnly": "npm run build && npm run test:ground-truth"
  },
  "devDependencies": {
    "@codeaudit/engine": "*",
    "@modelcontextprotocol/sdk": "^1.0.0",
    "@types/node": "^22.10.0",
    "esbuild": "^0.28.1",
    "tsx": "^4.19.0",
    "typescript": "^5.7.0",
    "zod": "^3.23.8"
  }
}
```

- [ ] **Step 2: Create `mcp/tsconfig.json`**

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "NodeNext",
    "moduleResolution": "NodeNext",
    "strict": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "forceConsistentCasingInFileNames": true,
    "outDir": "dist",
    "rootDir": "src"
  },
  "include": ["src"]
}
```

- [ ] **Step 3: Create `mcp/build.mjs`**

```js
// Bundles the MCP server into a single self-contained dist/index.js — no
// node_modules dependency at install time, so `npx codeaudit-mcp` works
// standalone. Mirrors cli/build.mjs. ESM output (unlike the CLI's CJS
// output) is safe here because this package never imports @babel/traverse
// (no import-graph analysis happens in the MCP server), which is what
// forced the CLI onto CJS.
import { build } from "esbuild";
import { chmod } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const here = path.dirname(fileURLToPath(import.meta.url));

await build({
  entryPoints: ["src/index.ts"],
  outfile: "dist/index.js",
  bundle: true,
  platform: "node",
  target: "node18",
  format: "esm",
  minify: false,
  sourcemap: false,
  alias: {
    "@codeaudit/engine": path.resolve(here, "../packages/engine/dist/index.js"),
  },
});

await chmod("dist/index.js", 0o755);

console.log("built dist/index.js");
```

- [ ] **Step 4: Register the workspace and build script at the repo root**

In the root `package.json`, change:

```json
  "workspaces": ["packages/engine", "server", "web", "cli"],
```

to:

```json
  "workspaces": ["packages/engine", "server", "web", "cli", "mcp"],
```

And add this script (next to `"build:cli"`):

```json
    "build:mcp": "npm run build --workspace @codeaudit/engine && npm run build --workspace codeaudit-mcp",
```

- [ ] **Step 5: Install dependencies**

Run: `npm install`
Expected: completes without error; `mcp/node_modules` (or root-hoisted equivalents) now include `@modelcontextprotocol/sdk`, `zod`, `esbuild`, `tsx`.

- [ ] **Step 6: Verify the scaffold builds once a trivial entrypoint exists**

Create a temporary placeholder so Step 5's build has something to bundle (Task 5 replaces this file for real):

`mcp/src/index.ts`:
```ts
#!/usr/bin/env node
console.log("codeaudit-mcp placeholder");
```

Run: `npm run build:mcp`
Expected: `built dist/index.js` printed, `mcp/dist/index.js` exists and is executable.

Run: `node mcp/dist/index.js`
Expected: prints `codeaudit-mcp placeholder`.

- [ ] **Step 7: Commit**

```bash
git add mcp/package.json mcp/tsconfig.json mcp/build.mjs mcp/src/index.ts package.json package-lock.json
git commit -m "Scaffold mcp/ workspace for codeaudit-mcp"
```

---

### Task 4: MCP server — hosted-alternatives client

**Files:**
- Create: `mcp/src/hosted.ts`

**Interfaces:**
- Consumes: `AlternativeSuggestion`, `Ecosystem` types (existing, `@codeaudit/engine`); the `/api/mcp/alternatives` endpoint from Task 2.
- Produces: `fetchHostedAlternatives(targets: {packageName: string; ecosystem: Ecosystem}[], token: string, apiUrl: string): Promise<Map<string, AlternativeSuggestion[]>>` — consumed by Task 5's `mcp/src/index.ts`.

- [ ] **Step 1: Create `mcp/src/hosted.ts`**

```ts
// Client for the hosted /api/mcp/alternatives endpoint (server/src/routes/
// mcpAlternatives.ts). Only called when CODEAUDIT_TOKEN is set — see
// index.ts's enrichWithHostedAlternatives. Never throws: a failed or slow
// hosted call must never block the local (offline) verification result.
import type { AlternativeSuggestion, Ecosystem } from "@codeaudit/engine";

export async function fetchHostedAlternatives(
  targets: { packageName: string; ecosystem: Ecosystem }[],
  token: string,
  apiUrl: string,
): Promise<Map<string, AlternativeSuggestion[]>> {
  const result = new Map<string, AlternativeSuggestion[]>();
  if (targets.length === 0) return result;
  try {
    const res = await fetch(`${apiUrl}/api/mcp/alternatives`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token, packages: targets }),
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) return result;
    const data = (await res.json()) as { alternatives?: Record<string, AlternativeSuggestion[]> };
    for (const [name, alts] of Object.entries(data.alternatives ?? {})) {
      if (Array.isArray(alts) && alts.length) result.set(name, alts);
    }
  } catch {
    // best-effort — hosted enrichment never blocks the local result
  }
  return result;
}
```

- [ ] **Step 2: Typecheck**

Run: `cd mcp && npx tsc --noEmit -p tsconfig.json`
Expected: no errors. (This will fail to resolve `@codeaudit/engine`'s types if Task 1 wasn't built first — run `npm run build:engine` from the repo root first if so.)

- [ ] **Step 3: Commit**

```bash
git add mcp/src/hosted.ts
git commit -m "Add hosted-alternatives client to codeaudit-mcp"
```

---

### Task 5: MCP server — verify_package / verify_packages tools

**Files:**
- Modify: `mcp/src/index.ts` (replace the Task 3 placeholder)

**Interfaces:**
- Consumes: `verifyPackage`, `PackageVerifyResult` (Task 1, `@codeaudit/engine`); `fetchHostedAlternatives` (Task 4, `./hosted.js`); `McpServer`, `StdioServerTransport` (`@modelcontextprotocol/sdk`).
- Produces: the real `codeaudit-mcp` executable — a running stdio MCP server with two registered tools, `verify_package` and `verify_packages`. Task 6's test spawns this as a child process.

- [ ] **Step 1: Replace the placeholder with the real server**

```ts
#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { verifyPackage, type PackageVerifyResult } from "@codeaudit/engine";
import { fetchHostedAlternatives } from "./hosted.js";

const token = process.env.CODEAUDIT_TOKEN || null;
const apiUrl = process.env.CODEAUDIT_API_URL || "https://api.codeaudit.dev";
const CONCURRENCY = 5;

/**
 * Runs `fn` over `items` with at most `limit` in flight at once — same
 * queue/workerLoop shape registry.ts uses for its own registry lookups,
 * so a large verify_packages batch doesn't hammer npm/PyPI all at once.
 */
async function mapConcurrent<T, R>(items: T[], limit: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  const queue = items.map((item, i) => ({ item, i }));
  async function worker() {
    while (queue.length) {
      const next = queue.shift();
      if (!next) return;
      results[next.i] = await fn(next.item);
    }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return results;
}

/**
 * When the agent doesn't specify an ecosystem, try npm first (the larger of
 * the two popular-package lists, and most ambiguous bare names in practice
 * are JS packages), then PyPI. If neither registry has the name, report the
 * npm result — the fuzzy "did you mean" match still runs against npm's
 * (larger) popular-package list.
 */
async function verifyWithGuessedEcosystem(
  name: string,
  ecosystem?: "npm" | "pypi",
): Promise<PackageVerifyResult> {
  if (ecosystem) return verifyPackage(name, ecosystem);
  const npmResult = await verifyPackage(name, "npm");
  if (npmResult.exists) return npmResult;
  const pypiResult = await verifyPackage(name, "pypi");
  if (pypiResult.exists) return pypiResult;
  return npmResult;
}

/** Mutates phantom-with-no-fuzzy-match results in place with a hosted LLM suggestion, only when CODEAUDIT_TOKEN is set. */
async function enrichWithHostedAlternatives(results: PackageVerifyResult[]): Promise<void> {
  if (!token) return;
  const needing = results.filter((r) => r.status === "phantom" && !r.alternatives?.length);
  if (needing.length === 0) return;
  const hosted = await fetchHostedAlternatives(
    needing.map((r) => ({ packageName: r.name, ecosystem: r.ecosystem })),
    token,
    apiUrl,
  );
  for (const r of needing) {
    const alts = hosted.get(r.name);
    if (alts?.length) r.alternatives = alts;
  }
}

const TOOL_DESCRIPTION_PREFIX =
  "Call this before running an install command for any package the user did not explicitly name, and before adding a new entry to a manifest file. ";

const server = new McpServer({ name: "codeaudit-mcp", version: "0.1.0" });

server.registerTool(
  "verify_package",
  {
    title: "Verify package",
    description:
      TOOL_DESCRIPTION_PREFIX +
      "Checks whether the package actually exists on its registry (npm or PyPI), whether it looks like a typo of a popular package, its download count and age, and any known CVEs. Returns a suggested real alternative when the package doesn't exist.",
    inputSchema: {
      name: z.string().min(1).max(214).describe("The package name to verify."),
      ecosystem: z
        .enum(["npm", "pypi"])
        .optional()
        .describe("The registry to check. Omit to auto-detect (tries npm, then PyPI)."),
    },
  },
  async ({ name, ecosystem }) => {
    const result = await verifyWithGuessedEcosystem(name, ecosystem);
    await enrichWithHostedAlternatives([result]);
    return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] };
  },
);

server.registerTool(
  "verify_packages",
  {
    title: "Verify multiple packages",
    description:
      TOOL_DESCRIPTION_PREFIX +
      "Same checks as verify_package, batched for reviewing an entire new dependency list at once (e.g. every new entry in a package.json or requirements.txt diff) instead of one call per package.",
    inputSchema: {
      packages: z
        .array(
          z.object({
            name: z.string().min(1).max(214),
            ecosystem: z.enum(["npm", "pypi"]).optional(),
          }),
        )
        .min(1)
        .max(50)
        .describe("The packages to verify."),
    },
  },
  async ({ packages }) => {
    const results = await mapConcurrent(packages, CONCURRENCY, (p) =>
      verifyWithGuessedEcosystem(p.name, p.ecosystem),
    );
    await enrichWithHostedAlternatives(results);
    return { content: [{ type: "text" as const, text: JSON.stringify(results, null, 2) }] };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
```

- [ ] **Step 2: Build**

Run: `npm run build:mcp` (from the repo root)
Expected: `built dist/index.js`. If this fails with a type error naming a different export shape than `registerTool`/`inputSchema`/`content`, open `mcp/node_modules/@modelcontextprotocol/sdk/dist/esm/server/mcp.d.ts` (the installed version's actual type definitions) and adjust the call to match — the exact method name and config-object shape can shift between SDK releases; the installed package's own `.d.ts` file is the source of truth, not this plan.

- [ ] **Step 3: Manual sanity check (server starts and doesn't crash)**

Run: `node mcp/dist/index.js` in one terminal, then in another: `echo '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2024-11-05","capabilities":{},"clientInfo":{"name":"manual-check","version":"0.0.1"}}}' | node mcp/dist/index.js`
Expected: a single line of JSON is printed to stdout containing `"result"` with server capabilities (not an error). Kill the process (Ctrl+C) once confirmed — Task 6 automates this properly.

- [ ] **Step 4: Commit**

```bash
git add mcp/src/index.ts
git commit -m "Implement verify_package/verify_packages MCP tools"
```

---

### Task 6: MCP server — ground-truth test over stdio

**Files:**
- Create: `mcp/test/ground-truth.ts`

**Interfaces:**
- Consumes: the built `mcp/dist/index.js` (Task 5) via `node:child_process`.
- Produces: `npm run test:ground-truth --workspace codeaudit-mcp` — the automated verification for this whole plan's offline path (no `CODEAUDIT_TOKEN` set).

- [ ] **Step 1: Write the test**

```ts
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

function startServer() {
  const child = spawn(process.execPath, [serverPath], {
    stdio: ["pipe", "pipe", "inherit"],
    env: { ...process.env, CODEAUDIT_TOKEN: "" },
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

const guessed = await callTool(send, "verify_package", { name: "requests" });
checks.push([
  "verify_package with ecosystem omitted resolves 'requests' via pypi guess",
  guessed.ecosystem === "pypi" && guessed.status !== "phantom",
]);

console.log("--- checks ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
child.kill();
process.exit(failed ? 1 : 0);
```

- [ ] **Step 2: Run it — expect it to fail first if the server isn't built**

Run: `cd mcp && rm -rf dist && npm run test:ground-truth`
Expected: fails immediately — `Error: Cannot find module '.../mcp/dist/index.js'` (or similar ENOENT) — confirming the test genuinely exercises the built artifact, not source.

- [ ] **Step 3: Build and run for real**

Run: `npm run build:mcp` (from repo root), then `cd mcp && npm run test:ground-truth`
Expected: every line prints `PASS`. Exit code 0.

- [ ] **Step 4: Commit**

```bash
git add mcp/test/ground-truth.ts
git commit -m "Add stdio JSON-RPC ground-truth test for codeaudit-mcp"
```

---

### Task 7: Docs — mcp/README.md and main README section

**Files:**
- Create: `mcp/README.md`
- Modify: `README.md` (root)

**Interfaces:**
- Consumes: nothing (documentation only).
- Produces: user-facing setup instructions — the mechanism that actually drives adoption of the advisory-only v1 (see spec's "Enforcement model").

- [ ] **Step 1: Create `mcp/README.md`**

```markdown
# codeaudit-mcp

An MCP server that lets AI coding agents (Claude Code, Cursor, Cline, and
other MCP-compatible tools) check whether a package is real and
trustworthy **before** installing it — catching hallucinated ("phantom")
packages, typosquats, and known CVEs at the moment an agent is about to
`npm install`/`pip install` something.

Runs fully offline by default (no account needed) — same registry/CVE
checks as `npx codeaudit-scan`. Set `CODEAUDIT_TOKEN` to additionally get
an LLM-suggested real alternative for phantom packages that aren't a
simple typo of anything popular (e.g. `fastimagepro` → Pillow/imageio).

## Setup

Add to your agent's MCP config, pointing at `npx codeaudit-mcp`:

**Claude Code** (`.claude/mcp.json` or via `claude mcp add`):

```json
{
  "mcpServers": {
    "codeaudit": {
      "command": "npx",
      "args": ["-y", "codeaudit-mcp"],
      "env": { "CODEAUDIT_TOKEN": "" }
    }
  }
}
```

**Cursor** (`.cursor/mcp.json`): identical shape to the above.

**Any other MCP-compatible client**: use the same `command`/`args` —
`npx -y codeaudit-mcp` — with `CODEAUDIT_TOKEN` as an optional env var.

Then add one line to your agent's instructions file (e.g. `CLAUDE.md`) so
the agent actually calls it — an MCP tool's description alone doesn't force
an agent to invoke it:

> Before installing any new package, call the CodeAudit `verify_package`
> tool.

## Tools

- `verify_package({ name, ecosystem? })` — checks one package.
- `verify_packages({ packages: [{ name, ecosystem? }] })` — checks several
  at once (e.g. every new line in a manifest diff).

`ecosystem` (`"npm"` or `"pypi"`) is optional — omit it and the tool tries
npm first, then PyPI.

## Getting a token (optional)

A `CODEAUDIT_TOKEN` is the same per-repo token used by `codeaudit-scan
--upload` — generate one from your repository's settings page at
[codeaudit.dev](https://codeaudit.dev), or via `POST
/repos/:repoId/cli-token` if self-hosting.
```

- [ ] **Step 2: Add a section to the root `README.md`**

Add a new `### Guardrails for AI coding agents` subsection under the existing `## Feature guide` section (peer to the existing `### CLI (npx codeaudit-scan)` subsection), and add it to the table of contents list alongside the CLI entry:

```markdown
  - [Guardrails for AI coding agents (`codeaudit-mcp`)](#guardrails-for-ai-coding-agents-codeaudit-mcp)
```

```markdown
### Guardrails for AI coding agents (`codeaudit-mcp`)

An MCP server your AI coding agent can call *before* installing a package,
to check whether it's real, well-maintained, and free of known CVEs —
catching hallucinated packages and typosquats at the moment an agent is
about to install them, rather than in a scan after the fact. See
[`mcp/README.md`](mcp/README.md) for setup (Claude Code, Cursor, and any
other MCP-compatible agent).
```

- [ ] **Step 3: Commit**

```bash
git add mcp/README.md README.md
git commit -m "Document codeaudit-mcp setup for AI coding agents"
```

---

## Self-Review Notes

- **Spec coverage:** every MVP checklist item from the design spec has a task — workspace scaffold (Task 3), stdio server with both tools (Task 5), hybrid local/hosted logic (Tasks 1, 2, 4, 5), `POST /api/mcp/alternatives` (Task 2), ground-truth test (Task 6), README + main README section (Task 7).
- **No new detection logic:** confirmed `verify.ts` (Task 1) only recomposes existing exported/newly-exported engine functions; no new algorithm.
- **Type consistency checked:** `PackageVerifyResult` (Task 1) is the single definition threaded through Task 4 (`hosted.ts`'s target type), Task 5 (`verifyWithGuessedEcosystem`/`enrichWithHostedAlternatives` return/parameter types), and Task 6 (asserted against in the test) — no renamed duplicate.
- **HTTP-route testing gap acknowledged deliberately:** this repo has zero automated tests for any Express route today; Task 2 follows that existing convention (manual `curl` smoke test) rather than introducing new test infrastructure out of scope for this plan.
