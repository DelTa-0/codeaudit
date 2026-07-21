import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import {
  api,
  type Scan,
  type Repo,
  type DependencyFinding,
  type CodeFinding,
} from "../lib/api";
import { Button, Card, Badge, EmptyState, Spinner, ScoreRing } from "../components/ui";

const STEPS = ["pending", "cloning", "analyzing", "complete"] as const;

function StatusStepper({ status, progress }: { status: string; progress: string | null }) {
  const idx = status === "failed" ? -1 : STEPS.indexOf(status as (typeof STEPS)[number]);
  return (
    <div>
      <div className="flex items-center gap-2">
        {["Queued", "Cloning", "Analyzing", "Complete"].map((label, i) => (
          <div key={label} className="flex flex-1 items-center gap-2">
            <div
              className={`flex h-7 w-7 shrink-0 items-center justify-center rounded-full border text-xs font-semibold ${
                i < idx || status === "complete"
                  ? "border-success bg-success/15 text-success"
                  : i === idx
                    ? "border-primary bg-primary/15 text-primary"
                    : "border-border text-muted"
              }`}
            >
              {i < idx || status === "complete" ? "✓" : i + 1}
            </div>
            <span className={`text-xs ${i <= idx ? "text-foreground" : "text-muted"}`}>{label}</span>
            {i < 3 && <div className="h-px flex-1 bg-border" />}
          </div>
        ))}
      </div>
      {status !== "complete" && status !== "failed" && progress && (
        <p className="mt-3 flex items-center gap-2 text-sm text-muted">
          <Spinner /> {progress}…
        </p>
      )}
    </div>
  );
}

function ConfidenceBar({ value }: { value: number }) {
  const color =
    value >= 0.8 ? "var(--color-danger)" : value >= 0.5 ? "var(--color-warning)" : "var(--color-muted)";
  return (
    <div className="flex items-center gap-2">
      <div className="h-1.5 w-20 overflow-hidden rounded-full bg-border">
        <div className="h-full rounded-full" style={{ width: `${value * 100}%`, background: color }} />
      </div>
      <span className="font-mono text-xs text-muted">{Math.round(value * 100)}%</span>
    </div>
  );
}

