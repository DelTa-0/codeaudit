import { query } from "../db/pool.js";

/**
 * Records one sighting of a hallucinated package name.
 *
 * Extracted from the route so the upsert semantics are testable against a
 * real database: the interesting behaviour is that N reports of one name are
 * one row with a count — a table that grew a row per report would let a
 * single noisy client bury the review queue.
 *
 * Validation stays at the route (zod); this trusts its caller.
 */
export async function recordPhantomReport(
  packageName: string,
  ecosystem: "npm" | "pypi",
): Promise<{ reportCount: number }> {
  const [row] = await query<{ report_count: number }>(
    `INSERT INTO phantom_reports (package_name, ecosystem)
     VALUES ($1, $2)
     ON CONFLICT (package_name, ecosystem) DO UPDATE
       SET report_count = phantom_reports.report_count + 1,
           last_reported_at = now()
     RETURNING report_count`,
    [packageName, ecosystem],
  );
  return { reportCount: Number(row.report_count) };
}
