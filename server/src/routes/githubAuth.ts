import { Router } from "express";
import crypto from "node:crypto";
import { query, queryOne } from "../db/pool.js";
import { signToken } from "../middleware/auth.js";
import { config } from "../lib/config.js";
import { badRequest } from "../lib/errors.js";
import { exchangeOauthCode, oauthAuthorizeUrl } from "../services/github.js";

export const githubAuthRouter = Router();

// Short-lived in-memory state store (single-process dev; move to Redis for multi-instance).
const pendingStates = new Map<string, number>();
setInterval(() => {
  const cutoff = Date.now() - 10 * 60_000;
  for (const [state, ts] of pendingStates) if (ts < cutoff) pendingStates.delete(state);
}, 60_000).unref();

githubAuthRouter.get("/github", (_req, res) => {
  if (!config.github.clientId)
    return res.status(501).json({ error: "GitHub OAuth is not configured (set GITHUB_CLIENT_ID)" });
  const state = crypto.randomBytes(16).toString("hex");
  pendingStates.set(state, Date.now());
  res.redirect(oauthAuthorizeUrl(state));
});

githubAuthRouter.get("/github/callback", async (req, res, next) => {
  try {
    const { code, state } = req.query as { code?: string; state?: string };
    if (!code || !state || !pendingStates.has(state)) throw badRequest("Invalid OAuth state");
    pendingStates.delete(state);

    const gh = await exchangeOauthCode(code);
    if (!gh.email) throw badRequest("Your GitHub account has no accessible email address");

    let user = await queryOne<{ id: string; email: string }>(
      "SELECT id, email FROM users WHERE github_user_id = $1",
      [gh.githubUserId],
    );
    if (!user) {
      // Link by email when an email/password account already exists.
      const byEmail = await queryOne<{ id: string; email: string }>(
        "SELECT id, email FROM users WHERE email = $1",
        [gh.email],
      );
      if (byEmail) {
        await query(
          "UPDATE users SET github_user_id = $2, avatar_url = COALESCE(avatar_url, $3) WHERE id = $1",
          [byEmail.id, gh.githubUserId, gh.avatarUrl],
        );
        user = byEmail;
      } else {
        const [created] = await query<{ id: string; email: string }>(
          `INSERT INTO users (email, github_user_id, name, avatar_url)
           VALUES ($1, $2, $3, $4) RETURNING id, email`,
          [gh.email, gh.githubUserId, gh.name, gh.avatarUrl],
        );
        const slug = `gh-${gh.githubUserId}-${created.id.slice(0, 6)}`;
        const [org] = await query<{ id: string }>(
          "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
          [gh.name ? `${gh.name}'s workspace` : "My workspace", slug],
        );
        await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
          org.id,
          created.id,
        ]);
        user = created;
      }
    }
    // Hand the JWT to the SPA via fragment (not query — avoids server logs).
    res.redirect(`${config.appUrl}/login#token=${signToken(user)}`);
  } catch (err) {
    next(err);
  }
});
