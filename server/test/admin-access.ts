// The admin console's security boundary, as executable assertions.
//
// This is the test that matters most in the whole feature. An admin panel that
// works is unremarkable; an admin panel that a non-admin can reach is the worst
// bug the product could ship. Every claim the design makes about access is
// checked here against a running API, not reasoned about.
//
// Run: npm run test:admin-access   (needs docker compose up -d, the API on
// :4000, and migrations applied)
import bcrypt from "bcryptjs";
import { query, queryOne, pool } from "../src/db/pool.js";

const API = process.env.API_URL ?? "http://localhost:4000";
const stamp = `admin-test-${process.pid}-${Date.now()}`;
const PASSWORD = "correct-horse-battery-staple";

const checks: [string, boolean][] = [];
const check = (label: string, ok: boolean) => checks.push([label, ok]);

/** Creates a user directly, bypassing the registration rate limiter. */
async function makeUser(suffix: string, platformRole: "user" | "admin") {
  const email = `${stamp}-${suffix}@example.test`;
  const hash = await bcrypt.hash(PASSWORD, 10);
  const [user] = await query<{ id: string }>(
    "INSERT INTO users (email, password_hash, platform_role) VALUES ($1, $2, $3) RETURNING id",
    [email, hash, platformRole],
  );
  const [org] = await query<{ id: string }>(
    "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
    [`${suffix} workspace`, `${stamp}-${suffix}`],
  );
  // 'owner' is the highest ORG role there is. Handing it out here is the point
  // of the test: it must buy exactly nothing on the platform axis.
  await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
    org.id,
    user.id,
  ]);
  return { id: user.id, email, orgId: org.id };
}

async function login(email: string): Promise<string> {
  const res = await fetch(`${API}/api/auth/login`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ email, password: PASSWORD }),
  });
  const body = (await res.json()) as { token?: string; error?: string };
  if (!body.token) throw new Error(`login failed for ${email}: ${body.error ?? res.status}`);
  return body.token;
}

function callAdmin(path: string, token: string | null, init: RequestInit = {}) {
  return fetch(`${API}/api/admin${path}`, {
    ...init,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...(init.headers ?? {}),
    },
  });
}

/** Walks a response body looking for any key that should never leave the server. */
function findLeakedSecret(value: unknown, path = "$"): string | null {
  const FORBIDDEN = [
    "password_hash",
    "passwordHash",
    "cli_token",
    "badge_token",
    "stripe_customer_id",
    "stripe_subscription_id",
    "webhook_secret",
    "private_key",
  ];
  if (Array.isArray(value)) {
    for (const [i, item] of value.entries()) {
      const hit = findLeakedSecret(item, `${path}[${i}]`);
      if (hit) return hit;
    }
    return null;
  }
  if (value && typeof value === "object") {
    for (const [key, child] of Object.entries(value)) {
      if (FORBIDDEN.includes(key)) return `${path}.${key}`;
      const hit = findLeakedSecret(child, `${path}.${key}`);
      if (hit) return hit;
    }
  }
  return null;
}

const plain = await makeUser("plain", "user");
const admin = await makeUser("admin", "admin");
const victim = await makeUser("victim", "user");

const plainToken = await login(plain.email);
const adminToken = await login(admin.email);

// --- the boundary itself ---------------------------------------------------
const ADMIN_ROUTES = [
  "/overview",
  "/users",
  "/orgs",
  "/activity",
  "/events",
  "/processes",
  "/health",
];

const anonStatuses = await Promise.all(
  ADMIN_ROUTES.map((r) => callAdmin(r, null).then((res) => res.status)),
);
check(
  "an unauthenticated caller is refused from every admin route",
  anonStatuses.every((s) => s === 401 || s === 404),
);

const plainStatuses = await Promise.all(
  ADMIN_ROUTES.map((r) => callAdmin(r, plainToken).then((res) => res.status)),
);
// 404, not 403: a 403 would confirm the namespace exists and that the caller
// merely lacks a role, which is a free hint to anyone probing.
check(
  "an ordinary user gets 404 from every admin route (not 403 — the namespace stays undiscoverable)",
  plainStatuses.every((s) => s === 404),
);

// The whole reason platform_role is a separate axis: org 'owner' is the highest
// role the product hands out, and every one of these users has it.
check(
  "being an org owner grants nothing on the platform axis",
  plainStatuses.every((s) => s === 404),
);

const adminStatuses = await Promise.all(
  ADMIN_ROUTES.map((r) => callAdmin(r, adminToken).then((res) => res.status)),
);
check(
  "a platform admin reaches every admin route",
  adminStatuses.every((s) => s === 200),
);

