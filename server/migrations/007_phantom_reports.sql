-- Candidate hallucinated package names, reported by opted-in codeorion-mcp
-- installs at the moment verify_package returns "phantom".
--
-- This is the input queue for the curated corpus
-- (packages/engine/src/data/hallucinatedNames.ts), NOT the corpus itself.
-- Nothing lands in the corpus without a human attaching checkable provenance —
-- auto-promoting reports would let anyone poison the list that ships inside
-- the scanner. The table exists to answer one question the corpus rule needs
-- answered first: which invented names actually recur in the wild, and how
-- often.
--
-- Deliberately stores nothing about the reporter: no IP, no token, no repo,
-- no code. A package name plus an ecosystem is the entire record.
CREATE TABLE phantom_reports (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  package_name TEXT NOT NULL,
  ecosystem TEXT NOT NULL,               -- npm | pypi
  report_count INT NOT NULL DEFAULT 1,
  first_reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  last_reported_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Set by a human after review: promoted (added to the corpus), rejected
  -- (legitimate private name, noise), or NULL while pending.
  review_state TEXT,
  UNIQUE (package_name, ecosystem)
);

-- The curation query: unreviewed names, most-recurrent first.
CREATE INDEX phantom_reports_pending_idx
  ON phantom_reports (report_count DESC)
  WHERE review_state IS NULL;
