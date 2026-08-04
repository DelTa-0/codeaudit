---
type: reference
title: "Decisions"
created: 2026-07-17
updated: 2026-08-04
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
  - "[[known-issues]]"
---

# Decisions (ADR-style log)

## Distributing the agent-config skill: two copies, not one, plus real end-to-end verification (2026-08-04)

The `codeorion-guardrails` skill (below) shipped first as a single file at
`.claude/skills/codeorion-guardrails/SKILL.md` — but that only auto-loads
for someone working *inside this monorepo*, which is nearly the opposite of
the actual audience: a developer who installed `codeorion-mcp` in their own,
unrelated project. A project-scoped skill dogfoods correctly but distributes
to nobody.

**Considered:** making `.claude/skills/codeorion-guardrails/` itself the
plugin root, by nesting `.claude-plugin/plugin.json` inside it and pointing
a repo-root `marketplace.json` at that path — zero file duplication.
**Rejected**, confirmed by research against the actual plugin docs: a
directory under `.claude/skills/` is *auto-discovered* as a local project
skill; the same directory *also* being a registered marketplace plugin
source creates two live registrations of the identical files
(`codeorion-guardrails@skills-dir` and `codeorion-guardrails@codeaudit`) —
confusing, and not how the mechanism is meant to be used.

**Decision:** two deliberately separate copies — `.claude/skills/…` stays
for local dogfooding, `plugins/codeorion-guardrails/` (with its own
`.claude-plugin/plugin.json`) is the one a repo-root
`.claude-plugin/marketplace.json` lists for external installation via
`/plugin marketplace add DelTa-0/codeaudit` then `/plugin install
codeorion-guardrails@codeaudit`. The duplication cost is one file; the
alternative was structural confusion for every future reader.

**This required `main` to actually be current.** The marketplace add
command resolves against a repo's *default* branch unless told otherwise;
this project's default branch is `main`, and all of this work — like most
recent work — had only ever landed on `dev`. Verified directly (fetching
`raw.githubusercontent.com/.../main/.claude-plugin/marketplace.json`, which
404'd) before assuming anything: the marketplace file plainly did not exist
on `main`. Fixed with a fast-forward (`main` was a strict git ancestor of
`dev`, so this was conflict-free) and a push, re-verified the same way
afterward.

**Verification was real, not simulated**, for the parts that could be:
a subagent-run RED/GREEN test proved the skill's *content* changes agent
behavior (§ below), but proving the *distribution mechanism* itself needed
an actual Claude Code CLI, which no available tool can drive — that part
was done by the user, live, in a real terminal, and the exact command
output (`Successfully added marketplace: codeaudit`, then `✓ Installed
codeorion-guardrails. Plugin is now active.`) was read back rather than
assumed from a green build. The first attempt failed silently
(un-diagnosed, not a version issue) and a clean retry succeeded — recorded
in [[roadmap]] rather than treated as proof the mechanism doesn't work.

## Agent config auditing: advisory-only scoring, path allow-list, no new dependencies (2026-08-03)

CodeAudit's wedge is framing risk in AI terms rather than generic security
terms. The gap that fit that wedge and wasn't covered by any named
competitor (Socket.dev, Snyk, CodeScene, SonarQube) or by CodeAudit itself:
the AI coding agent's own config — `CLAUDE.md`, `AGENTS.md`, `.cursorrules`,
MCP server configs, permission/settings files, skill files — is a file the
agent *trusts as instructions*, not just code it edits. Poisoning one
hijacks every future agent session against the repo, not just one diff, and
hidden Unicode characters make the attack invisible in an ordinary code
review. New engine modules: `packages/engine/src/agentConfig.ts` (pure,
sync, offline — hidden/invisible-character detection, injection-phrase
matching, credential-exfiltration heuristics, unsafe MCP/permission config)
and `packages/engine/src/agentPackages.ts` (recomposes the existing
`verifyPackage` guardrail against packages an MCP config points at — zero
new detection logic, same "recompose, don't invent" seam `verify.ts`
documents for its own MCP use).

**Path allow-list, not a content deny-list, is the false-positive control.**
`classifyAgentSurface` only recognizes a fixed set of filenames/paths as an
agent surface; everything else — including this engine's own `docs/`,
which discusses prompt injection at length, and `agentConfig.ts` itself,
which names every payload it detects — is simply never inspected. Two
must-not-fire cases the design didn't anticipate until testing: a byte-order
mark (U+FEFF) at a file's first byte is not an attack, and U+200D between
two non-ASCII pictographs is an ordinary emoji ZWJ sequence (a family
emoji), not a hidden character. Both are explicit carve-outs now, and both
are proof the false-positive surface here isn't yet well understood — which
is exactly why scoring stays advisory (see below).

**Scoring: advisory-only this release — `score -= 0`.** Precedent
(`docs/superpowers/specs/2026-07-31-phase1-signal-design.md`) scored secrets
immediately because `AKIA`-prefixed patterns have a decade of industry
false-positive data behind them, and made Phase-1a's advisories (deprecated/
licence/duplicate) advisory-only for one release specifically because
"adding penalties silently moves every repo's score and a merge gate
configured at 70 could begin failing on unchanged code." These detectors
have no such track record — they're written against a threat model
published this year — and the failure mode is worse here than for Phase 1a:
`server/src/routes/cliScans.ts` stores CLI-computed scores **verbatim, no
server recompute**, so a penalty would drop every `npx codeorion` user's
score the moment they upgrade, on completely unchanged repos, because their
`.mcp.json` uses the standard `npx -y` install idiom. `counts.agentConfig`
is threaded through `computeSummary` now (trailing optional param,
default 0) so weighting it in later is a one-line change once real output
has been observed — visibility (rank in Fix First, its own CLI/dashboard
section, a PR-comment count row) carries the signal instead, in the
meantime.

