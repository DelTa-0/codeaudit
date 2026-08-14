-- "all" | "selected": how much of the account an installation can see.
-- Recorded at link time so the dashboard can explain a missing repository as
-- "you only ticked some on GitHub" instead of leaving the user at a dead end.
ALTER TABLE github_installations ADD COLUMN repository_selection TEXT;
