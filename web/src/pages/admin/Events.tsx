import { useState } from "react";
import { adminApi, type SystemEvent } from "../../lib/adminApi";
import { useAdminData, useUrlFilters } from "../../lib/useAdminData";
import { countOf } from "../../lib/format";
import { Pager, SearchField, Select, Toolbar } from "../../components/admin/DataTable";
import {
  ErrorNote,
  JsonBlock,
  LevelBadge,
  LiveDot,
  Panel,
  Skeleton,
  Time,
} from "../../components/admin/primitives";

const DEFAULTS = { level: "all", source: "", q: "", days: "7", offset: "0" };
const LIVE_POLL_MS = 10_000;

/**
 * The system-event stream. Rendered as a list rather than a table because the
 * message is the content — it is long, it wraps, and squeezing it into a column
 * would truncate exactly the part you opened the page to read.
 */
export function AdminEvents() {
  const [filters, setFilters] = useUrlFilters(DEFAULTS);
  const [live, setLive] = useState(true);
  const [expanded, setExpanded] = useState<string | null>(null);
  const key = JSON.stringify(filters);

  const { data, error, loading, refreshing } = useAdminData(
    () =>
      adminApi.events({
        level: filters.level,
        source: filters.source,
        q: filters.q,
        days: filters.days,
        offset: Number(filters.offset),
      }),
    // Only tail live on the first page; auto-refreshing page 4 of a paginated
    // history would shuffle rows under the reader for no benefit.
    { key, intervalMs: live && filters.offset === "0" ? LIVE_POLL_MS : null },
  );

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">System events</h1>
          <p className="mt-0.5 text-sm text-muted">
            What the software did — scan failures, queue errors, integration problems.
          </p>
        </div>
        <label className="flex cursor-pointer items-center gap-2 text-xs text-muted">
          <input
            type="checkbox"
            checked={live}
            onChange={(e) => setLive(e.target.checked)}
            className="accent-primary"
          />
          {live && refreshing ? <LiveDot tone="warning" /> : live ? <LiveDot /> : null}
          Live tail
        </label>
      </header>

      {error && <ErrorNote message={error} />}

      <Panel padded={false}>
        <Toolbar>
          <SearchField
            value={filters.q}
            onChange={(q) => setFilters({ q })}
            placeholder="Search event key or message…"
          />
          <Select
            label="Level"
            value={filters.level}
            onChange={(level) => setFilters({ level })}
            options={[
              { value: "all", label: "All levels" },
              { value: "problems", label: "Warnings + errors" },
              { value: "error", label: "Errors" },
              { value: "warn", label: "Warnings" },
              { value: "info", label: "Info" },
              { value: "debug", label: "Debug" },
            ]}
          />
          <Select
            label="Source"
            value={filters.source}
            onChange={(source) => setFilters({ source })}
            options={[
              { value: "", label: "All sources" },
              { value: "api", label: "api" },
              { value: "worker", label: "worker" },
              { value: "queue", label: "queue" },
              { value: "webhook", label: "webhook" },
              { value: "billing", label: "billing" },
              { value: "llm", label: "llm" },
              { value: "auth", label: "auth" },
            ]}
          />
          <Select
            label="Range"
            value={filters.days}
            onChange={(days) => setFilters({ days })}
            options={[
              { value: "1", label: "24 hours" },
              { value: "7", label: "7 days" },
              { value: "30", label: "30 days" },
            ]}
          />
          {data && (
            <span className="ml-auto text-xs text-muted">{countOf(data.total, "event")}</span>
          )}
        </Toolbar>

        {loading && !data ? (
          <div className="p-4">
            <Skeleton rows={8} />
          </div>
        ) : data && data.rows.length === 0 ? (
          <p className="px-4 py-12 text-center text-sm text-muted">
            No events match these filters. On a healthy system that is the expected answer.
          </p>
        ) : (
          <ul className="divide-y divide-border">
            {data?.rows.map((e) => (
              <EventRow
                key={e.id}
                event={e}
                expanded={expanded === e.id}
                onToggle={() => setExpanded(expanded === e.id ? null : e.id)}
              />
            ))}
          </ul>
        )}

        {data && (
          <Pager
            total={data.total}
            limit={data.limit}
            offset={data.offset}
            onChange={(offset) => setFilters({ offset: String(offset) })}
          />
        )}
      </Panel>
    </div>
  );
}

function EventRow({
  event,
  expanded,
  onToggle,
}: {
  event: SystemEvent;
  expanded: boolean;
  onToggle: () => void;
}) {
  const hasDetail = Boolean(event.context) || Boolean(event.org_name) || Boolean(event.user_email);
  return (
    <li>
      <button
        type="button"
        onClick={hasDetail ? onToggle : undefined}
        className={`flex w-full items-start gap-3 px-4 py-2.5 text-left transition-colors ${
          hasDetail ? "cursor-pointer hover:bg-surface-2" : "cursor-default"
        }`}
      >
        {/* A left edge tinted by level makes the stream scannable at a glance —
            you find the red band before you read any words. */}
        <span
          aria-hidden="true"
          className={`mt-1 h-8 w-0.5 shrink-0 rounded-full ${
            event.level === "error"
              ? "bg-danger"
              : event.level === "warn"
                ? "bg-warning"
                : "bg-border"
          }`}
        />
        <div className="min-w-0 flex-1">
          <div className="flex flex-wrap items-center gap-2">
            <LevelBadge level={event.level} />
            <span className="rounded bg-surface-2 px-1.5 py-0.5 font-mono text-[11px] text-muted">
              {event.source}
            </span>
            <span className="truncate font-mono text-xs text-foreground">{event.event}</span>
            <span className="ml-auto shrink-0 text-xs">
              <Time iso={event.created_at} />
            </span>
          </div>
          <p className={`mt-1 text-sm text-foreground ${expanded ? "" : "line-clamp-2"}`}>
            {event.message}
          </p>
          {(event.org_name || event.user_email) && (
            <p className="mt-1 truncate text-xs text-muted">
              {[event.org_name, event.user_email].filter(Boolean).join(" · ")}
            </p>
          )}
        </div>
      </button>
      {expanded && event.context && (
        <div className="px-4 pb-3 pl-11">
          <JsonBlock value={event.context} />
        </div>
      )}
    </li>
  );
}