**No new npm dependencies, no DB migration, no new HTTP requests beyond the
existing per-package registry check.** Findings ride the existing
`code_findings.detail JSONB` column (added by `004_finding_detail.sql` for
exactly "finding types that do not fit the original dead-code-shaped
columns" — a commit SHA was a genuinely new *dimension* requiring that
migration; new keys in a bag built for new keys are not). `finding_type` is
unconstrained `TEXT`, same precedent as the `vulnerable` status and
`hardcoded_secret_history` reusing existing columns with zero schema
change.

**Redaction is stricter than the secrets precedent, and for a different
reason.** `secrets.ts`'s `redact()` exists because a secrets scanner that
stores secrets is a liability. `agentConfig.ts`'s `redactSnippet` exists
because a prompt-injection scanner that echoes an injection payload's
*mechanism* verbatim is itself a delivery vector — the destination is
another LLM's context window (the MCP tool response, the dashboard, a PR
comment read by bots and CI). `redactSnippet` converts every invisible/
control character to a visible literal token and strips markdown-forgery
characters, but deliberately does **not** hide ordinary visible text like a
`curl` command or URL — the point of showing `evidence` is so a human can
see what's dangerous; only the mechanism that would let it hide or execute
gets neutralized. Verified end-to-end: no raw zero-width, bidi-override, or
Unicode-tag byte reaches the CLI bundle, `--json`, `code_findings`, an
`--upload` body, the MCP tool response, or a PR comment.

## Report export: browser print for PDF, Word-HTML for .doc — no new dependencies (2026-07-22)

Scan results needed to leave the dashboard as a shareable document (hand to a
security reviewer, attach to a client report). Both formats ship without adding
a single package:

- **PDF** — a dedicated `/scans/:scanId/report` route renders the scan as a
  plain document (registered *outside* `<Layout>` so no nav chrome leaks in),
  and `window.print()` hands off to the browser's own Save-as-PDF. The
  `@media print` block in `styles.css` is therefore the entire PDF pipeline:
  it drops `.no-print` controls, pins light-on-white tokens so a dark-theme
  viewer doesn't export an unreadable page, repeats table headers across pages
  (`display: table-header-group`) and avoids splitting rows.
- **Word** — `lib/report.ts`'s `buildWordHtml()` emits Word-namespaced HTML
  downloaded as a `.doc` blob. Word, Google Docs and LibreOffice all open it
  natively and it stays editable.

Rejected the `docx` package (~1MB) and server-side PDF (pdfkit/puppeteer)
despite `docx` being the more "proper" OOXML answer. Rationale beyond the usual
dependency-minimalism of this codebase: CodeAudit's entire product thesis is
flagging unnecessary dependency weight, so shipping a megabyte of document
tooling for one export would be self-inflicted irony — and it would show up in
our own self-scan. The tradeoff is that `.doc` is HTML-backed rather than true
OOXML; if Word-compatibility complaints appear, swapping in `docx` is contained
to that one file, since nothing else produces the document.

Export runs **client-side from data already on the page**, paginating the
findings endpoints (`per_page` is capped at 100 server-side) so a large repo's
report is never silently truncated. No new server route, no auth-in-URL
problem, and one source of truth for the numbers.

All user-controlled strings — package names, LLM reasoning — are HTML-escaped
before entering the document; a hostile package name must not be able to inject
markup into an exported report. Covered by escaping assertions in the
serializer's verification (17 checks, including `<script>`, `&` and quotes).

