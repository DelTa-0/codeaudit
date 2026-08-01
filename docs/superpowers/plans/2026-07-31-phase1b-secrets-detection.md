# Phase 1b — Secrets Detection Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Detect hardcoded credentials in the working tree and in git history, rank them above every other finding, and surface them everywhere without ever letting a real secret value leave the machine it was found on.

**Architecture:** Detection is a pure function in `packages/engine/src/secrets.ts` with its own file walk (credentials hide in `.env`/`.yml`/`.tf`, not just JS/TS). Git plumbing lives server-side in `server/src/analysis/historySecrets.ts`, mirroring `aiAuthorship.ts`, so the engine stays subprocess-free. A single `redact()` choke point guarantees no raw value reaches the database, the LLM, an upload, an export, or a PR comment.

**Tech Stack:** TypeScript, Node 18+, `node:crypto` (stdlib, for fingerprints), `@codeaudit/engine`, Express/BullMQ worker, React 19 dashboard, esbuild CLI bundle, ground-truth assertion suite.

## Global Constraints

- **Engine stays LLM-free, heavy-dependency-free, and subprocess-free.** No new npm dependencies. `node:crypto` is stdlib and permitted; `git` execution is server-side only.
- **A raw secret value must never be persisted, logged, uploaded, exported, sent to the LLM, or posted to GitHub.** Only `provider`, `filePath`, `line`, a redacted shape, and a non-reversible fingerprint may leave the detector.
- **PR comments are public on public repositories.** A leaked value there is published to the internet.
- Secrets findings must NOT be passed into `reviewCandidatesWithLlm` — that call already receives raw source in `SymbolInfo.body`, and secrets must not widen it.
- Secrets **do** affect the health score (−20 each, capped at −40). This is the one Phase 1 detector that scores immediately, per the spec. Deprecated/licence/duplicate stay advisory.
- Precision over recall: every detector needs must-NOT-fire coverage, and the exclusion list is tested harder than the detection list.
- ESM: TypeScript source imports use `.js` specifiers.
- Test harness: `npm run test:ground-truth --prefix server`. Tests are `[label, boolean]` pairs pushed onto the existing `checks` array, inserted before `console.log("--- checks ---");`.
- Spec: `docs/superpowers/specs/2026-07-31-phase1-signal-design.md`.

---

## File Structure

| File | Responsibility |
|---|---|
| `packages/engine/src/imports.ts` | **Modify.** Skip fixture/test dirs in the import graph (Task 1). |
| `packages/engine/src/priority.ts` | **Modify.** Honest transitive labelling (Task 1); secrets ranking (Task 5). |
| `packages/engine/src/secrets.ts` | **Create.** Detection tiers, exclusions, `redact()`, `fingerprintSecret()`, file walk. |
| `packages/engine/src/score.ts` | **Modify.** Secrets penalty (Task 5). |
| `packages/engine/src/index.ts` | **Modify.** Export the secrets surface. |
| `server/migrations/004_finding_detail.sql` | **Create.** `code_findings.detail JSONB`. |
| `server/src/analysis/historySecrets.ts` | **Create.** `git log -p` plumbing + dedupe + `removedFromHead`. |
| `server/src/worker.ts` | **Modify.** Run both scans, persist redacted findings. |
| `cli/src/index.ts` | **Modify.** Redacted secrets output. |
| `web/src/pages/ScanDetail.tsx` | **Modify.** Secrets card with rotate-vs-remove guidance. |
| `server/src/queue/prComment.ts` | **Modify.** Redacted secrets row. |

---

### Task 1: Close the two dogfooding accuracy bugs

Prerequisite, not scope creep: a live scan of this repo produced two CRITICAL false positives (`react-toolkitz`, `@fixture/internal`) because test fixtures are walked as production code. Secrets detection walks the same tree and would fire on the same fixtures, so this must land first or Phase 1b inherits the problem.

**Files:**
- Modify: `packages/engine/src/imports.ts`
- Modify: `packages/engine/src/priority.ts`
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Produces: no signature change. `listSourceFiles` returns fewer paths; `rankFindings` emits different `location`/`effort`/`why` for transitive verdicts.

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts` before `console.log("--- checks ---");`:

```ts
// --- Fixture directories must not leak into the import graph ---
const repoRoot = path.join(fixtureDir, "..", "..", "..");
const selfAnalysis = analyzeRepo(repoRoot);
checks.push(
  [
    "whole-repo scan does NOT treat the test fixture's fake package as imported",
    !selfAnalysis.importedPackages.has("react-toolkitz"),
  ],
  [
    "whole-repo scan does NOT treat the fixture workspace member as imported",
    !selfAnalysis.importedPackages.has("@fixture/internal"),
  ],
  [
    "whole-repo scan still sees a genuinely imported production package",
    selfAnalysis.importedPackages.has("express"),
  ],
);

