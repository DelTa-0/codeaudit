import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Repo } from "../lib/api";
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

export function Dashboard() {
  const { orgs } = useAuth();
  const org = orgs[0];
  const [repos, setRepos] = useState<Repo[] | null>(null);
  const [url, setUrl] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const load = async () => {
    if (!org) return;
    setRepos(await api<Repo[]>(`/api/orgs/${org.id}/repos`));
  };

  useEffect(() => {
    void load().catch(() => setRepos([]));
  }, [org?.id]);

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
          Connect a public GitHub repository and scan it for phantom dependencies, unused packages
          and zombie code.
        </p>
      </div>

      <Card>
        <form onSubmit={connect} className="flex gap-3">
          <Input
            placeholder="https://github.com/owner/repo"
            value={url}
            onChange={(e) => setUrl(e.target.value)}
            required
          />
          <Button type="submit" disabled={busy}>
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
