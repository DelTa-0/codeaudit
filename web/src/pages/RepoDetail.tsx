import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer } from "recharts";
import { api, type Repo, type Scan, type LifecycleFinding } from "../lib/api";
import { Button, Card, Badge, EmptyState, Spinner, ScoreRing } from "../components/ui";

export function RepoDetail() {
  const { repoId } = useParams();
  const navigate = useNavigate();
  const [repo, setRepo] = useState<Repo | null>(null);
  const [scans, setScans] = useState<Scan[] | null>(null);
  const [findings, setFindings] = useState<LifecycleFinding[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [busyFinding, setBusyFinding] = useState<string | null>(null);
  const [showResolved, setShowResolved] = useState(false);

  const load = async () => {
    const [r, s, f] = await Promise.all([
      api<Repo>(`/api/repos/${repoId}`),
      api<Scan[]>(`/api/repos/${repoId}/scans`),
      // Older accounts may hit a server predating this endpoint — the card
      // simply stays empty rather than failing the whole page.
      api<LifecycleFinding[]>(`/api/repos/${repoId}/findings`).catch(() => []),
    ]);
    setRepo(r);
    setScans(s);
    setFindings(f);
  };

  const setFindingState = async (id: string, state: "open" | "ignored") => {
    setBusyFinding(id);
    try {
      const updated = await api<LifecycleFinding>(`/api/repos/${repoId}/findings/${id}`, {
        method: "PATCH",
        body: { state },
      });
      setFindings((prev) => prev.map((f) => (f.id === id ? updated : f)));
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not update the finding");
    } finally {
      setBusyFinding(null);
    }
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
          <h1 className="font-mono text-2xl font-semibold tracking-tight">{repo.full_name}</h1>
          <p className="mt-1 text-sm text-muted">Default branch: {repo.default_branch}</p>
        </div>
        <div className="flex items-center gap-4">
          <ScoreRing score={repo.latest_score !== null ? Number(repo.latest_score) : null} size={72} />
          <Button onClick={startScan}>Scan now</Button>
        </div>
      </div>
      {error && <p className="text-sm text-danger">{error}</p>}

      <RepoSettings repo={repo} onChanged={load} onError={setError} />

      {findings.length > 0 && (
        <Card>
          <div className="flex flex-wrap items-baseline justify-between gap-2">
            <p className="text-sm font-medium text-muted">Findings across scans</p>
            <button
              type="button"
              onClick={() => setShowResolved((v) => !v)}
              className="cursor-pointer text-xs text-muted underline underline-offset-2 hover:text-foreground"
            >
              {showResolved ? "Hide" : "Show"} fixed & ignored
            </button>
          </div>
          {/* Ignore exists because a false positive with no dismiss button
              costs the product its credibility on the second scan. An ignored
              finding never reopens by itself — scans record sightings but
              leave the state alone. */}
          <ul className="mt-3 divide-y divide-border">
            {findings
              .filter((f) => (showResolved ? true : f.state === "open"))
              .slice(0, 30)
              .map((f) => (
                <li key={f.id} className="flex items-center gap-3 py-2.5">
                  <div className="min-w-0 flex-1">
                    <div className="flex flex-wrap items-center gap-2">
                      <span className="truncate text-sm font-medium">{f.title}</span>
                      <Badge label={f.state === "open" ? f.kind.replace("_", " ") : f.state} />
                      {f.times_reintroduced > 0 && (
                        <span className="text-xs text-warning">
                          came back ×{f.times_reintroduced}
                        </span>
                      )}
                    </div>
                    <p className="mt-0.5 text-xs text-muted">
                      First seen {new Date(f.first_detected_at).toLocaleDateString()} · last seen{" "}
                      {new Date(f.last_seen_at).toLocaleDateString()}
                      {f.note ? ` · ${f.note}` : ""}
                    </p>
                  </div>
                  {f.state === "open" && (
                    <Button
                      variant="ghost"
                      onClick={() => void setFindingState(f.id, "ignored")}
                      disabled={busyFinding !== null}
                    >
                      {busyFinding === f.id ? "…" : "Ignore"}
                    </Button>
                  )}
                  {f.state === "ignored" && (
                    <Button
                      variant="ghost"
                      onClick={() => void setFindingState(f.id, "open")}
                      disabled={busyFinding !== null}
                    >
                      {busyFinding === f.id ? "…" : "Restore"}
                    </Button>
                  )}
                </li>
              ))}
          </ul>
        </Card>
      )}

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
                className="flex items-center justify-between rounded-md px-2 py-3 transition-colors hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              >
                <div className="flex items-center gap-3">
                  <Badge label={scan.status} />
                  <span className="text-sm text-muted">
                    {new Date(scan.created_at).toLocaleString()} · {scan.trigger}
                  </span>
                </div>
                <span className="flex items-center gap-2 font-mono text-sm">
                  {scan.summary?.reviewStatus && scan.summary.reviewStatus !== "full" && (
                    <span
                      className="rounded border border-warning/40 px-1.5 py-0.5 font-sans text-[10px] uppercase tracking-wide text-warning"
                      title="Dead-code findings are unfiltered static candidates — no LLM verdict was run, so this score is noisier than an LLM-verified scan."
                    >
                      static-only
                    </span>
                  )}
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

function SettingRow({
  title,
  description,
  children,
}: {
  title: string;
  description: string;
  children: React.ReactNode;
}) {
  return (
    <div className="flex items-center justify-between gap-4 py-3">
      <div>
        <p className="text-sm font-medium">{title}</p>
        <p className="text-xs text-muted">{description}</p>
      </div>
      <div className="flex shrink-0 items-center gap-2">{children}</div>
    </div>
  );
}

/**
 * Every automated behavior is opt-in and clearly described — nothing acts on
 * the repo unless its owner turned it on here.
 */
function RepoSettings({
  repo,
  onChanged,
  onError,
}: {
  repo: Repo;
  onChanged: () => Promise<void>;
  onError: (msg: string | null) => void;
}) {
  const [minScore, setMinScore] = useState(repo.min_score ? String(Number(repo.min_score)) : "");
  const [badgeMarkdown, setBadgeMarkdown] = useState<string | null>(null);
  const [cliUsage, setCliUsage] = useState<string | null>(null);

  const call = async (fn: () => Promise<unknown>) => {
    onError(null);
    try {
      await fn();
      await onChanged();
    } catch (err) {
      onError(err instanceof Error ? err.message : "Request failed");
    }
  };

  return (
    <Card>
      <p className="mb-1 text-sm font-medium text-muted">Repository settings</p>
      <p className="mb-2 text-xs text-muted">
        All automations are off by default and only report or propose — merging and blocking
        decisions always stay with you.
      </p>
      <div className="divide-y divide-border">
        <SettingRow
          title="Auto-scan on push & PR"
          description="GitHub webhooks trigger a scan on every push and pull request."
        >
          <Button
            variant="ghost"
            onClick={() =>
              call(() =>
                api(`/api/repos/${repo.id}/webhook`, {
                  method: "PATCH",
                  body: { enabled: !repo.webhook_enabled },
                }),
              )
            }
          >
            {repo.webhook_enabled ? "On — turn off" : "Off — turn on"}
          </Button>
        </SettingRow>

        <SettingRow
          title="Merge gate check"
          description="Posts a pass/fail GitHub check against your score threshold. Whether it blocks merges is up to your branch-protection rules."
        >
          {repo.gate_enabled && (
            <input
              className="w-16 rounded-lg border border-border bg-surface-2 px-2 py-1 text-sm focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              type="number"
              min={0}
              max={100}
              placeholder="min"
              value={minScore}
              onChange={(e) => setMinScore(e.target.value)}
              onBlur={() =>
                call(() =>
                  api(`/api/repos/${repo.id}/gate`, {
                    method: "PATCH",
                    body: { enabled: true, minScore: minScore === "" ? null : Number(minScore) },
                  }),
                )
              }
            />
          )}
          <Button
            variant="ghost"
            onClick={() =>
              call(() =>
                api(`/api/repos/${repo.id}/gate`, {
                  method: "PATCH",
                  body: {
                    enabled: !repo.gate_enabled,
                    minScore: minScore === "" ? null : Number(minScore),
                  },
                }),
              )
            }
          >
            {repo.gate_enabled ? "On — turn off" : "Off — turn on"}
          </Button>
        </SettingRow>

        <SettingRow
          title="Auto-fix PRs"
          description="Allows admins to request a PR removing unused dependencies from a scan report. PRs are only ever proposed — you review and merge."
        >
          <Button
            variant="ghost"
            onClick={() =>
              call(() =>
                api(`/api/repos/${repo.id}/autofix`, {
                  method: "PATCH",
                  body: { enabled: !repo.autofix_enabled },
                }),
              )
            }
          >
            {repo.autofix_enabled ? "On — turn off" : "Off — turn on"}
          </Button>
        </SettingRow>

        <SettingRow
          title="CLI / CI uploads"
          description="Per-repo token letting `npx codeorion scan --upload` report results into this dashboard from any machine or CI."
        >
          <Button
            variant="ghost"
            onClick={async () => {
              onError(null);
              try {
                const data = await api<{ usage: string }>(`/api/repos/${repo.id}/cli-token`, {
                  method: "POST",
                });
                setCliUsage(data.usage);
              } catch (err) {
                onError(err instanceof Error ? err.message : "Request failed");
              }
            }}
          >
            Get token
          </Button>
        </SettingRow>

        <SettingRow
          title="README badge"
          description="Public SVG badge showing the latest score — safe to embed anywhere."
        >
          <Button
            variant="ghost"
            onClick={async () => {
              onError(null);
              try {
                const data = await api<{ markdown: string }>(`/api/repos/${repo.id}/badge`, {
                  method: "POST",
                });
                setBadgeMarkdown(data.markdown);
              } catch (err) {
                onError(err instanceof Error ? err.message : "Request failed");
              }
            }}
          >
            Get badge
          </Button>
        </SettingRow>
      </div>
      {badgeMarkdown && (
        <div className="mt-2 rounded-lg bg-surface-2 p-3">
          <p className="mb-1 text-xs text-muted">Paste into your README:</p>
          <code className="block break-all font-mono text-xs">{badgeMarkdown}</code>
        </div>
      )}
      {cliUsage && (
        <div className="mt-2 rounded-lg bg-surface-2 p-3">
          <p className="mb-1 text-xs text-muted">
            Run locally or add to CI (keep the token secret — treat it like a password):
          </p>
          <code className="block break-all font-mono text-xs">{cliUsage}</code>
        </div>
      )}
    </Card>
  );
}
