// Sign in with Google.
//
// Mirrors githubAuth.ts deliberately, including the `#token=` fragment redirect
// the web app already listens for — a second provider is not the place to
// invent a second shape of callback.
//
// The decision this route exists to make lives in services/googleLink.ts, not
// here: which account an incoming Google identity belongs to is the whole
// security of the feature, and buried in a callback handler it is unreachable
// by any test. This file does the I/O; that file decides.
import { Router } from "express";
import { query, queryOne } from "../db/pool.js";
import { signToken } from "../middleware/auth.js";
import { config } from "../lib/config.js";
import { badRequest } from "../lib/errors.js";
import { issueOauthState, consumeOauthState } from "../lib/oauthState.js";
import { exchangeGoogleCode, googleAuthorizeUrl } from "../services/google.js";
import { decideGoogleLink } from "../services/googleLink.js";
import { createUserWithPersonalOrg } from "../services/accounts.js";

export const googleAuthRouter = Router();

googleAuthRouter.get("/google", (_req, res) => {
  if (!config.google.clientId)
    return res.status(501).json({ error: "Google sign-in is not configured (set GOOGLE_CLIENT_ID)" });
  res.redirect(googleAuthorizeUrl(issueOauthState()));
});

googleAuthRouter.get("/google/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !consumeOauthState(state)) throw badRequest("Invalid OAuth state");

    const profile = await exchangeGoogleCode(code);
    if (!profile.email) throw badRequest("Your Google account has no accessible email address");

    const [matchedByGoogleId, matchedByEmail] = await Promise.all([
      queryOne<{ id: string; email: string }>("SELECT id, email FROM users WHERE google_user_id = $1", [
        profile.googleUserId,
      ]),
      queryOne<{ id: string; email: string }>("SELECT id, email FROM users WHERE email = $1", [
        profile.email,
      ]),
    ]);

    const decision = decideGoogleLink({
      matchedByGoogleId,
      matchedByEmail,
      emailVerified: profile.emailVerified,
    });

    let user: { id: string; email: string };
    switch (decision.action) {
      case "refuse":
        throw badRequest(
          "Google has not verified this email address, so it cannot be used to sign in here. Verify it with Google, or sign in with your email instead.",
        );

      case "sign_in":
        user = matchedByGoogleId!;
        break;

      case "link":
        await query(
          "UPDATE users SET google_user_id = $2, avatar_url = COALESCE(avatar_url, $3) WHERE id = $1",
          [decision.userId, profile.googleUserId, profile.avatarUrl],
        );
        user = matchedByEmail!;
        break;

      case "create": {
        const created = await createUserWithPersonalOrg(profile.email, profile.name);
        await query("UPDATE users SET google_user_id = $2, avatar_url = $3 WHERE id = $1", [
          created.id,
          profile.googleUserId,
          profile.avatarUrl,
        ]);
        user = created;
        break;
      }
    }

    const suspended = await queryOne<{ suspended_at: Date | null }>(
      "SELECT suspended_at FROM users WHERE id = $1",
      [user.id],
    );
    if (suspended?.suspended_at) return res.redirect(`${config.appUrl}/login?error=suspended`);

    res.redirect(`${config.appUrl}/login#token=${signToken(user)}`);
  } catch (err) {
    next(err);
  }
});
