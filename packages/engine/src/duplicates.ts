import type { DependencyVerdict, Ecosystem } from "./registry.js";
import { EQUIVALENT_GROUPS } from "./data/equivalents.js";

export interface DuplicateGroup {
  category: string;
  ecosystem: Ecosystem;
  packages: string[];
  prefer: string | null;
  recommendation: string;
}

/**
 * Two or more libraries from the same equivalence group, both genuinely in
 * use. "In use" deliberately excludes `unused` (declared but never imported —
 * that is already its own finding, and reporting it twice is noise) and
 * `phantom` (does not exist, so it cannot be a real duplicate).
 */
export function findDuplicateLibraries(deps: DependencyVerdict[]): DuplicateGroup[] {
  const inUse = new Set(
    deps
      // An unreachable registry means "in use" is unknown, not true — the
      // verdict only carries `error: registry_unreachable` because the
      // status check itself never ran. Treating that as "in use" turns a
      // genuinely unused library into fabricated consolidation advice.
      .filter((d) => d.status !== "unused" && d.status !== "phantom" && !d.registryMetadata?.error)
      .map((d) => `${d.ecosystem}:${d.packageName}`),
  );

  const groups: DuplicateGroup[] = [];
  for (const group of EQUIVALENT_GROUPS) {
    const present = group.members.filter((m) => inUse.has(`${group.ecosystem}:${m}`));
    if (present.length < 2) continue;
    const target = group.prefer && present.includes(group.prefer) ? group.prefer : null;
    groups.push({
      category: group.category,
      ecosystem: group.ecosystem,
      packages: present,
      prefer: target,
      recommendation: target
        ? `${present.join(", ")} solve the same problem. Consolidating on ${target} removes ${present.length - 1} dependenc${present.length === 2 ? "y" : "ies"}.`
        : `${present.join(", ")} solve the same problem. Consolidating on one removes ${present.length - 1} dependenc${present.length === 2 ? "y" : "ies"}.`,
    });
  }
  return groups;
}
