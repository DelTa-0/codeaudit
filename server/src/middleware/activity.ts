import type { Request, Response, NextFunction } from "express";
import { query } from "../db/pool.js";
import { requestContext, normalizePath, type RequestContext } from "../lib/requestContext.js";

const MUTATING = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/**
 * Paths whose mutations are not worth an audit row of their own. Webhooks are
 * machine traffic with no actor and arrive at volume; their interesting
 * outcomes are recorded as system events by the handlers instead. CLI scan
 * uploads already write a semantic `scan.cli_uploaded` entry, which the flush
 * below prefers over the generic one anyway.
 */
const SKIP_PREFIXES = ["/api/webhooks", "/api/health"];

/**
 * Opens a request-scoped context and writes the activity log when the response
 * finishes.
 *
 * Two kinds of row come out of this:
 *
 *  - a **semantic** entry, when a route called `logAudit` ("repo.connected",
 *    "member.removed"). Those carry the domain meaning, and this middleware
 *    decorates them with the request that produced them.
 *  - a **generic** entry for any other mutating request, so the log is complete
 *    rather than only covering the routes someone remembered to instrument.
 *
 * A request that produced a semantic entry does *not* also get a generic one —
 * one action, one row.
 *
 * Reads are never recorded. They are the overwhelming majority of traffic, they
 * would bury the signal, and "who viewed what" is a different feature with
 * different retention obligations.
 */
export function trackActivity(req: Request, res: Response, next: NextFunction) {
  const startedAt = Date.now();
  const ctx: RequestContext = {
    method: req.method,
    path: normalizePath(req.originalUrl || req.path),
    ip: req.ip ?? null,
    // Bounded: a User-Agent is caller-controlled and has no useful length limit
    // of its own.
    userAgent: (req.get("user-agent") ?? "").slice(0, 300) || null,
    entries: [],
  };

  res.on("finish", () => {
    void flush(ctx, req, res.statusCode, Date.now() - startedAt);
  });

  requestContext.run(ctx, next);
}

async function flush(ctx: RequestContext, req: Request, status: number, durationMs: number) {
  const skip = SKIP_PREFIXES.some((p) => ctx.path.startsWith(p));
  if (skip) return;

  const userId = req.user?.id ?? null;
  const rows = ctx.entries.length
    ? ctx.entries
    : MUTATING.has(ctx.method)
      ? [
          {
            orgId: req.orgId ?? null,
            userId,
            // `METHOD /normalized/path` for the uninstrumented case. It reads
            // as what it is — a raw HTTP fact rather than a domain event — so
            // the two kinds stay tellable apart in the log view.
            action: `${ctx.method} ${ctx.path}`,
            target: null,
            metadata: null,
          },
        ]
      : [];
  if (!rows.length) return;

  try {
    for (const entry of rows) {
      await query(
        `INSERT INTO audit_log
           (org_id, user_id, action, target, metadata, ip, user_agent, method, path, status, duration_ms)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
        [
          entry.orgId,
          // A route may name the actor explicitly (an unauthenticated invite
          // acceptance, a webhook-driven change); otherwise it is whoever the
          // request authenticated as.
          entry.userId ?? userId,
          entry.action,
          entry.target,
          entry.metadata ? JSON.stringify(entry.metadata) : null,
          ctx.ip,
          ctx.userAgent,
          ctx.method,
          ctx.path,
          status,
          durationMs,
        ],
      );
    }
  } catch (err) {
    console.error("audit_log insert failed", err);
  }
}
