-- Findings that outlive the scan that found them.
--
-- Until now every finding lived only inside its own scan, so the product could
-- say "6 unused dependencies" but never "this one has been open since the 1st"
-- or "you fixed this and it came back". One row per distinct problem per
-- repository, updated by each scan rather than re-inserted.
CREATE TABLE finding_lifecycle (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  -- Stable identity from packages/engine/src/findingIdentity.ts. Deliberately
  -- computed in the engine, not here, so the CLI and the hosted worker agree
  -- on what "the same finding" means.
  finding_key TEXT NOT NULL,
  kind TEXT NOT NULL,                 -- dependency | dead_code | secret | agent_config
  title TEXT NOT NULL,
  location TEXT,

  -- open: currently present. fixed: was present, absent from the latest scan.
  -- ignored/acknowledged: a human decision, never set by a scan — a scan must
  -- not be able to un-ignore something someone deliberately dismissed.
  state TEXT NOT NULL DEFAULT 'open',

  first_detected_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  fixed_at TIMESTAMPTZ,
  reintroduced_at TIMESTAMPTZ,

  first_detected_scan UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,
  last_seen_scan UUID REFERENCES scan_jobs(id) ON DELETE SET NULL,

  -- How many scans have seen it, and how many times it came back after being
  -- fixed. A finding that keeps returning is a different (worse) story than
  -- one that has simply never been dealt with.
  times_seen INT NOT NULL DEFAULT 1,
  times_reintroduced INT NOT NULL DEFAULT 0,

  note TEXT,                          -- why it was ignored, when it was
  created_at TIMESTAMPTZ DEFAULT now(),

  UNIQUE (repo_id, finding_key)
);

-- The two queries this table exists to serve: "what is open for this repo"
-- (dashboard, delta) and "history of this one finding".
CREATE INDEX finding_lifecycle_repo_state_idx ON finding_lifecycle (repo_id, state);
CREATE INDEX finding_lifecycle_repo_kind_idx ON finding_lifecycle (repo_id, kind);
