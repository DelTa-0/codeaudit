# Email verification — design

**Date:** 2026-08-20
**Status:** superseded by
[2026-08-20-magic-link-signup-design.md](2026-08-20-magic-link-signup-design.md)

> Kept rather than deleted. The reasoning below about enumeration oracles and
> address squatting carries directly into the replacement, and the decision
> trail explains why the product went passwordless at signup rather than
> bolting verification onto a form that should not have existed.

> What changed: signup by magic link means an account can only come into
> existence when someone clicks a link in a mailbox they control. Verification
> stops being a step to enforce and becomes a property of how accounts are
> created — so every column, route and gate specified below is unnecessary.

## Problem

`POST /api/auth/register` validates that the submitted address *parses* as an
email and nothing else:

```ts
email: z.string().email("Valid email required")
```

`admin@admin.com` parses. So does any address at any domain the registrant does
not control. The account is created, a personal organization is created with it,
and a JWT is returned — all before anyone has demonstrated they can read mail at
that address.

Three consequences, in ascending order of how much they matter:

1. **No contact path.** Billing notices, security mail and scan alerts go to an
   address nobody has confirmed exists.
2. **Free unlimited accounts.** Sign-ups cost an attacker nothing and are not
   traceable to anything real. Every account carries an org, and every org can
   queue scans, which cost CPU and consume GitHub API quota.
3. **Impersonation.** Someone can register under an address they do not own. If
   the real owner later signs up, they find their address taken.

GitHub OAuth sign-ups are unaffected: GitHub verifies the address before it
reaches us.

## Non-goals

- **Password reset.** None exists today, and adding one here would double the
  scope. Its absence *does* shape one decision below (see "Re-registration").
- **Deliverability engineering.** DNS records for the sending domain are an
  operator task, not a code change.
- **Verification for GitHub OAuth accounts.** GitHub already did it; asking
  again would be theatre.
- **Closing the login-time enumeration oracle.** Explicitly accepted — see
  "Known residual leak".

## Decisions

### Enforcement: block login entirely

An unverified account gets no token from `register` and is refused at `login`.
Nothing is half-usable. This matches the existing suspension gate, which already
establishes the pattern of refusing a login with a reason.

### Storage: three columns on `users`, not a table

Alternatives considered:

- **A separate `email_verification_tokens` table.** Supports a history of issued
  tokens. Nothing needs that history, and it buys a join plus a cleanup job.
- **A stateless signed token with no storage.** Rejected outright: a consumed
  link must stop working, and a stateless token cannot be marked consumed.

One live token per user is the correct semantic — issuing a new link should
invalidate the previous one — and that is exactly what a column expresses. So:

```sql
ALTER TABLE users
  ADD COLUMN email_verified_at        TIMESTAMPTZ,
  ADD COLUMN verification_token_hash  TEXT,
  ADD COLUMN verification_sent_at     TIMESTAMPTZ;
```

`email_verified_at IS NULL` means unverified. The same migration backfills every
existing row to `now()`, in the same transaction that adds the column, so there
is no window in which live users — including the seeded platform operator — are
locked out.

**Only the SHA-256 hash of the token is stored.** A verification column holding
working links is the same class of mistake as a secrets scanner that stores
secrets, and this codebase already refuses to make that mistake elsewhere.

### Provider: Resend, via a hand-rolled REST client

No SDK. The Stripe integration already set this precedent — *"a small
hand-rolled REST client is sufficient for the three endpoints used"* — and
Resend needs exactly one endpoint. Keeping the dependency count flat matters
more than usual in a supply-chain security tool: every package added here is one
the product would flag in someone else's repository.

`server/src/lib/email.ts` exports `sendVerificationEmail(to, url)`. With
`RESEND_API_KEY` unset it logs the URL and returns `delivered: false`, matching
how LLM review, the GitHub App and billing all degrade when unconfigured.
`npm run dev` continues to need no secrets; local sign-up works by copying the
link out of the server log.

### Re-registration of an unverified address

`register` on an address that already exists **unverified** overwrites
`password_hash` and issues a fresh token.

This is a direct consequence of there being no password-reset flow. If the
password were left alone, anyone could permanently deny an address to its real
owner by registering it first — with no recovery path in the product. Allowing
the most recent registrant to set the password means whoever proves control of
the mailbox ends up owning the account.

