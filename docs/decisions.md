---
type: reference
title: "Decisions"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: evergreen
related:
  - "[[index]]"
  - "[[architecture]]"
  - "[[known-issues]]"
---

# Decisions (ADR-style log)

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