// --- Transitive vulnerabilities must not be described as direct dependencies ---
const transitiveRanked = rankFindings({
  deps: [
    {
      packageName: "deep-dep",
      declaredVersion: null,
      status: "vulnerable",
      ecosystem: "npm",
      registryMetadata: { maxSeverity: "high", transitive: true },
    },
  ] as unknown as Parameters<typeof rankFindings>[0]["deps"],
  codeFindings: [],
});
const transitiveItem = transitiveRanked[0];
checks.push(
  ["a transitive CVE is not located at package.json", transitiveItem?.location !== "package.json"],
  ["a transitive CVE is not rated S effort", transitiveItem?.effort !== "S"],
  [
    "a transitive CVE's why does not claim a direct version bump",
    !/usually a version bump/i.test(transitiveItem?.why ?? ""),
  ],
);
```

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL on all six new checks.

- [ ] **Step 3: Skip fixture and test directories in the file walk**

In `packages/engine/src/imports.ts`, extend the skip logic. Add next to `SKIP_DIRS`:

```ts
/**
 * Test fixtures are deliberately fake. `server/test/fixture/` here contains a
 * non-existent package and a workspace member that exists only to exercise the
 * analyzer, and a whole-repo scan was reporting both as CRITICAL phantom
 * dependencies. `deadcode.ts` already filters these paths when judging symbols;
 * the import graph needs the same filter or the fake names reach dependency
 * verdicts.
 */