## Dev-mode plan switching — remove the *payment* barrier, not the limits (2026-07-21)

While the project is pre-Stripe, owners need to move between tiers to exercise
each one. The obvious move — relaxing `PLANS` — is exactly what was done on
2026-07-20 and had to be reverted (see the entry below), because it turned a
"testing state" into a live billing regression that nothing detected.

Took the opposite approach this time: **`PLANS` is untouched and every tier
still enforces its real limits.** Only the payment step is bypassed. A new
`POST /orgs/:orgId/billing/plan` (owner-only) writes `organizations.plan`
directly, so switching to `free` genuinely enforces 3 repos / 10 scans/day —
which is the entire point, since the goal is to verify the gating works before
going live, not to avoid it.

Two properties make this safe to leave in the codebase:

1. **It self-disables.** The gate is `!stripeConfigured()`, so the route starts
   returning `409` the moment `STRIPE_SECRET_KEY` is set. There is no flag to
   remember to flip, and no way for it to silently survive into production.
   `GET /billing/config` exposes the same signal so the UI follows automatically.
2. **The existing regression test still applies.** `test/plan-limits.ts` guards
   the `PLANS` table, and because this change doesn't touch `PLANS`, that guard
   remains meaningful — unlike the 2026-07-20 change, which the test was written
   in response to.

The Billing page shows an explicit "Development mode — no payment required"
banner stating that limits still apply, so the bypass is never invisible.
Every switch is audit-logged as `billing.plan_switched_devmode`.

Verified end-to-end against a throwaway local account (since removed): config
reports `selfServePlans: true`, upgrade to `team` and downgrade back to `free`
both persist, an invalid tier is rejected by zod, and a second server booted
with `STRIPE_SECRET_KEY` set returns `409` and `selfServePlans: false`.

## OSV.dev for CVE scanning; client-computed scores stay trusted (2026-07-21)

When adding known-vulnerability scanning ([[roadmap#Supply-chain + tech-debt
expansion — CVE / typosquat / lockfile / hotspots]]), chose **OSV.dev** over
Snyk/GitHub Advisory API: it's free, needs no API key, covers npm + PyPI (+
more) in one batch endpoint, and its two-step query (batch → hydrate by id)
maps cleanly onto the existing `registry.ts` concurrency/timeout pattern. Kept
CVE lookup in the shared engine (not the server) so the CLI runs it too —
it's static/HTTP, unlike LLM review which stays server-only.

Deliberately did **not** add a DB migration for vulnerabilities: advisory
lists ride in the existing `dependency_findings.registry_metadata` JSONB, and
the new `vulnerable` status reuses the un-constrained `status TEXT` column —
zero schema change. The score penalty is per-package by *max* severity (not
per-advisory) so a package with ten advisories doesn't tank the score ten
times over.

Typosquat detection is intentionally **annotate-not-invent**: it refines the
existing `suspicious` status (adds `registryMetadata.typosquatOf`) rather than
introducing a new status, and gates escalation behind a download-count
"established package" check so popular real neighbors (`preact`≈`react`) never
fire. Popular-package lists are a committed TS module, not a fetched list —
offline, deterministic, and bundle-safe for the esbuild CLI.

CLI-uploaded scores remain **trusted as-computed** (`routes/cliScans.ts`
still stores `score`/`grade`/`counts` verbatim, no server recompute). The CVE
and typosquat additions run identically in the CLI and the worker, so a CLI
upload's numbers stay comparable to a hosted scan's for those categories; only
LLM-verified dead-code still differs (already flagged via `reviewStatus`).

## ~~Plan-limit gate temporarily disabled for testing~~ — REVERTED (2026-07-20)

The user asked to "remove the strip[e] barrier for now" to exercise the
product without hitting `402 Payment Required` walls. Rather than ripping out
the plan/billing code, `services/plans.ts`'s `PLANS` table was changed so
**every tier** (`free`/`pro`/`team`) gets team-level limits (unlimited repos,
unlimited scans/day, webhook scans enabled) — the production limits were kept
as a commented-out block in the same file for a one-line revert. Orgs still
displayed their real plan name in the billing UI; only enforcement changed.

