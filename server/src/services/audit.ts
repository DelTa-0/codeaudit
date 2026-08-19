import { query } from "../db/pool.js";
import { requestContext } from "../lib/requestContext.js";

/**
 * Records what a *person* did. (What the software did goes to
 * services/systemEvents.ts — different question, different reader.)
 *
 * Inside an HTTP request the entry is queued on the request context rather than
 * inserted here, so the activity middleware can attach the response status,
 * duration, IP, and user agent when the request finishes. Called from the
 * worker or a webhook processor, where there is no request, it inserts
 * immediately.
 *
 * Audit logging must never break the path it is auditing, so every failure is
 * reported to stderr and swallowed.
 */
export async function logAudit(
  orgId: string | null,
  userId: string | null,
  action: string,
  target?: string,
  metadata?: Record<string, unknown>,
) {
  const ctx = requestContext.getStore();
  if (ctx) {
    ctx.entries.push({
      orgId,
      userId,
      action,
      target: target ?? null,
      metadata: metadata ?? null,
    });
    return;
  }
  try {
    await query(
      "INSERT INTO audit_log (org_id, user_id, action, target, metadata) VALUES ($1, $2, $3, $4, $5)",
      [orgId, userId, action, target ?? null, metadata ? JSON.stringify(metadata) : null],
    );
  } catch (err) {
    console.error("audit_log insert failed", err);
  }
}
