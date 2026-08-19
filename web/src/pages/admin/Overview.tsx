import { Link } from "react-router-dom";
import { adminApi } from "../../lib/adminApi";
import { useAdminData } from "../../lib/useAdminData";
import { compactNumber, fullNumber } from "../../lib/format";
import {
  ErrorNote,
  LevelBadge,
  LiveDot,
  Panel,
  Skeleton,
  StatTile,
  Time,
} from "../../components/admin/primitives";

/** The whole page is a live view, so it re-reads on a timer rather than on a click. */
const POLL_MS = 15_000;

export function AdminOverview() {
  const { data, error, loading, refreshing } = useAdminData(() => adminApi.overview(), {
    intervalMs: POLL_MS,
    key: "overview",
  });

  if (error) return <ErrorNote message={error} />;
  if (loading || !data) return <Skeleton rows={8} />;

  const signups = data.series.map((d) => d.signups);
  const scanSeries = data.series.map((d) => d.scans);
  const errorSeries = data.series.map((d) => d.errors);
  const totalQueued = data.queues.reduce((n, q) => n + q.waiting + q.active, 0);
  const queuesDown = data.queues.some((q) => q.unreachable);

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Platform overview</h1>
          <p className="mt-0.5 text-sm text-muted">
            Everything on this page is live, refreshed every {POLL_MS / 1000} seconds.
          </p>
        </div>
        <span className="flex items-center gap-2 text-xs text-muted">
          {refreshing ? <LiveDot tone="warning" /> : <LiveDot />}
          {refreshing ? "updating…" : "up to date"}
        </span>
      </header>

      {/* Presence first: "who is using this right now" is the question the page
          exists to answer, and it belongs above the totals. */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 xl:grid-cols-4">
        <StatTile
          label="Online now"
          value={data.users.onlineNow}
          hint="Active in the last 5 minutes"
          tone="success"
          live
        />
        <StatTile
          label="Active today"
          value={data.users.activeToday}
          hint={`${compactNumber(data.users.activeWeek)} this week · ${compactNumber(data.users.activeMonth)} this month`}
        />
        <StatTile
          label="Total users"
          value={data.users.total}
          hint={`+${data.users.newToday} today · +${data.users.newWeek} this week`}
          series={signups}
        />
        <StatTile
          label="Scans today"
          value={data.scans.today}
          hint={`${fullNumber(data.scans.total)} all time`}
          series={scanSeries}
        />
        <StatTile
          label="Organizations"
          value={data.orgs.total}
          hint={`${data.orgs.paid} on a paid plan`}
        />
        <StatTile
          label="Repositories"
          value={data.repos.total}
          hint={`${data.repos.private} private`}
        />
        <StatTile
          label="In queue"
          value={queuesDown ? "—" : totalQueued}
          hint={queuesDown ? "Redis unreachable" : `${data.scans.inFlight} scans in flight`}
          tone={queuesDown ? "danger" : totalQueued > 20 ? "warning" : "default"}
        />
        <StatTile
          label="Errors today"
          value={data.events.errorsToday}
          hint={`${data.events.errorsLastHour} in the last hour · ${data.scans.failedToday} failed scans`}
          tone={data.events.errorsToday > 0 ? "danger" : "success"}
          series={errorSeries}
        />
      </div>

      <div className="grid gap-5 lg:grid-cols-3">
        <div className="lg:col-span-2">
          <Panel
            title="Last 14 days"
            subtitle="Sign-ups, scans, and errors per day"
            actions={
              <div className="flex gap-3 text-xs text-muted">
                <LegendKey color="var(--color-primary)" label="Scans" />
                <LegendKey color="var(--color-success)" label="Sign-ups" />
                <LegendKey color="var(--color-danger)" label="Errors" />
              </div>
            }
          >
            <DailyChart series={data.series} />
          </Panel>
        </div>

        <div className="space-y-5">
          <Panel title="Workers and queues">
            <div className="space-y-3">
              <div className="flex items-center justify-between rounded-xl bg-surface-2 px-3 py-2.5">
                <span className="text-sm font-medium text-foreground">Scan worker</span>
                <span
                  className={`flex items-center gap-2 font-mono text-xs ${
                    data.worker.alive ? "text-success" : "text-danger"
                  }`}
                >
                  {data.worker.alive ? <LiveDot /> : <LiveDot tone="danger" />}
                  {data.worker.alive ? `beat ${data.worker.ageSeconds}s ago` : "not running"}
                </span>
              </div>
              {data.queues.map((q) => (
                <div key={q.name} className="flex items-center justify-between gap-2 px-1">
                  <span className="font-mono text-xs text-muted">{q.name}</span>
                  {q.unreachable ? (
                    <span className="font-mono text-xs text-danger">unreachable</span>
                  ) : (
                    <span className="flex gap-2 font-mono text-xs tabular-nums">
                      <QueueChip label="wait" value={q.waiting} warnAbove={20} />
                      <QueueChip label="run" value={q.active} />
                      <QueueChip label="fail" value={q.failed} warnAbove={0} />
                    </span>
                  )}
                </div>
              ))}
              <Link
                to="/admin/processes"
                className="block pt-1 text-xs font-medium text-primary hover:underline"
              >
                Open process view →
              </Link>
            </div>
          </Panel>

          <Panel title="Recent problems" subtitle="Warnings and errors, newest first" padded={false}>
            {data.recentProblems.length === 0 ? (
              <p className="px-4 py-8 text-center text-sm text-muted">
                Nothing has gone wrong recently.
              </p>
            ) : (
              <ul className="divide-y divide-border">
                {data.recentProblems.map((e) => (
                  <li key={e.id} className="px-4 py-2.5">
                    <div className="flex items-center gap-2">
                      <LevelBadge level={e.level} />
                      <span className="truncate font-mono text-xs text-muted">{e.event}</span>
                      <span className="ml-auto text-xs">
                        <Time iso={e.created_at} />
                      </span>
                    </div>
                    <p className="mt-1 line-clamp-2 text-xs text-foreground">{e.message}</p>
                  </li>
                ))}
              </ul>
            )}
            <div className="border-t border-border px-4 py-2.5">
              <Link to="/admin/events?level=problems" className="text-xs font-medium text-primary hover:underline">
                All system events →
              </Link>
            </div>
          </Panel>
        </div>
      </div>
    </div>
  );
}

