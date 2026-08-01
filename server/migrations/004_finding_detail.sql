-- Structured metadata for finding types that do not fit the original
-- dead-code-shaped columns. Secrets need a provider, a redacted shape, a
-- dedupe fingerprint and (for history findings) a commit SHA.
--
-- NEVER store a raw secret value in this column.
ALTER TABLE code_findings ADD COLUMN detail JSONB;
