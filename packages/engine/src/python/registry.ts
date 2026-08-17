import path from "node:path";
import { fetchJson, type DependencyVerdict } from "../registry.js";
import { checkTyposquat, fuzzyAlternative } from "../typosquat.js";
import { lookupHallucinatedName } from "../data/hallucinatedNames.js";
import { classifyLicenseTerm } from "../licenseClass.js";
import type { PythonManifest } from "./manifest.js";
import { PYTHON_STDLIB } from "./stdlib.js";
import { importNameToDistribution, normalizePyPiName } from "./aliases.js";
import { listPythonFiles } from "./imports.js";

const cache = new Map<string, { exists: boolean; meta: Record<string, unknown> | null }>();
const CONCURRENCY = 5;
const SUSPICIOUS_MONTHLY_DOWNLOADS = 200;
const SUSPICIOUS_AGE_DAYS = 90;

/**
 * Distributions that are legitimately declared without ever being imported
 * by name: CLI-invoked servers/tools, string-referenced parser backends
 * (BeautifulSoup(html, "lxml")), and framework peer requirements
 * (python-multipart for FastAPI's UploadFile). Import analysis cannot see
 * these usage patterns, so "declared but never imported" is not evidence of
 * anything — never flag them unused.
 */
const NEVER_FLAG_UNUSED = new Set([
  "uvicorn",
  "gunicorn",
  "lxml",
  "python-multipart",
  "setuptools",
  "wheel",
  "pip",
]);

/**
 * A licence blob is full text, not an identifier: it has line breaks or is
 * far longer than any real SPDX expression (torch's is 99 chars; the cap
 * below is 200). A 60-character cap discarded torch's valid compound
 * expression outright — detect a blob by structure, not by an arbitrary
 * length that happens to be shorter than a real-world expression.
 */
function looksLikeLicenseText(value: string): boolean {
  return value.includes("\n") || value.length > 200;
}

/**
 * A resolved value that structurally looks like an SPDX identifier or
 * expression, as opposed to a package name ("python-ldap") or a free-text
 * description ("Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial
 * License"). A genuine SPDX expression is built entirely from identifier
 * tokens (letters, digits, dots, hyphens, plus signs, parentheses) joined
 * by the AND/OR/WITH operators — nothing else. Prose fails this even when
 * it mentions a real licence family by name, and is better routed through
 * the same keyword extraction used for trove classifiers than parsed as an
 * identifier outright.
 */
function looksLikeSpdxIdentifier(value: string): boolean {
  const token = "[A-Za-z0-9.+()-]+";
  return new RegExp(`^${token}(\\s+(AND|OR|WITH)\\s+${token})*$`).test(value.trim());
}

/**
 * Extract a licence FAMILY string — not an invented version — from a piece
 * of text: a PyPI trove classifier leaf ("GNU General Public License v2
 * (GPLv2)") or a free-text legacy `license` description ("Dual Licensed -
 * GNU AFFERO GPL 3.0 or Artifex Commercial License"). A `GNU General Public
 * License v2` classifier must not resolve to "GPL-3.0": that is a licence
 * the package does not carry, shown to a user making a legal decision.
 * These family strings still classify correctly through classifyLicenseTerm.
 *
 * Order matters: "GNU Affero General Public License" and "GNU Lesser General
 * Public License" both contain "General Public", so the more specific
 * families must be tested first.
 */
function familyFromText(text: string): string | null {
  if (/GNU Affero/i.test(text)) return "AGPL";
  if (/GNU Lesser|LGPL/i.test(text)) return "LGPL";
  if (/GNU General Public|GPL/i.test(text)) return "GPL";
  if (/Mozilla/i.test(text)) return "MPL";
  if (/Eclipse/i.test(text)) return "EPL";
  if (/Apache/i.test(text)) return "Apache-2.0";
  if (/BSD/i.test(text)) return "BSD";
  if (/\bMIT\b/i.test(text)) return "MIT";
  if (/\bISC\b/i.test(text)) return "ISC";
  if (/Python Software Foundation/i.test(text)) return "PSF";
  if (/Public Domain|Unlicense|CC0/i.test(text)) return "CC0-1.0";
  return null;
}

/** Restrictiveness order, mirroring licenseClass.ts's private ranking. */
const CLASS_RANK: Record<string, number> = {
  permissive: 0,
  unknown: 1,
  "weak-copyleft": 2,
  "strong-copyleft": 3,
};

/**
 * PyPI "License ::" trove classifiers mapped to SPDX-style family
 * identifiers.
 *
 * Needed because a large share of packages publish no `license_expression`
 * and put the entire licence TEXT in `license` — 61 KB of it for pandas.
 * The classifier is the only machine-readable licence signal those packages
 * carry, and without it they read as "declares no licence", which is a false
 * legal claim about well-licensed software.
 *
 * A package can carry several licence classifiers at once (dual-licensed, or
 * simply over-tagged) — `[MIT, GPLv3]` classifiers previously returned "MIT"
 * on first match, silently dropping the GPL obligation. Every matching
 * classifier is now collected and the MOST restrictive one wins, the same
 * way `checkLicenseConflicts` treats an AND-ed compound expression.
 */
