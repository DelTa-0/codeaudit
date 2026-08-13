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
interface ClaimableInstallation {
  installationId: number;
  accountLogin: string | null;
  repositorySelection: string | null;
}

type GithubState =
  | { kind: "loading" }
  | { kind: "unconfigured" } // no GITHUB_APP_ID on the server
  | { kind: "not-installed"; installUrl: string | null; claimable: ClaimableInstallation[] }
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
  // null = follow the default (open only when the list is short enough to be
  // worth showing outright); a boolean once the user has expressed a choice.
  const [pickerOpen, setPickerOpen] = useState<boolean | null>(null);

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
      // An App installed straight from GitHub — or installed before this flow
      // existed — leaves an installation nobody has claimed. Offer it instead
      // of telling someone to install what they already installed.
      let claimable: ClaimableInstallation[] = [];
      try {
        claimable = await api<ClaimableInstallation[]>(
          `/api/orgs/${org.id}/claimable-installations`,
        );
      } catch {
        // Older server, or no linked GitHub identity — just offer the install.
      }
      setGithub({ kind: "not-installed", installUrl, claimable });
    }
  };

  const claimInstallation = async (installationId: number) => {
    if (!org) return;
    setError(null);
    setConnecting(installationId);
    try {
      await api(`/api/orgs/${org.id}/installations`, {
        method: "POST",
        body: { installationId },
      });
      await Promise.all([load(), loadGithub()]);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not link that installation");
    } finally {
      setConnecting(null);
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

  // Unconnected repos, ignoring the filter — the honest total for the header,
  // so collapsing does not appear to change how many repositories you have.
  const totalAvailable = useMemo(() => {
    if (github.kind !== "ready") return 0;
    return github.repos.filter((r) => !connectedNames.has(r.fullName.toLowerCase())).length;
  }, [github, connectedNames]);

  // Short lists are more useful open than folded; long ones would push the
  // repositories you already connected off the screen entirely.
  const AUTO_OPEN_LIMIT = 6;
  const isPickerOpen = pickerOpen ?? totalAvailable <= AUTO_OPEN_LIMIT;

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

      {github.kind === "not-installed" && github.claimable.length > 0 && (
        <Card>
          <h2 className="text-sm font-semibold">Finish connecting GitHub</h2>
          <p className="mt-1 text-sm text-muted">
            The App is already installed on your GitHub account — it just isn't linked to this
            workspace yet. Link it and your repositories appear below.
          </p>
          <ul className="mt-3 divide-y divide-border">
            {github.claimable.map((i) => (
              <li key={i.installationId} className="flex items-center gap-3 py-2.5">
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-sm">@{i.accountLogin ?? "your account"}</div>
                  <div className="mt-0.5 text-xs text-muted">
                    {i.repositorySelection === "all"
                      ? "All repositories"
                      : "Selected repositories only"}
                  </div>
                </div>
                <Button
                  onClick={() => void claimInstallation(i.installationId)}
                  disabled={connecting !== null}
                >
                  {connecting === i.installationId ? "Linking…" : "Link"}
                </Button>
              </li>
            ))}
          </ul>
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </Card>
      )}

      {github.kind === "not-installed" && github.claimable.length === 0 && (
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
            <button
              type="button"
              onClick={() => setPickerOpen(!isPickerOpen)}
              aria-expanded={isPickerOpen}
              aria-controls="github-repo-picker"
              // Negative margins cancel the padding so the extra tap area does
              // not shift the header; py-3 takes it to 44px on touch screens.
              className="-mx-2 -my-3 flex cursor-pointer items-center gap-2 rounded-lg px-2 py-3 text-sm font-semibold transition-colors hover:bg-surface-2 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:-my-2 sm:py-2"
            >
              <svg
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
                className={`shrink-0 text-muted transition-transform duration-200 ${isPickerOpen ? "rotate-90" : ""}`}
              >
                <path d="m9 18 6-6-6-6" />
              </svg>
              From GitHub
              <span className="font-normal text-muted">
                {totalAvailable} available
              </span>
            </button>
            {isPickerOpen && github.repos.length > AUTO_OPEN_LIMIT && (
              <Input
                placeholder="Filter repositories…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
                className="w-full sm:w-64"
                aria-label="Filter repositories"
              />
            )}
          </div>

          {!isPickerOpen ? null : available.length === 0 ? (
            <p className="mt-3 text-sm text-muted">
              {github.repos.length === 0
                ? "The App is installed but has no repositories selected yet. Grant it access to a repository on GitHub, then reload."
                : filter
                  ? "No repositories match that filter."
                  : "Every repository the App can see is already connected."}
            </p>
          ) : (
            // Capped so a long list scrolls within the card instead of pushing
            // the repositories you already connected off the page.
            <ul
              id="github-repo-picker"
              className="mt-3 max-h-80 divide-y divide-border overflow-y-auto"
            >
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