const SKIP_DIR_NAMES_EXTRA = new Set(["__tests__", "__mocks__", "__fixtures__"]);
const FIXTURE_DIR_PATTERN = /^(fixtures?|test-fixtures?)$/i;
```

and change `shouldSkipDir` to:

```ts
function shouldSkipDir(name: string): boolean {
  return (
    SKIP_DIRS.has(name) ||
    SKIP_DIR_PATTERN.test(name) ||
    SKIP_DIR_NAMES_EXTRA.has(name) ||
    FIXTURE_DIR_PATTERN.test(name)
  );
}
```

Note the ground-truth suite calls `analyzeRepo(fixtureDir)` directly with the fixture as its ROOT, which still works — only directories *named* like fixtures encountered during a walk are skipped, not the walk's own starting point.

- [ ] **Step 4: Label transitive findings honestly**

In `packages/engine/src/priority.ts`, replace the `vulnerable` branch with:

```ts
    } else if (dep.status === "vulnerable") {
      const severity = (meta.maxSeverity as string | undefined) ?? "unknown";
      const critical = severity === "critical" || severity === "high";
      // A transitive package is not in any manifest, so "bump the version" is
      // not advice the reader can act on — they have to upgrade whatever pulls
      // it in, if a fixed release even exists yet.
      const transitive = meta.transitive === true;
      items.push({
        band: critical ? "critical" : "medium",
        kind: "vulnerable_dependency",
        title: `${dep.packageName} has known vulnerabilities (${severity})`,
        location: transitive ? "transitive dependency" : dep.ecosystem === "npm" ? "package.json" : "requirements",
        why: transitive
          ? `A published advisory affects a package pulled in indirectly, so it is not in your manifest. Fixing it means upgrading whichever dependency requires it — check your lockfile for the parent.`
          : `A published advisory affects the version currently resolved. Upgrading is usually a version bump, which makes this a high-value, low-effort fix.`,
        effort: transitive ? "L" : "S",
        confidence: 1,
      });
    } else if (dep.status === "suspicious") {
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: all six new checks PASS, zero regressions.

- [ ] **Step 6: Verify against the real repo**

```bash
npm run build:cli && node cli/dist/index.js scan .
```
Expected: `react-toolkitz` and `@fixture/internal` no longer appear; the score rises by roughly 30 points; transitive CVEs read "transitive dependency".

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/imports.ts packages/engine/src/priority.ts server/test/ground-truth.ts
git commit -m "Stop scanning test fixtures and mislabelling transitive CVEs"
```

---

### Task 2: Secret detection core

**Files:**
- Create: `packages/engine/src/secrets.ts`
- Modify: `packages/engine/src/index.ts`
- Test: `server/test/ground-truth.ts`

**Interfaces:**
- Produces:
  - `interface SecretFinding { filePath: string; line: number; provider: string; redacted: string; fingerprint: string; tier: 1 | 2; removedFromHead?: boolean; firstSeenCommit?: string; lastSeenCommit?: string }`
  - `scanTextForSecrets(text: string, filePath: string): SecretFinding[]` — pure, one buffer, used by both the working-tree walk and the history scanner
  - `findSecrets(repoDir: string): SecretFinding[]` — walks the tree
  - `redact(value: string): string`
  - `fingerprintSecret(value: string): string`
  - `isSecretScannablePath(relPath: string): boolean`

- [ ] **Step 1: Write the failing test**

Append to `server/test/ground-truth.ts` before `console.log("--- checks ---");`:

```ts
// --- Secret detection: tiers, exclusions, redaction ---
const AWS = "AKIA" + "IOSFODNN7EXAMPLE";
const GROQ = "gsk_" + "a".repeat(52);
const fire = (text: string, file = "src/config.ts") => scanTextForSecrets(text, file);
checks.push(
  ["tier 1: an AWS access key is detected", fire(`const k = "${AWS}";`).length === 1],
  ["tier 1: a Groq key is detected", fire(`const k = "${GROQ}";`).length === 1],
  [
    "tier 1: a PEM private key header is detected",
    fire("-----BEGIN RSA PRIVATE KEY-----").length === 1,
  ],
  [
    "tier 2: a high-entropy value on a secret-named key is detected",
    fire(`const apiKey = "9f2Kq7ZxVb3LmNp8RtYw1CsE4DhGj6Uk";`).length === 1,
  ],
  // --- must NOT fire: these matter more than the ones above ---
  [
    "does NOT fire on a process.env reference",
    fire(`const apiKey = process.env.API_KEY;`).length === 0,
  ],
  [
    "does NOT fire on an obvious placeholder",
    fire(`const apiKey = "your-api-key-here-placeholder";`).length === 0,
  ],
  [
    "does NOT fire on a low-entropy repeated string",
    fire(`const apiKey = "aaaaaaaaaaaaaaaaaaaaaaaa";`).length === 0,
  ],
  [
    "does NOT fire on a short value",
    fire(`const apiKey = "abc123";`).length === 0,
  ],
  ["does NOT scan a .env.example file", !isSecretScannablePath(".env.example")],
  ["does NOT scan a lockfile", !isSecretScannablePath("package-lock.json")],
  ["does NOT scan a fixture directory", !isSecretScannablePath("server/test/fixture/x.ts")],
  ["DOES scan a real .env file", isSecretScannablePath(".env")],
  ["DOES scan a docker-compose file", isSecretScannablePath("docker-compose.yml")],
  ["DOES scan a terraform file", isSecretScannablePath("infra/main.tf")],
  // --- redaction: the highest-severity guarantee in this feature ---
  ["redact never returns the raw value", redact(AWS) !== AWS],
  ["redact reveals at most 4 leading characters", redact(AWS).startsWith("AKIA") && !redact(AWS).includes("IOSFODNN7EXAMPLE")],
  ["redact reports the length", /\(\d+ chars\)/.test(redact(AWS))],
  ["fingerprint is not the raw value", fingerprintSecret(AWS) !== AWS],
  ["fingerprint is stable", fingerprintSecret(AWS) === fingerprintSecret(AWS)],
  ["fingerprint differs for different values", fingerprintSecret(AWS) !== fingerprintSecret(GROQ)],
  [
    "no finding object contains the raw secret anywhere in its serialization",
    !JSON.stringify(fire(`const k = "${AWS}";`)).includes(AWS),
  ],
);
```

Add `scanTextForSecrets`, `isSecretScannablePath`, `redact`, `fingerprintSecret` to the `@codeaudit/engine` import block.

- [ ] **Step 2: Run test to verify it fails**

Run: `npm run test:ground-truth --prefix server`
Expected: FAIL — the module does not exist.

- [ ] **Step 3: Create the module**

Create `packages/engine/src/secrets.ts`:

```ts
import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * A credential found in source. Deliberately does NOT carry the value — see
 * `redact`. A secrets scanner that stores secrets is a liability, not a
 * feature, and this finding travels to a database, an API, an export and
 * (for public repositories) a world-readable pull-request comment.
 */
export interface SecretFinding {
  filePath: string;
  line: number;
  provider: string;
  /** e.g. `AKIA…(20 chars)`. Never the value. */
  redacted: string;
  /** Non-reversible; used only to deduplicate across HEAD and git history. */
  fingerprint: string;
  tier: 1 | 2;
  /** Set by history scanning: gone from HEAD but still in git objects. */
  removedFromHead?: boolean;
  firstSeenCommit?: string;
  lastSeenCommit?: string;
}

/** Tier 1 — issuer-prefixed credentials. Near-zero false positive rate. */
const PROVIDER_PATTERNS: { provider: string; pattern: RegExp }[] = [
  { provider: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { provider: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { provider: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { provider: "Groq API key", pattern: /\bgsk_[A-Za-z0-9]{40,}/ },
  { provider: "GitHub token", pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36,}\b/ },
  { provider: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { provider: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { provider: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { provider: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { provider: "SendGrid API key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { provider: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { provider: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { provider: "DigitalOcean token", pattern: /\bdop_v1_[a-f0-9]{64}\b/ },
  { provider: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/** Tier 2 — a secret-sounding name assigned a high-entropy literal. */
const CONTEXTUAL_ASSIGNMENT =
  /['"]?([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)[A-Za-z0-9_.-]*)['"]?\s*[:=]\s*['"]([^'"\n]{16,})['"]/gi;

const MIN_ENTROPY_BITS = 4;

/**
 * Reading a value from the environment is the CORRECT pattern, not a finding.
 * Without this, every well-written config file lights up.
 */
const ENV_REFERENCE = /process\.env|os\.environ|import\.meta\.env|ENV\[|getenv\(|Deno\.env/;

/** Values that are obviously stand-ins rather than live credentials. */
const PLACEHOLDER =
  /^(?:x{3,}|\.{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|your[-_ ]|my[-_ ]|changeme|placeholder|dummy|example|sample|redacted|insert|todo|fixme|abc123|test[-_]?(?:key|token|secret)?$)/i;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The single choke point through which a secret may be described. Everything
 * that leaves this module — database row, API payload, CLI line, PR comment,
 * exported report — must describe the value through this, never directly.
 */
export function redact(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

/** Stable, non-reversible identity for deduplication. Never stored as a value. */
export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const SCANNABLE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yml", ".yaml",
  ".ini", ".cfg", ".conf", ".toml", ".tf", ".tfvars", ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".java", ".properties", ".xml", ".txt", ".md", ".env",
]);

const EXCLUDED_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv)\//;
const EXCLUDED_FIXTURE = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|test-fixtures?)\//i;
/** Integrity hashes are maximally high-entropy and would fire on every line. */
const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$/;
/** Template env files exist precisely to hold fake values. */
const TEMPLATE_FILE = /(\.example|\.sample|\.template|\.dist)$|(^|\/)\.env\.(example|sample|template)$/i;
const MINIFIED = /\.min\.(js|css)$|\.map$/;

export function isSecretScannablePath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  if (EXCLUDED_PATH.test(normalized)) return false;
  if (EXCLUDED_FIXTURE.test(normalized)) return false;
  if (LOCKFILE.test(normalized)) return false;
  if (TEMPLATE_FILE.test(normalized)) return false;
  if (MINIFIED.test(normalized)) return false;
  const base = path.posix.basename(normalized);
  // `.env`, `.env.local`, `.npmrc` have no extension in the usual sense.
  if (base.startsWith(".env") || base === ".npmrc" || base === ".netrc") return true;
  return SCANNABLE_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

/**
 * Scan one buffer. Shared by the working-tree walk and by the server-side git
 * history scanner, so detection logic exists in exactly one place.
 */
export function scanTextForSecrets(text: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");

  const push = (value: string, provider: string, line: number, tier: 1 | 2) => {
    const fingerprint = fingerprintSecret(value);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    findings.push({ filePath, line, provider, redacted: redact(value), fingerprint, tier });
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.slice(0, 2000);
    const lineNumber = index + 1;

    for (const { provider, pattern } of PROVIDER_PATTERNS) {
      const match = pattern.exec(line);
      if (match) push(match[0], provider, lineNumber, 1);
    }

    if (ENV_REFERENCE.test(line)) return;

    CONTEXTUAL_ASSIGNMENT.lastIndex = 0;
    let contextual: RegExpExecArray | null;
    while ((contextual = CONTEXTUAL_ASSIGNMENT.exec(line)) !== null) {
      const value = contextual[2];
      if (PLACEHOLDER.test(value)) continue;
      if (shannonEntropy(value) < MIN_ENTROPY_BITS) continue;
      push(value, "generic credential", lineNumber, 2);
    }
  });

  return findings;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;

/** Walks the repository. Its own walk: credentials live in .env and .tf, not just source. */
export function findSecrets(repoDir: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const stack = [repoDir];

  while (stack.length && findings.length < MAX_FINDINGS) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(repoDir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!EXCLUDED_PATH.test(`${rel}/`) && !EXCLUDED_FIXTURE.test(`${rel}/`)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isSecretScannablePath(rel)) continue;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        findings.push(...scanTextForSecrets(fs.readFileSync(full, "utf8"), rel));
      } catch {
        // unreadable or non-UTF8 file — skip, never fail a scan for one file
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}
```

- [ ] **Step 4: Export from the engine**

In `packages/engine/src/index.ts`:

```ts
export {
  findSecrets,
  scanTextForSecrets,
  isSecretScannablePath,
  redact,
  fingerprintSecret,
  type SecretFinding,
} from "./secrets.js";
```

- [ ] **Step 5: Run test to verify it passes**

Run: `npm run test:ground-truth --prefix server`
Expected: all 20 new checks PASS.

- [ ] **Step 6: Self-scan sanity check**

```bash
npm run build:engine
node -e "import('./packages/engine/dist/index.js').then(e=>console.log(JSON.stringify(e.findSecrets('.'),null,1)))"
```
Expected: an empty array, or only findings you can confirm are real. `server/.env` is gitignored but present — if it is scanned, confirm the output shows only redacted shapes and no values. Any false positive here must be fixed before proceeding.

- [ ] **Step 7: Commit**

```bash
git add packages/engine/src/secrets.ts packages/engine/src/index.ts server/test/ground-truth.ts
git commit -m "Add hardcoded-secret detection with redaction at the boundary"
```

---

### Task 3: Migration 004 and worker persistence

**Files:**
- Create: `server/migrations/004_finding_detail.sql`
- Modify: `server/src/worker.ts`

**Interfaces:**
- Consumes: `findSecrets`
- Produces: `code_findings` rows with `finding_type = 'hardcoded_secret'` and a populated `detail` JSONB.

- [ ] **Step 1: Create the migration**

Create `server/migrations/004_finding_detail.sql`:

```sql
-- Structured metadata for finding types that do not fit the original
-- dead-code-shaped columns. Secrets need a provider, a redacted shape, a
-- dedupe fingerprint and (for history findings) a commit SHA.
--
-- NEVER store a raw secret value in this column.
ALTER TABLE code_findings ADD COLUMN detail JSONB;
```

- [ ] **Step 2: Apply and verify**

```bash
npm run migrate
docker compose exec -T postgres psql -U codeaudit -d codeaudit -c "\d code_findings"
```
Expected: a `detail | jsonb` row in the output.

- [ ] **Step 3: Run the working-tree scan in the worker**

In `server/src/worker.ts`, add `findSecrets` to the `@codeaudit/engine` import block. Then, immediately AFTER the `reviewCandidatesWithLlm` call and its persistence loop, add:

```ts
    // Deliberately after the LLM pass and never part of its input: that call
    // already receives raw source in each candidate's `body`, and secrets must
    // not widen what leaves the machine. Persisted redacted — the raw value is
    // never written to the database.
    let secrets: ReturnType<typeof findSecrets> = [];
    try {
      secrets = findSecrets(dir);
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] secret scan failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    for (const s of secrets) {
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning, detail)
         VALUES ($1, $2, $3, $3, $4, 'hardcoded_secret', 1.0, $5, $6)`,
        [
          scanJobId,
          s.filePath,
          s.line,
          s.provider,
          `A ${s.provider} appears to be hardcoded here. Rotate it, then move it to an environment variable.`,
          JSON.stringify({
            provider: s.provider,
            redacted: s.redacted,
            fingerprint: s.fingerprint,
            tier: s.tier,
          }),
        ],
      );
    }
```

- [ ] **Step 4: Typecheck**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 5: Prove no raw value is persisted**

Create a scratch file OUTSIDE the repo containing a fake AWS key, point a scan at it, then:

```bash
docker compose exec -T postgres psql -U codeaudit -d codeaudit -c "SELECT detail FROM code_findings WHERE finding_type='hardcoded_secret' LIMIT 5;"
```
Expected: only redacted shapes such as `AKIA…(20 chars)`. **If any raw key appears, stop and fix before continuing.**

- [ ] **Step 6: Commit**

```bash
git add server/migrations/004_finding_detail.sql server/src/worker.ts
git commit -m "Persist redacted secret findings from the working tree"
```

---

### Task 4: Git history scanning

**Files:**
- Create: `server/src/analysis/historySecrets.ts`
- Modify: `server/src/worker.ts`

**Interfaces:**
- Consumes: `scanTextForSecrets`, `SecretFinding`
- Produces: `scanHistorySecrets(repoDir: string, headFingerprints: Set<string>): Promise<SecretFinding[]>`

- [ ] **Step 1: Create the module**

Create `server/src/analysis/historySecrets.ts`:

```ts
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { scanTextForSecrets, type SecretFinding } from "@codeaudit/engine";

const run = promisify(execFile);

const MAX_COMMITS = 100;
const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;
const TIMEOUT_MS = 60_000;

/**
 * Secrets that were committed and later deleted are still in the git objects
 * and still compromised — anyone who cloned has them. Deleting the line does
 * not help; only rotation does. That finding class is invisible to a
 * working-tree scan, which is the whole reason this exists.
 *
 * Lives server-side rather than in the engine because it shells out to git,
 * and the engine is deliberately subprocess-free. Detection itself is still
 * the engine's `scanTextForSecrets`, so there is one detector, not two.
 *
 * Best-effort: returns [] on any failure, like the rest of analysis/.
 */
export async function scanHistorySecrets(
  repoDir: string,
  headFingerprints: Set<string>,
): Promise<SecretFinding[]> {
  let stdout: string;
  try {
    const result = await run(
      "git",
      ["log", "-p", "--unified=0", "--no-color", `--max-count=${MAX_COMMITS}`],
      { cwd: repoDir, timeout: TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES },
    );
    stdout = result.stdout;
  } catch {
    return [];
  }

  const byFingerprint = new Map<string, SecretFinding>();
  let commit = "";
  let file = "";

  for (const line of stdout.split("\n")) {
    if (line.startsWith("commit ")) {
      commit = line.slice(7, 47).trim();
      continue;
    }
    if (line.startsWith("+++ b/")) {
      file = line.slice(6).trim();
      continue;
    }
    // Added lines only: every secret ever introduced appears as one at some
    // point, so this is complete without walking whole trees.
    if (!line.startsWith("+") || line.startsWith("+++")) continue;

    for (const found of scanTextForSecrets(line.slice(1), file)) {
      const existing = byFingerprint.get(found.fingerprint);
      if (existing) {
        // git log is newest-first, so an earlier iteration saw a later commit.
        existing.firstSeenCommit = commit;
        continue;
      }
      byFingerprint.set(found.fingerprint, {
        ...found,
        firstSeenCommit: commit,
        lastSeenCommit: commit,
        removedFromHead: !headFingerprints.has(found.fingerprint),
      });
    }
  }

  return [...byFingerprint.values()].filter((f) => f.removedFromHead);
}
```

Only findings absent from HEAD are returned — anything still present is already reported by the working-tree scan, and reporting it twice is noise.

- [ ] **Step 2: Wire into the worker**

In `server/src/worker.ts`, immediately after the working-tree secrets loop from Task 3:

```ts
    // Secrets that are gone from HEAD but still recoverable from git objects.
    // The recommendation differs fundamentally: you cannot fix these by
    // editing a file, only by rotating the credential.
    let historySecrets: SecretFinding[] = [];
    try {
      historySecrets = await scanHistorySecrets(dir, new Set(secrets.map((s) => s.fingerprint)));
    } catch (err) {
      console.error(
        `[scan ${scanJobId}] history secret scan failed (continuing without it):`,
        err instanceof Error ? err.message : err,
      );
    }
    for (const s of historySecrets) {
      await query(
        `INSERT INTO code_findings
           (scan_job_id, file_path, line_start, line_end, symbol_name, finding_type,
            confidence_score, llm_reasoning, detail)
         VALUES ($1, $2, $3, $3, $4, 'hardcoded_secret_history', 1.0, $5, $6)`,
        [
          scanJobId,
          s.filePath,
          s.line,
          s.provider,
          `A ${s.provider} was committed here and later removed. It is still recoverable from git history — rotate the credential; deleting the file does not revoke it.`,
          JSON.stringify({
            provider: s.provider,
            redacted: s.redacted,
            fingerprint: s.fingerprint,
            tier: s.tier,
            removedFromHead: true,
            firstSeenCommit: s.firstSeenCommit,
            lastSeenCommit: s.lastSeenCommit,
          }),
        ],
      );
    }
```

Add `scanHistorySecrets` and the `SecretFinding` type to the imports.

- [ ] **Step 3: Typecheck**

Run: `npm run lint`
Expected: exit 0.

- [ ] **Step 4: Verify against a throwaway repository**

In the system temp directory (NOT inside this repo), create a git repo, commit a file containing a fake AWS key, then delete the file and commit again. Run `scanHistorySecrets` against it via a scratch script.
Expected: exactly one finding, `removedFromHead: true`, a real `firstSeenCommit`, and a redacted value. Then confirm the same key appearing in twenty commits still produces exactly one finding.

- [ ] **Step 5: Commit**

```bash
git add server/src/analysis/historySecrets.ts server/src/worker.ts
git commit -m "Detect secrets removed from HEAD but still in git history"
```

---

### Task 5: Scoring and prioritization

**Files:**
- Modify: `packages/engine/src/score.ts`
- Modify: `packages/engine/src/priority.ts`
- Test: `server/test/ground-truth.ts`

- [ ] **Step 1: Write the failing test**

```ts
// --- Secrets scoring and ranking ---
const secretSummary = computeSummary([], [], 10, "skipped", 1);
const twoSecrets = computeSummary([], [], 10, "skipped", 2);
const manySecrets = computeSummary([], [], 10, "skipped", 9);
checks.push(
  ["one hardcoded secret costs 20 points", secretSummary.score === 80],
  ["two hardcoded secrets cost 40 points", twoSecrets.score === 60],
  ["the secret penalty is capped at 40", manySecrets.score === 60],
  ["secrets appear in the summary counts", secretSummary.counts.secrets === 1],
);

const secretRanked = rankFindings({
  deps: [
    { packageName: "fake-pkg", declaredVersion: "^1.0.0", status: "phantom", ecosystem: "npm", registryMetadata: null },
  ] as unknown as Parameters<typeof rankFindings>[0]["deps"],
  codeFindings: [],
  secrets: [
    { filePath: "src/config.ts", line: 4, provider: "AWS access key", redacted: "AKIA…(20 chars)", fingerprint: "abc", tier: 1 },
  ] as unknown as Parameters<typeof rankFindings>[0]["secrets"],
});
checks.push(
  ["a hardcoded secret outranks a phantom dependency", secretRanked[0]?.kind === "hardcoded_secret"],
  ["a hardcoded secret is critical", secretRanked[0]?.band === "critical"],
  ["the ranked secret carries no raw value", !JSON.stringify(secretRanked).includes("AKIAIOSFODNN7EXAMPLE")],
);
```

- [ ] **Step 2: Run to verify it fails**

Run: `npm run test:ground-truth --prefix server` → FAIL.

- [ ] **Step 3: Add the score penalty**

In `packages/engine/src/score.ts`, add `secrets: number` to `ScanSummary["counts"]`, add a trailing optional parameter `secretCount = 0` to `computeSummary`, set `counts.secrets = secretCount`, and apply:

```ts
  // A committed live credential is the most urgent thing a scan can find, and
  // unlike the advisory detectors it is unambiguous — so unlike deprecated /
  // licence / duplicate findings, it moves the score immediately.
  score -= Math.min(40, secretCount * 20);
```

Place it alongside the other penalties, before the clamp.

- [ ] **Step 4: Add secrets to ranking**

In `packages/engine/src/priority.ts`, add `hardcoded_secret: -1` to `KIND_ORDER` so it precedes every existing kind, add `secrets?: SecretFinding[]` to `RankInput`, and emit before the dependency loop:

```ts
  for (const secret of input.secrets ?? []) {
    const removed = secret.removedFromHead === true;
    items.push({
      band: "critical",
      kind: "hardcoded_secret",
      title: `${secret.provider} hardcoded in ${secret.filePath}`,
      location: `${secret.filePath}:${secret.line}`,
      why: removed
        ? `This credential was committed and later removed, but it is still recoverable from git history. Deleting the file does not revoke it — rotate the credential.`
        : `A live credential in source can be used by anyone who can read the repository. Rotate it, then load it from an environment variable.`,
      effort: removed ? "M" : "S",
      confidence: 1,
    });
  }
```

Import the type: `import type { SecretFinding } from "./secrets.js";`

- [ ] **Step 5: Run to verify it passes**

Run: `npm run test:ground-truth --prefix server` → all PASS.

- [ ] **Step 6: Commit**

```bash
git add packages/engine/src/score.ts packages/engine/src/priority.ts server/test/ground-truth.ts
git commit -m "Score hardcoded secrets and rank them above every other finding"
```

---

### Task 6: Surface secrets in the CLI, dashboard and PR comment

Three surfaces, one commit each. Every one must render `detail.redacted`, never a value.

**Files:**
- Modify: `cli/src/index.ts`, `web/src/pages/ScanDetail.tsx`, `web/src/lib/api.ts`, `server/src/queue/prComment.ts`, `server/src/worker.ts`

- [ ] **Step 1: CLI**

Call `findSecrets(dir)` inside the existing advisory try/catch, pass it to `rankFindings`, add it to the `--json` payload as `secrets`, and print a `Secrets` section above `Fix first` when non-empty. Print `provider`, `filePath:line`, and `redacted` only. Follow the existing colour-constant conventions; use `RED`.

Verify: `npm run build:cli && node cli/dist/index.js scan <scratch-dir-with-fake-key>` shows the redacted shape and **not** the key.

Commit: `Report redacted secrets in CLI output`

- [ ] **Step 2: Dashboard**

Add `detail?: { provider: string; redacted: string; removedFromHead?: boolean; firstSeenCommit?: string } | null` to `CodeFinding` in `web/src/lib/api.ts`. In `ScanDetail.tsx` add a critical-styled Secrets card listing findings whose `finding_type` starts with `hardcoded_secret`, showing provider, `file:line`, the redacted shape, and guidance that switches on `removedFromHead` — "rotate this credential" versus "remove and rotate".

Verify: `npm run build --workspace web` exits 0, and the card renders against a real scan.

Commit: `Add a secrets card to the scan detail page`

- [ ] **Step 3: PR comment**

Add a secrets row to the counts table and, when any exist, a line above the table stating how many were found and that values are withheld. **Never interpolate `redacted` or any detail into the comment** — on a public repository the comment is world-readable, and even a redacted prefix plus a file path narrows an attacker's search. State the count and the file path only, and route the reader to the dashboard.

Pass the secret count through to `computeSummary` in the worker so `summary.counts.secrets` is populated for this.

Verify: `npm run lint` exits 0; render the body with a fixture summary via a scratch script and confirm no redacted shape appears.

Commit: `Surface secret counts in the PR comment without leaking values`

---

### Task 7: Full gate and publish

- [ ] **Step 1: Run everything**

```bash
npm run test:ground-truth --prefix server
npm run test:ground-truth-python --prefix server
npm run test:plan-limits --prefix server
npm run lint
npm run build
npm run build:cli
```
All must exit 0 with zero FAIL lines. Report actual PASS counts — do not trust a summary.

- [ ] **Step 2: Egress audit**

Grep the built CLI bundle and a real scan's database rows for any value that looks like a live credential. Confirm the only representations anywhere are `…(N chars)` shapes.

- [ ] **Step 3: Bump and publish**

```bash
npm version minor --no-git-tag-version --prefix cli
npm run build:cli
git add cli/package.json package-lock.json
git commit -m "Publish codeaudit-scan 0.4.0 with secret detection"
```

`npm publish --workspace cli` is a world-visible, irreversible action — get explicit confirmation before running it.

---

## Self-Review

**Spec coverage.** Tier 1/2/3 detection → Task 2. Own file walk → Task 2 (`isSecretScannablePath`, `findSecrets`). Redaction choke point → Task 2, enforced by serialization assertions and re-verified in Tasks 3, 6 and 7. Migration 004 → Task 3. Git history + dedupe + `removedFromHead` → Task 4. Secrets score immediately at −20 capped −40 → Task 5. Ranked above everything → Task 5 (`KIND_ORDER: -1`). CLI/dashboard/PR surfacing → Task 6. Publish discipline → Task 7. The two dogfooding accuracy bugs → Task 1.

**Deliberately excluded.** CLI-side git-history scanning (needs its own git plumbing; the shared detector already makes it cheap later). Pre-commit hook. Weighting the Phase 1a advisory findings into the score.

**Placeholder scan.** No TBD/TODO. Tasks 1–5 carry complete code. Task 6's three steps are specified as behaviour plus exact type signatures rather than full JSX, because they must match conventions in files the implementer has to read first — the same approach that worked for Phase 1a Tasks 7 and 8, where verbatim sketches went stale.

**Type consistency.** `SecretFinding` is defined once in Task 2 and consumed unchanged in Tasks 3, 4, 5 and 6. `scanTextForSecrets(text, filePath)` has one signature, used by both `findSecrets` and `scanHistorySecrets`. `redact`/`fingerprintSecret` are the only value-handling functions and are never bypassed. `computeSummary`'s new `secretCount` is a trailing optional parameter, so all existing call sites keep working.

**Ambiguity check.** "Secrets score immediately" is stated as an exact formula. "Never leaks" is defined as a testable property (raw value absent from the serialization) rather than a principle. History findings are explicitly filtered to `removedFromHead` so they cannot duplicate working-tree findings.