export function licenseFromClassifiers(classifiers: string[]): string | null {
  let best: string | null = null;
  let bestRank = -1;
  for (const classifier of classifiers) {
    if (!classifier.startsWith("License ::")) continue;
    const leaf = classifier.split("::").pop()?.trim() ?? "";
    const family = familyFromText(leaf);
    if (!family) continue;
    const rank = CLASS_RANK[classifyLicenseTerm(family)];
    if (rank > bestRank) {
      bestRank = rank;
      best = family;
    }
  }
  return best;
}

/**
 * Resolve a PyPI package's licence from PEP 639's `license_expression`, the
 * legacy `license` field, and trove classifiers, in that precedence order.
 *
 * `license_expression` is preferred because it is a proper SPDX expression by
 * construction. The legacy `license` field is free text: sometimes a short
 * identifier, sometimes the entire licence document (pandas ships 61 KB of
 * it there). A short value that still doesn't read as an identifier (a bare
 * package name, e.g. python-ldap's "python-ldap") is rejected in favour of
 * the classifier signal rather than surfaced as-is.
 */
function resolveLicense(
  licenseExpression: string | null,
  legacyLicense: string | null,
  classifiers: string[],
): { license: string | null; hasLicenseText: boolean } {
  let hasLicenseText = false;
  let license: string | null = null;

  if (licenseExpression) {
    if (looksLikeLicenseText(licenseExpression)) hasLicenseText = true;
    else license = licenseExpression;
  }
  if (license === null && legacyLicense) {
    if (looksLikeLicenseText(legacyLicense)) hasLicenseText = true;
    else license = legacyLicense;
  }
  if (license === null || (classifyLicenseTerm(license) === "unknown" && !looksLikeSpdxIdentifier(license))) {
    // Prefer a classifier signal when one exists; otherwise the resolved
    // value itself may be free text that names a real licence family without
    // being a parseable identifier (pymupdf's legacy `license` field is
    // "Dual Licensed - GNU AFFERO GPL 3.0 or Artifex Commercial License" —
    // no "License ::" classifier at all, but unmistakably AGPL). Extracting
    // the family from that text beats discarding it and reading as
    // permissive/unlicensed.
    const fallback = licenseFromClassifiers(classifiers) ?? (license ? familyFromText(license) : null);
    if (fallback) license = fallback;
  }
  return { license, hasLicenseText };
}

export async function checkPyPiPackage(name: string) {
  const cached = cache.get(name);
  if (cached) return cached;

  const result: { exists: boolean; meta: Record<string, unknown> | null } = {
    exists: false,
    meta: null,
  };
  const { status, data } = await fetchJson(`https://pypi.org/pypi/${encodeURIComponent(name)}/json`);
  if (status !== 404 && data) {
    result.exists = true;
    const doc = data as {
      info?: {
        version?: string;
        license?: string;
        license_expression?: string;
        classifiers?: string[];
        yanked?: boolean;
      };
      releases?: Record<string, { upload_time_iso_8601?: string }[]>;
    };
    // First release date = earliest upload across all versions (best-effort).
    let created: string | null = null;
    for (const files of Object.values(doc.releases ?? {})) {
      for (const f of files) {
        const t = f.upload_time_iso_8601;
        if (t && (!created || t < created)) created = t;
      }
    }
    let monthlyDownloads: number | null = null;
    try {
      const dl = await fetchJson(`https://pypistats.org/api/packages/${encodeURIComponent(name)}/recent`);
      monthlyDownloads =
        (dl.data as { data?: { last_month?: number } } | null)?.data?.last_month ?? null;
    } catch {
      // pypistats is best-effort and rate-limited — tolerate failures
    }
    // PEP 639: modern PyPI publishes an SPDX identifier in
    // `license_expression` and leaves the legacy `license` field null.
    // Older packages do the reverse, so consult both. A large share of
    // packages (pandas among them) publish neither a usable expression nor a
    // short `license` string — they dump the full licence TEXT into
    // `license` instead. Those packages still carry a reliable signal in
    // their trove classifiers, so fall back to that before giving up.
    const { license, hasLicenseText } = resolveLicense(
      doc.info?.license_expression ?? null,
      doc.info?.license ?? null,
      doc.info?.classifiers ?? [],
    );
    result.meta = {
      created,
      latest: doc.info?.version ?? null,
      // stored under the same key the dashboard's downloads column reads
      weeklyDownloads: monthlyDownloads,
      downloadsPeriod: "month",
      license,
      // Licence text existed (legacy `license` or `license_expression` was a
      // blob) but couldn't be parsed as an identifier — unknown is not the
      // same as absent, so downstream conflict checks must not treat this
      // package as declaring no licence at all.
      hasLicenseText,
      deprecated: doc.info?.yanked ? "This release has been yanked from PyPI." : null,
    };
  }
  cache.set(name, result);
  return result;
}

