import type { ReactNode } from "react";
import { fullNumber } from "../../lib/format";
import { Skeleton } from "./primitives";

export interface Column<T> {
  key: string;
  header: string;
  /** Set when the server accepts this key as a `sort` value. */
  sortable?: boolean;
  align?: "left" | "right";
  /** Hidden below `sm`. Phones get the identifying columns only. */
  secondary?: boolean;
  render: (row: T) => ReactNode;
}

/**
 * One table for every admin list.
 *
 * Sorting and paging are lifted to the caller rather than held here, because in
 * every one of these views they live in the URL — a filtered activity view has
 * to be linkable and survive a refresh, which is impossible if the table owns
 * the state.
 */
export function DataTable<T>({
  columns,
  rows,
  rowKey,
  loading,
  empty = "Nothing here yet.",
  sort,
  dir,
  onSort,
  onRowClick,
}: {
  columns: Column<T>[];
  rows: T[] | null;
  rowKey: (row: T) => string;
  loading?: boolean;
  empty?: string;
  sort?: string;
  dir?: "asc" | "desc";
  onSort?: (key: string) => void;
  onRowClick?: (row: T) => void;
}) {
  if (loading && !rows) return <div className="p-4"><Skeleton rows={6} /></div>;
  if (rows && rows.length === 0)
    return <p className="px-4 py-10 text-center text-sm text-muted">{empty}</p>;

  return (
    <div className="overflow-x-auto">
      <table className="w-full min-w-[36rem] border-collapse text-sm">
        <thead>
          <tr className="border-b border-border">
            {columns.map((col) => (
              <th
                key={col.key}
                scope="col"
                className={`px-4 py-2.5 text-xs font-medium tracking-wide text-muted uppercase ${
                  col.align === "right" ? "text-right" : "text-left"
                } ${col.secondary ? "hidden sm:table-cell" : ""}`}
              >
                {col.sortable && onSort ? (
                  <button
                    type="button"
                    onClick={() => onSort(col.key)}
                    className="inline-flex cursor-pointer items-center gap-1 uppercase transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
                    aria-label={`Sort by ${col.header}`}
                  >
                    {col.header}
                    <span aria-hidden="true" className={sort === col.key ? "text-primary" : "opacity-30"}>
                      {sort === col.key && dir === "asc" ? "▲" : "▼"}
                    </span>
                  </button>
                ) : (
                  col.header
                )}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className={loading ? "opacity-50 transition-opacity" : "transition-opacity"}>
          {(rows ?? []).map((row) => (
            <tr
              key={rowKey(row)}
              onClick={onRowClick ? () => onRowClick(row) : undefined}
              className={`border-b border-border/60 last:border-0 ${
                onRowClick ? "cursor-pointer transition-colors hover:bg-surface-2" : ""
              }`}
            >
              {columns.map((col) => (
                <td
                  key={col.key}
                  className={`px-4 py-2.5 align-middle ${col.align === "right" ? "text-right" : ""} ${
                    col.secondary ? "hidden sm:table-cell" : ""
                  }`}
                >
                  {col.render(row)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

export function Pager({
  total,
  limit,
  offset,
  onChange,
}: {
  total: number;
  limit: number;
  offset: number;
  onChange: (offset: number) => void;
}) {
  if (total <= limit) return null;
  const from = offset + 1;
  const to = Math.min(offset + limit, total);
  return (
    <div className="flex items-center justify-between gap-3 border-t border-border px-4 py-3">
      <p className="text-xs text-muted">
        {fullNumber(from)}–{fullNumber(to)} of {fullNumber(total)}
      </p>
      <div className="flex gap-2">
        <PagerButton disabled={offset === 0} onClick={() => onChange(Math.max(0, offset - limit))}>
          Previous
        </PagerButton>
        <PagerButton disabled={to >= total} onClick={() => onChange(offset + limit)}>
          Next
        </PagerButton>
      </div>
    </div>
  );
}

function PagerButton({
  children,
  disabled,
  onClick,
}: {
  children: ReactNode;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onClick}
      className="cursor-pointer rounded-full border border-border px-3 py-1.5 text-xs font-medium text-muted transition-colors hover:bg-surface-2 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-40 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
    >
      {children}
    </button>
  );
}

export function Toolbar({ children }: { children: ReactNode }) {
  return (
    <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">{children}</div>
  );
}

export function SearchField({
  value,
  onChange,
  placeholder,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder: string;
}) {
  return (
    <input
      type="search"
      value={value}
      placeholder={placeholder}
      onChange={(e) => onChange(e.target.value)}
      className="min-w-0 flex-1 rounded-xl border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted focus:ring-2 focus:ring-primary/50 focus:outline-none sm:max-w-xs"
    />
  );
}

export function Select({
  value,
  onChange,
  options,
  label,
}: {
  value: string;
  onChange: (v: string) => void;
  options: { value: string; label: string }[];
  label: string;
}) {
  return (
    <label className="flex items-center gap-2 text-xs text-muted">
      <span className="sr-only sm:not-sr-only">{label}</span>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value)}
        className="cursor-pointer rounded-xl border border-border bg-surface-2 px-2.5 py-2 text-sm text-foreground focus:ring-2 focus:ring-primary/50 focus:outline-none"
      >
        {options.map((o) => (
          <option key={o.value} value={o.value}>
            {o.label}
          </option>
        ))}
      </select>
    </label>
  );
}
