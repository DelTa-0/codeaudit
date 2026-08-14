const TOKEN_KEY = "codeaudit_token";

export function getToken(): string | null {
  return localStorage.getItem(TOKEN_KEY);
}

export function setToken(token: string | null) {
  if (token) localStorage.setItem(TOKEN_KEY, token);
  else localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    public status: number,
    message: string,
  ) {
    super(message);
  }
}

export async function api<T = unknown>(
  path: string,
  options: { method?: string; body?: unknown } = {},
): Promise<T> {
  const headers: Record<string, string> = { "content-type": "application/json" };
  const token = getToken();
  if (token) headers.authorization = `Bearer ${token}`;

  const res = await fetch(path, {
    method: options.method ?? "GET",
    headers,
    body: options.body !== undefined ? JSON.stringify(options.body) : undefined,
  });

  const data = (await res.json().catch(() => ({}))) as { error?: string };
  if (!res.ok) {
    if (res.status === 401) setToken(null);
    throw new ApiError(res.status, data.error ?? `Request failed (${res.status})`);
  }
  return data as T;
}

// ---- Shared API types ----

export interface Org {
  id: string;
  name: string;
  slug: string;
  plan: string;
  role: string;
}

/** A repo the org's GitHub App installation can see but has not connected yet. */
export interface GithubRepoOption {
  githubRepoId: number;
  fullName: string;
  private: boolean;
  defaultBranch: string;
  /** Which installation surfaced it — an org can have more than one. */
  installationId: number;
}

/** A linked App installation. `repositorySelection` is "all" | "selected". */
export interface GithubInstallation {
  installationId: number;
  accountLogin: string | null;
  repositorySelection: string | null;
}

export interface GithubReposResponse {
  installations: GithubInstallation[];
  repos: GithubRepoOption[];
}

export interface Repo {
  id: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  webhook_enabled: boolean;
  gate_enabled?: boolean;
  min_score?: string | null;
  autofix_enabled?: boolean;
  badge_token?: string | null;
  installation_id?: string | null;
  latest_score: string | null;
  last_scan_status?: string | null;
  last_scan_at?: string | null;
  trend?: { id: string; created_at: string; score: string | null }[];
}

export interface HotspotFile {
  path: string;
  commits: number;
  lines: number;
  score: number;
  ai: boolean;
  hasFinding: boolean;
}

export interface AiAuthorshipStats {
  aiCommits: number;
  totalCommits: number;
  shareOfFiles: number;
  aiFindingDensity: number;
  humanFindingDensity: number;
  aiFiles: number;
  humanFiles: number;
  automationCommits?: number;
  /** false when either bucket is too small for the comparison to mean anything */
  comparable?: boolean;
  hotspots?: HotspotFile[];
}

export interface ScanSummary {
  score: number;
  grade: string;
  counts: {
    phantom: number;
    suspicious: number;
    unused: number;
    healthy: number;
    vulnerable?: number;
    zombies: number;
    filesAnalyzed: number;
    /** Absent on scans from before secret detection shipped. */
    secrets?: number;
    /** Absent on scans from before agent-config auditing shipped. Advisory only — never affects `score`. */
    agentConfig?: number;
  };
  /** "skipped" means zombie findings are unfiltered static candidates (no LLM verdict) — score is noisier. */
  reviewStatus?: "full" | "partial" | "skipped";
  /** Present only when reviewStatus !== "skipped" AND the review was a CLI user's own key, not the platform's — self-reported by the CLI, never platform-verified. */
  llmReviewSource?: "cli-byok";
  ai?: AiAuthorshipStats | null;
  priorities?: RankedFinding[];
  advisories?: {
    duplicates: DuplicateGroup[];
    licenseConflicts: LicenseConflict[];
  };
}

export interface RankedFinding {
  rank: number;
  band: "critical" | "high" | "medium" | "low";
  kind: string;
  title: string;
  location: string | null;
  why: string;
  effort: "S" | "M" | "L";
  confidence: number;
}

export interface DuplicateGroup {
  category: string;
  ecosystem: string;
  packages: string[];
  prefer: string | null;
  recommendation: string;
}

export interface LicenseConflict {
  packageName: string;
  ecosystem: string;
  packageLicense: string | null;
  projectLicense: string | null;
  severity: "high" | "medium";
  reason: string;
}

export interface Scan {
  id: string;
  repo_id?: string;
  trigger: string;
  branch: string | null;
  commit_sha: string | null;
  status: string;
  progress: string | null;
  error_message: string | null;
  summary: ScanSummary | null;
  created_at: string;
  completed_at: string | null;
}

export interface VulnAdvisory {
  id: string;
  aliases: string[];
  summary: string | null;
  severity: "low" | "medium" | "high" | "critical" | "unknown";
  url: string;
}

export interface DependencyFinding {
  id: string;
  package_name: string;
  ecosystem: string;
  declared_version: string | null;
  status: "phantom" | "suspicious" | "unused" | "healthy" | "vulnerable";
  registry_metadata: {
    weeklyDownloads?: number | null;
    created?: string | null;
    latest?: string | null;
    vulnerabilities?: VulnAdvisory[];
    maxSeverity?: string;
    typosquatOf?: string;
    typosquatDistance?: number;
    transitive?: boolean;
    alternatives?: { name: string; reason: string; confidence: number; source: "fuzzy" | "ai" }[];
    deprecated?: string | null;
  } | null;
}

export interface CodeFinding {
  id: string;
  file_path: string;
  line_start: number | null;
  line_end: number | null;
  symbol_name: string | null;
  finding_type: string;
  confidence_score: string | null;
  llm_reasoning: string | null;
  detail?:
    | {
        provider: string;
        redacted: string;
        tier?: number;
        removedFromHead?: boolean;
        firstSeenCommit?: string;
        lastSeenCommit?: string;
      }
    | {
        category: string;
        rule: string;
        severity: "critical" | "high" | "medium";
        tier: number;
        surface: string;
        evidence: string;
      }
    | null;
}

export interface Member {
  id: string;
  role: string;
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}
