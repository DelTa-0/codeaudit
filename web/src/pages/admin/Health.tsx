import { adminApi, type HealthCheck } from "../../lib/adminApi";
import { useAdminData } from "../../lib/useAdminData";
import { duration, millis } from "../../lib/format";
import { ErrorNote, Panel, Skeleton } from "../../components/admin/primitives";

const POLL_MS = 30_000;

const STATUS_STYLE: Record<HealthCheck["status"], { dot: string; text: string; label: string }> = {
  ok: { dot: "bg-success", text: "text-success", label: "OK" },
  degraded: { dot: "bg-warning", text: "text-warning", label: "Degraded" },
  down: { dot: "bg-danger", text: "text-danger", label: "Down" },
  // Not red on purpose: running without Stripe is a deployment choice, and
  // reporting a choice as a failure is how people learn to ignore red.
  not_configured: { dot: "bg-border", text: "text-muted", label: "Not configured" },
};

export function AdminHealth() {
  const { data, error, loading } = useAdminData(() => adminApi.health(), {
    intervalMs: POLL_MS,
    key: "health",
  });

  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Skeleton rows={6} />;

  const failing = data.checks.filter((c) => c.status === "down");

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Health</h1>
        <p className="mt-0.5 text-sm text-muted">
          The dependencies this deployment needs, checked live.
        </p>
      </header>

      {failing.length > 0 && (
        <div className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3">
          <p className="text-sm font-semibold text-danger">
            {failing.length === 1
              ? `${failing[0].name} is down.`
              : `${failing.length} dependencies are down.`}
          </p>
          <p className="mt-1 text-xs text-danger/90">
            {failing.map((c) => `${c.name}: ${c.detail}`).join(" · ")}
          </p>
        </div>
      )}

      <Panel title="Dependencies" padded={false}>
        <ul className="divide-y divide-border">
          {data.checks.map((c) => {
            const style = STATUS_STYLE[c.status];
            return (
              <li key={c.name} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                <span className={`h-2.5 w-2.5 shrink-0 rounded-full ${style.dot}`} aria-hidden="true" />
                <span className="font-mono text-sm font-medium text-foreground">{c.name}</span>
                <span className="min-w-0 flex-1 truncate text-xs text-muted" title={c.detail}>
                  {c.detail}
                </span>
                {c.latencyMs !== undefined && (
                  <span className="font-mono text-xs text-muted tabular-nums">
                    {millis(c.latencyMs)}
                  </span>
                )}
                <span className={`text-xs font-medium ${style.text}`}>{style.label}</span>
              </li>
            );
          })}
        </ul>
      </Panel>

      <div className="grid gap-5 lg:grid-cols-2">
        <Panel title="Runtime">
          <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
            <Pair label="API uptime" value={duration(data.runtime.uptimeSeconds)} />
            <Pair label="Node" value={data.runtime.nodeVersion} />
            <Pair label="Memory (RSS)" value={`${data.runtime.memoryMb} MB`} />
            <Pair label="PID" value={String(data.runtime.pid)} />
            <Pair label="Beta plan caps" value={data.runtime.betaUnlimited ? "lifted" : "enforced"} />
            <Pair
              label="Log retention"
              value={`${data.runtime.retention.auditLogDays}d audit · ${data.runtime.retention.systemEventDays}d events`}
            />
          </dl>
        </Panel>

        <Panel
          title="Schema migrations"
          subtitle={
            data.migrations.error
              ? "Could not read the migration table"
              : `${data.migrations.applied.length} applied · latest ${data.migrations.latest ?? "none"}`
          }
        >
          {data.migrations.error ? (
            <ErrorNote message={data.migrations.error} />
          ) : (
            // Code deployed ahead of its schema is the outage that looks like
            // nothing else, so the applied list is worth showing in full.
            <ol className="max-h-52 space-y-1 overflow-y-auto font-mono text-xs text-muted">
              {data.migrations.applied.map((m) => (
                <li key={m} className="truncate">
                  {m}
                </li>
              ))}
            </ol>
          )}
        </Panel>
      </div>
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-sm text-foreground">{value}</dd>
    </div>
  );
}
