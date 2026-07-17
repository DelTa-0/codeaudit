---
type: reference
title: "Known Issues"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
status: developing
related:
  - "[[index]]"
  - "[[decisions]]"
  - "[[setup]]"
---

# Known Issues

## GitHub OAuth email permission (active, unresolved)

`POST /api/auth/github/callback` → `exchangeOauthCode()` calls
`GET /user/emails` when the user's primary email isn't public on `/user`.
This has been consistently **403ing** in testing, even after:
1. Adding the "Email addresses: Read-only" **Account permission** in the
   GitHub App settings (Permissions & events → Account permissions —
   distinct section from Repository permissions, easy to scroll past)
2. Revoking the existing user authorization
   (`github.com/settings/apps/authorizations`) to force a fresh consent screen

Server logs (`bghw7eatv` background task) show the same `GitHub API 403:
/user/emails` error repeating across multiple retry attempts even after both
fixes were reportedly applied. Last debugging step in progress: confirming
whether the permission was actually saved (green "Save changes" button at
the bottom of the page is easy to miss) and whether a fresh authorization was
actually triggered (was about to retry live when the session moved on to
documentation/git push).

**Mitigation already in place**: `services/github.ts` catches the
`/user/emails` failure and logs it instead of throwing an unhandled
exception — so the failure mode is a clean `400 "Your GitHub account has no
accessible email address"` rather than a 500 crash. Email/password login and
the rest of the app are unaffected.

**Next step when resuming**: verify the Account permission is genuinely
saved, confirm the OAuth consent screen shows an email-related permission
request on the next login attempt (if it doesn't, the App-level change
hasn't propagated), and as a fallback, consider having the user set a public
email on their GitHub profile as a workaround.

## Local webhook testing requires a public tunnel — blocked by auto-mode

GitHub can't POST webhooks to `localhost`. `ngrok` is installed and
configured (`ngrok config check` confirms a valid authtoken), but starting it
via the agent's Bash tool was **blocked twice by the Claude Code auto-mode
classifier**, even after explicit user confirmation — it does not allow
starting a process that exposes a local port to the public internet. This is
a hard block, not a permission prompt; routing around it wasn't attempted per
the safety policy.

**Workaround**: the user needs to run `ngrok http 4000` themselves in their
own terminal, then paste the resulting `https://*.ngrok-free.app` URL into
the GitHub App's Webhook URL field (as `.../api/webhooks/github`). Not yet
done as of last session — webhook-triggered scans are code-complete and unit
tested with hand-signed fake payloads (see [[features/m4-github-app]]), but
have not been triggered by a real GitHub webhook delivery yet.

## `git push` blocked by auto-mode; remote add succeeded

Similarly, `git push -u origin main` was blocked by the same classifier even
after the user provided the repo URL and confirmed private visibility. `git
remote add origin` (a non-networked local config change) was allowed and
completed. The user ran the push themselves from their own terminal
afterward.

## Stripe billing untested against real Stripe

`routes/billing.ts` checkout/portal/webhook code is written and verified only
against a **hand-signed fake webhook payload** (see [[features/m5-billing]])
proving the signature verification and plan-upgrade logic work. No real
Stripe test-mode account has been connected — `STRIPE_SECRET_KEY`,
`STRIPE_WEBHOOK_SECRET`, `STRIPE_PRICE_PRO`, `STRIPE_PRICE_TEAM` are all still
empty in `.env`. Checkout/portal endpoints correctly 501 when unconfigured.

## `XAI_*` env var naming is misleading

See [[decisions#LLM provider]] — the actual provider is Groq, not xAI. Same
naming trap independently hit in the `trackMyFinance` project. Low priority
to rename since the code is provider-agnostic, but worth a global rename pass
(`XAI_API_KEY` → `GROQ_API_KEY` etc.) if this project's env footprint grows.

## No email transport for invites

`POST /api/orgs/:orgId/invites` logs the invite link to the server console
(`[invite] email -> /invites/{token}`) instead of sending an actual email.
Fine for local dev/demo, would need a real transport (Resend, SES, etc.)
before any real multi-user usage.

## `web/node_modules` — Vite dep-cache artifacts appeared in the file tree

`web/node_modules/.vite/deps/*` shows up in `find` listings despite
`node_modules/` being gitignored — this is normal Vite pre-bundling cache,
not tracked by git, not a concern, just noted here because it looked odd in
a full directory listing.
