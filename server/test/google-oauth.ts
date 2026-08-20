// Google sign-in: the linking rule, and the OAuth state nonce.
//
// Both are pure, and both are the kind of code whose absence nobody notices.
// Delete the email_verified check and every test of the happy path still
// passes, every manual sign-in still works, and the only symptom is that
// strangers can claim other people's accounts.
//
// Run: npm run test:google-oauth   (no database, no network)
import { decideGoogleLink } from "../src/services/googleLink.js";
import { issueOauthState, consumeOauthState } from "../src/lib/oauthState.js";

const checks: [string, boolean][] = [];
const USER = { id: "user-1" };
const OTHER = { id: "user-2" };

// --- already linked -------------------------------------------------------
checks.push(
  [
    "a known google_user_id signs in",
    decideGoogleLink({ matchedByGoogleId: USER, matchedByEmail: null, emailVerified: true }).action ===
      "sign_in",
  ],
  [
    // The identity Google guarantees is the subject id, not the address. If
    // email were checked first, someone changing the address on their Google
    // account would silently get a second CodeAudit account.
    "a known google_user_id wins over a different email match",
    (() => {
      const d = decideGoogleLink({ matchedByGoogleId: USER, matchedByEmail: OTHER, emailVerified: true });
      return d.action === "sign_in" && d.userId === USER.id;
    })(),
  ],
  [
    // An already-linked identity is already trusted; re-checking verification
    // would lock out a user whose Workspace admin changed something.
    "a known google_user_id signs in even when the email is unverified",
    decideGoogleLink({ matchedByGoogleId: USER, matchedByEmail: null, emailVerified: false }).action ===
      "sign_in",
  ],
);

// --- linking to an existing local account --------------------------------
checks.push(
  [
    "a verified address links to the existing account",
    (() => {
      const d = decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: USER, emailVerified: true });
      return d.action === "link" && d.userId === USER.id;
    })(),
  ],
  [
    // THE check. Without it, creating a Google account that claims someone
    // else's address hands over their CodeAudit account.
    "an UNVERIFIED address does NOT link to an existing account",
    decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: USER, emailVerified: false }).action !==
      "link",
  ],
  [
    "it refuses rather than linking",
    (() => {
      const d = decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: USER, emailVerified: false });
      return d.action === "refuse" && d.reason === "email_unverified";
    })(),
  ],
  [
    // Refusing must not mean "quietly make another account on the same email".
    // That is a duplicate now and an unanswerable question later.
    "it does not silently create a duplicate on the same address",
    decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: USER, emailVerified: false }).action !==
      "create",
  ],
);

// --- brand new ------------------------------------------------------------
checks.push(
  [
    "a verified address with no local account creates one",
    decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: null, emailVerified: true }).action ===
      "create",
  ],
  [
    "an unverified address with no local account is refused",
    decideGoogleLink({ matchedByGoogleId: null, matchedByEmail: null, emailVerified: false }).action ===
      "refuse",
  ],
);

// --- the OAuth state nonce ------------------------------------------------
// Without a single-use nonce tying the callback to the redirect that began it,
// an attacker can feed a victim's browser their own authorization code and
// land the victim inside the attacker's account.
const state = issueOauthState();
checks.push(
  ["a fresh state is accepted", consumeOauthState(state) === true],
  ["the same state is rejected the second time", consumeOauthState(state) === false],
  ["an unknown state is rejected", consumeOauthState("deadbeef") === false],
  ["an absent state is rejected", consumeOauthState(undefined) === false],
  ["states are unpredictable", issueOauthState() !== issueOauthState()],
  ["states are long enough to be unguessable", issueOauthState().length >= 32],
);

console.log("--- google oauth ---");
let failed = 0;
for (const [label, ok] of checks) {
  console.log(`${ok ? "PASS" : "FAIL"}: ${label}`);
  if (!ok) failed++;
}
if (failed) {
  console.error(`${failed} check(s) failed`);
  process.exit(1);
}