**Reverted** as Phase 4 of [[roadmap#Making CodeAudit Actually Useful]]: this
had become a live regression rather than a deliberate testing state — real
per-tier limits (`free`: 1 private/3 total repos, no webhook scans, 10
scans/day; `pro`: 10/25, webhook scans on, 200/day; `team`: unlimited, 2000/day)
are restored as the real exported `PLANS`. A regression test
(`server/test/plan-limits.ts`, `npm run test:plan-limits`) now asserts the
free tier is strictly more restrictive than pro/team, so this can't silently
recur without a failing test. Verifying Stripe checkout/webhook flows against
a real test-mode account (see [[known-issues#Stripe billing untested against
real Stripe]]) is only meaningful now that there's a real gate to verify
against.

## Scope expanded from MVP to full SaaS mid-plan

The original brief (`master build prompt`) specified a 3–4 week internship-demo
MVP: single-user, no auth beyond a stub, no billing, no GitHub integration
beyond a manual URL paste. Before implementation started, the user asked for
"a full-fledged SaaS project as it can be a major project" — this pulled in
organizations/roles, GitHub App (OAuth + webhooks + PR comments), and Stripe
billing as first-class scope rather than backlog items. All five milestones
(M1–M5) were built in that expanded scope; see [[roadmap]].

## LLM provider

Originally specified as Anthropic Claude, then the user redirected to "Grok
API as it is free." Code and env vars were written assuming **xAI's Grok**
(`api.x.ai`). When the actual API key was provided, testing it against both
`api.groq.com` and `api.x.ai` showed it was a **Groq** key
(`gsk_...` prefix), not xAI. Groq (groq.com) and xAI Grok (x.ai) are
different companies with confusingly similar names — this is the same trap
hit in the `trackMyFinance` project (see that vault's `known-issues.md`).

Fixed by pointing `XAI_BASE_URL` at `https://api.groq.com/openai/v1` and
`XAI_MODEL` at `llama-3.3-70b-versatile` (verified available on the actual
key via `GET /v1/models`). The env var names were **left as `XAI_*`** rather
than renamed to `GROQ_*` — low value to rename mid-build, and the `LlmClient`
usage is provider-agnostic (just `baseURL` + `apiKey` + `model`), so the name
mismatch is cosmetic only. Flagged in [[known-issues]] for future cleanup.

## No ORM — plain SQL migrations

`pg` directly with numbered `.sql` files and a ~40-line runner, not
Drizzle/Prisma/Knex. The schema is small and stable enough (9 tables) that an
ORM's abstraction cost wasn't worth it, and every route already needs
hand-tuned org-scoped joins that fight most query builders anyway.

## No Stripe SDK

Only 3 Stripe operations are needed (create customer, create checkout
session, create billing portal session) plus webhook signature verification.
A hand-rolled `fetch`-based client (`stripeRequest()` in `routes/billing.ts`)
avoids pulling in the full `stripe` npm package for that surface area. The
webhook HMAC verification is also hand-rolled (`{timestamp}.{body}` SHA256,
±300s replay window) rather than using `stripe.webhooks.constructEvent` —
functionally equivalent, one less dependency.

## JWT handed to the SPA via URL fragment, not query param

After GitHub OAuth completes server-side, the resulting JWT is redirected to
the frontend as `/login#token=...` rather than `?token=...`. URL fragments
are never sent to the server in subsequent requests and don't appear in
server access logs, unlike query params — meaningful when the "server" here
is Express itself logging its own requests.

## Security checklist (non-negotiable from the original spec, carried through the SaaS expansion)

- Static analysis only — the worker never executes, `npm install`s, or evals
  anything from a scanned repository
- Per-job temp clone dirs with size (200MB) / file-count (20k) / time (60s)
  caps, cleanup always in a `finally` block
- Server-side repo URL validation: HTTPS + `github.com` host allow-list
  (`lib/repoUrl.ts`) — blocks `file://`, internal IPs, other hosts (SSRF guard)
- GitHub and Stripe webhooks both HMAC/signature-verified with
  constant-time comparison before any payload is trusted
- Rate limiting on scan creation (5/min per user, via `express-rate-limit`)
  plus plan-based daily scan caps (`services/plans.ts`)
- Secrets only in `server/.env` (gitignored, verified never committed —
  checked via `git log --all --diff-filter=A` before the first push)
- Repo content is explicitly delimited as **untrusted data** in the LLM
  system prompt — a stated prompt-injection guard against adversarial code
  comments trying to influence the "is this dead code" verdict
- Every org-scoped route enforces a minimum role via `requireOrgRole()`;
  admin+ required for delete/billing operations
- Truncation caps on code sent to the LLM (~120 lines per candidate)

## `.env` and secrets — never committed

`.gitignore` excludes `.env` from day one; verified before the first GitHub
push with `git log --all --diff-filter=A --name-only | grep -i env` (empty
result) and a check for tracked `.pem` files (also empty). The GitHub App
private key lives outside the repo entirely
(`C:\Users\ASUS\Desktop\arbytes\codeauditsec\`).

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
