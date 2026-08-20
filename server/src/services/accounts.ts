// Creating an account and the workspace that makes it usable.
//
// Extracted from the register route it used to live in, because the moment
// account creation moved to "whoever clicks the link" it stopped belonging to a
// signup handler. Both the magic-link path and GitHub OAuth need the same three
// rows written the same way, and having that in one place is what stops the two
// drifting into subtly different notions of a new account.
import { query } from "../db/pool.js";
import { logAudit } from "./audit.js";

export interface NewAccount {
  id: string;
  email: string;
}

function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

/**
 * Creates a user, a personal organization, and the owner membership joining
 * them — the three rows that together make a usable account.
 *
 * No password is set. Accounts now begin passwordless by construction: the
 * caller proved control of the mailbox, which is a stronger claim than a
 * password chosen at a signup form ever was, and the set-password step comes
 * afterwards if the user wants the login form to work for them.
 */
export async function createUserWithPersonalOrg(
  email: string,
  name?: string | null,
): Promise<NewAccount> {
  const [user] = await query<{ id: string; email: string }>(
    "INSERT INTO users (email, name) VALUES ($1, $2) RETURNING id, email",
    [email, name ?? null],
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

  await logAudit(org.id, user.id, "auth.registered", user.email);
  return user;
}
