import pg from "pg";
import { config } from "../lib/config.js";

export const pool = new pg.Pool({
  connectionString: config.databaseUrl,
  max: 10,
  // RDS terminates TLS with a cert chain that isn't in Node's default trust
  // store; within a VPC we encrypt in transit without CA pinning. Set
  // DATABASE_SSL only in environments that actually front Postgres with TLS.
  ...(config.databaseSsl ? { ssl: { rejectUnauthorized: false } } : {}),
});

export async function query<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T[]> {
  const res = await pool.query<T>(text, params);
  return res.rows;
}

export async function queryOne<T extends pg.QueryResultRow = pg.QueryResultRow>(
  text: string,
  params: unknown[] = [],
): Promise<T | null> {
  const rows = await query<T>(text, params);
  return rows[0] ?? null;
}
