import { Router } from "express";
import rateLimit from "express-rate-limit";
import bcrypt from "bcryptjs";
import { z } from "zod";
import { query, queryOne } from "../db/pool.js";
import { signToken, requireAuth } from "../middleware/auth.js";
import { validateBody } from "../middleware/validate.js";
import { badRequest, conflict, unauthorized } from "../lib/errors.js";

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

authRouter.post("/register", registerLimiter, validateBody(credentialsSchema), async (req, res, next) => {
  try {
    const { email, password, name } = req.body as z.infer<typeof credentialsSchema>;
    const existing = await queryOne("SELECT id FROM users WHERE email = $1", [email]);
    if (existing) throw conflict("An account with this email already exists");

    const hash = await bcrypt.hash(password, 10);
    const [user] = await query<{ id: string; email: string }>(
      "INSERT INTO users (email, password_hash, name) VALUES ($1, $2, $3) RETURNING id, email",
      [email, hash, name ?? null],
    );

    // Every new user gets a personal org so the app is usable immediately.
    const orgName = name ? `${name}'s workspace` : "My workspace";
    const baseSlug = slugify(name ?? email.split("@")[0]);
    const slug = `${baseSlug}-${user.id.slice(0, 6)}`;
    const [org] = await query<{ id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [orgName, slug],
    );
    await query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
      org.id,
      user.id,
    ]);

    res.status(201).json({ token: signToken(user), user: { id: user.id, email: user.email } });
  } catch (err) {
    next(err);
  }
});

authRouter.post(
  "/login",
  loginLimiter,
  validateBody(credentialsSchema.pick({ email: true, password: true })),
  async (req, res, next) => {
    try {
      const { email, password } = req.body as { email: string; password: string };
      const user = await queryOne<{ id: string; email: string; password_hash: string | null }>(
        "SELECT id, email, password_hash FROM users WHERE email = $1",
        [email],
      );
      if (!user?.password_hash) throw unauthorized("Invalid email or password");
      const ok = await bcrypt.compare(password, user.password_hash);
      if (!ok) throw unauthorized("Invalid email or password");
      res.json({ token: signToken(user), user: { id: user.id, email: user.email } });
    } catch (err) {
      next(err);
    }
  },
);

authRouter.get("/me", requireAuth, async (req, res, next) => {
  try {
    const user = await queryOne(
      "SELECT id, email, name, avatar_url, github_user_id IS NOT NULL AS github_linked FROM users WHERE id = $1",
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
