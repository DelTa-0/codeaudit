// The magic-link routes against a running API.
//
// magic-link.ts covers the token logic; this covers the claims that only exist
// at the HTTP boundary. The important one is that `signin-link` answers
// identically for an address that exists and one that does not — the whole
// reason the signup form was removed rather than patched. That claim cannot be
// checked from inside the module, because it is a statement about what a
// stranger can observe.
//
// Run: npm run test:magic-link-api   (needs docker compose up -d, the API on
// :4000, and migrations applied)
import bcrypt from "bcryptjs";
import { query, queryOne, pool } from "../src/db/pool.js";
import { issueSignInToken } from "../src/lib/emailTokens.js";

const API = process.env.API_URL ?? "http://localhost:4000";
const stamp = `mlapi-${process.pid}-${Date.now()}`;
const known = `${stamp}-known@example.test`;
const unknown = `${stamp}-unknown@example.test`;

const checks: [string, boolean][] = [];

// A real account for the "known address" side of the comparison.
const [user] = await query<{ id: string }>(
  "INSERT INTO users (email, password_hash) VALUES ($1, $2) RETURNING id",
  [known, await bcrypt.hash("correct-horse-battery", 10)],
);
const [org] = await query<{ id: string }>(
  "INSERT INTO organizations (name, slug) VALUES ($1, $1) RETURNING id",
  [stamp],
);
await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
  org.id,
  user.id,
]);

const post = (path: string, body: unknown, token?: string) =>
  fetch(`${API}/api/auth${path}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: JSON.stringify(body),
  });

// --- the enumeration claim -----------------------------------------------
const resKnown = await post("/signin-link", { email: known });
const resUnknown = await post("/signin-link", { email: unknown });
const bodyKnown = await resKnown.text();
const bodyUnknown = await resUnknown.text();

checks.push(
  ["signin-link accepts a known address", resKnown.status === 202],
  ["signin-link accepts an unknown address", resUnknown.status === 202],
  ["both return the same status", resKnown.status === resUnknown.status],
  [
    // The point of the whole design. If these ever differ, account enumeration
    // is back and nothing else in this feature compensates for it.
    "both return a byte-identical body",
    bodyKnown === bodyUnknown,
  ],
  ["neither body mentions the address", !bodyKnown.includes(known) && !bodyUnknown.includes(unknown)],
);

// --- the register route is gone ------------------------------------------
// Asserted by consequence rather than by status code. An unmatched path under
// /api meets an auth middleware before it can 404, so the route answers 401 —
// which says nothing about whether it still works. What matters is that no
// address can talk its way into an account without a mailbox.
const goneAddr = `${stamp}-viaregister@example.test`;
const registerGone = await post("/register", { email: goneAddr, password: "hunter2hunter2" });
const registerCreated = await queryOne("SELECT id FROM users WHERE email = $1", [goneAddr]);
checks.push(
  ["POST /auth/register does not succeed", !registerGone.ok],
  ["POST /auth/register creates no account", registerCreated === null],
);

// --- the cooldown is silent ----------------------------------------------
const again = await post("/signin-link", { email: known });
checks.push([
  // Answering "too soon" only for real addresses would be the oracle again,
  // wearing a helpful message.
  "a request inside the cooldown is indistinguishable from the first",
  again.status === 202 && (await again.text()) === bodyKnown,
]);

// --- signing in with a token ---------------------------------------------
const issued = await issueSignInToken(known);
const verify = await post("/signin-verify", { token: issued.token });
const verified = (await verify.json()) as { token?: string; mustSetPassword?: boolean };
checks.push(
  ["a valid token signs in", verify.status === 200 && typeof verified.token === "string"],
  ["an account with a password is not asked to set one", verified.mustSetPassword === false],
);

const replay = await post("/signin-verify", { token: issued.token });
checks.push(["a replayed token is refused", replay.status === 401]);

const bogus = await post("/signin-verify", { token: "x".repeat(40) });
const bogusBody = await bogus.text();
checks.push(
  ["an unknown token is refused", bogus.status === 401],
  [
    "the refusal does not say why",
    !/expired|consumed|attempt/i.test(bogusBody),
  ],
);

// --- set-password requires a session -------------------------------------
const anon = await post("/set-password", { password: "a-new-password" });
checks.push(["set-password rejects an anonymous caller", anon.status === 401]);

const short = await post("/set-password", { password: "short" }, verified.token);
checks.push(["set-password rejects a password under 8 characters", short.status === 400]);

const setOk = await post("/set-password", { password: "a-brand-new-password" }, verified.token);
checks.push(["set-password accepts a valid password", setOk.status === 200]);

const loginAfter = await fetch(`${API}/api/auth/login`, {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ email: known, password: "a-brand-new-password" }),
});
checks.push([
  "the login form works with the newly set password",
  loginAfter.status === 200,
]);

// --- a link creates the account for a genuinely new address --------------
const newIssued = await issueSignInToken(unknown);
const newVerify = await post("/signin-verify", { token: newIssued.token });
const newBody = (await newVerify.json()) as { mustSetPassword?: boolean };
const createdUser = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = $1", [unknown]);
checks.push(
  ["a new address is signed in", newVerify.status === 200],
  ["the account now exists", createdUser !== null],
  ["it is asked to set a password", newBody.mustSetPassword === true],
);

// --- cleanup --------------------------------------------------------------
await query("DELETE FROM email_tokens WHERE email LIKE $1", [`${stamp}%`]);
await query(
  `DELETE FROM organizations WHERE id IN (
     SELECT m.org_id FROM org_members m JOIN users u ON u.id = m.user_id
      WHERE u.email LIKE $1)`,
  [`${stamp}%`],
);
await query("DELETE FROM organizations WHERE id = $1", [org.id]);
await query("DELETE FROM users WHERE email LIKE $1", [`${stamp}%`]);

console.log("--- magic link (api) ---");
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
