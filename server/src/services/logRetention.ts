import { query } from "../db/pool.js";
import { config } from "../lib/config.js";
import { logEvent } from "./systemEvents.js";

const SWEEP_INTERVAL_MS = 6 * 60 * 60_000; // four times a day

/**
 * Ages logs out of Postgres.
 *
 * An unbounded log table is a slow-motion outage: it is fine for months, then
 * the disk fills or the index stops fitting in cache and every query in the
 * admin panel falls off a cliff at once. Deleting on a schedule is the boring
 * fix, and doing it in the worker keeps it off the request path.
 *
 * The two tables get different windows on purpose. `audit_log` is the record of
 * who did what and is the one you go back to months later; `system_events` is
 * operational exhaust that stops being interesting within days.
 *
 * Deletes are chunked so a first run against a long-neglected table cannot take
 * a lock long enough to matter.
 */
const CHUNK = 5_000;

async function sweepTable(table: "audit_log" | "system_events", days: number): Promise<number> {
  let removed = 0;
  for (;;) {
    // Table name is a literal from the union type above, never user input.
    const rows = await query<{ id: string }>(
      `DELETE FROM ${table}
       WHERE id IN (
         SELECT id FROM ${table} WHERE created_at < now() - ($1 || ' days')::interval LIMIT ${CHUNK}
       ) RETURNING id`,
      [String(days)],
    );
    removed += rows.length;
    if (rows.length < CHUNK) return removed;
  }
}

export async function sweepLogs(): Promise<{ auditLog: number; systemEvents: number }> {
  const auditLog = await sweepTable("audit_log", config.retention.auditLogDays);
  const systemEvents = await sweepTable("system_events", config.retention.systemEventDays);
  if (auditLog || systemEvents) {
    await logEvent({
      source: "worker",
      event: "logs.swept",
      message: `Retention sweep removed ${auditLog} audit and ${systemEvents} system rows`,
      context: {
        auditLog,
        systemEvents,
        auditLogDays: config.retention.auditLogDays,
        systemEventDays: config.retention.systemEventDays,
      },
    });
  }
  return { auditLog, systemEvents };
}

export function startLogRetention(): NodeJS.Timeout {
  const run = () =>
    void sweepLogs().catch((err) => console.error("log retention sweep failed", err));
  // Delayed rather than immediate: a worker restart loop should not turn into a
  // delete loop, and nothing about retention is urgent.
  const timer = setInterval(run, SWEEP_INTERVAL_MS);
  timer.unref();
  return timer;
}
