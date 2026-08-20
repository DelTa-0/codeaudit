// One-time emailed sign-in credentials.
//
// This module is the whole security boundary of magic-link signup, so the
// interesting parts are the refusals rather than the happy path. A magic link
// is a bearer credential sent in plaintext through infrastructure we do not
// control; what makes that acceptable is that it is short-lived, single-use,
// and not guessable. Each of those is one condition below that could be deleted
// without a single positive test noticing.
//
// The caller never learns whether an address is known. `issueSignInToken`
// behaves identically for a new address and an existing one, and account
// creation is deferred to the click — which is what removes account enumeration
// as a category rather than papering over it.
import { createHash, randomBytes, randomInt, timingSafeEqual } from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { createUserWithPersonalOrg } from "../services/accounts.js";

/**
 * Fifteen minutes. This is a sign-in credential, not an account activation, and
 * the two deserve different numbers: a link that grants a session should not
 * sit valid in an inbox for a day.
 */
export const SIGNIN_TOKEN_TTL_MS = 15 * 60_000;

/**
 * Six digits is a million possibilities, which is only a meaningful number if
 * something stops a script working through them. This is that something.
 */
export const MAX_CODE_ATTEMPTS = 5;

/** Minimum gap between links for one address, so the mailbox is not a weapon. */
export const RESEND_COOLDOWN_MS = 60_000;

export interface IssuedSignIn {
  /** Raw token for the emailed link. Returned once; only its hash is stored. */
  token: string;
  /** Raw 6-digit code for manual entry. Returned once; only its hash is stored. */
  code: string;
  expiresAt: Date;
}

export type ConsumeResult =
  | {
      ok: true;
      user: { id: string; email: string };
      /** True when the account has no password — the caller should route to set one. */
      mustSetPassword: boolean;
      /** True when this click brought the account into existence. */
      created: boolean;
    }
  | { ok: false; reason: "invalid" | "expired" | "consumed" | "attempts_exhausted" };

const sha256 = (value: string) => createHash("sha256").update(value).digest("hex");

/** Addresses differing only by case are the same mailbox. */
export const normalizeEmail = (email: string) => email.trim().toLowerCase();

/**
 * Whether another link may be issued for this address yet.
 *
 * Deliberately separate from `issueSignInToken` and advisory: the route decides
 * what to tell the user, and it tells them the same thing either way, because
 * "you must wait" for a known address and silence for an unknown one would
 * reinstate exactly the enumeration oracle this design removes.
 */
export async function isWithinCooldown(email: string): Promise<boolean> {
  const recent = await queryOne<{ created_at: Date }>(
    `SELECT created_at FROM email_tokens
      WHERE email = $1 AND consumed_at IS NULL
      ORDER BY created_at DESC LIMIT 1`,
    [normalizeEmail(email)],
  );
  if (!recent) return false;
  return Date.now() - new Date(recent.created_at).getTime() < RESEND_COOLDOWN_MS;
}

/**
 * Issues a link + code for an address, existing or not.
 *
 * Any outstanding token for the address is consumed first, so a second request
 * invalidates the first link. That is the behaviour a user expects — the newest
 * mail is the one that works — and it also bounds how many live credentials can
 * exist for one mailbox at once, which is one.
 */
export async function issueSignInToken(email: string): Promise<IssuedSignIn> {
  const normalized = normalizeEmail(email);

  await query(
    "UPDATE email_tokens SET consumed_at = now() WHERE email = $1 AND consumed_at IS NULL",
    [normalized],
  );

  // 32 bytes for the link; base64url so it survives a query string untouched.
  const token = randomBytes(32).toString("base64url");
  // randomInt, not Math.random: this is a credential, and the difference
  // between a CSPRNG and a PRNG here is the difference between six unguessable
  // digits and six predictable ones.
  const code = String(randomInt(0, 1_000_000)).padStart(6, "0");
  const expiresAt = new Date(Date.now() + SIGNIN_TOKEN_TTL_MS);

  const existing = await queryOne<{ id: string }>("SELECT id FROM users WHERE email = $1", [
    normalized,
  ]);

  await query(
    `INSERT INTO email_tokens (email, user_id, token_hash, code_hash, expires_at)
     VALUES ($1, $2, $3, $4, $5)`,
    [normalized, existing?.id ?? null, sha256(token), sha256(code), expiresAt],
  );

  return { token, code, expiresAt };
}

