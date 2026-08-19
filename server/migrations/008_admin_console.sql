-- The operator axis: a platform role, presence, and logs worth reading.
--
-- Every role in the product so far has been org-scoped (org_members.role), and
-- that is the point: an org "admin" administers *their own workspace*. Nothing
-- about that should grant sight of anyone else's data. Operating the platform
-- is a second, independent axis, which is why this is a column on users rather
-- than another value in the org_members enum.

-- 'user' (everybody) | 'admin' (operator). Deliberately NOT a JWT claim —
-- tokens live 7 days, so a claim-based role would mean a revoked admin keeps
-- their access for up to a week, which is precisely the window that matters
-- when you are revoking it. The guard re-reads this column per request.
ALTER TABLE users ADD COLUMN platform_role TEXT NOT NULL DEFAULT 'user';

-- Presence. Touched by middleware on authenticated requests, throttled to one
-- write per user per two minutes, which is what makes "online now" answerable
-- without a session store.
ALTER TABLE users ADD COLUMN last_seen_at TIMESTAMPTZ;

-- Suspension is checked on the same middleware pass that touches last_seen_at,
-- so it takes effect on the account's next request rather than at its next
-- login — an already-issued token stops working immediately.
ALTER TABLE users ADD COLUMN suspended_at TIMESTAMPTZ;
ALTER TABLE users ADD COLUMN suspended_reason TEXT;

-- Partial: admins are a handful of rows out of the whole table, and this index
-- exists only to answer "list the operators" without a sequential scan.
CREATE INDEX users_platform_admin_idx ON users (platform_role) WHERE platform_role <> 'user';
CREATE INDEX users_last_seen_idx ON users (last_seen_at DESC NULLS LAST);
CREATE INDEX users_created_idx ON users (created_at DESC);

-- ---------------------------------------------------------------------------
-- audit_log: what a *person* did.
--
-- It already existed but was written by a handful of routes by hand and carried
-- no request context, so it could say "someone removed a member" and nothing
-- about from where. Middleware now records every mutating request, plus the
-- authentication events (login ok/failed, register) that no mutation-shaped
-- middleware would ever see.
--
-- Reads are deliberately not recorded: they are the overwhelming majority of
-- traffic, they would bury the signal, and "who viewed what" is a different
-- feature with different retention obligations.
-- ---------------------------------------------------------------------------
ALTER TABLE audit_log ADD COLUMN ip TEXT;
ALTER TABLE audit_log ADD COLUMN user_agent TEXT;
ALTER TABLE audit_log ADD COLUMN method TEXT;
ALTER TABLE audit_log ADD COLUMN path TEXT;
-- HTTP status of the request the entry describes. Failures are the interesting
-- rows — a burst of 401s is the story, and it is invisible if only successes
-- are kept.
ALTER TABLE audit_log ADD COLUMN status INT;
ALTER TABLE audit_log ADD COLUMN duration_ms INT;

-- The three queries the activity view actually issues: newest-first globally,
-- newest-first for one actor, and "everything of this kind".
CREATE INDEX audit_log_created_idx ON audit_log (created_at DESC);
CREATE INDEX audit_log_user_created_idx ON audit_log (user_id, created_at DESC);
CREATE INDEX audit_log_action_created_idx ON audit_log (action, created_at DESC);

-- ---------------------------------------------------------------------------
-- system_events: what the *software* did.
--
-- Kept separate from audit_log on purpose. The two answer different questions
-- for different readers, and merging them produces a table where every query
-- needs a discriminator and neither view is good. Worker and queue failures
-- currently reach console.error and land nowhere durable; this is where they go.
-- ---------------------------------------------------------------------------
CREATE TABLE system_events (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  level TEXT NOT NULL DEFAULT 'info',    -- debug | info | warn | error
  source TEXT NOT NULL,                  -- api | worker | queue | webhook | billing | llm | auth
  -- A stable dotted key ('scan.failed', 'queue.job.stalled') so events stay
  -- groupable and countable as their human-readable message is reworded.
  event TEXT NOT NULL,
  message TEXT NOT NULL,
  -- Structured detail. Nothing secret goes in here: it is rendered verbatim in
  -- the admin panel and exported with it.
  context JSONB,
  org_id UUID REFERENCES organizations(id) ON DELETE SET NULL,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  scan_job_id UUID REFERENCES scan_jobs(id) ON DELETE CASCADE,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

CREATE INDEX system_events_created_idx ON system_events (created_at DESC);
CREATE INDEX system_events_level_created_idx ON system_events (level, created_at DESC);
CREATE INDEX system_events_source_created_idx ON system_events (source, created_at DESC);
-- The "what is broken right now" query, which is the one that gets run under
-- pressure. Partial, because errors are the small minority of rows.
CREATE INDEX system_events_problems_idx ON system_events (created_at DESC)
  WHERE level IN ('warn', 'error');
