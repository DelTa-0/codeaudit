import { useState } from "react";
import { adminApi, type FailedJob, type QueueCounts } from "../../lib/adminApi";
import { useAdminData } from "../../lib/useAdminData";
import { duration } from "../../lib/format";
import { Badge, Button } from "../../components/ui";
import {
  ErrorNote,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  Time,
} from "../../components/admin/primitives";

const POLL_MS = 5_000;

/** A scan sitting in one state longer than this is worth looking at. */
const STUCK_SECONDS = 15 * 60;

export function AdminProcesses() {
  const { data, error, loading, refresh, refreshing } = useAdminData(() => adminApi.processes(), {
    intervalMs: POLL_MS,
    key: "processes",
  });

  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Skeleton rows={8} />;

  const { throughput, worker } = data;
  const successRate =
    throughput.total > 0 ? Math.round((throughput.complete / throughput.total) * 100) : null;

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Processes</h1>
          <p className="mt-0.5 text-sm text-muted">
            Live queue state and every scan currently running, refreshed every {POLL_MS / 1000}{" "}
            seconds.
          </p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          {refreshing ? <LiveDot tone="warning" /> : <LiveDot />} live
        </span>
      </header>

      {/* The single most important line on the page. A deep queue and a dead
          consumer produce identical depth numbers, so the heartbeat gets its own
          banner rather than a chip in a corner. */}
      {!worker.alive && (
        <div className="rounded-2xl border border-danger/40 bg-danger/10 px-4 py-3">
          <p className="text-sm font-semibold text-danger">The scan worker is not running.</p>
          <p className="mt-1 text-xs text-danger/90">
            {worker.lastBeatAt
              ? `Last heartbeat ${worker.ageSeconds}s ago. Queued scans will sit unprocessed until it comes back.`
              : "No heartbeat has ever been recorded. Either the worker process was never started, or Redis is unreachable."}
          </p>
        </div>
      )}

      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <StatTile
          label="In flight"
          value={data.inFlight.length}
          hint="Scans not yet finished"
          tone={data.inFlight.length > 0 ? "primary" : "default"}
          live
        />
        <StatTile
          label="Scans (24h)"
          value={throughput.total}
          hint={`${throughput.failed} failed`}
          tone={throughput.failed > 0 ? "warning" : "default"}
        />
        <StatTile
          label="Success rate"
          value={successRate === null ? "—" : `${successRate}%`}
          hint="Last 24 hours"
          tone={successRate === null ? "default" : successRate >= 95 ? "success" : "warning"}
        />
        <StatTile
          label="Avg duration"
          // An em dash rather than "<1s" when nothing has run: a duration
          // derived from zero scans is not a fast system, it is no data.
          value={throughput.complete === 0 ? "—" : duration(throughput.avgSeconds)}
          hint={throughput.complete === 0 ? "No completed scans today" : `p95 ${duration(throughput.p95Seconds)}`}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        {data.queues.map((q) => (
          <QueueCard key={q.name} queue={q} />
        ))}
      </div>

      <Panel
        title="Running now"
        subtitle="Oldest first — the one that has been going longest is the one to look at"
        padded={false}
      >
        {data.inFlight.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">Nothing is running right now.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.inFlight.map((s) => {
              const stuck = s.age_seconds > STUCK_SECONDS;
              return (
                <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-3">
                  <Badge label={s.status} />
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm font-medium text-foreground">{s.repo}</p>
                    <p className="truncate text-xs text-muted">
                      {s.org_name} · {s.trigger}
                      {s.branch ? ` · ${s.branch}` : ""}
                      {s.progress ? ` · ${s.progress}` : ""}
                    </p>
                  </div>
                  <span
                    className={`font-mono text-xs tabular-nums ${stuck ? "font-semibold text-warning" : "text-muted"}`}
                    title={stuck ? "Running unusually long" : undefined}
                  >
                    {duration(s.age_seconds)}
                  </span>
                </li>
              );
            })}
          </ul>
        )}
      </Panel>

      <Panel
        title="Failed jobs"
        subtitle="Retry re-runs the processor against the existing scan row"
        padded={false}
      >
        {data.failedJobs.length === 0 ? (
          <p className="px-4 py-10 text-center text-sm text-muted">No failed jobs in any queue.</p>
        ) : (
          <ul className="divide-y divide-border">
            {data.failedJobs.map((j) => (
              <FailedJobRow key={`${j.queue}:${j.id}`} job={j} onRetried={refresh} />
            ))}
          </ul>
        )}
      </Panel>

      <Panel title="Recently finished" padded={false}>
        <ul className="divide-y divide-border">
          {data.recent.map((s) => (
            <li key={s.id} className="flex flex-wrap items-center gap-x-3 gap-y-1 px-4 py-2.5">
              <Badge label={s.status} />
              <div className="min-w-0 flex-1">
                <p className="truncate text-sm text-foreground">{s.repo}</p>
                {s.error_message && (
                  <p className="truncate text-xs text-danger">{s.error_message}</p>
                )}
              </div>
              <span className="font-mono text-xs text-muted tabular-nums">
                {duration(s.duration_seconds)}
              </span>
              <span className="text-xs">
                <Time iso={s.completed_at} />
              </span>
            </li>
          ))}
        </ul>
      </Panel>
    </div>
  );
}

