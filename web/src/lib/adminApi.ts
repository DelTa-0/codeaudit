import { api } from "./api";

/** Every list endpoint in the admin API answers with this envelope. */
export interface Paged<T> {
  rows: T[];
  total: number;
  limit: number;
  offset: number;
  sort?: string;
  dir?: "asc" | "desc";
}

export interface QueueCounts {
  name: string;
  waiting: number;
  active: number;
  delayed: number;
  completed: number;
  failed: number;
  paused: number;
  unreachable?: boolean;
}

export interface WorkerHeartbeat {
  alive: boolean;
  lastBeatAt: string | null;
  ageSeconds: number | null;
  pid: number | null;
  host: string | null;
  startedAt: string | null;
}

export interface SystemEvent {
  id: string;
  level: "debug" | "info" | "warn" | "error";
  source: string;
  event: string;
  message: string;
  context?: Record<string, unknown> | null;
  org_id?: string | null;
  org_name?: string | null;
  user_id?: string | null;
  user_email?: string | null;
  scan_job_id?: string | null;
  created_at: string;
}

export interface Overview {
  users: {
    onlineNow: number;
    activeToday: number;
    activeWeek: number;
    activeMonth: number;
    total: number;
    newToday: number;
    newWeek: number;
    suspended: number;
    admins: number;
  };
  orgs: { total: number; paid: number };
  repos: { total: number; private: number };
  scans: { total: number; today: number; failedToday: number; inFlight: number };
  events: { errorsToday: number; warningsToday: number; errorsLastHour: number };
  queues: QueueCounts[];
  worker: WorkerHeartbeat;
  series: { day: string; signups: number; scans: number; scanFailures: number; errors: number }[];
  recentProblems: SystemEvent[];
}

export interface AdminUser {
  id: string;
  email: string;
  name: string | null;
  avatar_url: string | null;
  platform_role: "user" | "admin";
  created_at: string;
  last_seen_at: string | null;
  suspended_at: string | null;
  suspended_reason: string | null;
  github_linked: boolean;
  has_password: boolean;
  org_count?: string;
  scan_count?: string;
}

export interface AdminUserDetail {
  user: AdminUser;
  orgs: {
    id: string;
    name: string;
    slug: string;
    plan: string;
    plan_status: string;
    role: string;
    joined_at: string;
    repo_count: string;
  }[];
  activity: ActivityEntry[];
  scans: { total: number; last30d: number; failed: number };
}

export interface AdminOrg {
  id: string;
  name: string;
  slug: string;
  plan: string;
  plan_status: string;
  created_at: string;
  member_count: string;
  repo_count: string;
  scan_count: string;
  last_activity: string | null;
  owner_email: string | null;
}

export interface ActivityEntry {
  id: string;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
  ip: string | null;
  user_agent: string | null;
  method: string | null;
  path: string | null;
  status: number | null;
  duration_ms: number | null;
  created_at: string;
  user_id: string | null;
  user_email: string | null;
  user_name: string | null;
  org_id: string | null;
  org_name: string | null;
}

export interface InFlightScan {
  id: string;
  status: string;
  progress: string | null;
  trigger: string;
  branch: string | null;
  commit_sha: string | null;
  created_at: string;
  repo: string;
  org_name: string;
  org_id: string;
  age_seconds: number;
}

export interface FinishedScan {
  id: string;
  status: string;
  trigger: string;
  error_message: string | null;
  created_at: string;
  completed_at: string | null;
  duration_seconds: number | null;
  repo: string;
  org_name: string;
}

export interface FailedJob {
  queue: string;
  id: string;
  name: string;
  reason: string | null;
  attempts: number;
  failedAt: string | null;
  data: unknown;
}

export interface Processes {
  queues: QueueCounts[];
  worker: WorkerHeartbeat;
  inFlight: InFlightScan[];
  recent: FinishedScan[];
  failedJobs: FailedJob[];
  throughput: {
    total: number;
    complete: number;
    failed: number;
    avgSeconds: number;
    p95Seconds: number;
  };
}

export interface HealthCheck {
  name: string;
  status: "ok" | "degraded" | "down" | "not_configured";
  detail: string;
  latencyMs?: number;
}

export interface Health {
  checks: HealthCheck[];
  migrations: { applied: string[]; latest: string | null; error: string | null };
  runtime: {
    nodeVersion: string;
    uptimeSeconds: number;
    memoryMb: number;
    pid: number;
    betaUnlimited: boolean;
    retention: { auditLogDays: number; systemEventDays: number };
  };
}

/** Drops empty values so the URL carries only the filters actually in effect. */
export function adminUrl(path: string, params: Record<string, string | number | undefined> = {}) {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value === undefined || value === "" || value === "all") continue;
    search.set(key, String(value));
  }
  const qs = search.toString();
  return `/api/admin${path}${qs ? `?${qs}` : ""}`;
}

export const adminApi = {
  overview: () => api<Overview>(adminUrl("/overview")),
  users: (params: Record<string, string | number | undefined>) =>
    api<Paged<AdminUser>>(adminUrl("/users", params)),
  user: (id: string) => api<AdminUserDetail>(adminUrl(`/users/${id}`)),
  setRole: (id: string, platformRole: "user" | "admin", password: string, reason?: string) =>
    api(adminUrl(`/users/${id}/role`), {
      method: "PATCH",
      body: { platformRole, password, reason },
    }),
  setSuspension: (id: string, suspended: boolean, password: string, reason?: string) =>
    api(adminUrl(`/users/${id}/suspension`), {
      method: "PATCH",
      body: { suspended, password, reason },
    }),
  orgs: (params: Record<string, string | number | undefined>) =>
    api<Paged<AdminOrg>>(adminUrl("/orgs", params)),
  activity: (params: Record<string, string | number | undefined>) =>
    api<Paged<ActivityEntry>>(adminUrl("/activity", params)),
  actions: () => api<{ action: string; count: number }[]>(adminUrl("/activity/actions")),
  events: (params: Record<string, string | number | undefined>) =>
    api<Paged<SystemEvent>>(adminUrl("/events", params)),
  processes: () => api<Processes>(adminUrl("/processes")),
  retryJob: (queue: string, jobId: string) =>
    api(adminUrl(`/processes/jobs/${queue}/${jobId}/retry`), { method: "POST" }),
  health: () => api<Health>(adminUrl("/health")),
};
