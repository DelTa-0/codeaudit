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

/**
 * Tier 2 — a secret-sounding name assigned a high-entropy literal.
 *
 * The two `[A-Za-z0-9_.-]*` runs flanking the keyword are bounded to `{0,64}`
 * as a backtracking guard: unbounded, a single adversarial 2000-character line
 * measured 676ms to reject; bounded, the same line measured 8ms (~85x). This
 * regex runs over arbitrary user repositories on a hosted worker, so a cheap
 * line is a cheap way to burn a worker slot.
 *
 * Deliberately NOT a bare `key` alternative. `_KEY` is at least as often an
 * identifier as a secret — STORAGE_KEY, CACHE_KEY, QUERY_KEY, PRIMARY_KEY,
 * ROUTING_KEY, SHARD_KEY are all common and none of them hold cryptographic
 * material. Matching bare `key` and denylisting the false positives as they
 * turn up is the same shape of mistake as flagging `TOKEN_KEY` (a storage key
 * *name*, not a token) — the denylist never stops growing because "key" means
 * "identifier" in code far more often than "cryptographic secret". Instead,
 * the *specific* compounds below name cryptographic material directly, so
 * each one added is a precision decision, not a coverage sweep.
 */
const CONTEXTUAL_ASSIGNMENT =
  /['"]?([A-Za-z0-9_.-]{0,64}(?:api[_-]?key|secret|token|password|passwd|credential|private[_-]?key|encryption[_-]?key|signing[_-]?key|cipher[_-]?key|crypto[_-]?key|hmac[_-]?key|jwt[_-]?key|master[_-]?key|aes[_-]?key|rsa[_-]?key)[A-Za-z0-9_.-]{0,64})['"]?\s*[:=]\s*['"]([^'"\n]{16,})['"]/gi;

/**
 * Per-character entropy alone is really a test of alphabet size: hex tops out
 * at 4.0 bits/char, so a 32-character hex API key — a very common format —
 * could never clear a 4.0 threshold no matter how random it was. Measured:
 * 0% of random hex secrets passed at 16, 32 or 64 characters.
 *
 * So require a floor on per-character randomness (which rejects repeated or
 * dictionary-ish strings) AND a floor on TOTAL entropy (which admits long
 * small-alphabet secrets while still rejecting short ones).
 */
const MIN_ENTROPY_BITS_PER_CHAR = 3;
const MIN_TOTAL_ENTROPY_BITS = 60;

/**
 * Prose, not a credential.
 *
 * Shannon entropy over a character histogram measures alphabet variety, not
 * word-likeness — it cannot tell English from randomness. "Invalid
 * credentials" runs ~3.6 bits/char over 19 characters (~68 bits total) and
 * clears BOTH floors above, so a line like
 *
 *     CREDENTIALS_ERROR = "Invalid credentials provided"
 *
 * was reported as a CRITICAL hardcoded credential. Whitespace is the cheap
 * discriminator: generated credentials are drawn from base64/hex/urlsafe
 * alphabets and effectively never contain a space, while error messages and
 * documentation prose almost always do. Recall cost is negligible; precision
 * win is large, because the tier-2 keyword list (`secret`, `token`,
 * `credential`, `password`) is exactly the vocabulary of error messages about
 * those things.
 */
const CONTAINS_WHITESPACE = /\s/;

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
  const shown = value.length > 8 ? value.slice(0, 4) : "";
  return `${shown}…(${value.length} chars)`;
}

/**
 * Stable identity for deduplication, never a value.
 *
 * Peppered because tier 2 catches human-chosen passwords by design, and a bare
 * unsalted hash of one falls to a dictionary or a precomputed table. The pepper
 * is a constant, not a secret — it defeats precomputed tables, not a targeted
 * attacker. Treat this as internal to deduplication: it must never be rendered
 * into CLI output, an exported report, or a pull-request comment.
 */
const FINGERPRINT_PEPPER = "codeaudit-secret-fingerprint-v1";

export function fingerprintSecret(value: string): string {
  return createHash("sha256").update(`${FINGERPRINT_PEPPER}:${value}`).digest("hex").slice(0, 16);
}

const SCANNABLE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs", ".json", ".yml", ".yaml",
  ".ini", ".cfg", ".conf", ".toml", ".tf", ".tfvars", ".sh", ".bash", ".zsh",
  ".py", ".rb", ".go", ".java", ".properties", ".xml", ".txt", ".md", ".env",
]);

