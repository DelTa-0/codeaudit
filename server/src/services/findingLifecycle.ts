import { query } from "../db/pool.js";
import type { FindingIdentity } from "@codeaudit/engine";

/**
 * What changed since the previous scan of this repository.
 *
 * This is the number the product has been missing: "82 -> 76" says a score
 * moved, but not whether that was one new vulnerability or four dead-code
 * candidates, nor whether anything was actually fixed. A delta is only
 * computable once findings have identity across scans, which is what
 * finding_lifecycle provides.
 */
export interface FindingDelta {
  new: number;
  /** Open before, absent now. */
  resolved: number;
  /** Previously fixed, present again. The worst category — it means a fix
   *  regressed, which a simple new/resolved count would hide as "new". */
  reintroduced: number;
  /** Present before and still present. */
  persisting: number;
  /** Open right now, after this scan. */
  openTotal: number;
  byKind: Record<string, { new: number; resolved: number; reintroduced: number }>;
}

function emptyKind() {
  return { new: 0, resolved: 0, reintroduced: 0 };
}

/**
 * Reconciles this scan's findings against the repository's known findings and
 * returns the delta.
 *
 * Deliberately never touches rows in `ignored` or `acknowledged`: those states
 * record a human decision, and a scan silently reopening something a person
 * dismissed would make the dismissal worthless. Such rows still have their
 * last_seen updated so "still present, still ignored" stays truthful.
 */
export async function reconcileFindings(
  repoId: string,
  scanJobId: string,
  identities: FindingIdentity[],
): Promise<FindingDelta> {
  // Deduplicate within the scan first: the same problem can legitimately be
  // reported twice (a dependency both unused and duplicated, say), and without
  // this the second row would overwrite the first's counters.
  const seen = new Map<string, FindingIdentity>();
  for (const identity of identities) seen.set(identity.key, identity);

  const existing = await query<{
    finding_key: string;
    kind: string;
    state: string;
  }>("SELECT finding_key, kind, state FROM finding_lifecycle WHERE repo_id = $1", [repoId]);
  const previous = new Map(existing.map((row) => [row.finding_key, row]));

  const delta: FindingDelta = {
    new: 0,
    resolved: 0,
    reintroduced: 0,
    persisting: 0,
    openTotal: 0,
    byKind: {},
  };
  const bump = (kind: string) => (delta.byKind[kind] ??= emptyKind());

  for (const [key, identity] of seen) {
    const before = previous.get(key);
    if (!before) {
      delta.new++;
      bump(identity.kind).new++;
      await query(
        `INSERT INTO finding_lifecycle
           (repo_id, finding_key, kind, title, location, first_detected_scan, last_seen_scan)
         VALUES ($1, $2, $3, $4, $5, $6, $6)`,
        [repoId, key, identity.kind, identity.title, identity.location, scanJobId],
      );
      continue;
    }

    if (before.state === "fixed") {
      delta.reintroduced++;
      bump(identity.kind).reintroduced++;
      await query(
        `UPDATE finding_lifecycle
            SET state = 'open', reintroduced_at = now(), last_seen_at = now(),
                last_seen_scan = $3, times_seen = times_seen + 1,
                times_reintroduced = times_reintroduced + 1, fixed_at = NULL,
                title = $4, location = $5
          WHERE repo_id = $1 AND finding_key = $2`,
        [repoId, key, scanJobId, identity.title, identity.location],
      );
      continue;
    }

    // open, ignored or acknowledged — still here, so only the sighting is
    // recorded. `state` is intentionally left alone.
    delta.persisting++;
    await query(
      `UPDATE finding_lifecycle
          SET last_seen_at = now(), last_seen_scan = $3, times_seen = times_seen + 1,
              title = $4, location = $5
        WHERE repo_id = $1 AND finding_key = $2`,
      [repoId, key, scanJobId, identity.title, identity.location],
    );
  }

  // Anything open that this scan did not see is fixed. Restricted to `open`
  // so an ignored finding is not silently reclassified as an achievement.
  const keys = [...seen.keys()];
  const resolvedRows = await query<{ kind: string }>(
    `UPDATE finding_lifecycle
        SET state = 'fixed', fixed_at = now()
      WHERE repo_id = $1 AND state = 'open' AND NOT (finding_key = ANY($2::text[]))
      RETURNING kind`,
    [repoId, keys],
  );
  for (const row of resolvedRows) {
    delta.resolved++;
    bump(row.kind).resolved++;
  }

  const [openRow] = await query<{ count: string }>(
    "SELECT count(*)::text AS count FROM finding_lifecycle WHERE repo_id = $1 AND state = 'open'",
    [repoId],
  );
  delta.openTotal = Number(openRow?.count ?? 0);
  return delta;
}
