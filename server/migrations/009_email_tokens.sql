-- One-time emailed sign-in credentials, replacing the signup form.
--
-- `POST /auth/register` used to check that an address *parsed* and nothing
-- else, so admin@admin.com created an account, an organization and a session
-- before anyone had shown they could read mail there. Verification could have
-- been bolted onto that form; instead the form is gone. An account can only
-- come into existence when someone clicks a link in a mailbox they control, so
-- the property holds by construction rather than by a check every call site has
-- to remember.
--
-- A table rather than columns on `users`, for a reason that is not stylistic:
-- for a new address there is no row to hang a column on. The token has to be
-- issuable before the account exists, which is exactly why `user_id` is
-- nullable here.

CREATE TABLE email_tokens (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),

  -- Lowercased at the call site so lookups are case-insensitive without a
  -- functional index; addresses differing only by case are the same mailbox.
  email TEXT NOT NULL,

  -- NULL until the click that creates the account. Set for an existing user so
  -- a consumed row still points at who it signed in.
  user_id UUID REFERENCES users(id) ON DELETE CASCADE,

  -- Hashes only, never the credential. A table holding working sign-in links is
  -- the same class of mistake as a secrets scanner that stores secrets, and
  -- this codebase refuses to make that mistake elsewhere.
  token_hash TEXT NOT NULL,
  code_hash TEXT NOT NULL,

  -- Six digits is a million possibilities, which only means anything if
  -- something stops a script trying them. Five wrong entries burns the row.
  attempts INT NOT NULL DEFAULT 0,

  expires_at TIMESTAMPTZ NOT NULL,
  consumed_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- The two lookups this table exists to serve: by link, and by typed code.
CREATE INDEX email_tokens_token_hash_idx ON email_tokens (token_hash);
CREATE INDEX email_tokens_email_idx ON email_tokens (email);

-- Sweeping consumed and expired rows. Nothing reads them after the fact —
-- audit_log records the sign-in — so they are deletable on any schedule.
CREATE INDEX email_tokens_expires_at_idx ON email_tokens (expires_at);
