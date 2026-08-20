// Magic-link signup, against a real database — because the behaviour under test
// is mostly what the SQL is allowed to do: which rows a click may consume, how
// many wrong codes a row survives, and whether an account gets created at all.
//
// The checks that matter most are the negative ones. A magic link is a bearer
// credential mailed in plaintext to a third party's infrastructure; the value of
// the design rests entirely on it being short-lived, single-use, and impossible
// to guess by brute force. Each of those is a line of code that could be
// deleted without any positive test noticing.
//
// Run: npm run test:magic-link   (needs docker compose up -d postgres)
import { createHash } from "node:crypto";
import { query, queryOne, pool } from "../src/db/pool.js";
import {
  issueSignInToken,
  consumeSignInToken,
  MAX_CODE_ATTEMPTS,
  SIGNIN_TOKEN_TTL_MS,
} from "../src/lib/emailTokens.js";

const checks: [string, boolean][] = [];
const suffix = process.pid;
const addr = (n: string) => `magic-${n}-${suffix}@example.test`;

const sha = (v: string) => createHash("sha256").update(v).digest("hex");

// --- a brand-new address creates nothing until the link is clicked ---------
const fresh = addr("fresh");
const issued = await issueSignInToken(fresh);

const beforeUser = await queryOne("SELECT id FROM users WHERE email = $1", [fresh]);
checks.push(
  ["issuing a link creates no user", beforeUser === null],
  ["the issued token is returned to the caller once", typeof issued.token === "string" && issued.token.length > 20],
  ["a 6-digit code is issued", /^\d{6}$/.test(issued.code)],
);

// --- the stored row must not contain the credential -----------------------
const row = await queryOne<{ token_hash: string; code_hash: string }>(
  "SELECT token_hash, code_hash FROM email_tokens WHERE email = $1",
  [fresh],
);
checks.push(
  ["the raw token is not stored", row?.token_hash !== issued.token],
  ["the raw code is not stored", row?.code_hash !== issued.code],
  ["the token is stored as its sha256", row?.token_hash === sha(issued.token)],
  [
    "no column anywhere in the row contains the raw token",
    !JSON.stringify(
      await queryOne("SELECT * FROM email_tokens WHERE email = $1", [fresh]),
    ).includes(issued.token),
  ],
);

// --- clicking the link creates the account, its org, and the membership ---
const created = await consumeSignInToken({ token: issued.token });
checks.push(
  ["consuming a token for a new address succeeds", created.ok === true],
  ["a user is created", created.ok && typeof created.user.id === "string"],
  ["the new account has no password yet", created.ok && created.mustSetPassword === true],
);

const orgCount = await queryOne<{ n: string }>(
  `SELECT count(*)::text AS n FROM org_members m
     JOIN users u ON u.id = m.user_id
    WHERE u.email = $1 AND m.role = 'owner'`,
  [fresh],
);
checks.push(["the new user owns exactly one organization", orgCount?.n === "1"]);

// --- single use -----------------------------------------------------------
const replay = await consumeSignInToken({ token: issued.token });
checks.push(["a consumed token is rejected on second use", replay.ok === false]);

// --- a second request invalidates the first link --------------------------
const rotating = addr("rotate");
const first = await issueSignInToken(rotating);
const second = await issueSignInToken(rotating);
const firstAfter = await consumeSignInToken({ token: first.token });
const secondAfter = await consumeSignInToken({ token: second.token });
checks.push(
  ["issuing a new link invalidates the previous one", firstAfter.ok === false],
  ["the newest link still works", secondAfter.ok === true],
);

// --- expiry ---------------------------------------------------------------
const stale = addr("stale");
const staleToken = await issueSignInToken(stale);
await query("UPDATE email_tokens SET expires_at = now() - interval '1 second' WHERE email = $1", [stale]);
const staleResult = await consumeSignInToken({ token: staleToken.token });
checks.push(
  ["an expired token is rejected", staleResult.ok === false],
  ["the TTL is short enough to be a sign-in credential, not an activation one", SIGNIN_TOKEN_TTL_MS <= 20 * 60_000],
);

// --- the code path, and its brute-force guard -----------------------------
const coded = addr("coded");
const codedToken = await issueSignInToken(coded);
const wrongCode = codedToken.code === "000000" ? "111111" : "000000";

let rejectedAll = true;
for (let i = 0; i < MAX_CODE_ATTEMPTS; i++) {
  const r = await consumeSignInToken({ email: coded, code: wrongCode });
  if (r.ok) rejectedAll = false;
}
const afterBurn = await consumeSignInToken({ email: coded, code: codedToken.code });
checks.push(
  ["wrong codes are rejected", rejectedAll],
  [
    // The check the whole 6-digit design depends on. Without it the code is a
    // million-guess credential with unlimited guesses, i.e. not a credential.
    "the correct code fails once the attempt limit is spent",
    afterBurn.ok === false,
  ],
);

const ok = addr("okcode");
const okToken = await issueSignInToken(ok);
await consumeSignInToken({ email: ok, code: okToken.code === "000000" ? "111111" : "000000" });
const okResult = await consumeSignInToken({ email: ok, code: okToken.code });
checks.push(["a correct code within the limit succeeds", okResult.ok === true]);

// --- an existing account is signed in, not duplicated ---------------------
const repeat = await issueSignInToken(fresh);
const repeatResult = await consumeSignInToken({ token: repeat.token });
const userCount = await queryOne<{ n: string }>(
  "SELECT count(*)::text AS n FROM users WHERE email = $1",
  [fresh],
);
checks.push(
  ["a known address signs in rather than erroring", repeatResult.ok === true],
  ["no second user is created for a known address", userCount?.n === "1"],
  [
    "the token records which user it signed in",
    (await queryOne<{ user_id: string | null }>(
      "SELECT user_id FROM email_tokens WHERE token_hash = $1",
      [sha(repeat.token)],
    ))?.user_id !== null,
  ],
);

// --- mustSetPassword reflects reality ------------------------------------
await query("UPDATE users SET password_hash = 'x' WHERE email = $1", [fresh]);
const withPassword = await issueSignInToken(fresh);
const withPasswordResult = await consumeSignInToken({ token: withPassword.token });
checks.push([
  "an account that already has a password is not asked to set one",
  withPasswordResult.ok === true && withPasswordResult.mustSetPassword === false,
]);

// --- a garbage token is rejected without throwing -------------------------
const nonsense = await consumeSignInToken({ token: "not-a-real-token" });
checks.push(["an unknown token is rejected, not an error", nonsense.ok === false]);

// --- cleanup --------------------------------------------------------------
await query("DELETE FROM email_tokens WHERE email LIKE $1", [`magic-%-${suffix}@example.test`]);
await query(
  `DELETE FROM organizations WHERE id IN (
     SELECT m.org_id FROM org_members m
       JOIN users u ON u.id = m.user_id
      WHERE u.email LIKE $1)`,
  [`magic-%-${suffix}@example.test`],
);
await query("DELETE FROM users WHERE email LIKE $1", [`magic-%-${suffix}@example.test`]);

console.log("--- magic link ---");
let failed = 0;
for (const [label, okCheck] of checks) {
  console.log(`${okCheck ? "PASS" : "FAIL"}: ${label}`);
  if (!okCheck) failed++;
}
await pool.end();
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
