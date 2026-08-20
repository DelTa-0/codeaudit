import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { conflict, forbidden, unauthorized } from "../lib/errors.js";
import { logAudit } from "../services/audit.js";
import {
  issueSignInToken,
  consumeSignInToken,
  isWithinCooldown,
  normalizeEmail,
} from "../lib/emailTokens.js";
import { sendSignInEmail } from "../lib/email.js";

export const authRouter = Router();

// Login is where an anonymous caller guesses a password, so it gets the tight
// budget. Keyed by IP — which requires `trust proxy` (set in index.ts), or
// every request behind the reverse proxy shares one bucket.
const loginLimiter = rateLimit({
  windowMs: 15 * 60_000,
  limit: 10,
  standardHeaders: true,
  legacyHeaders: false,
  // Only failed attempts count; logging in successfully several times must not
  // burn the allowance.
  skipSuccessfulRequests: true,
  message: { error: "Too many attempts. Try again in a few minutes." },
});

// Registration gets its OWN, more generous bucket. Sharing login's bucket
// meant ten fat-fingered logins from one office IP locked registration for
// everyone behind that NAT — a real day-one failure for the "a colleague
// showed me this, let me sign up" path on a shared corporate network. Still
// capped, to blunt automated mass-signup; unlike login it does not skip
// successes, since a burst of successful registrations from one IP is exactly
// the abuse to slow.
const registerLimiter = rateLimit({
  windowMs: 60 * 60_000,
  limit: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many sign-ups from this network. Try again later." },
});

const credentialsSchema = z.object({
  email: z.string().email("Valid email required"),
  password: z.string().min(8, "Password must be at least 8 characters"),
  name: z.string().min(1).max(100).optional(),
});

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

// Signup is a magic link, not a form. The old handler took an address that
// merely *parsed*, created a user, an organization and a session, and handed
// back a token — so admin@admin.com was a working account. Verification could
// have been bolted on; removing the form is stronger, because an account can
// now only exist once someone has clicked a link in a mailbox they control.
// There is no unverified state to enforce, and therefore no call site that can
// forget to enforce it.
authRouter.post(
  "/signin-link",
  registerLimiter,
  validateBody(credentialsSchema.pick({ email: true })),
  async (req, res, next) => {
    try {
      const email = normalizeEmail((req.body as { email: string }).email);

      // One response for every case — known address, unknown address, typo,
      // or too soon. Saying anything more specific would rebuild the account
      // enumeration oracle that removing the signup form just closed.
      if (!(await isWithinCooldown(email))) {
        const { token, code } = await issueSignInToken(email);
        const url = `${process.env.APP_URL ?? ""}/signin?token=${encodeURIComponent(token)}`;
        await sendSignInEmail(email, url, code);
      }

      res.status(202).json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

// The click, or the typed code. Either creates the account if this is its
// first use, and signs the holder in.
const signInVerifySchema = z
  .object({
    token: z.string().min(10).max(200).optional(),
    email: z.string().email().optional(),
    code: z.string().regex(/^\d{6}$/).optional(),
  })
  .refine((v) => Boolean(v.token) || Boolean(v.email && v.code), {
    message: "Provide either a token or an email and code",
  });

authRouter.post(
  "/signin-verify",
  loginLimiter,
  validateBody(signInVerifySchema),
  async (req, res, next) => {
    try {
      const body = req.body as z.infer<typeof signInVerifySchema>;
      const result = body.token
        ? await consumeSignInToken({ token: body.token })
        : await consumeSignInToken({ email: body.email!, code: body.code! });

      // Reasons are flattened to one message on purpose. Telling an
      // unauthenticated caller that a token expired rather than never existed
      // is useful to an honest user and equally useful to someone probing.
      if (!result.ok) {
        throw unauthorized("That sign-in link or code is no longer valid. Request a new one.");
      }

      const suspended = await queryOne<{ suspended_at: Date | null }>(
        "SELECT suspended_at FROM users WHERE id = $1",
        [result.user.id],
      );
      if (suspended?.suspended_at)
        throw forbidden("This account has been suspended. Contact support.");

      res.json({
        token: signToken(result.user),
        user: result.user,
        mustSetPassword: result.mustSetPassword,
      });
    } catch (err) {
      next(err);
    }
  },
);

// Optional, and deliberately so. An account created by a link works without a
// password forever — requesting another link is always available, which is
// also the password reset this product has never had. Setting one only buys
// the convenience of the login form.
authRouter.post(
  "/set-password",
  requireAuth,
  validateBody(credentialsSchema.pick({ password: true })),
  async (req, res, next) => {
    try {
      const { password } = req.body as { password: string };
      const userId = req.user!.id;
      await query("UPDATE users SET password_hash = $2 WHERE id = $1", [
        userId,
        await bcrypt.hash(password, 10),
      ]);
      await logAudit(null, userId, "auth.password_set", req.user!.email);
      res.json({ ok: true });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.post(
  "/login",
  loginLimiter,
  validateBody(credentialsSchema.pick({ email: true, password: true })),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const user = await queryOne<{
        id: string;
        email: string;
        password_hash: string | null;
        suspended_at: Date | null;
      }>("SELECT id, email, password_hash, suspended_at FROM users WHERE email = $1", [email]);
      // Failed sign-ins are the entries an operator most wants during an
      // incident, and no mutation-shaped middleware would ever produce them:
      // the request has no authenticated user to attribute. The attempted
      // address is the target — that is what makes credential stuffing legible
      // as a pattern rather than as scattered 401s.
      if (!user?.password_hash) {
        await logAudit(null, null, "auth.login_failed", email, { reason: "no_such_account" });
        throw unauthorized("Invalid email or password");
      }
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) {
        await logAudit(null, user.id, "auth.login_failed", email, { reason: "bad_password" });
        throw unauthorized("Invalid email or password");
      }
      if (user.suspended_at) {
        await logAudit(null, user.id, "auth.login_blocked", email, { reason: "suspended" });
        throw forbidden("This account has been suspended. Contact support.");
      }
      await logAudit(null, user.id, "auth.login", email);
      res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne(
      `SELECT id, email, name, avatar_url, platform_role,
              github_user_id IS NOT NULL AS github_linked
       FROM users WHERE id = $1`,
      [req.user!.id],
    );
    if (!user) throw unauthorized();
    const orgs = await query(
      `SELECT o.id, o.name, o.slug, o.plan, m.role
       FROM organizations o JOIN org_members m ON m.org_id = o.id
       WHERE m.user_id = $1 ORDER BY o.created_at`,
      [req.user!.id],
    );
    res.json({ user, orgs });
  } catch (err) {
    next(err);
  }
});