interface TokenRow {
  id: string;
  email: string;
  user_id: string | null;
  code_hash: string;
  attempts: number;
  expires_at: Date;
  consumed_at: Date | null;
}

/** Constant-time compare, so a wrong code cannot be narrowed by timing. */
function hashesEqual(a: string, b: string): boolean {
  const left = Buffer.from(a, "hex");
  const right = Buffer.from(b, "hex");
  if (left.length !== right.length) return false;
  return timingSafeEqual(left, right);
}

/**
 * Consumes a link token or a typed code, signing the holder in and creating the
 * account if this is its first click.
 *
 * Failure reasons are returned rather than thrown, and the route flattens them
 * to one message: distinguishing "expired" from "never existed" to an
 * unauthenticated caller would be an oracle, however useful the distinction
 * would be to an honest user.
 */
export async function consumeSignInToken(
  input: { token: string } | { email: string; code: string },
): Promise<ConsumeResult> {
  const row =
    "token" in input
      ? await queryOne<TokenRow>(
          `SELECT id, email, user_id, code_hash, attempts, expires_at, consumed_at
             FROM email_tokens WHERE token_hash = $1`,
          [sha256(input.token)],
        )
      : await queryOne<TokenRow>(
          `SELECT id, email, user_id, code_hash, attempts, expires_at, consumed_at
             FROM email_tokens
            WHERE email = $1 AND consumed_at IS NULL
            ORDER BY created_at DESC LIMIT 1`,
          [normalizeEmail(input.email)],
        );

  if (!row) return { ok: false, reason: "invalid" };
  if (row.consumed_at) return { ok: false, reason: "consumed" };
  if (new Date(row.expires_at).getTime() <= Date.now()) return { ok: false, reason: "expired" };

  if ("code" in input) {
    if (row.attempts >= MAX_CODE_ATTEMPTS) {
      // Burn the row rather than leaving it to expire: an exhausted token is
      // evidence someone is guessing, and the honest user can request another.
      await query("UPDATE email_tokens SET consumed_at = now() WHERE id = $1", [row.id]);
      return { ok: false, reason: "attempts_exhausted" };
    }
    if (!hashesEqual(row.code_hash, sha256(input.code))) {
      await query("UPDATE email_tokens SET attempts = attempts + 1 WHERE id = $1", [row.id]);
      return { ok: false, reason: "invalid" };
    }
  }

  // Consume before doing anything else. A crash after this point costs the user
  // one more email; a crash before it would leave a live credential behind.
  const claimed = await query<{ id: string }>(
    "UPDATE email_tokens SET consumed_at = now() WHERE id = $1 AND consumed_at IS NULL RETURNING id",
    [row.id],
  );
  // Lost the race against a concurrent click — that click was the real one.
  if (!claimed.length) return { ok: false, reason: "consumed" };

  const existing = await queryOne<{ id: string; email: string; password_hash: string | null }>(
    "SELECT id, email, password_hash FROM users WHERE email = $1",
    [row.email],
  );

  if (existing) {
    await query("UPDATE email_tokens SET user_id = $2 WHERE id = $1", [row.id, existing.id]);
    return {
      ok: true,
      user: { id: existing.id, email: existing.email },
      mustSetPassword: existing.password_hash === null,
      created: false,
    };
  }

  const user = await createUserWithPersonalOrg(row.email);
  await query("UPDATE email_tokens SET user_id = $2 WHERE id = $1", [row.id, user.id]);
  return { ok: true, user, mustSetPassword: true, created: true };
}
