// Stable identity for a finding across scans.
//
// Every finding today exists only inside the scan that produced it, so the
// product can say "6 unused dependencies" but never "this one has been here
// since August 1st" or "you fixed this and it came back". Persistence needs a
// key that names the *problem* rather than the observation of it, and the hard
// part is choosing what counts as the same problem.
//
// The rule applied throughout: identity is what a developer would call "the
// same issue" when deciding whether their fix worked. Line numbers move on
// every edit above them, confidence changes when an LLM re-runs, versions
// bump — none of those are the issue changing, so none of them are in a key.
//
// What IS deliberately in a key, per kind, and why:
//
//   dependency   name + ecosystem + status. Status belongs: "axios is unused"
//                and "axios has a CVE" are different problems with different
//                fixes, and treating them as one would silently reclassify a
//                resolved cleanup as an unresolved vulnerability.
//
//   dead code    file + symbol, NOT findingType. A symbol that stops being
//                exported is still the same dead symbol; churning identity on
//                that would report a fix and a new finding for one refactor.
//
//   secret       fingerprint only. Already a hash of the credential itself, so
//                it survives the file being moved or renamed — which is the
//                point, since a leaked key is leaked wherever it lives.
//
//   agent config file + rule, NOT line and NOT the evidence excerpt. One
//                prompt-injection rule firing in one file is one problem to go
//                and look at; keying on line would resurrect it on every edit
//                above it.
//
// Known limitation, accepted for v1: a renamed or moved file reads as one
// finding resolved and one detected. The alternative — content hashing — is
// worse, because it churns on every edit to the code itself. Renames are rarer
// than edits, so this trades a rare wrong answer for a constant one.

export type FindingKind = "dependency" | "dead_code" | "secret" | "agent_config";

export interface FindingIdentity {
  kind: FindingKind;
  /** Stable across scans. Unique per repository. */
  key: string;
  /** Human label for lists and history views. Never used for matching. */
  title: string;
  /** Where to look. Null for findings that are not file-scoped. */
  location: string | null;
}

/** `:` separates fields, so any value containing one is escaped rather than
 *  allowed to shift the field boundaries and collide with another key. */
function esc(value: string): string {
  return value.replace(/\\/g, "\\\\").replace(/:/g, "\\:");
}

export function dependencyFindingIdentity(dep: {
  packageName: string;
  ecosystem: string;
  status: string;
}): FindingIdentity {
  return {
    kind: "dependency",
    key: `dependency:${esc(dep.ecosystem)}:${esc(dep.packageName)}:${esc(dep.status)}`,
    title: `${dep.packageName} (${dep.status})`,
    location: null,
  };
}

export function deadCodeFindingIdentity(finding: {
  filePath: string;
  symbolName: string;
}): FindingIdentity {
  return {
    kind: "dead_code",
    key: `dead_code:${esc(finding.filePath)}:${esc(finding.symbolName)}`,
    title: `${finding.symbolName} in ${finding.filePath}`,
    location: finding.filePath,
  };
}

export function secretFindingIdentity(finding: {
  fingerprint: string;
  provider: string;
  filePath: string;
}): FindingIdentity {
  return {
    kind: "secret",
    key: `secret:${esc(finding.fingerprint)}`,
    title: `${finding.provider} in ${finding.filePath}`,
    location: finding.filePath,
  };
}

export function agentConfigFindingIdentity(finding: {
  filePath: string;
  rule: string;
}): FindingIdentity {
  return {
    kind: "agent_config",
    key: `agent_config:${esc(finding.filePath)}:${esc(finding.rule)}`,
    title: `${finding.rule} in ${finding.filePath}`,
    location: finding.filePath,
  };
}
