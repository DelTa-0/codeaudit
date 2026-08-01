import fs from "node:fs";
import path from "node:path";
import type { DependencyVerdict, Ecosystem } from "./registry.js";
import { classifyLicenseExpression } from "./licenseClass.js";

export interface LicenseConflict {
  packageName: string;
  ecosystem: Ecosystem;
  packageLicense: string | null;
  projectLicense: string | null;
  severity: "high" | "medium";
  reason: string;
}

function isCopyleftProject(license: string | null): boolean {
  if (license === null) return false;
  const cls = classifyLicenseExpression(license);
  return cls === "strong-copyleft" || cls === "weak-copyleft";
}

/**
 * The project's own licence, read as plain text — package.json first, then a
 * LICENSE file's first line as a fallback. Never installs or executes anything.
 */
export function readProjectLicense(repoDir: string): string | null {
  try {
    const pkg = JSON.parse(fs.readFileSync(path.join(repoDir, "package.json"), "utf8")) as {
      license?: string | { type?: string };
    };
    const raw = pkg.license;
    const value = typeof raw === "string" ? raw : (raw?.type ?? null);
    if (value) return value;
  } catch {
    // no package.json, or unparseable — fall through to LICENSE
  }
  for (const name of ["LICENSE", "LICENSE.md", "LICENSE.txt", "COPYING"]) {
    try {
      const first = fs.readFileSync(path.join(repoDir, name), "utf8").split("\n")[0]?.trim();
      if (first) return first;
    } catch {
      // not present — try the next candidate
    }
  }
  return null;
}

/**
 * Copyleft dependencies inside a permissive project, and dependencies with no
 * declared licence at all.
 *
 * Only considers dependencies genuinely in use: an `unused` dependency is
 * already its own finding and carries no licence obligation once removed, and
 * a `phantom` one does not exist. Skipped entirely when the project is itself
 * copyleft, where a copyleft dependency is expected rather than a conflict.
 */
export function checkLicenseConflicts(
  deps: DependencyVerdict[],
  projectLicense: string | null,
): LicenseConflict[] {
  const projectIsCopyleft = isCopyleftProject(projectLicense);
  const conflicts: LicenseConflict[] = [];

  for (const dep of deps) {
    if (dep.status === "unused" || dep.status === "phantom") continue;
    // Workspace members are the project's own code, symlinked in rather than
    // installed from a registry — not a third-party dependency at all, so
    // there is no external licence obligation to conflict with. It carries
    // the project's own licence.
    if (dep.registryMetadata?.workspaceMember === true) continue;
    // An unreachable registry means the licence is unknown, not absent — the
    // metadata we'd read it from was never fetched. Asserting "no licence"
    // (and worse, "all rights reserved") from missing data is a false legal
    // claim; saying nothing is strictly safer than saying something wrong.
    if (dep.registryMetadata?.error) continue;
    // A lockfile-only, transitive-CVE verdict (applyVulnerabilities in
    // vulns.ts) is pushed with `{ vulnerabilities, maxSeverity, transitive:
    // true }` and no `license` key at all — the licence was never looked up
    // for it. Treating the missing key as "declares no licence" would flag
    // every transitive vulnerable package as unlicensed, which is false.
    if (dep.registryMetadata?.transitive === true) continue;
    const license = (dep.registryMetadata?.license as string | null | undefined) ?? null;
    const hasLicenseText = dep.registryMetadata?.hasLicenseText === true;

    if (license === null) {
      // Licence text exists but could not be parsed into an identifier —
      // unknown is not the same as absent, and asserting "all rights
      // reserved" about software that shipped a licence is a false legal
      // claim.
      if (hasLicenseText) continue;
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: null,
        projectLicense,
        severity: "medium",
        reason: `${dep.packageName} declares no licence. Code with no licence grant is legally "all rights reserved" by default.`,
      });
      continue;
    }
    if (projectIsCopyleft) continue;

    const cls = classifyLicenseExpression(license);
    if (cls === "strong-copyleft") {
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: license,
        projectLicense,
        severity: "high",
        reason: `${dep.packageName} is ${license}, a strong copyleft licence, in a project licensed ${projectLicense ?? "permissively or not at all"}. Distributing this may oblige you to release your own source under the same terms.`,
      });
    } else if (cls === "weak-copyleft") {
      conflicts.push({
        packageName: dep.packageName,
        ecosystem: dep.ecosystem,
        packageLicense: license,
        projectLicense,
        severity: "medium",
        reason: `${dep.packageName} is ${license}, a weak copyleft licence. Obligations usually attach to the library rather than your whole application, but modifications to it must typically be published.`,
      });
    }
  }
  return conflicts;
}
