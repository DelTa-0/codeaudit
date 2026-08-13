import { useEffect, useMemo, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, ApiError, type GithubRepoOption, type Repo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Input, Badge, EmptyState, Spinner } from "../components/ui";

const ICON_PALETTE = [
  { bg: "bg-primary/15", text: "text-primary" },
  { bg: "bg-blue-500/15", text: "text-blue-500" },
  { bg: "bg-violet-500/15", text: "text-violet-500" },
  { bg: "bg-emerald-500/15", text: "text-emerald-500" },
];

function iconStyleFor(name: string) {
  let hash = 0;
  for (let i = 0; i < name.length; i++) hash = (hash * 31 + name.charCodeAt(i)) >>> 0;
  return ICON_PALETTE[hash % ICON_PALETTE.length];
}

/**
 * Why the GitHub path is not just "log in with GitHub and list their repos":
 * OAuth identifies the user, but reading repositories here runs on a GitHub
 * App *installation* token. Until the App is installed on an account or org
 * there is nothing to list, which is why this distinguishes "App not
 * configured on this deployment" (501) from "no installation linked yet" (404)
 * from "installed, here are the repos".
 */
type GithubState =
  | { kind: "loading" }
  | { kind: "unconfigured" } // no GITHUB_APP_ID on the server
  | { kind: "not-installed"; installUrl: string | null }
  | { kind: "ready"; repos: GithubRepoOption[] };

