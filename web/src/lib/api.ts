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

export interface Repo {
  id: string;
  full_name: string;
  private: boolean;
  default_branch: string;
  webhook_enabled: boolean;
  latest_score: string | null;
  last_scan_status?: string | null;
  last_scan_at?: string | null;
  trend?: { id: string; created_at: string; score: string | null }[];
}

export interface ScanSummary {
  score: number;
  grade: string;
  counts: {
    phantom: number;
    suspicious: number;
    unused: number;
    healthy: number;
    zombies: number;
    filesAnalyzed: number;
  };
}

export interface Scan {
  id: string;
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

export interface DependencyFinding {
  id: string;
  package_name: string;
  ecosystem: string;
  declared_version: string | null;
  status: "phantom" | "suspicious" | "unused" | "healthy";
  registry_metadata: { weeklyDownloads?: number | null; created?: string | null; latest?: string | null } | null;
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
}

export interface Member {
  id: string;
  role: string;
  user_id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
}
