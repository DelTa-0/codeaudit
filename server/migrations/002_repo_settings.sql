-- F2-F4: per-repo feature settings (all opt-in, default off) + badge token
ALTER TABLE repositories ADD COLUMN gate_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repositories ADD COLUMN min_score NUMERIC(5,2);
ALTER TABLE repositories ADD COLUMN autofix_enabled BOOLEAN NOT NULL DEFAULT false;
ALTER TABLE repositories ADD COLUMN badge_token TEXT UNIQUE;