export function Dashboard() {
  const { orgs } = useAuth();
  const org = orgs[0];
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [github, setGithub] = useState<GithubState>({ kind: "loading" });
  const [filter, setFilter] = useState("");
  const [connecting, setConnecting] = useState<number | null>(null);

  const load = async () => {
    if (!org) return;
    setRepos(await api<Repo[]>(`/api/orgs/${org.id}/repos`));
  };

  const loadGithub = async () => {
    if (!org) return;
    try {
      const list = await api<GithubRepoOption[]>(`/api/orgs/${org.id}/github-repos`);
      setGithub({ kind: "ready", repos: list });
    } catch (err) {
      const status = err instanceof ApiError ? err.status : 0;
      if (status === 501) return setGithub({ kind: "unconfigured" });
      // 404 is the documented "no installation linked to this org" case.
      let installUrl: string | null = null;
      try {
        installUrl = (await api<{ url: string }>("/api/github/install-url")).url;
      } catch {
        // App not configured on this deployment — fall through with no link.
      }
      setGithub({ kind: "not-installed", installUrl });
    }
  };

  useEffect(() => {
    void load().catch(() => setRepos([]));
    void loadGithub();
  }, [org?.id]);

  const connectFromGithub = async (repo: GithubRepoOption) => {
    if (!org) return;
    setError(null);
    setConnecting(repo.githubRepoId);
    try {
      await api(`/api/orgs/${org.id}/github-repos`, {
        method: "POST",
        body: {
          githubRepoId: repo.githubRepoId,
          fullName: repo.fullName,
          private: repo.private,
          defaultBranch: repo.defaultBranch,
        },
      });
      await Promise.all([load(), loadGithub()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect repository");
    } finally {
      setConnecting(null);
    }
  };

  // Already-connected repos must not appear in the picker, or connecting one
  // twice returns a confusing duplicate error.
  const connectedNames = useMemo(
    () => new Set((repos ?? []).map((r) => r.full_name.toLowerCase())),
    [repos],
  );
  const available = useMemo(() => {
    if (github.kind !== "ready") return [];
    const q = filter.trim().toLowerCase();
    return github.repos
      .filter((r) => !connectedNames.has(r.fullName.toLowerCase()))
      .filter((r) => !q || r.fullName.toLowerCase().includes(q));
  }, [github, connectedNames, filter]);

  const connect = async (e: FormEvent) => {
    e.preventDefault();
    if (!org) return;
    setError(null);
    setBusy(true);
    try {
      await api(`/api/orgs/${org.id}/repos`, { method: "POST", body: { url } });
      setUrl("");
      await load();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to connect repository");
    } finally {
      setBusy(false);
    }
  };

  if (!org) return <EmptyState title="No organization" hint="Something went wrong during signup." />;

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Repositories</h1>
        <p className="mt-1 text-sm text-muted">
          Pick a repository to scan for hallucinated dependencies, leaked secrets, poisoned agent
          configs and zombie code.
        </p>
      </div>

      {github.kind === "loading" && (
        <Card>
          <div className="flex items-center gap-3 text-sm text-muted">
            <Spinner />
            Checking your GitHub App installation…
          </div>
        </Card>
      )}

      {github.kind === "not-installed" && (
        <Card>
          <h2 className="text-sm font-semibold">Connect your GitHub account</h2>
          <p className="mt-1 text-sm text-muted">
            Install the GitHub App to pick repositories from a list — including private ones — and
            to get PR comments and merge gates. You choose exactly which repositories it can see.
          </p>
          {github.installUrl && (
            <a
              href={github.installUrl}
              target="_blank"
              rel="noreferrer"
              className="mt-3 inline-flex cursor-pointer items-center justify-center gap-2 rounded-full bg-ink px-4 py-3 text-sm font-medium text-ink-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:py-2.5"
            >
              Install the GitHub App
            </a>
          )}
        </Card>
      )}

      {github.kind === "ready" && (
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-3">
            <h2 className="text-sm font-semibold">
              From GitHub
              <span className="ml-2 font-normal text-muted">
                {available.length} available
              </span>
            </h2>
            {github.repos.length > 6 && (
              <Input
                placeholder="Filter repositories…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full sm:w-64"
                aria-label="Filter repositories"
              />
            )}
          </div>

          {available.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              {github.repos.length === 0
                ? "The App is installed but has no repositories selected yet. Grant it access to a repository on GitHub, then reload."
                : filter
                  ? "No repositories match that filter."
                  : "Every repository the App can see is already connected."}
            </p>
          ) : (
            <ul className="mt-3 divide-y divide-border">
              {available.map((r) => (
                <li key={r.githubRepoId} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate font-mono text-sm">{r.fullName}</div>
                    <div className="mt-0.5 flex items-center gap-2">
                      <Badge label={r.private ? "Private" : "Public"} />
                      <span className="text-xs text-muted">{r.defaultBranch}</span>
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    onClick={() => void connectFromGithub(r)}
                    disabled={connecting !== null}
                  >
                    {connecting === r.githubRepoId ? "Connecting…" : "Connect"}
                  </Button>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}

      {/* Kept as a secondary path: it is the only way to scan a public repo in
          an org where the user cannot install the App. Repos connected this way
          may have no installation behind them, so PR comments can silently do
          nothing — the picker above is the path that always works. */}
      <Card>
        <h2 className="text-sm font-semibold">
          {github.kind === "ready" ? "Or paste a public repo URL" : "Scan a public repository"}
        </h2>
        <form onSubmit={connect} className="mt-3 flex flex-col gap-3 sm:flex-row">
          <Input
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy} className="sm:w-auto">
            {busy ? "Connecting…" : "Connect repo"}
          </Button>
        </form>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </Card>

      {repos === null ? (
        <div className="flex justify-center py-12">
          <Spinner />
        </div>
      ) : repos.length === 0 ? (
        <EmptyState title="No repositories yet" hint="Connect your first repo above to get started." />
      ) : (
        <div className="grid gap-4 sm:grid-cols-2">
          {repos.map((repo) => {
            const icon = iconStyleFor(repo.full_name);
            return (
              <Link
                key={repo.id}
                to={`/repos/${repo.id}`}
                className="rounded-2xl focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <Card className="cursor-pointer transition-shadow hover:shadow-md">
                  <div className="flex items-start gap-3">
                    <div
                      className={`flex h-11 w-11 shrink-0 items-center justify-center rounded-xl font-mono text-sm font-bold ${icon.bg} ${icon.text}`}
                    >
                      {repo.full_name.replace(/^.*\//, "").charAt(0).toUpperCase()}
                    </div>
                    <div className="min-w-0 flex-1">
                      <p className="truncate font-mono text-sm font-medium">{repo.full_name}</p>
                      <p className="mt-1 text-xs text-muted">
                        {repo.last_scan_at
                          ? `Last scan ${new Date(repo.last_scan_at).toLocaleString()}`
                          : "Never scanned"}
                      </p>
                      {repo.last_scan_status && (
                        <div className="mt-2">
                          <Badge label={repo.last_scan_status} />
                        </div>
                      )}
                    </div>
                    <p className="font-mono text-2xl font-bold">{repo.latest_score ?? "—"}</p>
                  </div>
                </Card>
              </Link>
            );
          })}
        </div>
      )}
    </div>
  );
}
