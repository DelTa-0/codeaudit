---
type: reference
title: "Roadmap"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: developing
related:
  - "[[index]]"
  - "[[known-issues]]"
---

# Roadmap

## The 5-milestone plan (all code-complete)

Originally scoped as `M1–M5` in the approved implementation plan. All five
were built and verified in a single session; see `features/` for what each
one actually contains.

- [x] [[features/m1-foundation]] — monorepo, docker-compose, migrations, auth, orgs/roles, React shell
- [x] [[features/m2-scan-engine]] — BullMQ, sandboxed clone, AST analysis, npm registry verdicts, live dashboard
- [x] [[features/m3-llm-zombie-layer]] — dead-code candidates, LLM batch review, weighted health score
- [x] [[features/m4-github-app]] — OAuth, App install, webhooks, PR sticky comments
- [x] [[features/m5-billing]] — Stripe checkout/portal/webhooks, plan limits

## Immediate next steps (picking back up)

1. **Finish debugging GitHub OAuth email 403** — see [[known-issues#GitHub OAuth email permission]]
2. ~~Set up the ngrok tunnel and register the real webhook URL~~ — **DONE**: real push → webhook → scan confirmed working end-to-end. ~~Confirm pull_request → sticky PR comment~~ — **DONE**: opened a real PR (`DelTa-0/codeaudit#1`), webhook fired, scan ran with `pr_number` set, comment posted (`[pr-comment] posted on DelTa-0/codeaudit#1`). One gotcha hit along the way — see [[known-issues#Repo connected via URL paste has no linked installation → PR comment silently no-ops]]
3. **Connect a real Stripe test-mode account** — set `STRIPE_SECRET_KEY`/`STRIPE_WEBHOOK_SECRET`/price IDs, run an actual test-mode checkout to confirm the full redirect + webhook flow (not just a signed fake payload). Currently moot for testing — plan limits are temporarily disabled, see [[decisions#Plan-limit gate temporarily disabled for testing]]
4. **Install the GitHub App on a real private repo** and confirm private-repo cloning via installation token works end-to-end

## Explicit post-M5 backlog (from the original plan, never started)

- **Python/PyPI ecosystem support** — currently JS/TS + npm only. Would need
  a Python AST parser (candidate: `ast` via a small Python sidecar, or a
  JS-native Python parser) and PyPI registry checks mirroring `registry.ts`
- **SSE for live scan status** — currently the frontend polls
  `GET /api/scans/:id` every ~2s; server-sent events would remove the polling
  delay and reduce request volume
- **Slack notifications** — mentioned in the original spec's enterprise
  feature list, never implemented
- **Real email transport for invites** — see [[known-issues#No email transport for invites]]
- **Rename `XAI_*` env vars to `GROQ_*`** — cosmetic, see [[known-issues#`XAI_*` env var naming is misleading]]

## Things intentionally left as follow-ups, not gaps

- No CI/CD — not requested, not blocking local dev/demo
- No test suite beyond the ground-truth fixture test
  (`server/test/ground-truth.ts`) — sufficient for validating the analysis
  engine's correctness, but no route-level integration tests exist yet
- Local dev only — no deployment target chosen yet (Nitro/Cloudflare was
  used for the *landing page* project, `ai-debt-cleaner`, not this one)