/**
 * Every module name the repo itself defines: the basename of each .py file
 * plus every directory segment on the way to one (packages). Anything in
 * this set can be satisfied by an intra-repo import from anywhere (tests
 * importing sibling test modules, src-layout packages, etc.), so it must
 * never be treated as a PyPI dependency.
 */
function collectLocalModuleNames(repoDir: string): Set<string> {
  const names = new Set<string>();
  for (const file of listPythonFiles(repoDir)) {
    const rel = path.relative(repoDir, file).split(path.sep);
    const base = rel[rel.length - 1];
    names.add(base.replace(/\.py$/, ""));
    for (const segment of rel.slice(0, -1)) names.add(segment);
  }
  return names;
}

/**
 * PyPI verdicts, mirroring the npm checker. Python-specific care:
 * - stdlib modules are never checked or flagged
 * - imported-but-undeclared names that 404 are only phantom when they're
 *   also not resolvable as a local module in the repo — Python's import
 *   namespace conflates local and third-party names
 * - import names are mapped through the alias table (cv2 → opencv-python)
 */
export async function checkPythonDependencies(
  repoDir: string,
  manifest: PythonManifest | null,
  importedNames: Set<string>,
  options?: { transitivelyRequired?: Set<string> },
): Promise<DependencyVerdict[]> {
  const declared = manifest?.dependencies ?? {};
  const localModules = collectLocalModuleNames(repoDir);
  const transitivelyRequired = options?.transitivelyRequired ?? new Set<string>();

  // Distribution name -> the import evidence that maps to it.
  const importedDistributions = new Map<string, string>();
  for (const importName of importedNames) {
    if (PYTHON_STDLIB.has(importName)) continue;
    if (localModules.has(importName)) continue;
    importedDistributions.set(importNameToDistribution(importName), importName);
  }

  const names = new Set([...Object.keys(declared), ...importedDistributions.keys()]);
  const verdicts: DependencyVerdict[] = [];
  const queue = [...names];

  async function workerLoop() {
    while (queue.length) {
      const name = queue.shift()!;
      const normalized = normalizePyPiName(name);
      const declaredVersion = declared[normalized] ?? null;
      const isDeclared = normalized in declared;
      const isImported = importedDistributions.has(normalized);
      try {
        const { exists, meta } = await checkPyPiPackage(normalized);
        let status: DependencyVerdict["status"];
        let registryMetadata = meta;
        if (!exists) {
          status = "phantom";
          const alternative = fuzzyAlternative(normalized, "pypi");
          if (alternative) registryMetadata = { alternatives: [alternative] };
        } else if (
          isDeclared &&
          !isImported &&
          !NEVER_FLAG_UNUSED.has(normalized) &&
          !transitivelyRequired.has(normalized)
        ) {
          status = "unused";
        } else {
          const monthly = (meta?.weeklyDownloads as number | null) ?? null;
          const created = meta?.created ? new Date(meta.created as string) : null;
          const ageDays = created ? (Date.now() - created.getTime()) / 86_400_000 : Infinity;
          const lowDownloads = monthly !== null && monthly < SUSPICIOUS_MONTHLY_DOWNLOADS;
          const veryNew = ageDays < SUSPICIOUS_AGE_DAYS;
          status = lowDownloads || veryNew ? "suspicious" : "healthy";
        }
        // Known-hallucination corpus — see registry.ts for why a match is
        // never left "healthy".
        const hallucinated = lookupHallucinatedName(normalized, "pypi");
        if (hallucinated) {
          registryMetadata = { ...(registryMetadata ?? {}), hallucinated };
          if (status === "healthy") status = "suspicious";
        }

        // Typosquat/slopsquat check — see registry.ts for the distance/
        // established-package policy. Downloads here are monthly (PyPI).
        if (status !== "phantom") {
          const monthlyDl = (meta?.weeklyDownloads as number | null) ?? null;
          const established = monthlyDl !== null && monthlyDl >= 100_000;
          const squat = checkTyposquat(normalized, "pypi");
          if (squat && (status === "suspicious" || (squat.distance === 1 && !established))) {
            status = "suspicious";
            registryMetadata = {
              ...(meta ?? {}),
              typosquatOf: squat.suspectedTarget,
              typosquatDistance: squat.distance,
            };
          }
        }
        verdicts.push({
          packageName: normalized,
          declaredVersion,
          status,
          ecosystem: "pypi",
          registryMetadata,
        });
      } catch {
        verdicts.push({
          packageName: normalized,
          declaredVersion,
          status: isDeclared && !isImported ? "unused" : "healthy",
          ecosystem: "pypi",
          registryMetadata: { error: "registry_unreachable" },
        });
      }
    }
  }

  await Promise.all(Array.from({ length: CONCURRENCY }, workerLoop));
  return verdicts;
}
