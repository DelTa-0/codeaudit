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

## ~~Fixed-in-`main` Python false positives never reached npm~~ — RESOLVED (2026-07-20)

`a2b9411` ("Fix Python analyzer false positives found by real-world FastAPI
review") fixes exactly the false-positive classes documented in
[[roadmap#Python precision fixes from real-world review (2026-07-20)]] —
decorator-wired route handlers, same-file-only helpers, the `docx`→
`python-docx` alias gap, and the `NEVER_FLAG_UNUSED` allowlist
(`uvicorn`/`lxml`/`python-multipart`/etc). Ground-truth suite (16 checks) is
green for all of it.

**None of that fix is live for anyone running `npx codeaudit-scan scan`.**
`npm view codeaudit-scan time --json` shows `0.2.0` published
2026-07-20T14:31:27Z; `a2b9411` was committed 2026-07-20T14:47:32Z (UTC) —
16 minutes *after* that publish, same version number, never bumped or
republished since. `npx` always resolves the latest published dist-tag, so
every real-world run since the fix landed (including a second independent
review, of an unrelated FastAPI+Pydantic finance app, that rediscovered the
identical four categories: decorator handlers, Pydantic
inheritance/type-annotation refs, same-file helper calls, and
kwarg-value/singleton-instantiation refs) has been auditing stale,
already-fixed logic and reproducing bugs that don't exist in `main`.

Two of the four categories that second review hit (Pydantic base-class/
type-annotation references, and identifiers used only as kwarg values or
singleton-instantiation targets) were never separately broken — the
Python analyzer is a flat per-line identifier regex, not a call-graph, so
any textual occurrence of a name already counts as a reference regardless
of whether it's a call, a type annotation, a base class, or a kwarg value.
They just needed the same-file-exported-symbol rescue (fixed same commit)
to stop being miscategorized as "no reference at all."

**Fixed**: `codeaudit-scan@0.2.1` published; re-verified against the scrapper
repo (score 62(C) → 93.3(A)). The JS/TS analog of the same-file rescue bug
(never actually broken for Python, only for JS/TS — see
[[roadmap#Making CodeAudit Actually Useful — Phases 1–4 shipped
(2026-07-20)]]) and the npm-side `NEVER_FLAG_UNUSED`/workspace-awareness gaps
were fixed the same session. `cli/package.json`'s `prepublishOnly` now runs
both ground-truth suites before any publish can proceed, so this specific
"fix committed but never published" failure mode can't recur silently.

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

## ~~Local webhook testing requires a public tunnel~~ — RESOLVED

GitHub can't POST webhooks to `localhost`, and starting `ngrok` via the
agent's Bash tool was **blocked twice by the Claude Code auto-mode
classifier** even after explicit user confirmation (it does not allow
starting a process that exposes a local port to the public internet — a hard
block, not a permission prompt).

**Resolved by the user running `ngrok http 4000` themselves** in their own
terminal, then setting the GitHub App's Webhook URL to
`https://<tunnel>.ngrok-free.dev/api/webhooks/github`. Verified reachable
(`/api/health` → 200, unsigned webhook POST → 401 "Invalid signature" as
expected) before the user pushed a real commit — the webhook fired, the scan
ran end-to-end, and results rendered correctly in the dashboard (score 82,
1 phantom dep, 1 unused, 44 files analyzed). The full push → webhook → scan →
UI loop is now confirmed working with real GitHub-originated traffic, not
just hand-signed fake payloads. Note: free-tier ngrok URLs change on every
tunnel restart, so the Webhook URL needs re-registering each time.

## ~~Repo connected via URL paste has no linked installation~~ — FIXED

Repos connected through the plain "paste a github.com URL" flow
(`POST /orgs/:orgId/repos`, [[features/m2-scan-engine]]) get `installation_id
= NULL` — that flow doesn't go through the GitHub App picker
(`POST /orgs/:orgId/github-repos`) which is what actually links a
`github_installations` row. `queue/prComment.ts`'s `processPrCommentJob()`
checks `if (!repo?.installation_id) return;` and exits silently by design —
no error, no log line, just nothing happens. This meant the first real PR
test (`pull_request` webhook → scan completed with `pr_number` set) produced
no comment, with nothing in the logs to explain why.

**Fixed by manually linking the installation**: looked up the real
installation ID via the GitHub API (`GET /app/installations` using the App
JWT, filtered by `account.login`), inserted a `github_installations` row for
the org, and pointed the `repositories.installation_id` at it directly in
Postgres. After that, a second PR push correctly produced
`[pr-comment] posted on DelTa-0/codeaudit#1`.

**Root-caused and fixed**: `routes/repos.ts`'s `POST /orgs/:orgId/repos`
(URL-paste flow) now calls a new `findInstallationMatch(orgId, fullName)`
helper before inserting — it lists every `github_installations` row for the
org, calls `listInstallationRepos()` for each, and if the target repo shows
up in any of them, links `installation_id` + `github_repo_id` +
`private`/`default_branch` on insert instead of leaving them null. Degrades
gracefully to the old unlinked behavior if the org has no installation yet
(e.g. hasn't installed the GitHub App at all) or a stale/revoked installation
lookup fails.

Verified: connected `DelTa-0/InfoAi-ARB` via the plain URL-paste endpoint for
an org that already had installation `147130657` linked — the new
`repositories` row came back with `installation_id` and `github_repo_id`
populated automatically, no manual DB patch needed this time.

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
