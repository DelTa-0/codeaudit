import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { api, type Repo, type Scan } from "../lib/api";
import { Button, Card, Badge, EmptyState, Spinner, ScoreRing } from "../components/ui";

export function RepoDetail() {
  const { repoId } = useParams();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => {
    const [r, s] = await Promise.all([
      api<Repo>(`/api/repos/${repoId}`),
      api<Scan[]>(`/api/repos/${repoId}/scans`),
    ]);
    setRepo(r);
    setScans(s);
  };

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [repoId]);

  const startScan = async () => {
    setError(null);
    try {
      const scan = await api<{ id: string }>(`/api/repos/${repoId}/scans`, { method: "POST" });
      navigate(`/scans/${scan.id}`);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to start scan");
    }
  };

  if (error && !repo) return <EmptyState title="Repository unavailable" hint={error} />;
  if (!repo || !scans)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  const trendData = (repo.trend ?? [])
    .filter((t) => t.score !== null)
    .map((t) => ({ date: new Date(t.created_at).toLocaleDateString(), score: Number(t.score) }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="font-mono text-xl font-semibold">{repo.full_name}</h1>
          <p className="mt-1 text-sm text-muted">Default branch: {repo.default_branch}</p>
        </div>
        <div className="flex items-center gap-4">
          <ScoreRing score={repo.latest_score !== null ? Number(repo.latest_score) : null} size={72} />
          <div className="flex flex-col gap-2">
            <Button onClick={startScan}>Scan now</Button>
            <Button
              variant="ghost"
              onClick={async () => {
                setError(null);
                try {
                  await api(`/api/repos/${repoId}/webhook`, {
                    method: "PATCH",
                    body: { enabled: !repo.webhook_enabled },
                  });
                  await load();
                } catch (err) {
                  setError(err instanceof Error ? err.message : "Failed to toggle webhook");
                }
              }}
            >
              {repo.webhook_enabled ? "Disable auto-scan" : "Enable auto-scan"}
            </Button>
          </div>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      {trendData.length >= 2 && (
        <Card>
          <p className="mb-3 text-sm font-medium text-muted">Score trend</p>
          <div className="h-40">
            <ResponsiveContainer>
              <LineChart data={trendData}>
                <XAxis dataKey="date" stroke="var(--color-muted)" fontSize={11} />
                <YAxis domain={[0, 100]} stroke="var(--color-muted)" fontSize={11} width={30} />
                <Tooltip
                  contentStyle={{
                    background: "var(--color-surface-2)",
                    border: "1px solid var(--color-border)",
                    borderRadius: 8,
                  }}
                />
                <Line type="monotone" dataKey="score" stroke="var(--color-primary)" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </Card>
      )}

      <Card>
        <p className="mb-3 text-sm font-medium text-muted">Scan history</p>
        {scans.length === 0 ? (
          <EmptyState title="No scans yet" hint='Click "Scan now" to run the first audit.' />
        ) : (
          <div className="divide-y divide-border">
            {scans.map((scan) => (
              <Link
                key={scan.id}
                to={`/scans/${scan.id}`}
                className="flex items-center justify-between py-3 hover:bg-surface-2/50"
              >
                <div className="flex items-center gap-3">
                  <Badge label={scan.status} />
                  <span className="text-sm text-muted">
                    {new Date(scan.created_at).toLocaleString()} · {scan.trigger}
                  </span>
                </div>
                <span className="font-mono text-sm">
                  {scan.summary ? `${scan.summary.score} (${scan.summary.grade})` : scan.progress ?? ""}
                </span>
              </Link>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
