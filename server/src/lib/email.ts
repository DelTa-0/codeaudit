// Transactional email, via Resend's REST API.
//
// No SDK, following the same reasoning as the Stripe client: one endpoint does
// not justify a dependency tree. That matters more than usual here — every
// package this project adds is one it would flag in someone else's repository,
// and a supply-chain scanner that pulls fifty transitive dependencies to send a
// single POST has an argument to answer.
//
// Degrades like every other optional integration in this codebase. With
// RESEND_API_KEY unset the message is logged instead of sent, so `npm run dev`
// still needs no secrets and local signup works by reading the link out of the
// server log. It returns `delivered: false` rather than throwing, because a
// mail outage should not turn a signup request into a 500 — the user can ask
// for another link, and the route says so either way.
const RESEND_ENDPOINT = "https://api.resend.com/emails";

export interface SendResult {
  delivered: boolean;
  reason?: string;
}

interface SendInput {
  to: string;
  subject: string;
  text: string;
}

async function send({ to, subject, text }: SendInput): Promise<SendResult> {
  const key = process.env.RESEND_API_KEY;
  const from = process.env.EMAIL_FROM;

  if (!key || !from) {
    // Not an error: this is the documented local-development path.
    console.log(`[email] unconfigured — would send to ${to}\n[email] subject: ${subject}\n${text}`);
    return { delivered: false, reason: "unconfigured" };
  }

  try {
    const res = await fetch(RESEND_ENDPOINT, {
      method: "POST",
      headers: {
        authorization: `Bearer ${key}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({ from, to, subject, text }),
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) {
      // The body can carry the recipient address; log the status only.
      console.error(`[email] send failed: ${res.status} ${res.statusText}`);
      return { delivered: false, reason: `http_${res.status}` };
    }
    return { delivered: true };
  } catch (err) {
    console.error("[email] send failed:", err instanceof Error ? err.message : err);
    return { delivered: false, reason: "network" };
  }
}

/**
 * The sign-in message: a link and a code, both of which do the same thing.
 *
 * The code is not redundancy for its own sake. Corporate mail scanners and link
 * previewers fetch URLs in email automatically, consuming a single-use token
 * before the human ever clicks — and the user then sees "expired" with no
 * explanation. The code is also the answer to requesting on a laptop and
 * opening the mail on a phone.
 *
 * Plain text, no HTML. A sign-in mail has one job, and an HTML part is one more
 * thing to get wrong in a client we cannot test.
 */
export async function sendSignInEmail(to: string, url: string, code: string): Promise<SendResult> {
  const text = [
    "Sign in to CodeOrion",
    "",
    "Click the link below, or enter the code on the page where you asked for it.",
    "",
    url,
    "",
    `Code: ${code}`,
    "",
    "The link and code both expire in 15 minutes and can each be used once.",
    "",
    "If you did not request this, you can ignore this message — nothing was",
    "created, and nobody can sign in without this email.",
  ].join("\n");

  return send({ to, subject: "Sign in to CodeOrion", text });
}
