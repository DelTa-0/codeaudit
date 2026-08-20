// Which account an incoming Google identity belongs to.
//
// Extracted from the callback route so it can be tested, because this decision
// is the entire security of "sign in with Google" and every wrong answer is an
// account takeover rather than an inconvenience.
//
// The trap: linking an OAuth identity to an existing account by email address
// is the obvious behaviour, and it is safe only if the provider actually
// verified the address. Anyone can create a Google account claiming an email
// they do not own. If we trust that claim, we hand them the CodeAudit account
// that already uses it — no password needed, no notification, nothing to
// notice afterwards.
//
// Google reports whether it verified, so the rule reads that rather than
// assuming it. It is false in real Workspace and edge cases, not just in
// theory.

export type GoogleLinkDecision =
  /** Already linked by subject id. Email is irrelevant here. */
  | { action: "sign_in"; userId: string }
  /** Existing local account, same verified address: attach the identity. */
  | { action: "link"; userId: string }
  /** No local account: create one. */
  | { action: "create" }
  /**
   * Refuse. Returned instead of quietly creating a second account on the same
   * address, because a duplicate is a support ticket now and both a duplicate
   * *and* a takeover question later.
   */
  | { action: "refuse"; reason: "email_unverified" };

export interface GoogleLinkInput {
  /** User already carrying this google_user_id, if any. */
  matchedByGoogleId: { id: string } | null;
  /** User already carrying this email address, if any. */
  matchedByEmail: { id: string } | null;
  /** Google's own `email_verified` claim. Never inferred. */
  emailVerified: boolean;
}

export function decideGoogleLink({
  matchedByGoogleId,
  matchedByEmail,
  emailVerified,
}: GoogleLinkInput): GoogleLinkDecision {
  // Subject id first: it is the identity Google guarantees, and it stays
  // correct even if the person later changes the address on their Google
  // account. Checking email first would mean a changed address silently
  // creates a second CodeAudit account for the same human.
  if (matchedByGoogleId) return { action: "sign_in", userId: matchedByGoogleId.id };

  if (!emailVerified) return { action: "refuse", reason: "email_unverified" };

  if (matchedByEmail) return { action: "link", userId: matchedByEmail.id };

  return { action: "create" };
}
