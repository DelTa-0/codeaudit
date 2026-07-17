import { useEffect, useState, type FormEvent } from "react";
import { Link } from "react-router-dom";
import { api, type Repo } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Input, Badge, EmptyState, Spinner } from "../components/ui";

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
        <h1 className="text-xl font-semibold">Repositories</h1>
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
          {repos.map((repo) => (
            <Link key={repo.id} to={`/repos/${repo.id}`}>
              <Card className="transition-colors hover:border-primary/50">
                <div className="flex items-start justify-between">
                  <div>
                    <p className="font-mono text-sm font-medium">{repo.full_name}</p>
                    <p className="mt-1 text-xs text-muted">
                      {repo.last_scan_at
                        ? `Last scan ${new Date(repo.last_scan_at).toLocaleString()}`
                        : "Never scanned"}
                    </p>
                  </div>
                  <div className="text-right">
                    <p className="font-mono text-2xl font-bold">
                      {repo.latest_score ?? "—"}
                    </p>
                    {repo.last_scan_status && <Badge label={repo.last_scan_status} />}
                  </div>
                </div>
              </Card>
            </Link>
          ))}
        </div>
      )}
    </div>
  );
}