/**
 * Postgres hands a DATE column back as a timestamp, which JSON-serialises to a
 * full ISO string — rendering it raw put "2026-08-05T18:15:00.000Z" under a
 * chart axis. Only the day is meaningful here.
 */
function dayLabel(day: string | undefined): string {
  if (!day) return "";
  const d = new Date(day);
  return Number.isNaN(d.getTime())
    ? day
    : d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

function LegendKey({ color, label }: { color: string; label: string }) {
  return (
    <span className="flex items-center gap-1.5">
      <span className="h-2 w-2 rounded-full" style={{ background: color }} aria-hidden="true" />
      {label}
    </span>
  );
}

function QueueChip({ label, value, warnAbove }: { label: string; value: number; warnAbove?: number }) {
  const hot = warnAbove !== undefined && value > warnAbove;
  return (
    <span className={hot ? "text-warning" : "text-muted"}>
      {label} {value}
    </span>
  );
}

/**
 * Three overlaid day series on a shared scale.
 *
 * Drawn by hand for the same reason the sparklines are: with no axes to
 * configure, no tooltip, and fourteen fixed points, a charting library would be
 * more code than the SVG and would fight the theme tokens.
 */
function DailyChart({
  series,
}: {
  series: { day: string; signups: number; scans: number; errors: number }[];
}) {
  const W = 640;
  const H = 160;
  const PAD = 6;
  const max = Math.max(1, ...series.flatMap((d) => [d.signups, d.scans, d.errors]));
  const step = series.length > 1 ? (W - PAD * 2) / (series.length - 1) : 0;
  const point = (v: number, i: number) =>
    `${(PAD + i * step).toFixed(1)},${(H - PAD - (v / max) * (H - PAD * 2)).toFixed(1)}`;
  const line = (pick: (d: (typeof series)[number]) => number) =>
    series.map((d, i) => point(pick(d), i)).join(" ");

  return (
    <div className="overflow-x-auto">
      <svg viewBox={`0 0 ${W} ${H}`} className="h-40 w-full min-w-[26rem]" role="img" aria-label="Daily activity over the last 14 days">
        {[0.25, 0.5, 0.75].map((f) => (
          <line
            key={f}
            x1={PAD}
            x2={W - PAD}
            y1={H - PAD - f * (H - PAD * 2)}
            y2={H - PAD - f * (H - PAD * 2)}
            stroke="var(--color-border)"
            strokeWidth="1"
          />
        ))}
        <polyline points={line((d) => d.scans)} fill="none" stroke="var(--color-primary)" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={line((d) => d.signups)} fill="none" stroke="var(--color-success)" strokeWidth="2" strokeLinejoin="round" />
        <polyline points={line((d) => d.errors)} fill="none" stroke="var(--color-danger)" strokeWidth="2" strokeLinejoin="round" />
        {/* Transparent hit areas so every day is hoverable for its exact
            numbers. The line itself is 2px and would be a cruel target. */}
        {series.map((d, i) => (
          <rect
            key={d.day}
            x={PAD + i * step - step / 2}
            y={0}
            width={Math.max(step, 8)}
            height={H}
            fill="transparent"
          >
            <title>{`${dayLabel(d.day)} — ${d.scans} scans, ${d.signups} sign-ups, ${d.errors} errors`}</title>
          </rect>
        ))}
      </svg>
      <div className="mt-1 flex justify-between font-mono text-[10px] text-muted">
        <span>{dayLabel(series[0]?.day)}</span>
        <span>{dayLabel(series.at(-1)?.day)}</span>
      </div>
    </div>
  );
}