**Residual risk, accepted:** if a victim clicks a verification link they did not
request, they verify an account whose password an attacker chose. The blast
radius is one empty organization with no repositories, no scans and no billing
relationship. The email copy states plainly that no account is active until the
link is clicked and that an unexpected message can be ignored.

### Existing users: grandfathered

Backfilled to verified. Enforcement applies only to sign-ups after this ships.

## Routes

| Route | Behaviour |
|---|---|
| `POST /auth/register` | Creates user + org as today. Issues a token, sends mail. Returns `201 { verificationRequired: true, email }` — **no JWT**. |
| `POST /auth/verify-email` | `{ token }` → look up by hash, check 24h expiry, set `email_verified_at`, clear the hash. Returns `{ token, user }`. |
| `POST /auth/resend-verification` | `{ email }` → always `202 { ok: true }`. Rate-limited to 10/hour per IP (matching `registerLimiter`'s shape), plus a 60s per-user cooldown read from `verification_sent_at`. |
| `POST /auth/login` | After the password check and before the suspension check: `403 { error, verificationRequired: true }` when unverified. |

Verification returns a JWT so the click lands the user in the dashboard rather
than at a login form they have just proved they do not need.

### Register no longer reveals whether an address is taken

Previously `409 "An account with this email already exists"` — an enumeration
oracle available to anyone, unauthenticated, at any volume the rate limiter
allows. Register now returns the identical `201` body in all three cases:

- **address is new** — create user + org, send a verification link;
- **address exists, unverified** — overwrite the password, re-issue, resend;
- **address exists, verified** — change nothing, and send *that address* a
  "someone tried to register with your email; you already have an account"
  message with a sign-in link.

The third case is what makes the responses indistinguishable without also
silently discarding the attempt. It also tells a real owner that someone is
probing their address.

### Known residual leak

`login` returns `403 verificationRequired` only for addresses that exist, so
account existence remains observable there. This was chosen deliberately over a
`pending_signups` design that closes it completely: the 403 is what lets the
login screen offer a resend button, and without it a user who never clicked the
link gets a bare "invalid email or password" with no path forward.

The tradeoff is stated here so it stays a decision rather than an oversight. If
it is revisited, the fix is to create no `users` row until verification.

## Web

Three changes, all in the existing structure — `web/src/pages/Auth.tsx` handles
both login and register, and routes live in `web/src/main.tsx`.

1. **Register success becomes a state, not a redirect.** `Auth.tsx` currently
   stores the returned JWT and navigates to the dashboard. With no JWT in the
   response it switches to a "check your email" panel naming the address it sent
   to, with a resend control that calls `resend-verification` and reports the
   cooldown rather than silently doing nothing.
2. **A `/verify-email` route.** Reads `?token=` from the query string, posts it,
   stores the returned JWT and goes to the dashboard. Distinct states for
   in-flight, expired-or-consumed, and malformed — the expired state offers a
   resend, because that is the whole reason a user is looking at it.
3. **Login surfaces the 403.** When the response carries
   `verificationRequired: true`, show the same resend control instead of the
   generic credentials error.

## Configuration

| Var | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | No | Unset ⇒ links are logged, not sent. |
| `EMAIL_FROM` | No | e.g. `CodeOrion <noreply@example>`. Defaults to a placeholder that Resend will reject, which is the correct failure. |
| `APP_URL` | Already exists | Builds the verification link. |

## Testing

Existing suite style — plain script, `PASS`/`FAIL` lines, non-zero exit.
New suite: `server/test/email-verification.ts`.

- The raw token never appears in any column (query the row, assert absence).
- An expired token (>24h) is rejected.
- A consumed token is rejected on second use.
- Login with an unverified account returns 403 with `verificationRequired`.
- Login succeeds once verified.
- A grandfathered (backfilled) user logs in unaffected.
- A GitHub OAuth sign-up is verified at creation.
- `register` returns byte-identical bodies for a new address and a taken one.
- `resend-verification` returns `202` for an address that does not exist.
- The 60-second resend cooldown holds.
- Re-registering an unverified address changes the password and invalidates the
  previously issued token.

## Operator setup

Resend requires DNS records on the sending domain before it will deliver to
arbitrary recipients. Until they are added, only pre-verified addresses receive
mail. This is a one-time task outside the codebase and blocks real sign-ups, so
it belongs in the deploy notes alongside the other DNS-dependent integrations.