/**
 * Generated output. Must stay in step with `SKIP_DIRS` in imports.ts — the two
 * walkers drifting apart is not hypothetical: `.next` was listed there but not
 * here, so scanning a Next.js app reported ~60 "generic credential" findings
 * from minified chunks under `frontend/.next/`, drowning the three real ones
 * and dragging the score from an A to a D.
 */
const EXCLUDED_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv|\.next|\.nuxt|\.svelte-kit|\.turbo|\.output|target)\//;
const EXCLUDED_FIXTURE = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|test-fixtures?)\//i;
/** Integrity hashes are maximally high-entropy and would fire on every line. */
const LOCKFILE =
  /(^|\/)(package-lock\.json|yarn\.lock|pnpm-lock\.yaml|poetry\.lock|Cargo\.lock|composer\.lock|Gemfile\.lock)$/;
/** Template env files exist precisely to hold fake values. */
const TEMPLATE_FILE = /(\.example|\.sample|\.template|\.dist)$|(^|\/)\.env\.(example|sample|template)$/i;
const MINIFIED = /\.min\.(js|css)$|\.map$/;

/**
 * Files that exist to hold local credentials and are gitignored by convention.
 * Only skipped when the caller could not tell us what git actually tracks —
 * with a real `isTracked` predicate these ARE scanned, because a committed
 * `.env` is a genuine leak.
 */
const LOCAL_SECRET_FILE = /(^|\/)\.env(\.[A-Za-z0-9_-]+)?$/;

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
    // The private-key pattern matches only the PEM header, e.g.
    // "-----BEGIN RSA PRIVATE KEY-----", which is byte-identical for every
    // key in every file. Fingerprinting by value alone would collapse every
    // distinct private key in the whole scan onto one fingerprint. Folding
    // the file path in keeps distinct files distinct while every other
    // provider still fingerprints by value alone — that's what lets the same
    // credential be recognised across HEAD and git history.
    const fingerprintInput = provider === "private key" ? `${value}:${filePath}` : value;
    const fingerprint = fingerprintSecret(fingerprintInput);
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
      if (CONTAINS_WHITESPACE.test(value)) continue;
      const bitsPerChar = shannonEntropy(value);
      if (bitsPerChar < MIN_ENTROPY_BITS_PER_CHAR) continue;
      if (bitsPerChar * value.length < MIN_TOTAL_ENTROPY_BITS) continue;
      push(value, "generic credential", lineNumber, 2);
    }
  });

  return findings;
}

const MAX_FILE_BYTES = 512 * 1024;
const MAX_FINDINGS = 100;

export interface FindSecretsOptions {
  /**
   * Whether a repo-relative path is tracked by git. A credential in a tracked
   * file is a leak; one in a gitignored file like `.env` is correct practice,
   * and flagging it would fire on nearly every well-configured project.
   *
   * The engine cannot answer this itself — it is deliberately subprocess-free —
   * so callers that have git available supply it. When omitted, conventional
   * local-secret files are skipped instead, which is the safe default: better
   * to miss a secret in a file that is almost certainly gitignored than to
   * report every project's .env as a critical leak.
   */
  isTracked?: (relPath: string) => boolean;
}

/** Walks the repository. Its own walk: credentials live in .env and .tf, not just source. */
export function findSecrets(repoDir: string, options: FindSecretsOptions = {}): SecretFinding[] {
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
      if (options.isTracked) {
        if (!options.isTracked(rel)) continue;
      } else if (LOCAL_SECRET_FILE.test(rel)) {
        continue;
      }
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
