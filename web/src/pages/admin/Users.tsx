import { useState } from "react";
import { Link } from "react-router-dom";
import { adminApi, type AdminUser } from "../../lib/adminApi";
import { useAdminData, useUrlFilters } from "../../lib/useAdminData";
import { countOf } from "../../lib/format";
import { useAuth } from "../../lib/auth";
import { Avatar, Button } from "../../components/ui";
import { ConfirmAction } from "../../components/admin/ConfirmAction";
import { DataTable, Pager, SearchField, Select, Toolbar, type Column } from "../../components/admin/DataTable";
import { ErrorNote, LiveDot, Panel, Skeleton, Time } from "../../components/admin/primitives";

const DEFAULTS = { q: "", status: "all", sort: "created_at", dir: "desc", offset: "0" };

export function AdminUsers() {
  const [filters, setFilters] = useUrlFilters(DEFAULTS);
  const [selected, setSelected] = useState<string | null>(null);

  const key = JSON.stringify(filters);
  const { data, error, loading, refresh } = useAdminData(
    () =>
      adminApi.users({
        q: filters.q,
        status: filters.status,
        sort: filters.sort,
        dir: filters.dir,
        offset: Number(filters.offset),
      }),
    { key },
  );

  const columns: Column<AdminUser>[] = [
    {
      key: "email",
      header: "User",
      sortable: true,
      render: (u) => (
        <div className="flex min-w-0 items-center gap-2.5">
          <Avatar label={u.name || u.email} size={30} />
          <div className="min-w-0">
            <div className="flex items-center gap-1.5">
              <span className="truncate font-medium text-foreground">{u.name || u.email}</span>
              {u.platform_role === "admin" && <RoleTag />}
              {u.suspended_at && <SuspendedTag />}
            </div>
            {u.name && <p className="truncate text-xs text-muted">{u.email}</p>}
          </div>
        </div>
      ),
    },
    {
      key: "last_seen_at",
      header: "Last seen",
      sortable: true,
      render: (u) => <PresenceCell lastSeen={u.last_seen_at} />,
    },
    { key: "orgs", header: "Orgs", sortable: true, align: "right", secondary: true, render: (u) => <Num v={u.org_count} /> },
    { key: "scans", header: "Scans", sortable: true, align: "right", secondary: true, render: (u) => <Num v={u.scan_count} /> },
    {
      key: "created_at",
      header: "Joined",
      sortable: true,
      secondary: true,
      render: (u) => <Time iso={u.created_at} />,
    },
  ];

  const toggleSort = (k: string) =>
    setFilters({ sort: k, dir: filters.sort === k && filters.dir === "desc" ? "asc" : "desc" });

  return (
    <div className="space-y-5">
      <header>
        <h1 className="text-xl font-semibold text-foreground">Users</h1>
        <p className="mt-0.5 text-sm text-muted">
          Every account on the platform. Selecting one opens its workspaces, volume, and history.
        </p>
      </header>

      {error && <ErrorNote message={error} />}

      <Panel padded={false}>
        <Toolbar>
          <SearchField
            value={filters.q}
            onChange={(q) => setFilters({ q })}
            placeholder="Search name or email…"
          />
          <Select
            label="Status"
            value={filters.status}
            onChange={(status) => setFilters({ status })}
            options={[
              { value: "all", label: "All accounts" },
              { value: "online", label: "Online now" },
              { value: "active", label: "Not suspended" },
              { value: "suspended", label: "Suspended" },
              { value: "admin", label: "Platform admins" },
            ]}
          />
          {data && (
            <span className="ml-auto text-xs text-muted">{countOf(data.total, "account")}</span>
          )}
        </Toolbar>
        <DataTable
          columns={columns}
          rows={data?.rows ?? null}
          rowKey={(u) => u.id}
          loading={loading}
          empty="No accounts match these filters."
          sort={filters.sort}
          dir={filters.dir as "asc" | "desc"}
          onSort={toggleSort}
          onRowClick={(u) => setSelected(u.id)}
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

      {selected && (
        <UserDetail id={selected} onClose={() => setSelected(null)} onChanged={refresh} />
      )}
    </div>
  );
}

function Num({ v }: { v: string | undefined }) {
  return <span className="font-mono text-xs tabular-nums text-muted">{v ?? "0"}</span>;
}

function RoleTag() {
  return (
    <span className="shrink-0 rounded-md bg-primary/15 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-primary uppercase">
      admin
    </span>
  );
}

function SuspendedTag() {
  return (
    <span className="shrink-0 rounded-md bg-danger/10 px-1.5 py-0.5 font-mono text-[10px] font-medium tracking-wide text-danger uppercase">
      suspended
    </span>
  );
}

