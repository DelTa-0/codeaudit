import bcrypt from "bcryptjs";
import { pool } from "./pool.js";

/**
 * Creates or promotes the platform admin account.
 *
 *   ADMIN_EMAIL=you@example.com ADMIN_PASSWORD='…' npm run seed:admin
 *
 * Credentials come from the environment, never from argv: command-line
 * arguments land in shell history and are readable by any other process on the
 * box via `ps`. Nothing here is committed, and the script prints no secret.
 *
 * Idempotent by design, because the realistic uses are "set this up" and "I
 * need to make this second account an operator too":
 *   - account exists  → promoted to platform admin, password left alone unless
 *                       ADMIN_RESET_PASSWORD=true is set
 *   - account is new  → created with a personal workspace, exactly like a
 *                       normal registration, so the admin can also use the
 *                       product as a user
 */

const MIN_PASSWORD_LENGTH = 12;

function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "org"
  );
}

async function seedAdmin() {
  const email = (process.env.ADMIN_EMAIL ?? "").trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD ?? "";
  const name = (process.env.ADMIN_NAME ?? "").trim() || null;
  const resetPassword = (process.env.ADMIN_RESET_PASSWORD ?? "").toLowerCase() === "true";

  if (!email || !email.includes("@")) {
    throw new Error("ADMIN_EMAIL must be set to a valid email address.");
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const existing = await client.query<{ id: string; platform_role: string }>(
      "SELECT id, platform_role FROM users WHERE email = $1",
      [email],
    );

    if (existing.rows.length) {
      const user = existing.rows[0];
      // A password is only required when one is actually being set. Promoting
      // an existing account should not force the operator to retype a password
      // they are not changing.
      if (resetPassword) {
        assertStrongPassword(password);
        await client.query("UPDATE users SET password_hash = $2 WHERE id = $1", [
          user.id,
          await bcrypt.hash(password, 10),
        ]);
      }
      await client.query(
        "UPDATE users SET platform_role = 'admin', suspended_at = NULL, suspended_reason = NULL WHERE id = $1",
        [user.id],
      );
      await client.query(
        `INSERT INTO audit_log (org_id, user_id, action, target, metadata)
         VALUES (NULL, $1, 'admin.seeded', $2, $3)`,
        [
          user.id,
          email,
          JSON.stringify({ via: "seed:admin", from: user.platform_role, passwordReset: resetPassword }),
        ],
      );
      await client.query("COMMIT");
      console.log(
        `Promoted existing account to platform admin.${resetPassword ? " Password was reset." : " Password unchanged."}`,
      );
      return;
    }

    assertStrongPassword(password);
    const hash = await bcrypt.hash(password, 10);
    const inserted = await client.query<{ id: string }>(
      `INSERT INTO users (email, password_hash, name, platform_role)
       VALUES ($1, $2, $3, 'admin') RETURNING id`,
      [email, hash, name],
    );
    const userId = inserted.rows[0].id;

    // Same personal workspace a normal registration creates, so the operator
    // account is a usable account and not a strange half-user that breaks every
    // org-scoped page it visits.
    const orgName = name ? `${name}'s workspace` : "Admin workspace";
    const slug = `${slugify(name ?? email.split("@")[0])}-${userId.slice(0, 6)}`;
    const org = await client.query<{ id: string }>(
      "INSERT INTO organizations (name, slug) VALUES ($1, $2) RETURNING id",
      [orgName, slug],
    );
    await client.query("INSERT INTO org_members (org_id, user_id, role) VALUES ($1, $2, 'owner')", [
      org.rows[0].id,
      userId,
    ]);
    await client.query(
      `INSERT INTO audit_log (org_id, user_id, action, target, metadata)
       VALUES ($1, $2, 'admin.seeded', $3, $4)`,
      [org.rows[0].id, userId, email, JSON.stringify({ via: "seed:admin", created: true })],
    );

    await client.query("COMMIT");
    console.log("Created platform admin account with a personal workspace.");
  } catch (err) {
    await client.query("ROLLBACK");
    throw err;
  } finally {
    client.release();
  }
}

function assertStrongPassword(password: string) {
  if (password.length < MIN_PASSWORD_LENGTH) {
    throw new Error(
      `ADMIN_PASSWORD must be at least ${MIN_PASSWORD_LENGTH} characters. ` +
        "This account can read every log and grant this role to others; the app's " +
        "8-character minimum is not the right bar for it.",
    );
  }
}

seedAdmin()
  .then(() => pool.end())
  .catch(async (err) => {
    // The message may name the email but never the password.
    console.error(err instanceof Error ? err.message : err);
    await pool.end().catch(() => {});
    process.exit(1);
  });
