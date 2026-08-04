---
type: reference
title: "About — Project Overview"
created: 2026-07-22
updated: 2026-08-04
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
  - "[[decisions]]"
  - "[[roadmap]]"
  - "[[known-issues]]"
---

# About CodeAudit

A single-page orientation to the whole project — what it does, why it exists,
how it's built, and what is genuinely finished versus still open. Written to be
read start-to-finish by someone who has never seen the codebase.

---

## 1. The one-paragraph version

**CodeAudit is a SaaS that audits GitHub repositories for technical debt
introduced by AI-assisted coding.** It clones a repo, verifies every declared
and imported dependency against the live npm and PyPI registries, checks them
for known vulnerabilities, flags names that look like typosquats, finds
unreferenced ("zombie") code and has an LLM confirm it, then produces a health
score (0–100, graded A–F) with a per-finding breakdown. It runs as a hosted
dashboard with a GitHub App (PR comments, merge gates, auto-fix PRs) and as a
zero-signup CLI (`npx codeorion`) that also works in CI.

## 2. The problem it solves

Large language models invent packages that don't exist. A 2026 multi-LLM study
across 576k samples found roughly **20% of AI-recommended packages are
hallucinated**, and 43% of hallucinated names recur across identical prompts.
Attackers register those predictable names and wait — an attack called
**slopsquatting**. Because the name looks plausible and the AI suggested it, it
often survives code review.