// --- the role is read from the database, not from the token ----------------
await query("UPDATE users SET platform_role = 'admin' WHERE id = $1", [plain.id]);
const promoted = await callAdmin("/overview", plainToken);
check(
  "a promotion takes effect on the existing token — the role is not a JWT claim",
  promoted.status === 200,
);
await query("UPDATE users SET platform_role = 'user' WHERE id = $1", [plain.id]);
const demoted = await callAdmin("/overview", plainToken);
check(
  "a revocation takes effect immediately, without waiting for the token to expire",
  demoted.status === 404,
);

// --- suspension ------------------------------------------------------------
await query("UPDATE users SET suspended_at = now() WHERE id = $1", [plain.id]);
const suspendedCall = await fetch(`${API}/api/auth/me`, {
  headers: { authorization: `Bearer ${plainToken}` },
});
check(
  "a suspended account is refused on its next request, not at its next login",
  suspendedCall.status === 403,
);
await query("UPDATE users SET suspended_at = NULL WHERE id = $1", [plain.id]);

// --- step-up confirmation on privileged actions ----------------------------
const noPassword = await callAdmin(`/users/${victim.id}/role`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ platformRole: "admin" }),
});
check(
  "granting platform admin without the password confirmation is refused",
  noPassword.status === 400,
);

const wrongPassword = await callAdmin(`/users/${victim.id}/role`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ platformRole: "admin", password: "not-the-password" }),
});
check("granting platform admin with a wrong password is refused", wrongPassword.status === 401);

const victimAfterFailures = await queryOne<{ platform_role: string }>(
  "SELECT platform_role FROM users WHERE id = $1",
  [victim.id],
);
check(
  "neither refused attempt changed anything",
  victimAfterFailures?.platform_role === "user",
);

const selfDemote = await callAdmin(`/users/${admin.id}/role`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ platformRole: "user", password: PASSWORD }),
});
check(
  "an admin cannot revoke their own role — that is how you end up with zero operators",
  selfDemote.status === 403,
);

const selfSuspend = await callAdmin(`/users/${admin.id}/suspension`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ suspended: true, password: PASSWORD }),
});
check("an admin cannot suspend their own account", selfSuspend.status === 403);

const grant = await callAdmin(`/users/${victim.id}/role`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ platformRole: "admin", password: PASSWORD, reason: "test" }),
});
const victimRole = await queryOne<{ platform_role: string }>(
  "SELECT platform_role FROM users WHERE id = $1",
  [victim.id],
);
check(
  "a correctly confirmed grant succeeds",
  grant.status === 200 && victimRole?.platform_role === "admin",
);

const suspendPeer = await callAdmin(`/users/${victim.id}/suspension`, adminToken, {
  method: "PATCH",
  body: JSON.stringify({ suspended: true, password: PASSWORD }),
});
check(
  "suspending a fellow operator is refused until their role is revoked first",
  suspendPeer.status === 403,
);

// --- the privileged action is itself audited -------------------------------
const audited = await queryOne<{ n: string }>(
  `SELECT count(*)::text AS n FROM audit_log
   WHERE action = 'admin.platform_role_changed' AND user_id = $1 AND target = $2`,
  [admin.id, victim.email],
);
check("the grant was written to the audit log", audited?.n === "1");

// --- the log cannot be erased from the panel -------------------------------
const deleteAttempts = await Promise.all(
  [
    callAdmin("/activity", adminToken, { method: "DELETE" }),
    callAdmin("/events", adminToken, { method: "DELETE" }),
  ].map((p) => p.then((r) => r.status)),
);
check(
  "there is no endpoint that deletes log entries, even for an admin",
  deleteAttempts.every((s) => s === 404),
);

// --- data minimisation -----------------------------------------------------
const bodies = await Promise.all(
  ["/users", "/orgs", "/activity", "/events", "/processes"].map((r) =>
    callAdmin(r, adminToken).then((res) => res.json()),
  ),
);
const leaks = bodies.map((b) => findLeakedSecret(b)).filter(Boolean);
check(
  `no admin response carries a credential or billing identifier${leaks.length ? ` (found ${leaks.join(", ")})` : ""}`,
  leaks.length === 0,
);

const userDetail = await callAdmin(`/users/${victim.id}`, adminToken).then((r) => r.json());
check(
  "the user detail response carries no password hash",
  findLeakedSecret(userDetail) === null,
);

// --- pagination is bounded -------------------------------------------------
const huge = await callAdmin("/users?limit=100000", adminToken).then(
  (r) => r.json() as Promise<{ limit: number }>,
);
check("a caller cannot ask for an unbounded page", huge.limit <= 200);

// --- cleanup ---------------------------------------------------------------
await query("DELETE FROM audit_log WHERE user_id = ANY($1)", [[plain.id, admin.id, victim.id]]);
await query("DELETE FROM system_events WHERE user_id = ANY($1)", [[plain.id, admin.id, victim.id]]);
await query("DELETE FROM users WHERE email LIKE $1", [`${stamp}%`]);
await query("DELETE FROM organizations WHERE slug LIKE $1", [`${stamp}%`]);

console.log("--- admin access control ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
await pool.end();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
