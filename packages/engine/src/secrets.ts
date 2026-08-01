import fs from "node:fs";
import path from "node:path";
import { createHash } from "node:crypto";

/**
 * A credential found in source. Deliberately does NOT carry the value — see
 * `redact`. A secrets scanner that stores secrets is a liability, not a
 * feature, and this finding travels to a database, an API, an export and
 * (for public repositories) a world-readable pull-request comment.
 */
export interface SecretFinding {
  filePath: string;
  line: number;
  provider: string;
  /** e.g. `AKIA…(20 chars)`. Never the value. */
  redacted: string;
  /** Non-reversible; used only to deduplicate across HEAD and git history. */
  fingerprint: string;
  tier: 1 | 2;
  /** Set by history scanning: gone from HEAD but still in git objects. */
  removedFromHead?: boolean;
  firstSeenCommit?: string;
  lastSeenCommit?: string;
}

/** Tier 1 — issuer-prefixed credentials. Near-zero false positive rate. */
const PROVIDER_PATTERNS: { provider: string; pattern: RegExp }[] = [
  { provider: "AWS access key", pattern: /\bAKIA[0-9A-Z]{16}\b/ },
  { provider: "Anthropic API key", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/ },
  { provider: "OpenAI API key", pattern: /\bsk-[A-Za-z0-9]{32,}\b/ },
  { provider: "Groq API key", pattern: /\bgsk_[A-Za-z0-9]{40,}/ },
  { provider: "GitHub token", pattern: /\b(?:ghp|gho|ghs|ghu)_[A-Za-z0-9]{36,}\b/ },
  { provider: "GitHub fine-grained token", pattern: /\bgithub_pat_[A-Za-z0-9_]{50,}/ },
  { provider: "Google API key", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/ },
  { provider: "Slack token", pattern: /\bxox[baprs]-[A-Za-z0-9-]{10,}/ },
  { provider: "Stripe live key", pattern: /\b(?:sk|rk)_live_[A-Za-z0-9]{20,}/ },
  { provider: "SendGrid API key", pattern: /\bSG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/ },
  { provider: "npm token", pattern: /\bnpm_[A-Za-z0-9]{36}\b/ },
  { provider: "GitLab token", pattern: /\bglpat-[A-Za-z0-9_-]{20,}/ },
  { provider: "DigitalOcean token", pattern: /\bdop_v1_[a-f0-9]{64}\b/ },
  { provider: "private key", pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----/ },
];

/** Tier 2 — a secret-sounding name assigned a high-entropy literal. */
const CONTEXTUAL_ASSIGNMENT =
  /['"]?([A-Za-z0-9_.-]*(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key)[A-Za-z0-9_.-]*)['"]?\s*[:=]\s*['"]([^'"\n]{16,})['"]/gi;

const MIN_ENTROPY_BITS = 4;

/**
 * Reading a value from the environment is the CORRECT pattern, not a finding.
 * Without this, every well-written config file lights up.
 */
const ENV_REFERENCE = /process\.env|os\.environ|import\.meta\.env|ENV\[|getenv\(|Deno\.env/;

/** Values that are obviously stand-ins rather than live credentials. */
const PLACEHOLDER =
  /^(?:x{3,}|\.{3,}|\*{3,}|<[^>]*>|\$\{[^}]*\}|your[-_ ]|my[-_ ]|changeme|placeholder|dummy|example|sample|redacted|insert|todo|fixme|abc123|test[-_]?(?:key|token|secret)?$)/i;

/**
 * Documentation sample credentials. Vendors embed a marker word in the values
 * they publish in tutorials — Amazon's canonical `AKIAIOSFODNN7EXAMPLE` is the
 * most-copied string of its kind — so any README, ADR or onboarding doc that
 * quotes one would otherwise be reported as a live leak. A randomly generated
 * credential effectively never contains these markers, so the recall cost is
 * negligible against a large precision win.
 */
const DOCUMENTATION_SAMPLE = /EXAMPLE|SAMPLE_?KEY|YOUR_?(?:API_?)?KEY|XXXXXXXX/i;

function shannonEntropy(value: string): number {
  const counts = new Map<string, number>();
  for (const ch of value) counts.set(ch, (counts.get(ch) ?? 0) + 1);
  let entropy = 0;
  for (const count of counts.values()) {
    const p = count / value.length;
    entropy -= p * Math.log2(p);
  }
  return entropy;
}

/**
 * The single choke point through which a secret may be described. Everything
 * that leaves this module — database row, API payload, CLI line, PR comment,
 * exported report — must describe the value through this, never directly.
 */
export function redact(value: string): string {
  return `${value.slice(0, 4)}…(${value.length} chars)`;
}

/** Stable, non-reversible identity for deduplication. Never stored as a value. */
export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 16);
}

const SCANNABLE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yml", ".yaml",
  ".ini", ".cfg", ".conf", ".toml", ".tf", ".tfvars", ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".java", ".properties", ".xml", ".txt", ".md", ".env",
]);

