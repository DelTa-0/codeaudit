import type { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { config } from "../lib/config.js";
import { unauthorized, forbidden, notFound } from "../lib/errors.js";
import { queryOne } from "../db/pool.js";

export interface AuthUser {
  id: string;
  email: string;
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

export function requireAuth(req: Request, _res: Response, next: NextFunction) {
  const header = req.headers.authorization;
  if (!header?.startsWith("Bearer ")) return next(unauthorized());
  try {
    const payload = jwt.verify(header.slice(7), config.jwtSecret, {
      algorithms: [JWT_ALG],
    }) as jwt.JwtPayload;
    req.user = { id: String(payload.sub), email: String(payload.email) };
    next();
  } catch {
    next(unauthorized("Invalid or expired token"));
  }
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