/** Online is a live state, so it is shown as one; anything older is just a timestamp. */
function PresenceCell({ lastSeen }: { lastSeen: string | null }) {
  const online = lastSeen ? Date.now() - new Date(lastSeen).getTime() < 5 * 60_000 : false;
  if (online)
    return (
      <span className="flex items-center gap-1.5 text-xs font-medium text-success">
        <LiveDot /> online
      </span>
    );
  return (
    <span className="text-xs">
      <Time iso={lastSeen} />
    </span>
  );
}

/**
 * The detail panel, and the only place in the console that can change anything
 * about an account. Both actions route through the password step-up dialog.
 */
function UserDetail({
  id,
  onClose,
  onChanged,
}: {
  id: string;
  onClose: () => void;
  onChanged: () => void;
}) {
  const { user: me } = useAuth();
  const { data, error, loading, refresh } = useAdminData(() => adminApi.user(id), { key: id });
  const [pending, setPending] = useState<"role" | "suspend" | null>(null);

  const u = data?.user;
  // The server refuses both of these on your own account; disabling them here
  // means the operator never has to learn that by being told no.
  const isSelf = me?.id === id;

  return (
    <div
      className="fixed inset-0 z-40 flex justify-end bg-ink/50 backdrop-blur-sm"
      role="dialog"
      aria-modal="true"
      aria-label="User detail"
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <div className="flex h-full w-full max-w-xl flex-col overflow-y-auto border-l border-border bg-background shadow-soft">
        <header className="sticky top-0 z-10 flex items-center gap-3 border-b border-border bg-surface px-4 py-3">
          <h2 className="min-w-0 flex-1 truncate text-sm font-semibold text-foreground">
            {u ? u.name || u.email : "Loading…"}
          </h2>
          <button
            onClick={onClose}
            className="cursor-pointer rounded-full border border-border px-3 py-1.5 text-xs text-muted transition-colors hover:bg-surface-2 hover:text-foreground"
          >
            Close
          </button>
        </header>

        <div className="space-y-4 p-4">
          {error && <ErrorNote message={error} />}
          {loading && !data && <Skeleton rows={6} />}

          {u && data && (
            <>
              <Panel title="Account">
                <dl className="grid grid-cols-2 gap-x-4 gap-y-3 text-sm">
                  <Field label="Email" value={u.email} mono />
                  <Field label="Platform role" value={u.platform_role} mono />
                  <Field label="Joined" value={<Time iso={u.created_at} />} />
                  <Field label="Last seen" value={<PresenceCell lastSeen={u.last_seen_at} />} />
                  <Field label="Sign-in" value={signInMethods(u)} />
                  <Field
                    label="Status"
                    value={
                      u.suspended_at ? (
                        <span className="text-danger">
                          suspended{u.suspended_reason ? ` — ${u.suspended_reason}` : ""}
                        </span>
                      ) : (
                        <span className="text-success">active</span>
                      )
                    }
                  />
                </dl>

                <div className="mt-4 flex flex-wrap gap-2 border-t border-border pt-4">
                  <Button
                    variant="ghost"
                    disabled={isSelf}
                    onClick={() => setPending("role")}
                    title={isSelf ? "You cannot change your own platform role" : undefined}
                  >
                    {u.platform_role === "admin" ? "Revoke platform admin" : "Grant platform admin"}
                  </Button>
                  <Button
                    variant={u.suspended_at ? "ghost" : "danger"}
                    disabled={isSelf}
                    onClick={() => setPending("suspend")}
                    title={isSelf ? "You cannot suspend your own account" : undefined}
                  >
                    {u.suspended_at ? "Reinstate account" : "Suspend account"}
                  </Button>
                </div>
                {isSelf && (
                  <p className="mt-2 text-xs text-muted">
                    This is your own account. Another admin has to make these changes — that is what
                    stops the platform from ending up with no operators.
                  </p>
                )}
              </Panel>

              <div className="grid grid-cols-3 gap-3">
                <MiniStat label="Scans" value={data.scans.total} />
                <MiniStat label="Last 30d" value={data.scans.last30d} />
                <MiniStat label="Failed" value={data.scans.failed} tone={data.scans.failed ? "danger" : "default"} />
              </div>

              <Panel title="Workspaces" padded={false}>
                {data.orgs.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">No workspaces.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.orgs.map((o) => (
                      <li key={o.id} className="flex items-center gap-3 px-4 py-2.5">
                        <div className="min-w-0 flex-1">
                          <Link
                            to={`/admin/orgs?q=${encodeURIComponent(o.slug)}`}
                            className="truncate text-sm font-medium text-foreground hover:text-primary"
                          >
                            {o.name}
                          </Link>
                          <p className="truncate font-mono text-xs text-muted">
                            {o.role} · {o.plan} · {o.repo_count} repos
                          </p>
                        </div>
                        <Time iso={o.joined_at} />
                      </li>
                    ))}
                  </ul>
                )}
              </Panel>

              <Panel title="Recent activity" subtitle="Last 50 recorded actions" padded={false}>
                {data.activity.length === 0 ? (
                  <p className="px-4 py-6 text-center text-sm text-muted">Nothing recorded yet.</p>
                ) : (
                  <ul className="divide-y divide-border">
                    {data.activity.map((a) => (
                      <li key={a.id} className="px-4 py-2">
                        <div className="flex items-baseline gap-2">
                          <span className="truncate font-mono text-xs text-foreground">{a.action}</span>
                          <span className="ml-auto shrink-0 text-xs">
                            <Time iso={a.created_at} />
                          </span>
                        </div>
                        {a.target && <p className="truncate text-xs text-muted">{a.target}</p>}
                      </li>
                    ))}
                  </ul>
                )}
                <div className="border-t border-border px-4 py-2.5">
                  <Link
                    to={`/admin/activity?userId=${u.id}&days=90`}
                    className="text-xs font-medium text-primary hover:underline"
                  >
                    Full activity for this account →
                  </Link>
                </div>
              </Panel>

              <ConfirmAction
                open={pending === "role"}
                title={u.platform_role === "admin" ? "Revoke platform admin" : "Grant platform admin"}
                destructive={u.platform_role !== "admin"}
                confirmLabel={u.platform_role === "admin" ? "Revoke" : "Grant admin"}
                reasonLabel="Reason (optional)"
                description={
                  u.platform_role === "admin" ? (
                    <>
                      <strong className="text-foreground">{u.email}</strong> will lose access to this
                      console immediately — the role is re-read on every request, not carried in
                      their token.
                    </>
                  ) : (
                    <>
                      <strong className="text-foreground">{u.email}</strong> will be able to read
                      every user, organization, and log on the platform, and to grant this role to
                      others.
                    </>
                  )
                }
                onConfirm={async (password, reason) => {
                  await adminApi.setRole(
                    u.id,
                    u.platform_role === "admin" ? "user" : "admin",
                    password,
                    reason || undefined,
                  );
                  refresh();
                  onChanged();
                }}
                onClose={() => setPending(null)}
              />

              <ConfirmAction
                open={pending === "suspend"}
                title={u.suspended_at ? "Reinstate account" : "Suspend account"}
                destructive={!u.suspended_at}
                confirmLabel={u.suspended_at ? "Reinstate" : "Suspend"}
                reasonLabel={u.suspended_at ? undefined : "Reason (shown in the audit log)"}
                description={
                  u.suspended_at ? (
                    <>
                      <strong className="text-foreground">{u.email}</strong> will be able to sign in
                      again.
                    </>
                  ) : (
                    <>
                      <strong className="text-foreground">{u.email}</strong> will be signed out on
                      their next request and blocked from signing in. Their data is untouched.
                    </>
                  )
                }
                onConfirm={async (password, reason) => {
                  await adminApi.setSuspension(u.id, !u.suspended_at, password, reason || undefined);
                  refresh();
                  onChanged();
                }}
                onClose={() => setPending(null)}
              />
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function signInMethods(u: AdminUser): string {
  const methods = [u.has_password && "password", u.github_linked && "GitHub"].filter(Boolean);
  return methods.length ? methods.join(" + ") : "none";
}

function Field({ label, value, mono }: { label: string; value: React.ReactNode; mono?: boolean }) {
  return (
    <div className="min-w-0">
      <dt className="text-xs text-muted">{label}</dt>
      <dd className={`mt-0.5 truncate text-sm text-foreground ${mono ? "font-mono text-xs" : ""}`}>
        {value}
      </dd>
    </div>
  );
}

function MiniStat({
  label,
  value,
  tone = "default",
}: {
  label: string;
  value: number;
  tone?: "default" | "danger";
}) {
  return (
    <div className="rounded-xl border border-border bg-surface p-3 text-center">
      <p className={`font-mono text-xl font-semibold ${tone === "danger" ? "text-danger" : "text-foreground"}`}>
        {value}
      </p>
      <p className="mt-0.5 text-xs text-muted">{label}</p>
    </div>
  );
}
