CREATE EXTENSION IF NOT EXISTS pgcrypto;

CREATE TABLE users (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  email TEXT UNIQUE NOT NULL,
  password_hash TEXT,               -- NULL for GitHub-only accounts
  github_user_id BIGINT UNIQUE,
  name TEXT,
  avatar_url TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE organizations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  name TEXT NOT NULL,
  slug TEXT UNIQUE NOT NULL,
  plan TEXT NOT NULL DEFAULT 'free',          -- free | pro | team
  plan_status TEXT NOT NULL DEFAULT 'active', -- active | past_due | canceled
  stripe_customer_id TEXT,
  stripe_subscription_id TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE org_members (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  role TEXT NOT NULL DEFAULT 'developer',     -- owner | admin | developer
  invited_by UUID REFERENCES users(id),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, user_id)
);

CREATE TABLE invites (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  email TEXT NOT NULL,
  role TEXT NOT NULL DEFAULT 'developer',
  token TEXT UNIQUE NOT NULL,
  invited_by UUID REFERENCES users(id),
  expires_at TIMESTAMPTZ NOT NULL,
  accepted_at TIMESTAMPTZ,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE github_installations (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id BIGINT UNIQUE NOT NULL,
  account_login TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE repositories (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  installation_id UUID REFERENCES github_installations(id) ON DELETE SET NULL,
  github_repo_id BIGINT,
  full_name TEXT NOT NULL,           -- owner/repo
  private BOOLEAN NOT NULL DEFAULT false,
  default_branch TEXT NOT NULL DEFAULT 'main',
  webhook_enabled BOOLEAN NOT NULL DEFAULT false,
  latest_score NUMERIC(5,2),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE (org_id, full_name)
);

CREATE TABLE scan_jobs (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  repo_id UUID NOT NULL REFERENCES repositories(id) ON DELETE CASCADE,
  org_id UUID NOT NULL REFERENCES organizations(id) ON DELETE CASCADE,
  requested_by UUID REFERENCES users(id),
  trigger TEXT NOT NULL DEFAULT 'manual',    -- manual | push | pull_request
  commit_sha TEXT,
  branch TEXT,
  pr_number INT,
  status TEXT NOT NULL DEFAULT 'pending',    -- pending | cloning | analyzing | complete | failed
  progress TEXT,
  error_message TEXT,
  summary JSONB,
  created_at TIMESTAMPTZ DEFAULT now(),
  completed_at TIMESTAMPTZ
);

CREATE TABLE dependency_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_job_id UUID NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  package_name TEXT NOT NULL,
  ecosystem TEXT NOT NULL DEFAULT 'npm',     -- npm | pypi
  declared_version TEXT,
  status TEXT NOT NULL,                      -- phantom | unused | healthy | suspicious
  registry_metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE code_findings (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  scan_job_id UUID NOT NULL REFERENCES scan_jobs(id) ON DELETE CASCADE,
  file_path TEXT NOT NULL,
  line_start INT,
  line_end INT,
  symbol_name TEXT,
  finding_type TEXT NOT NULL,                -- dead_function | dead_route | dead_export | dead_component
  confidence_score NUMERIC(3,2),
  llm_reasoning TEXT,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE TABLE audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  org_id UUID REFERENCES organizations(id) ON DELETE CASCADE,
  user_id UUID REFERENCES users(id) ON DELETE SET NULL,
  action TEXT NOT NULL,
  target TEXT,
  metadata JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_org_members_user ON org_members(user_id);
CREATE INDEX idx_repositories_org ON repositories(org_id);
CREATE INDEX idx_scan_jobs_repo ON scan_jobs(repo_id);
CREATE INDEX idx_scan_jobs_org ON scan_jobs(org_id);
CREATE INDEX idx_dep_findings_job ON dependency_findings(scan_job_id);
CREATE INDEX idx_code_findings_job ON code_findings(scan_job_id);
CREATE INDEX idx_audit_log_org ON audit_log(org_id);
