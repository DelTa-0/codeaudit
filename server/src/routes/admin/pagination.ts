import type { Request } from "express";

/** Hard ceiling. A caller asking for 100k rows gets 200 and no explanation. */
const MAX_LIMIT = 200;
const DEFAULT_LIMIT = 50;

export interface Page {
  limit: number;
  offset: number;
}

/**
 * Offset paging rather than cursors, deliberately. These tables are small
 * enough that the offset scan is not the bottleneck, the admin views want a
 * *total* count to render "1–50 of 1,284", and a linkable ?offset= is worth
 * more here than the constant-time paging a cursor would buy.
 */
export function readPage(req: Request): Page {
  const rawLimit = Number(req.query.limit);
  const rawOffset = Number(req.query.offset);
  return {
    limit: Number.isFinite(rawLimit) && rawLimit > 0 ? Math.min(rawLimit, MAX_LIMIT) : DEFAULT_LIMIT,
    offset: Number.isFinite(rawOffset) && rawOffset > 0 ? Math.floor(rawOffset) : 0,
  };
}

/**
 * Resolves a caller-supplied sort key against an allow-list.
 *
 * The value lands in the SQL as a literal — it cannot be parameterised, because
 * an ORDER BY target is not a value — so it must never be caller-controlled
 * text. Mapping through a fixed table is what makes that safe: an unrecognised
 * key silently becomes the default rather than reaching the query.
 */
export function readSort(
  req: Request,
  columns: Record<string, string>,
  fallback: string,
): { orderBy: string; sort: string; dir: "asc" | "desc" } {
  const key = String(req.query.sort ?? "");
  const sort = key in columns ? key : fallback;
  const dir = String(req.query.dir ?? "desc").toLowerCase() === "asc" ? "asc" : "desc";
  return { orderBy: `${columns[sort]} ${dir.toUpperCase()} NULLS LAST`, sort, dir };
}

/** A `?range=` window, clamped so nobody can ask for an unbounded table scan. */
export function readRangeDays(req: Request, fallback = 7): number {
  const n = Number(req.query.days);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.min(Math.floor(n), 365);
}