CodeAudit's wedge is that it frames supply-chain risk in AI terms rather than
generic security terms: *this dependency does not exist*, *this one is one
character from a popular package*, *this file is AI-touched, changes constantly
and already has findings*. Established tools solve adjacent problems
([Socket.dev](https://socket.dev) — malicious package behaviour,
[Snyk](https://snyk.io) — CVEs and reachability,
[CodeScene](https://codescene.com) — churn-based debt hotspots,
SonarQube — code smells), but none frame the AI-authorship angle as the
organising idea.

## 3. Architecture at a glance

An npm-workspaces monorepo with five packages:

| Workspace | What it is | Notes |
|---|---|---|
| `packages/engine/` | `@codeaudit/engine` — the analysis core | Shared by server, CLI **and** MCP. LLM review (`llm.ts`) is plain `fetch()`, no SDK, so it lives in the main export — no separate subpath needed to keep the CLI bundle light (the old `./llm` split was removed once the `openai` SDK was dropped) |
| `server/` | Express API + BullMQ background workers | Postgres (data) + Redis (queues) |
| `web/` | React + Vite + Tailwind SPA | Dashboard, plus a public marketing landing page |
| `cli/` | `codeorion`, published to npm | esbuild-bundled into one self-contained file, no install-time deps |
| `mcp/` | `codeorion-mcp`, published to npm | MCP server for AI coding agents — `verify_package`, `scan_secrets`, `audit_agent_config` |

**Scan pipeline** (`server/src/worker.ts`):

```
queued → clone (sandboxed) → detect ecosystems → parse imports/manifests
       → registry verdicts (npm / PyPI)
       → OSV vulnerability lookup
       → dead-code candidates → LLM review
       → AI authorship + hotspots
       → score + persist → PR comment / check run
```

## 4. What it actually detects

| Finding | How it works | Confidence |
|---|---|---|
| **Phantom dependency** | Package name returns 404 from npm/PyPI — it does not exist | Binary fact. The flagship signal |
| **Typosquat / slopsquat** | Damerau-Levenshtein distance 1–2 from a curated popular-package list, gated by a download-count "established package" check so real neighbours (`preact`≈`react`) don't fire | Heuristic, tuned for precision |
| **Known vulnerability** | Every resolved package+version queried against [OSV.dev](https://osv.dev) (free, no API key); covers transitive deps via lockfile resolution | Authoritative (CVE/GHSA ids) |
| **Suspicious package** | Exists but low-signal: <50 weekly downloads (npm) or <90 days old | Heuristic |
| **Unused dependency** | Declared in the manifest, never imported anywhere | Heuristic, heavily allowlist-tuned |
| **Zombie / dead code** | AST analysis finds top-level symbols with no cross-file references; an LLM then judges each `dead_code`/`alive`/`uncertain` and only `dead_code` survives | LLM-verified with a confidence score |
| **AI authorship** | `Co-Authored-By` trailers + known assistant authors in git history | Metadata-based; advisory only |
| **Hotspots** | Churn (commit count) × file size, tagged AI/human and whether already flagged | Prioritisation aid |

**Ecosystems:** npm (JS/TS, real Babel AST parsing) and PyPI (Python,
line-oriented parsing — tree-sitter is the documented upgrade path).
Polyglot repos run both analyzers and merge results.

## 5. How the score works

Starts at 100 and subtracts (`packages/engine/src/score.ts`):

| Finding | Penalty |
|---|---|
| Phantom dependency | −15 each |
| Vulnerability | −20 critical / −10 high / −4 medium / −1 low, per package by its worst advisory |
| Suspicious package | −6 each |
| Unused dependency | −3 each |
| Zombie code | −(confidence × 1.5), capped at −20 total |

Grades: **A ≥90 · B ≥75 · C ≥60 · D ≥40 · F <40**.

`reviewStatus` (`full` / `partial` / `skipped`) records whether zombie findings
actually got an LLM verdict, so a static-only CLI score is never presented as
equivalent to an LLM-verified one.

## 6. Platform features

- **GitHub App** — OAuth login, install flow, push/PR webhooks (HMAC-verified),
  private-repo cloning via installation tokens
- **Sticky PR comments** — one bot comment that edits itself on every push, with
  score delta vs the last non-PR scan
- **Merge gate** — a GitHub check run reporting pass/fail against a score
  threshold. Off by default; *blocking* is the owner's branch-protection choice
- **Auto-fix PRs** — opens a PR removing unused dependencies. Double opt-in
  (repo toggle + explicit click), never auto-merged, max one open PR at a time
- **CLI + CI uploads** — per-repo token lets `npx codeorion --upload` report
  into the dashboard from any CI system, no GitHub webhook needed
- **Report export** — PDF (print-optimised route) and Word (`.doc`), both
  dependency-free
- **README badge** — live score SVG at an unguessable token URL
- **Orgs, roles, audit log** — owner/admin/developer with per-route enforcement
- **Stripe billing** — free/pro/team tiers with real enforced limits

## 7. Security posture

This is the part most worth showing a reviewer, because the product's whole job
is handling untrusted third-party code:

- **Static analysis only.** The worker never executes, `npm install`s, or evals
  anything from a scanned repository
- **Sandboxed clones** with 200MB / 20k-file / 60s caps, cleanup always in a
  `finally`
- **SSRF guard** — repo URLs validated server-side against an HTTPS +
  `github.com` allowlist, blocking `file://` and internal addresses
- **Prompt-injection guard** — repo code is wrapped and explicitly declared
  untrusted in the LLM system prompt, so adversarial comments can't influence a
  verdict
- **Constant-time HMAC** verification on both GitHub and Stripe webhooks, with a
  ±300s replay window on Stripe
- **JWT via URL fragment**, not query param — fragments never reach the server or
  its access logs
- **Output escaping** — all user-controlled strings are HTML-escaped before
  entering an exported report
- **Everything is opt-in.** Auto-scan, merge gate and auto-fix all ship off by
  default. The system proposes; a human decides

## 8. Engineering practices

**Deliberate dependency minimalism.** No ORM (plain SQL migrations and a ~40-line
runner), no Stripe SDK (three REST calls plus hand-rolled HMAC), no document
library for report export. The reasoning is documented in [[decisions]] — a tool
whose purpose is flagging unnecessary dependency weight should not carry much.

**Ground-truth testing over mocks.** Rather than unit-testing internals, fixture
repos with *known* correct answers are analyzed end-to-end and asserted against:

| Suite | Checks | Guards |
|---|---|---|
| `test/ground-truth.ts` | 32 | JS/TS analysis, path aliases, typosquats, lockfiles |
| `test/ground-truth-python.ts` | 16 | Python analysis, aliases, decorators |
| `test/plan-limits.ts` | 7 | Free tier can never silently become unlimited |

Most of these exist because a real false positive was found first — the suites
encode past bugs so they cannot recur.

**Decisions are written down.** [[decisions]] is an ADR-style log including
reversals, and [[roadmap]] records failures honestly (e.g. an engine fix that
sat committed-but-unpublished for days, so every CLI run audited stale code).

## 9. Current status

**Working end-to-end:** the full scan pipeline (npm + Python), CVE/typosquat/
lockfile analysis, LLM zombie review (including CLI bring-your-own-key
review and hardcoded-secret detection), dashboard, CLI (published to npm as
`codeorion`), MCP server (published to npm as `codeorion-mcp`, including
agent-config auditing for prompt injection), GitHub webhooks → scan → PR
comment (verified on a real PR), report export, org/RBAC, dev-mode plan
switching.

**CLI/MCP publish status:** after two prior rejections (`codeaudit-scan` →
`codematrix` 403'd for being too close to an existing `code-matrix`
package — `npm publish --dry-run` had passed clean for that name and did
not catch it), the project renamed to `codeorion`/`codeorion-mcp` and the
real publish succeeded: `codeorion@1.0.0` and `codeorion-mcp@1.0.0`, both
2026-08-02. `codeorion-mcp` was later bumped to `1.1.0` (2026-08-04) to
ship the `audit_agent_config` tool. See [[known-issues]] / [[roadmap]] for
the full history.

**Built but not fully proven:**

| Area | Status |
|---|---|
| Stripe billing | Wired, but only tested with hand-signed fake payloads — never against real Stripe test mode |
| GitHub OAuth email | `/user/emails` returns 403; mitigated to a clean error, root cause open |
| Invites | Generated and validated, but the link is logged to console — no email transport |
| Merge gate / auto-fix live runs | Code paths verified; need a repo with the right App permissions |
| Print/PDF report rendering | Serializer tested; visual print layout unverified |

**Not started:** deployment (no Dockerfile/hosting/TLS chosen — local dev only),
CI/CD, monitoring, Slack notifications, SSE for live scan status.

**Known limitations worth stating plainly:** only two ecosystems (no Go/Rust/
Ruby/Java); the Python parser is line-based, not a real AST; CSS `@import`s
aren't scanned, so CSS-only packages still read as unused; AI-authorship depends
entirely on commit-trailer hygiene and is metadata-based, not code analysis.

## 10. Running it

```bash
docker compose up -d          # Postgres + Redis
npm install
npm run migrate -w server     # 3 SQL migrations, 10 tables
npm run dev -w server         # API on :4000
npm run dev:worker -w server  # BullMQ worker — scans stay "queued" without it
npm run dev -w web            # dashboard on :5173
```

The CLI needs no account at all:

```bash
npx codeorion scan .
```

The full env-var reference and GitHub App walkthrough live in the root
[`README.md`](../README.md); [[setup]] covers the vault-side notes.

## 11. Where to read more

- [[architecture]] — stack, service layout, scan pipeline in depth
- [[database-schema]] — all tables, relationships, migration history
- [[decisions]] — why things are built the way they are, including reversals
- [[roadmap]] — what shipped when, and what's deliberately deferred
- [[known-issues]] — open bugs with root-cause analysis
- `features/m1`–`m5` — per-milestone detail
