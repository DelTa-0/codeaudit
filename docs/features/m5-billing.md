---
type: feature
title: "M5 — Billing"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
  - milestone
status: done
related:
  - "[[../index]]"
  - "[[../architecture]]"
  - "[[../decisions]]"
  - "[[../known-issues]]"
---

# M5 — Billing (Stripe test mode)

## What it delivers

Stripe-backed subscription billing with plan-limit enforcement, plus the
security/hardening pass that closes out the original plan.

## Key pieces

- `routes/billing.ts` — hand-rolled Stripe REST client (see
  [[../decisions#No Stripe SDK]]): `POST /orgs/:orgId/billing/checkout`
  (creates/reuses a Stripe customer, creates a subscription Checkout
  session), `POST /orgs/:orgId/billing/portal` (billing portal session).
  Both `owner`-only
- Stripe webhook (`POST /api/webhooks/stripe`, raw-body mounted like the
  GitHub one): hand-rolled signature verification
  (`{timestamp}.{body}` HMAC-SHA256, ±300s replay window). Handles
  `checkout.session.completed` (activates the plan), `customer.subscription.updated`
  (tracks `past_due`), `customer.subscription.deleted` (reverts to free)
- `services/plans.ts` — `PLANS` limits table (repos, private repos,
  scans/day, webhook-scan eligibility per tier), `assertCanAddRepo()` /
  `assertCanScan()` throw `402 Payment Required` with a clear message when
  exceeded
- Frontend: `Billing.tsx` — plan comparison cards, upgrade → redirects to
  Stripe Checkout URL

## Verification performed

- Signed a fake `checkout.session.completed` webhook payload by hand — bad
  signature → 401, good signature → 200 and the org's plan/status/
  subscription-id updated in Postgres, immediately reflected in the billing
  UI ("Current plan: team")
- Confirmed plan-limit enforcement: enabling a repo's webhook while on the
  free plan is rejected (`webhookScans: false` on the free tier), succeeds
  after simulating an upgrade to pro
- **Not yet verified against a real Stripe account** — see
  [[../known-issues#Stripe billing untested against real Stripe]]

## Also part of this milestone: security hardening pass

Consolidated in [[../decisions#Security checklist (non-negotiable from the original spec, carried through the SaaS expansion)]] —
rate limiting, SSRF guard, webhook signature verification, tenant isolation,
prompt-injection guard, secret handling, all confirmed working via the spot-
checks listed there.
