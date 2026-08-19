import { useState } from "react";
import { adminApi, adminUrl, type ActivityEntry } from "../../lib/adminApi";
import { useAdminData, useUrlFilters } from "../../lib/useAdminData";
import { countOf, millis } from "../../lib/format";
import { getToken } from "../../lib/api";
import { Button } from "../../components/ui";
import { DataTable, Pager, SearchField, Select, Toolbar, type Column } from "../../components/admin/DataTable";
import { ErrorNote, JsonBlock, Panel, StatusPill, Time } from "../../components/admin/primitives";

const DEFAULTS = {
  q: "",
  action: "",
  outcome: "all",
  days: "7",
  userId: "",
  orgId: "",
  offset: "0",
};

export function AdminActivity() {
  const [filters, setFilters] = useUrlFilters(DEFAULTS);
  const [expanded, setExpanded] = useState<string | null>(null);
  const key = JSON.stringify(filters);

  const { data, error, loading } = useAdminData(
    () =>
      adminApi.activity({
        q: filters.q,
        action: filters.action,
        outcome: filters.outcome,
        days: filters.days,
        userId: filters.userId,
        orgId: filters.orgId,
        offset: Number(filters.offset),
      }),
    { key },
  );
  const { data: actions } = useAdminData(() => adminApi.actions(), { key: "actions" });

  const columns: Column<ActivityEntry>[] = [
    {
      key: "created_at",
      header: "When",
      render: (a) => (
        <span className="text-xs">
          <Time iso={a.created_at} />
        </span>
      ),
    },
    {
      key: "action",
      header: "Action",
      render: (a) => (
        <div className="min-w-0">
          <span className="font-mono text-xs text-foreground">{a.action}</span>
          {a.target && <p className="truncate text-xs text-muted">{a.target}</p>}
        </div>
      ),
    },
    {
      key: "actor",
      header: "Actor",
      render: (a) =>
        a.user_email ? (
          <span className="truncate text-xs text-foreground">{a.user_email}</span>
        ) : (
          <span className="text-xs text-muted italic">anonymous</span>
        ),
    },
    {
      key: "org",
      header: "Org",
      secondary: true,
      render: (a) => <span className="truncate text-xs text-muted">{a.org_name ?? "—"}</span>,
    },
    {
      key: "status",
      header: "Result",
      align: "right",
      render: (a) => <StatusPill status={a.status} />,
    },
    {
      key: "duration",
      header: "Took",
      align: "right",
      secondary: true,
      render: (a) => <span className="font-mono text-xs text-muted">{millis(a.duration_ms)}</span>,
    },
  ];

  return (
    <div className="space-y-5">
      <header className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h1 className="text-xl font-semibold text-foreground">Activity log</h1>
          <p className="mt-0.5 text-sm text-muted">
            Every action a person took. Reads are not recorded; this is what changed and who changed
            it.
          </p>
        </div>
        <ExportButton filters={filters} />
      </header>

      {error && <ErrorNote message={error} />}

      <Panel padded={false}>
        <Toolbar>
          <SearchField
            value={filters.q}
            onChange={(q) => setFilters({ q })}
            placeholder="Search action, target, path, or actor…"
          />
          <Select
            label="Action"
            value={filters.action}
            onChange={(action) => setFilters({ action })}
            options={[
              { value: "", label: "All actions" },
              ...(actions ?? []).map((a) => ({
                value: a.action,
                label: `${a.action} (${a.count})`,
              })),
            ]}
          />
          <Select
            label="Result"
            value={filters.outcome}
            onChange={(outcome) => setFilters({ outcome })}
            options={[
              { value: "all", label: "Any result" },
              { value: "failed", label: "Failed only" },
              { value: "ok", label: "Succeeded only" },
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
              { value: "90", label: "90 days" },
            ]}
          />
          {data && (
            <span className="ml-auto text-xs text-muted">{countOf(data.total, "entry", "entries")}</span>
          )}
        </Toolbar>

        {(filters.userId || filters.orgId) && (
          <div className="flex items-center gap-2 border-b border-border bg-surface-2 px-4 py-2 text-xs text-muted">
            Filtered to a single {filters.userId ? "user" : "organization"}.
            <button
              onClick={() => setFilters({ userId: "", orgId: "" })}
              className="cursor-pointer font-medium text-primary hover:underline"
            >
              Clear
            </button>
          </div>
        )}

        <DataTable
          columns={columns}
          rows={data?.rows ?? null}
          rowKey={(a) => a.id}
          loading={loading}
          empty="No activity in this window."
          onRowClick={(a) => setExpanded(expanded === a.id ? null : a.id)}
        />

        {expanded && data && <EntryDetail entry={data.rows.find((r) => r.id === expanded)} />}

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

function EntryDetail({ entry }: { entry: ActivityEntry | undefined }) {
  if (!entry) return null;
  return (
    <div className="space-y-3 border-t border-border bg-surface-2/50 px-4 py-4">
      <dl className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs sm:grid-cols-4">
        <Pair label="Request" value={entry.method && entry.path ? `${entry.method} ${entry.path}` : "—"} />
        <Pair label="IP" value={entry.ip ?? "—"} />
        <Pair label="Duration" value={millis(entry.duration_ms)} />
        <Pair label="Entry id" value={entry.id} />
        <div className="col-span-2 min-w-0 sm:col-span-4">
          <dt className="text-muted">User agent</dt>
          <dd className="mt-0.5 truncate font-mono text-foreground">{entry.user_agent ?? "—"}</dd>
        </div>
      </dl>
      {entry.metadata && <JsonBlock value={entry.metadata} />}
    </div>
  );
}

function Pair({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <dt className="text-muted">{label}</dt>
      <dd className="mt-0.5 truncate font-mono text-foreground">{value}</dd>
    </div>
  );
}

/**
 * The CSV endpoint needs the Authorization header, so it cannot be a plain
 * link — the browser would send an unauthenticated GET and get a 404 back from
 * the admin guard. Fetch it, then hand the blob to a click.
 */
function ExportButton({ filters }: { filters: Record<string, string> }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const download = async () => {
    setBusy(true);
    setError(null);
    try {
      const url = adminUrl("/activity.csv", {
        q: filters.q,
        action: filters.action,
        outcome: filters.outcome,
        days: filters.days,
        userId: filters.userId,
        orgId: filters.orgId,
      });
      const res = await fetch(url, { headers: { authorization: `Bearer ${getToken() ?? ""}` } });
      if (!res.ok) throw new Error(`Export failed (${res.status})`);
      const blob = await res.blob();
      const href = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = href;
      a.download = "codeaudit-activity.csv";
      a.click();
      URL.revokeObjectURL(href);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Export failed");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="flex items-center gap-2">
      {error && <span className="text-xs text-danger">{error}</span>}
      <Button variant="ghost" onClick={download} disabled={busy}>
        {busy ? "Exporting…" : "Export CSV"}
      </Button>
    </div>
  );
}
