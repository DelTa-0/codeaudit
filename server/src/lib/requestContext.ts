import { AsyncLocalStorage } from "node:async_hooks";

/** A semantic audit entry a route asked for, held until the response finishes. */
export interface PendingAuditEntry {
  orgId: string | null;
  userId: string | null;
  action: string;
  target: string | null;
  metadata: Record<string, unknown> | null;
}

export interface RequestContext {
  method: string;
  path: string;
  ip: string | null;
  userAgent: string | null;
  entries: PendingAuditEntry[];
}

/**
 * Carries the current HTTP request alongside the call stack, so `logAudit` can
 * enrich an entry with the request that caused it without every one of its
 * ~20 call sites having to thread a `req` through.
 *
 * Entries are *queued* rather than inserted, because the two most useful fields
 * — response status and duration — do not exist yet when a route calls
 * `logAudit` mid-request. The activity middleware flushes them on `finish`.
 *
 * Outside a request (the worker, the Stripe webhook processor) there is no
 * store, and `logAudit` falls back to inserting immediately.
 */
export const requestContext = new AsyncLocalStorage<RequestContext>();

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * Collapses identifiers out of a path so activity groups by *route* rather than
 * by instance. Without this, "how often does anyone delete a repo" is
 * unanswerable because every delete has a distinct action string.
 */
export function normalizePath(path: string): string {
  return path
    .split("?")[0]
    .split("/")
    .map((seg) => {
      if (!seg) return seg;
      if (UUID.test(seg)) return ":id";
      if (/^\d+$/.test(seg)) return ":n";
      // Opaque high-entropy segments (CLI and badge tokens ride in the path).
      if (seg.length >= 24 && /^[A-Za-z0-9_-]+$/.test(seg) && /\d/.test(seg)) return ":token";
      return seg;
    })
    .join("/");
}
