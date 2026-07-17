import { query } from "../db/pool.js";

export async function logAudit(
  orgId: string,
  userId: string | null,
  action: string,
  target?: string,
  metadata?: Record<string, unknown>,
) {
  try {
    await query(
      "INSERT INTO audit_log (org_id, user_id, action, target, metadata) VALUES ($1, $2, $3, $4, $5)",
      [orgId, userId, action, target ?? null, metadata ? JSON.stringify(metadata) : null],
    );
  } catch (err) {
    // Audit logging must never break the main request path.
    console.error("audit_log insert failed", err);
  }
}
