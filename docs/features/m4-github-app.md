---
type: feature
title: "M4 — GitHub App Integration"
created: 2026-07-17
updated: 2026-07-17
tags:
  - project/codeaudit
  - milestone
status: done
related:
  - "[[../index]]"
  - "[[../architecture]]"
  - "[[../known-issues]]"
---

# M4 — GitHub App Integration

## What it delivers

OAuth sign-in, App installation/private-repo access, webhook-triggered
scans, and PR sticky comments.

## Key pieces

- `services/github.ts` — App-level JWT signing (RS256, App private key),
  installation token minting, authenticated clone URL construction, sticky
  PR comment upsert (hidden-marker keyed so re-pushes edit the same comment
  instead of spamming new ones), HMAC webhook signature verification, and
  the OAuth code-exchange flow
- `routes/githubAuth.ts` — `GET /api/auth/github` (redirect to GitHub
  authorize URL, in-memory state store with a 10-min TTL cleanup) and
  `GET /api/auth/github/callback` (exchanges code, links/creates user by
  `github_user_id` or matching email, redirects to the SPA with the JWT in a
  URL fragment)
- `routes/github.ts` — install-URL endpoint, installation linking, repo
  picker (`GET /orgs/:orgId/github-repos`), connecting a picked repo
  (private-capable, plan-limit checked), per-repo webhook enable/disable
  toggle (gated to the Pro+ plan)
- `routes/webhooks.ts` — `POST /api/webhooks/github`, raw-body mounted
  before `express.json()` for HMAC verification. Handles `push`,
  `pull_request` (opened/synchronize/reopened), `installation` (deleted).
  Always returns 200 after the signature check passes, even on internal
  errors, so GitHub doesn't auto-disable the hook
- `queue/prComment.ts` — `processPrCommentJob()`: builds the score-delta +
  findings-table comment body, calls `upsertPrComment()`
- Worker changes: private repos now clone via installation token
  (`authenticatedCloneUrl()`); PR-triggered scans enqueue a `pr-comment` job
  on completion
- Frontend: "Continue with GitHub" button (`Auth.tsx`), fragment-token
  pickup on redirect back, webhook enable/disable toggle (`RepoDetail.tsx`)

## Getting GitHub App credentials

Full walkthrough (from live debugging session):

1. Create at `github.com/settings/apps/new` — **GitHub App**, not OAuth App
2. Callback URL: `http://localhost:4000/api/auth/github/callback`
3. Webhook URL: needs a public tunnel for local dev (GitHub can't reach
   `localhost` — see [[../known-issues#Local webhook testing requires a public tunnel — blocked by auto-mode]])
4. Webhook secret: **you generate this yourself** (e.g. `openssl rand -hex
   32`) and enter the same value in both the GitHub form and `.env`'s
   `GITHUB_WEBHOOK_SECRET` — GitHub doesn't hand it to you
5. Repository permissions: Contents (read-only), Pull requests (read & write)
6. **Account permissions → Email addresses: Read-only** — a separate section
   from repository permissions, easy to miss, required for OAuth login to
   fetch the user's email (see [[../known-issues#GitHub OAuth email permission]])
7. Subscribe to events: Push, Pull request
8. `App ID` shown at the top of the settings page → `GITHUB_APP_ID`
9. Generate a private key (downloads a `.pem`) → move it somewhere outside
   the repo, point `GITHUB_APP_PRIVATE_KEY_PATH` at the **file**, not its
   containing folder (this was an actual bug caught during setup — the path
   pointed at a directory)
10. Client ID / generate a client secret → `GITHUB_CLIENT_ID` /
    `GITHUB_CLIENT_SECRET`
11. Install the app on a test repo (Install App button on the same page)

## Verification performed

- Signed a fake `push` webhook payload by hand (`HMAC-SHA256` with the
  configured secret) — bad signature → 401, good signature → 200 and a real
  scan created/completed
- Verified App-JWT signing end-to-end: read the private key, signed a JWT,
  called `GET /app` on GitHub's real API, got back the actual app name
  (`codeaudit01`) and ID (`4321222`) — confirms the App ID + private key pair
  is valid and correctly wired
- Confirmed `GITHUB_CLIENT_ID` is loaded correctly (OAuth authorize redirect
  URL contains it)
- **Not yet verified**: a real GitHub-originated webhook delivery (needs the
  ngrok tunnel — see [[../known-issues]]), and a full successful OAuth login
  (blocked on the email-permission 403, see [[../known-issues#GitHub OAuth email permission]])
