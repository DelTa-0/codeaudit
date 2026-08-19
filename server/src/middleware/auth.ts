import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../lib/config.js";
import { unauthorized, forbidden, notFound } from "../lib/errors.js";
import { query, queryOne } from "../db/pool.js";

export interface AuthUser {
  id: string;
  email: string;
  /** "user" | "admin". Read from the database per request, never from the token. */
  platformRole?: string;
}

declare module "express-serve-static-core" {
  interface Request {
    user?: AuthUser;
    orgRole?: string;
    orgId?: string;
  }
}

// Pin the algorithm on both sides. jsonwebtoken already refuses `alg:none`
// when a secret is supplied, but an explicit allow-list is the belt-and-braces
// a security reviewer looks for: it closes any future algorithm-confusion
// (e.g. an attacker-supplied `alg` the library might otherwise honour) by
// construction, not by trusting the library's default.
const JWT_ALG = "HS256" as const;

export function signToken(user: AuthUser): string {
  return jwt.sign({ sub: user.id, email: user.email }, config.jwtSecret, {
    expiresIn: "7d",
    algorithm: JWT_ALG,
  });
}

/** How stale a user's presence may get before we spend a write refreshing it. */
const PRESENCE_THROTTLE = "2 minutes";

export async function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized());
  let userId: string;
  let email: string;
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret, {
      algorithms: [JWT_ALG],
    }) as jwt.JwtPayload;
    userId = String(payload.sub);
    email = String(payload.email);
  } catch {
    return next(unauthorized("Invalid or expired token"));
  }

  try {
    // One primary-key read that earns its place three times over: it is the
    // only fresh source of platform_role (a JWT claim would keep a revoked
    // admin privileged for the remaining life of their 7-day token), it makes
    // suspension effective on the account's *next request* rather than its next
    // login, and it carries the presence timestamp that answers "who is using
    // this right now" without a session store.
    const row = await queryOne<{
      email: string;
      platform_role: string;
      suspended_at: Date | null;
      stale: boolean;
    }>(
      `SELECT email, platform_role, suspended_at,
              (last_seen_at IS NULL OR last_seen_at < now() - interval '${PRESENCE_THROTTLE}') AS stale
       FROM users WHERE id = $1`,
      [userId],
    );
    // A token for a deleted account is not a valid identity.
    if (!row) return next(unauthorized("Invalid or expired token"));
    if (row.suspended_at)
      return next(forbidden("This account has been suspended. Contact support."));

    req.user = { id: userId, email: row.email || email, platformRole: row.platform_role };

    if (row.stale) {
      // Fire-and-forget: presence is a nice-to-have, and making every request
      // wait on a write to record that it happened is a bad trade.
      void query("UPDATE users SET last_seen_at = now() WHERE id = $1", [userId]).catch(() => {});
    }
    next();
  } catch (err) {
    next(err);
  }
}

/**
 * The platform-operator gate. Mounted on the /api/admin router itself rather
 * than route-by-route, so an endpoint added to that file is protected by
 * construction instead of by the author remembering to add a guard.
 *
 * Answers a non-admin with 404, not 403: a 403 confirms the namespace exists
 * and that the caller merely lacks a role, which is a free hint to anyone
 * probing. The admin surface should not be discoverable from outside.
 */
export function requirePlatformAdmin(req: Request, _res: Response, next: NextFunction) {
  if (req.user?.platformRole !== "admin") return next(notFound());
  next();
}

const roleRank: Record<string, number> = { developer: 1, admin: 2, owner: 3 };

/** Loads the caller's membership for req.params[param] and enforces a minimum role. */
export function requireOrgRole(minRole: "developer" | "admin" | "owner", param = "orgId") {
  return async (req: Request, _res: Response, next: NextFunction) => {
    try {
      const orgId = req.params[param];
      if (!orgId) return next(notFound("Organization not found"));
      const member = await queryOne<{ role: string }>(
        "SELECT role FROM org_members WHERE org_id = $1 AND user_id = $2",
        [orgId, req.user!.id],
      );
      if (!member) return next(notFound("Organization not found"));
      if (roleRank[member.role] < roleRank[minRole])
        return next(forbidden(`Requires ${minRole} role`));
      req.orgRole = member.role;
      req.orgId = orgId;
      next();
    } catch (err) {
      next(err);
    }
  };
}
