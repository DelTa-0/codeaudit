// Google OAuth: authorize URL and code exchange.
//
// Hand-rolled against Google's endpoints for the same reason the GitHub and
// Stripe clients are: two requests do not justify a dependency, and this is a
// product that flags other people's dependency trees.
//
// Only non-sensitive scopes — `openid email profile`. That is not a detail:
// sensitive or restricted scopes drag the app into Google's full verification
// review, and nothing here needs more than who the person is.
import { config } from "../lib/config.js";

const AUTHORIZE = "https://accounts.google.com/o/oauth2/v2/auth";
const TOKEN = "https://oauth2.googleapis.com/token";
const USERINFO = "https://openidconnect.googleapis.com/v1/userinfo";

/** Must match a redirect URI registered on the OAuth client, character for character. */
export function googleRedirectUri(): string {
  return `${config.apiUrl}/api/auth/google/callback`;
}

export function googleAuthorizeUrl(state: string): string {
  const params = new URLSearchParams({
    client_id: config.google.clientId,
    redirect_uri: googleRedirectUri(),
    response_type: "code",
    scope: "openid email profile",
    state,
    // Google omits the email on a repeat consent unless asked to include it.
    include_granted_scopes: "true",
    prompt: "select_account",
  });
  return `${AUTHORIZE}?${params}`;
}

export interface GoogleIdentity {
  googleUserId: string;
  email: string | null;
  /**
   * Whether Google itself has verified the address.
   *
   * The single most important field here. Linking an OAuth identity to an
   * existing account by email address is only safe if the provider proved the
   * address — otherwise anyone can register a Google account claiming someone
   * else's email and inherit their account. Google returns false for some
   * Workspace and edge cases, so this is read rather than assumed.
   */
  emailVerified: boolean;
  name: string | null;
  avatarUrl: string | null;
}

export async function exchangeGoogleCode(code: string): Promise<GoogleIdentity> {
  const tokenRes = await fetch(TOKEN, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      code,
      client_id: config.google.clientId,
      client_secret: config.google.clientSecret,
      redirect_uri: googleRedirectUri(),
      grant_type: "authorization_code",
    }),
    signal: AbortSignal.timeout(10_000),
  });

  if (!tokenRes.ok) {
    // The body echoes the client_id; log the status only.
    throw new Error(`Google token exchange failed (${tokenRes.status})`);
  }
  const token = (await tokenRes.json()) as { access_token?: string };
  if (!token.access_token) throw new Error("Google returned no access token");

  const userRes = await fetch(USERINFO, {
    headers: { authorization: `Bearer ${token.access_token}` },
    signal: AbortSignal.timeout(10_000),
  });
  if (!userRes.ok) throw new Error(`Google userinfo failed (${userRes.status})`);

  const profile = (await userRes.json()) as {
    sub?: string;
    email?: string;
    email_verified?: boolean;
    name?: string;
    picture?: string;
  };
  if (!profile.sub) throw new Error("Google returned no subject identifier");

  return {
    googleUserId: profile.sub,
    email: profile.email?.toLowerCase() ?? null,
    emailVerified: profile.email_verified === true,
    name: profile.name ?? null,
    avatarUrl: profile.picture ?? null,
  };
}
