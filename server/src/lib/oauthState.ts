// The OAuth `state` nonce, shared by every provider.
//
// Lifted out of githubAuth.ts when Google was added rather than copied, because
// what this defends against is easy to reimplement subtly wrong: without a
// single-use nonce tying the callback to the redirect that started it, an
// attacker can feed a victim's browser their own authorization code and land
// the victim in the attacker's account. Two copies of that logic is two chances
// to get the expiry, the deletion, or the check itself wrong — and only one of
// them would be noticed.
//
// In-memory, which is a real limitation and the reason it is written down here:
// a second server process has a different Map, so a callback that lands on the
// wrong instance is rejected as an invalid state. Fine for one box, wrong the
// moment there are two. Moving it to Redis means changing this file only.
import crypto from "node:crypto";

const TTL_MS = 10 * 60_000;

const pending = new Map<string, number>();

setInterval(() => {
  const cutoff = Date.now() - TTL_MS;
  for (const [state, ts] of pending) if (ts < cutoff) pending.delete(state);
}, 60_000).unref();

/** Mints a nonce for an outbound authorize redirect. */
export function issueOauthState(): string {
  const state = crypto.randomBytes(16).toString("hex");
  pending.set(state, Date.now());
  return state;
}

/**
 * Checks and consumes a state from a provider callback.
 *
 * Single use: a replayed callback must fail even seconds later, so the entry is
 * deleted on the way through rather than left to expire.
 */
export function consumeOauthState(state: string | undefined): boolean {
  if (!state) return false;
  const issued = pending.get(state);
  if (issued === undefined) return false;
  pending.delete(state);
  return Date.now() - issued < TTL_MS;
}
