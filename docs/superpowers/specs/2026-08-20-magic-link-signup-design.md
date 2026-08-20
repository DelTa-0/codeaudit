# Magic-link signup — design

**Date:** 2026-08-20
**Status:** approved for implementation
**Supersedes:** [2026-08-20-email-verification-design.md](2026-08-20-email-verification-design.md)

## Problem

`POST /api/auth/register` checks that the submitted address *parses* and nothing
else:

```ts
email: z.string().email("Valid email required")
```

`admin@admin.com` parses. The account is created, a personal organization is
created with it, and a JWT is returned — before anyone has shown they can read
mail at that address. Sign-ups are therefore free, unlimited, untraceable to
anything real, and each one carries an org that can queue scans, which cost CPU
and GitHub API quota.

The first design bolted a verification step onto that form. This one removes the
form. If an account can only come into existence when someone clicks a link in a
mailbox they control, there is no unverified state to enforce — the property
holds by construction rather than by a check that has to be remembered at every
call site.

## Scope

**In:** replacing the signup form with a magic-link flow, and a set-password step
after first sign-in.

**Unchanged:** the login form. Email + password, exactly as today. GitHub OAuth,
untouched.

**Explicitly deferred to later phases:** Google OAuth (phase 2); removing
password login entirely (phase 3, which must also rework `seed:admin` and the
step-up re-auth at `server/src/routes/admin/users.ts:128`, both of which depend
on a password existing).

## Flow

Signup page has one field. Submitting it returns `202` — always, for a known
address, an unknown one, or a typo. Nothing is created at request time.

The email carries **a link and a 6-digit code**. On a successful click or code
entry:

| Address | Result |
|---|---|
| unknown | create user + personal org, sign in, land on *set a password* |
| known, no password | sign in, land on *set a password* |
| known, has password | sign in |

That third row is the recovery path, and it exists because of the second. A user
who skips setting a password would otherwise be permanently locked out: the
login form needs a password they never chose. Letting a link sign in an existing
account fixes that, and incidentally gives the product the **password reset it
has never had** — there is no reset flow in the codebase today.

## Decisions

### Link *and* code, not link alone

Corporate mail scanners and link previewers fetch URLs in email automatically,
which consumes a single-use token before the human ever clicks. The user then
sees "this link has expired" with no explanation and no recourse.

The code is the answer to that, and to the cross-device case — requested on a
laptop, mail opened on a phone. The link stays the happy path; the code is typed
back into the page that requested it.

### The code needs a brute-force guard

Six digits is a million possibilities, which is only meaningful if something
stops a script trying them. **Five failed attempts invalidates the token**,
counted on the row. Without that the code is weaker than the password it stands
in for, and it is the kind of omission that looks fine in review because the
number *looks* large.

### 15-minute expiry

This is a sign-in credential, not an account activation. A different risk
profile deserves a different number than the 24 hours the superseded spec used.

### Storage: an `email_tokens` table

```sql
CREATE TABLE email_tokens (
  id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email       TEXT NOT NULL,
  user_id     UUID REFERENCES users(id) ON DELETE CASCADE,  -- NULL until the account exists
  token_hash  TEXT NOT NULL,
  code_hash   TEXT NOT NULL,
  attempts    INT NOT NULL DEFAULT 0,
  expires_at  TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
);
```

`user_id` is nullable because the token precedes the account it will create. A
table rather than columns on `users` for the same reason: for a new address
there is no row to hang a column on.

**Only hashes are stored.** Never the token, never the code. A table holding
working sign-in credentials is the same class of mistake as a secrets scanner
that stores secrets, and this codebase already refuses to make that mistake
elsewhere.

One live token per address: issuing a new one consumes any outstanding row for
that email, so a second request invalidates the first link.

### Enumeration

There is nothing to leak. Requesting a link returns an identical `202` in every
case, and no route distinguishes a known address from an unknown one — because
the *flow* does not distinguish them. The superseded design had to accept a
residual oracle at login to keep a resend button working; this one has no such
tension.

The existing login form still answers `401` for a wrong password on a real
account and `401` for an address that does not exist, unchanged.

### Provider: Resend, via a hand-rolled REST client

No SDK. The Stripe integration set the precedent — *"a small hand-rolled REST
client is sufficient for the three endpoints used"* — and Resend needs exactly
one endpoint. Dependency count matters more than usual here: every package added
is one this product would flag in someone else's repository.

`server/src/lib/email.ts` degrades like every other optional integration: with
`RESEND_API_KEY` unset it logs the link and code to the server log and returns
`delivered: false`. `npm run dev` keeps needing no secrets, and local signup
works by reading the log.

## Routes

| Route | Behaviour |
|---|---|
| `POST /auth/signin-link` | `{ email }` → always `202 { ok: true }`. Issues a token, consuming any outstanding one for that address. Rate-limited 10/hour per IP; 60s cooldown per address. |
| `POST /auth/signin-verify` | `{ token }` or `{ email, code }` → creates the account if new, signs in, returns `{ token, user, mustSetPassword }`. |
| `POST /auth/set-password` | Authenticated. `{ password }` (min 8) → sets `password_hash`. |
| `POST /auth/register` | **Removed.** |

Account creation moves out of `register` and into `signin-verify`: user row,
personal organization, `org_members` owner row, and the `auth.registered` audit
entry, unchanged in substance from what `register` does today.

## Web

- **Signup page** becomes one email field, then a "check your mail" state with a
  code input and a resend control that reports the cooldown rather than silently
  doing nothing.
- **`/signin` route** handles the emailed link, and falls back to the code form
  when the token is already spent — which is exactly the scanner case, so the
  copy says so instead of blaming the user.
- **Set-password page** after first sign-in. Skippable, because forcing it
  before the dashboard would strand anyone who closes the tab; the recovery path
  above is what makes skipping safe.
- **Login page** unchanged, plus a link to the magic-link page for anyone who
  has no password.

## Testing

Existing style — plain script, `PASS`/`FAIL`, non-zero exit. New suite:
`server/test/magic-link.ts`.

- Neither the raw token nor the raw code appears in the stored row.
- An expired token is rejected.
- A consumed token is rejected on second use.
- Five wrong codes invalidates the token; the sixth attempt fails even with the
  correct code.
- A correct code within the attempt limit succeeds.
- Requesting a link twice invalidates the first.
- An unknown address creates a user, an org, and an owner membership.
- A known address does not create a second user or org.
- `signin-verify` returns `mustSetPassword: true` for an account with no
  password and `false` for one with a password.
- `signin-link` returns byte-identical responses for known and unknown
  addresses.
- The 60-second cooldown holds.
- `set-password` requires authentication and rejects passwords under 8
  characters.
- The login form still works unchanged for an account that has a password.

## Operator setup

Resend needs DNS records on the sending domain before it will deliver to
arbitrary recipients; until then only pre-verified addresses receive mail. This
is a one-time task outside the codebase and it blocks real signups, so it
belongs in the deploy notes beside the other DNS-dependent integrations.

| Var | Required | Notes |
|---|---|---|
| `RESEND_API_KEY` | No | Unset ⇒ link and code are logged, not sent. |
| `EMAIL_FROM` | No | e.g. `CodeOrion <noreply@example>`. |
| `APP_URL` | Already exists | Builds the link. |
