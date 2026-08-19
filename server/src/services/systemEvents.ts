import { query } from "../db/pool.js";

export type EventLevel = "debug" | "info" | "warn" | "error";
export type EventSource = "api" | "worker" | "queue" | "webhook" | "billing" | "llm" | "auth";

export interface SystemEventInput {
  level?: EventLevel;
  source: EventSource;
  /** Stable dotted key — "scan.failed", "queue.job.stalled". Group and count on this. */
  event: string;
  message: string;
  /** Structured detail. Rendered verbatim in the admin panel: put nothing secret here. */
  context?: Record<string, unknown>;
  orgId?: string | null;
  userId?: string | null;
  scanJobId?: string | null;
}

/**
 * Records what the software did, as opposed to what a person did (that is
 * audit_log). Until this existed, a failed scan, a stalled job, or an LLM
 * fallback reached console.error on one machine and was gone the moment the
 * container was replaced — which is exactly when you want to read it.
 *
 * Never throws and never rejects. An observability write that can break the
 * thing it observes is worse than no observability, so failures are reported to
 * stderr and swallowed.
 */
export async function logEvent(input: SystemEventInput): Promise<void> {
  const level = input.level ?? "info";
  try {
    await query(
      `INSERT INTO system_events (level, source, event, message, context, org_id, user_id, scan_job_id)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
      [
        level,
        input.source,
        input.event,
        // The column is TEXT with no length limit, but a runaway stack trace or
        // a stringified payload would make the log unreadable in the panel and
        // bloat the table. The full detail belongs in `context`.
        input.message.slice(0, 2000),
        input.context ? JSON.stringify(input.context) : null,
        input.orgId ?? null,
        input.userId ?? null,
        input.scanJobId ?? null,
      ],
    );
  } catch (err) {
    console.error("system_events insert failed", err);
  }
}

/** Convenience for the overwhelmingly common case: something went wrong. */
export function logError(
  source: EventSource,
  event: string,
  err: unknown,
  extra: Omit<SystemEventInput, "level" | "source" | "event" | "message"> = {},
): Promise<void> {
  const message = err instanceof Error ? err.message : String(err);
  return logEvent({
    level: "error",
    source,
    event,
    message,
    ...extra,
    context: {
      ...extra.context,
      // The stack is the part you actually need at 3am, but it is long, so it
      // rides in context rather than in the message column the list view shows.
      stack: err instanceof Error ? err.stack?.split("\n").slice(0, 12).join("\n") : undefined,
    },
  });
}