const EXCLUDED_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv)\//;
const EXCLUDED_FIXTURE = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|test-fixtures?)\//i;
/** Integrity hashes are maximally high-entropy and would fire on every line. */
const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$/;
/** Template env files exist precisely to hold fake values. */
const TEMPLATE_FILE = /(\.example|\.sample|\.template|\.dist)$|(^|\/)\.env\.(example|sample|template)$/i;
const MINIFIED = /\.min\.(js|css)$|\.map$/;

export function isSecretScannablePath(relPath: string): boolean {
  const normalized = relPath.split(path.sep).join("/");
  if (EXCLUDED_PATH.test(normalized)) return false;
  if (EXCLUDED_FIXTURE.test(normalized)) return false;
  if (LOCKFILE.test(normalized)) return false;
  if (TEMPLATE_FILE.test(normalized)) return false;
  if (MINIFIED.test(normalized)) return false;
  const base = path.posix.basename(normalized);
  // `.env`, `.env.local`, `.npmrc` have no extension in the usual sense.
  if (base.startsWith(".env") || base === ".npmrc" || base === ".netrc") return true;
  return SCANNABLE_EXTENSIONS.has(path.posix.extname(base).toLowerCase());
}

/**
 * Scan one buffer. Shared by the working-tree walk and by the server-side git
 * history scanner, so detection logic exists in exactly one place.
 */
export function scanTextForSecrets(text: string, filePath: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const seen = new Set<string>();
  const lines = text.split("\n");

  const push = (value: string, provider: string, line: number, tier: 1 | 2) => {
    // A vendor-marked documentation sample (e.g. Amazon's AKIA...EXAMPLE) —
    // never a live credential, regardless of which tier matched it.
    if (DOCUMENTATION_SAMPLE.test(value)) return;
    const fingerprint = fingerprintSecret(value);
    if (seen.has(fingerprint)) return;
    seen.add(fingerprint);
    findings.push({ filePath, line, provider, redacted: redact(value), fingerprint, tier });
  };

  lines.forEach((rawLine, index) => {
    const line = rawLine.slice(0, 2000);
    const lineNumber = index + 1;

    for (const { provider, pattern } of PROVIDER_PATTERNS) {
      const match = pattern.exec(line);
      if (match) push(match[0], provider, lineNumber, 1);
    }

    if (ENV_REFERENCE.test(line)) return;

    CONTEXTUAL_ASSIGNMENT.lastIndex = 0;
    let contextual: RegExpExecArray | null;
    while ((contextual = CONTEXTUAL_ASSIGNMENT.exec(line)) !== null) {
      const value = contextual[2];
      if (PLACEHOLDER.test(value)) continue;
      if (shannonEntropy(value) < MIN_ENTROPY_BITS) continue;
      push(value, "generic credential", lineNumber, 2);
    }
  });

  return findings;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;

/** Walks the repository. Its own walk: credentials live in .env and .tf, not just source. */
export function findSecrets(repoDir: string): SecretFinding[] {
  const findings: SecretFinding[] = [];
  const stack = [repoDir];

  while (stack.length && findings.length < MAX_FINDINGS) {
    const current = stack.pop()!;
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(current, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const full = path.join(current, entry.name);
      const rel = path.relative(repoDir, full).split(path.sep).join("/");
      if (entry.isDirectory()) {
        if (!EXCLUDED_PATH.test(`${rel}/`) && !EXCLUDED_FIXTURE.test(`${rel}/`)) stack.push(full);
        continue;
      }
      if (!entry.isFile() || !isSecretScannablePath(rel)) continue;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        findings.push(...scanTextForSecrets(fs.readFileSync(full, "utf8"), rel));
      } catch {
        // unreadable or non-UTF8 file — skip, never fail a scan for one file
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}