function QueueCard({ queue }: { queue: QueueCounts }) {
  if (queue.unreachable) {
    return (
      <Panel title={queue.name}>
        <p className="text-sm text-danger">
          Unreachable. Redis is down or the connection is misconfigured — these numbers are unknown,
          not zero.
        </p>
      </Panel>
    );
  }
  const backlog = queue.waiting + queue.delayed;
  return (
    <Panel
      title={queue.name}
      subtitle={backlog === 0 ? "drained" : `${backlog} waiting`}
      actions={queue.active > 0 ? <LiveDot /> : undefined}
    >
      <dl className="grid grid-cols-3 gap-3 text-center">
        <Counter label="Waiting" value={queue.waiting} tone={queue.waiting > 20 ? "warning" : "default"} />
        <Counter label="Active" value={queue.active} tone={queue.active > 0 ? "primary" : "default"} />
        <Counter label="Failed" value={queue.failed} tone={queue.failed > 0 ? "danger" : "default"} />
        <Counter label="Delayed" value={queue.delayed} />
        <Counter label="Paused" value={queue.paused} tone={queue.paused > 0 ? "warning" : "default"} />
        <Counter label="Done" value={queue.completed} />
      </dl>
    </Panel>
  );
}

const COUNTER_TONE: Record<string, string> = {
  default: "text-foreground",
  primary: "text-primary",
  warning: "text-warning",
  danger: "text-danger",
};

function Counter({ label, value, tone = "default" }: { label: string; value: number; tone?: string }) {
  return (
    <div>
      <dd className={`font-mono text-lg font-semibold tabular-nums ${COUNTER_TONE[tone]}`}>{value}</dd>
      <dt className="text-[11px] text-muted">{label}</dt>
    </div>
  );
}

function FailedJobRow({ job, onRetried }: { job: FailedJob; onRetried: () => void }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState(false);

  const retry = async () => {
    setBusy(true);
    setError(null);
    try {
      await adminApi.retryJob(job.queue, job.id);
      setDone(true);
      onRetried();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Retry failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <li className="px-4 py-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
          {job.queue}#{job.id}
        </span>
        <span className="text-xs text-muted">
          {job.attempts} attempt{job.attempts === 1 ? "" : "s"}
        </span>
        <span className="text-xs">
          <Time iso={job.failedAt} />
        </span>
        <div className="ml-auto flex items-center gap-2">
          {error && <span className="text-xs text-danger">{error}</span>}
          <Button variant="ghost" onClick={retry} disabled={busy || done}>
            {done ? "Requeued" : busy ? "Retrying…" : "Retry"}
          </Button>
        </div>
      </div>
      {job.reason && (
        <p className="mt-1.5 line-clamp-3 font-mono text-xs break-words text-danger">{job.reason}</p>
      )}
    </li>
  );
}