export function ScanDetail() {
  const { scanId } = useParams();
  const [scan, setScan] = useState<Scan | null>(null);
  const [deps, setDeps] = useState<DependencyFinding[] | null>(null);
  const [codeFindings, setCodeFindings] = useState<CodeFinding[] | null>(null);
  const [expanded, setExpanded] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [repo, setRepo] = useState<Repo | null>(null);
  const [autofixMessage, setAutofixMessage] = useState<string | null>(null);

  useEffect(() => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const poll = async () => {
      try {
        const s = await api<Scan>(`/api/scans/${scanId}`);
        if (stopped) return;
        setScan(s);
        if (s.status === "complete") {
          const [d, c, r] = await Promise.all([
            api<DependencyFinding[]>(`/api/scans/${scanId}/dependencies?per_page=100`),
            api<CodeFinding[]>(`/api/scans/${scanId}/code-findings?per_page=100`),
            s.repo_id ? api<Repo>(`/api/repos/${s.repo_id}`).catch(() => null) : Promise.resolve(null),
          ]);
          if (!stopped) {
            setDeps(d);
            setCodeFindings(c);
            setRepo(r);
          }
        } else if (s.status !== "failed") {
          timer = setTimeout(poll, 2000);
        }
      } catch (err) {
        if (!stopped) setError(err instanceof Error ? err.message : "Failed to load scan");
      }
    };

    void poll();
    return () => {
      stopped = true;
      if (timer) clearTimeout(timer);
    };
  }, [scanId]);

  if (error) return <EmptyState title="Scan unavailable" hint={error} />;
  if (!scan)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold tracking-tight">Scan report</h1>

      <Card>
        <StatusStepper status={scan.status} progress={scan.progress} />
        {scan.status === "failed" && (
          <p className="mt-3 text-sm text-danger">
            Scan failed: {scan.error_message ?? "unknown error"}
          </p>
        )}
      </Card>

      {scan.summary && (
        <Card className="flex items-center gap-6">
          <ScoreRing score={scan.summary.score} />
          <div className="flex-1">
            {scan.summary.reviewStatus && scan.summary.reviewStatus !== "full" && (
              <p className="mb-3 rounded-lg bg-warning/10 px-3 py-2 text-xs text-warning">
                Static-only score — dead-code findings weren't verified by the LLM, so this score
                is noisier than an LLM-verified scan.
                {scan.summary.reviewStatus === "skipped"
                  ? " Typical of CLI uploads run without a hosted scan."
                  : " Some findings' LLM batch failed and fell back to unfiltered candidates."}
              </p>
            )}
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
            {(
              [
                ["Phantom", scan.summary.counts.phantom, "text-danger"],
                ["Vulnerable", scan.summary.counts.vulnerable ?? 0, "text-danger"],
                ["Suspicious", scan.summary.counts.suspicious, "text-warning"],
                ["Unused", scan.summary.counts.unused, "text-warning"],
                ["Zombies", scan.summary.counts.zombies, "text-primary"],
                ["Files", scan.summary.counts.filesAnalyzed, "text-muted"],
              ] as const
            ).map(([label, value, color]) => (
              <div key={label}>
                <p className={`font-mono text-xl font-bold ${color}`}>{value}</p>
                <p className="text-xs text-muted">{label}</p>
              </div>
            ))}
            </div>
          </div>
        </Card>
      )}

      {scan.summary?.ai && scan.summary.ai.totalCommits > 0 && (
        <Card>
          <p className="mb-3 text-sm font-medium text-muted">AI-assisted code</p>
          <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
            <div>
              <p className="font-mono text-xl font-bold text-primary">
                {Math.round(scan.summary.ai.shareOfFiles * 100)}%
              </p>
              <p className="text-xs text-muted">of files AI-touched</p>
            </div>
            <div>
              <p className="font-mono text-xl font-bold">
                {scan.summary.ai.aiCommits}/{scan.summary.ai.totalCommits}
              </p>
              <p className="text-xs text-muted">AI-assisted commits</p>
            </div>
            <div>
              <p className="font-mono text-xl font-bold text-warning">
                {scan.summary.ai.aiFindingDensity}
              </p>
              <p className="text-xs text-muted">findings /100 AI files</p>
            </div>
            <div>
              <p className="font-mono text-xl font-bold text-success">
                {scan.summary.ai.humanFindingDensity}
              </p>
              <p className="text-xs text-muted">findings /100 human files</p>
            </div>
          </div>
          <p className="mt-2 text-xs text-muted">
            Attribution heuristic: Co-Authored-By trailers and bot authors in the last 100
            commits. Advisory only.
          </p>
        </Card>
      )}

      {scan.summary?.ai?.hotspots && scan.summary.ai.hotspots.length > 0 && (
        <Card>
          <p className="mb-1 text-sm font-medium text-muted">Hotspots</p>
          <p className="mb-3 text-xs text-muted">
            Files ranked by change frequency × size — where technical debt costs the most.
            Flagged when they also carry a finding.
          </p>
          <div className="divide-y divide-border">
            {scan.summary.ai.hotspots.map((h) => (
              <div key={h.path} className="flex items-center gap-3 py-2">
                <div className="h-1.5 w-24 shrink-0 overflow-hidden rounded-full bg-border">
                  <div
                    className="h-full rounded-full bg-primary"
                    style={{ width: `${Math.max(4, h.score * 100)}%` }}
                  />
                </div>
                <span className="flex-1 truncate font-mono text-xs" title={h.path}>
                  {h.path}
                </span>
                {h.hasFinding && <Badge label="flagged" />}
                <Badge label={h.ai ? "AI" : "human"} />
                <span className="shrink-0 font-mono text-xs text-muted">
                  {h.commits} commits · {h.lines} lines
                </span>
              </div>
            ))}
          </div>
        </Card>
      )}

      {scan.status === "complete" &&
        repo?.autofix_enabled &&
        repo?.installation_id &&
        (scan.summary?.counts.unused ?? 0) > 0 && (
          <Card className="flex items-center justify-between gap-4">
            <div>
              <p className="text-sm font-medium">
                {scan.summary!.counts.unused} unused{" "}
                {scan.summary!.counts.unused === 1 ? "dependency" : "dependencies"} can be removed
              </p>
              <p className="text-xs text-muted">
                Opens a pull request for review — nothing is merged without you.
              </p>
            </div>
            <Button
              onClick={async () => {
                setAutofixMessage(null);
                try {
                  const res = await api<{ message: string }>(`/api/scans/${scan.id}/autofix`, {
                    method: "POST",
                  });
                  setAutofixMessage(res.message);
                } catch (err) {
                  setAutofixMessage(err instanceof Error ? err.message : "Request failed");
                }
              }}
            >
              Create fix PR
            </Button>
          </Card>
        )}
      {autofixMessage && <p className="text-sm text-muted">{autofixMessage}</p>}

      {deps && (() => {
        const vulnerable = deps.filter(
          (d) => (d.registry_metadata?.vulnerabilities?.length ?? 0) > 0,
        );
        if (vulnerable.length === 0) return null;
        const sevColor: Record<string, string> = {
          critical: "text-danger",
          high: "text-danger",
          medium: "text-warning",
          low: "text-muted",
          unknown: "text-muted",
        };
        return (
          <Card>
            <p className="mb-3 text-sm font-medium text-muted">
              Known vulnerabilities ({vulnerable.length})
            </p>
            <div className="divide-y divide-border">
              {vulnerable.map((d) => (
                <div key={d.id} className="py-3">
                  <div className="flex items-center gap-2">
                    <span className="font-mono text-sm">{d.package_name}</span>
                    <span className="text-xs text-muted">{d.declared_version ?? ""}</span>
                    <span
                      className={`text-xs font-semibold uppercase ${sevColor[d.registry_metadata?.maxSeverity ?? "unknown"] ?? "text-muted"}`}
                    >
                      {d.registry_metadata?.maxSeverity ?? "unknown"}
                    </span>
                  </div>
                  <ul className="mt-2 space-y-1">
                    {d.registry_metadata!.vulnerabilities!.map((v) => (
                      <li key={v.id} className="text-xs text-muted">
                        <a
                          href={v.url}
                          target="_blank"
                          rel="noreferrer noopener"
                          className={`font-mono ${sevColor[v.severity] ?? "text-muted"} hover:underline`}
                        >
                          {v.id}
                        </a>
                        {v.aliases.length > 0 && (
                          <span className="ml-1 text-muted">({v.aliases.join(", ")})</span>
                        )}
                        {v.summary && <span className="ml-2">{v.summary}</span>}
                      </li>
                    ))}
                  </ul>
                </div>
              ))}
            </div>
          </Card>
        );
      })()}

      {deps && (
        <Card>
          <p className="mb-3 text-sm font-medium text-muted">Dependencies ({deps.length})</p>
          {deps.length === 0 ? (
            <EmptyState
              title="No dependencies found"
              hint="The repo may not have a package.json, requirements.txt, or pyproject.toml."
            />
          ) : (
            (() => {
              const polyglot = new Set(deps.map((d) => d.ecosystem)).size > 1;
              return (
                <table className="w-full text-sm">
                  <thead>
                    <tr className="border-b border-border text-left text-xs text-muted">
                      <th className="pb-2 font-medium">Package</th>
                      {polyglot && <th className="pb-2 font-medium">Ecosystem</th>}
                      <th className="pb-2 font-medium">Version</th>
                      <th className="pb-2 font-medium">Status</th>
                      <th className="pb-2 font-medium">Downloads</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-border">
                    {deps.map((d) => (
                      <tr key={d.id}>
                        <td className="py-2 font-mono">
                          {d.package_name}
                          {d.registry_metadata?.typosquatOf && (
                            <span className="ml-2 font-sans text-xs text-warning">
                              looks like <span className="font-mono">{d.registry_metadata.typosquatOf}</span> — possible slopsquat
                            </span>
                          )}
                          {d.registry_metadata?.transitive && (
                            <span className="ml-2 font-sans text-xs text-muted">(transitive)</span>
                          )}
                        </td>
                        {polyglot && (
                          <td className="py-2">
                            <Badge label={d.ecosystem} />
                          </td>
                        )}
                        <td className="py-2 font-mono text-muted">{d.declared_version ?? "—"}</td>
                        <td className="py-2">
                          <Badge label={d.status} />
                        </td>
                        <td className="py-2 font-mono text-muted">
                          {d.registry_metadata?.weeklyDownloads?.toLocaleString() ?? "—"}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              );
            })()
          )}
        </Card>
      )}

      {codeFindings && (
        <Card>
          <p className="mb-3 text-sm font-medium text-muted">
            Zombie code findings ({codeFindings.length})
          </p>
          {codeFindings.length === 0 ? (
            <EmptyState title="No zombie code detected" />
          ) : (
            <div className="divide-y divide-border">
              {codeFindings.map((f) => (
                <div key={f.id} className="py-1">
                  <button
                    className="flex w-full cursor-pointer items-center justify-between rounded-md px-2 py-2 text-left transition-colors hover:bg-surface-2/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    onClick={() => setExpanded(expanded === f.id ? null : f.id)}
                  >
                    <div>
                      <span className="font-mono text-sm">{f.symbol_name ?? "(anonymous)"}</span>
                      <span className="ml-2 text-xs text-muted">
                        {f.file_path}
                        {f.line_start ? `:${f.line_start}` : ""}
                      </span>
                    </div>
                    <div className="flex items-center gap-3">
                      <Badge label={f.finding_type.replace("dead_", "dead ")} />
                      {f.confidence_score !== null && (
                        <ConfidenceBar value={Number(f.confidence_score)} />
                      )}
                    </div>
                  </button>
                  {expanded === f.id && f.llm_reasoning && (
                    <p className="mt-2 rounded-lg bg-surface-2 p-3 text-sm text-muted">
                      {f.llm_reasoning}
                    </p>
                  )}
                </div>
              ))}
            </div>
          )}
        </Card>
      )}
    </div>
  );
}
