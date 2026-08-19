import { Link } from "react-router-dom";
import { adminApi, type AdminOrg } from "../../lib/adminApi";
import { useAdminData, useUrlFilters } from "../../lib/useAdminData";
import { countOf } from "../../lib/format";
import { Badge } from "../../components/ui";
import { DataTable, Pager, SearchField, Select, Toolbar, type Column } from "../../components/admin/DataTable";
import { ErrorNote, Panel, Time } from "../../components/admin/primitives";

const DEFAULTS = { q: "", plan: "all", sort: "created_at", dir: "desc", offset: "0" };

export function AdminOrganizations() {
  const [filters, setFilters] = useUrlFilters(DEFAULTS);
  const key = JSON.stringify(filters);

  const { data, error, loading } = useAdminData(
    () =>
      adminApi.orgs({
        q: filters.q,
        plan: filters.plan,
        sort: filters.sort,
        dir: filters.dir,
        offset: Number(filters.offset),
      }),
    { key },
  );

  const columns: Column<AdminOrg>[] = [
    {
      key: "name",
      header: "Organization",
      sortable: true,
      render: (o) => (
        <div className="min-w-0">
          <p className="truncate font-medium text-foreground">{o.name}</p>
          <p className="truncate font-mono text-xs text-muted">{o.owner_email ?? o.slug}</p>
        </div>
      ),
    },
    {
      key: "plan",
      header: "Plan",
      render: (o) => (
        <div className="flex items-center gap-1.5">
          <Badge label={o.plan} />
          {o.plan_status !== "active" && (
            <span className="font-mono text-[10px] text-warning uppercase">{o.plan_status}</span>
          )}
        </div>
      ),
    },
    { key: "members", header: "Members", sortable: true, align: "right", render: (o) => <Num v={o.member_count} /> },
    { key: "repos", header: "Repos", sortable: true, align: "right", secondary: true, render: (o) => <Num v={o.repo_count} /> },
    { key: "scans", header: "Scans", sortable: true, align: "right", secondary: true, render: (o) => <Num v={o.scan_count} /> },
    {
      key: "last_activity",
      header: "Last scan",
      sortable: true,
      secondary: true,
      render: (o) => <Time iso={o.last_activity} />,
    },
    {
      key: "logs",
      header: "",
      align: "right",
      render: (o) => (
        <Link
          to={`/admin/activity?orgId=${o.id}&days=30`}
          className="text-xs font-medium whitespace-nowrap text-primary hover:underline"
          onClick={(e) => e.stopPropagation()}
        >
          activity →
        </Link>
      ),
    },
  ];

  const toggleSort = (k: string) =>
    setFilters({ sort: k, dir: filters.sort === k && filters.dir === "desc" ? "asc" : "desc" });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Organizations</h1>
        <p className="mt-0.5 text-sm text-muted">
          Every workspace, with its size and how much of the platform it uses.
        </p>
      </header>

      {error && <ErrorNote message={error} />}

      <Panel padded={false}>
        <Toolbar>
          <SearchField
            value={filters.q}
            onChange={(q) => setFilters({ q })}
            placeholder="Search name or slug…"
          />
          <Select
            label="Plan"
            value={filters.plan}
            onChange={(plan) => setFilters({ plan })}
            options={[
              { value: "all", label: "All plans" },
              { value: "free", label: "Free" },
              { value: "pro", label: "Pro" },
              { value: "team", label: "Team" },
            ]}
          />
          {data && (
            <span className="ml-auto text-xs text-muted">{countOf(data.total, "organization")}</span>
          )}
        </Toolbar>
        <DataTable
          columns={columns}
          rows={data?.rows ?? null}
          rowKey={(o) => o.id}
          loading={loading}
          empty="No organizations match these filters."
          sort={filters.sort}
          dir={filters.dir as "asc" | "desc"}
          onSort={toggleSort}
        />
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

function Num({ v }: { v: string }) {
  return <span className="font-mono text-xs tabular-nums text-muted">{v}</span>;
}
