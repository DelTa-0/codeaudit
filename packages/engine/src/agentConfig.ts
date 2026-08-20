import fs from "node:fs";
import { createHash } from "node:crypto";
import path from "node:path";
import { canonicalizeWithTrace, findMixedScriptWords, type CanonicalizationStep } from "./canonicalize.js";

/**
 * A file the AI coding agent itself trusts as instructions or configuration —
 * distinct from application source, which the agent merely edits. Poisoning
 * one of these hijacks every future agent session against this repo, not
 * just the current diff.
 */
export type AgentSurface = "instructions" | "mcp_config" | "permissions" | "skill" | "corroborate_only";

export type AgentConfigCategory =
  | "hidden_text"
  | "instruction_injection"
  | "credential_exfiltration"
  | "dangerous_agent_config"
  | "unverified_mcp_package";

/**
 * A finding against an agent-config surface. Deliberately does NOT carry raw
 * repo text — see `redactSnippet`. A prompt-injection scanner that echoes the
 * payload it found is itself a delivery mechanism: this finding travels to a
 * database, an MCP tool response, a dashboard, and (via the CLI) another
 * agent's context window.
 */
export interface AgentConfigFinding {
  filePath: string;
  line: number;
  category: AgentConfigCategory;
  /** Stable machine id, e.g. "unicode_tag", "always_allow", "mcp_shell_command". */
  rule: string;
  severity: "critical" | "high" | "medium";
  tier: 1 | 2;
  surface: AgentSurface;
  /** Remediation sentence. Always written by us, never repo text. */
  message: string;
  /**
   * True when the rule only matched after canonicalization — i.e. the payload
   * was written to defeat a literal matcher. Absent on a raw match, so an
   * existing consumer sees exactly what it saw before.
   */
  canonicalized?: boolean;
  /** Which canonicalization steps changed the text, when `canonicalized`. */
  transformations?: CanonicalizationStep[];
  /** Sanitized excerpt. Produced only by `redactSnippet` — never raw. */
  evidence: string;
}

export interface McpPackageRef {
  filePath: string;
  line: number;
  packageName: string;
  ecosystem: "npm" | "pypi";
  pinned: boolean;
  serverKey: string;
}

// ---------------------------------------------------------------------------
// Path classification — an allow-list, and the primary false-positive control.
// Everything not matched here is simply never inspected: application source,
// docs, tests. That is what keeps this engine's own docs (which discuss
// prompt injection at length) and this very file (which names every payload
// below) from ever being scanned as if they were agent instructions.
// ---------------------------------------------------------------------------

const EXCLUDED_PATH =
  /(^|\/)(node_modules|dist|build|out|coverage|vendor|\.git|__pycache__|\.venv|venv)\//;
const EXCLUDED_FIXTURE = /(^|\/)(tests?|__tests__|__mocks__|fixtures?|test-fixtures?)\//i;

const MCP_CONFIG_PATTERN =
  /(^|\/)(\.mcp\.json|\.vscode\/mcp\.json|\.cursor\/mcp\.json|\.claude\/mcp\.json|cline_mcp_settings\.json)$/;
const PERMISSIONS_PATTERN = /(^|\/)\.claude\/settings(\.local)?\.json$/;
const SKILL_PATTERN = /(^|\/)\.claude\/(skills\/.+\/SKILL\.md|commands\/.+\.md)$/i;
const INSTRUCTIONS_PATTERN =
  /(^|\/)(CLAUDE\.md|AGENTS\.md|\.cursorrules|\.clinerules|\.windsurfrules|\.github\/copilot-instructions\.md|\.cursor\/rules\/.+\.mdc?|\.claude\/agents\/.+\.md)$/i;
const CORROBORATE_PATTERN = /(^|\/)(README\.md|CONTRIBUTING\.md)$/i;

export function classifyAgentSurface(relPath: string): AgentSurface | null {
  const normalized = relPath.split(path.sep).join("/");
  if (EXCLUDED_PATH.test(normalized)) return null;
  if (EXCLUDED_FIXTURE.test(normalized)) return null;

  if (MCP_CONFIG_PATTERN.test(normalized)) return "mcp_config";
  if (PERMISSIONS_PATTERN.test(normalized)) return "permissions";
  if (SKILL_PATTERN.test(normalized)) return "skill";
  if (INSTRUCTIONS_PATTERN.test(normalized)) return "instructions";
  if (CORROBORATE_PATTERN.test(normalized)) return "corroborate_only";
  return null;
}

// ---------------------------------------------------------------------------
// Tier 1 — structural. No benign explanation in a file the agent trusts.
// ---------------------------------------------------------------------------

/** curl|wget piped straight into a shell. Bounded to guard against a long adversarial line. */
const CURL_PIPE_SHELL =
  /\b(?:curl|wget)\b[^\n|]{0,200}\|\s*(?:sudo(?:\s+-\w+)*\s+)?(?:\/bin\/)?(?:ba|z|da)?sh\b/i;
/**
 * Download-to-a-file, then execute that file — the same attack as
 * `curl | sh` with the pipe taken out, and the form real install docs most
 * often use. Deliberately two parts on one line rather than one regex: the
 * download alone is ordinary (`curl -o data.json …` appears in this repo's
 * own docs) and the shell call alone is ordinary. Only the pair is an
 * instruction to run remote code — the same shape as the CREDENTIAL_PATH +
 * EGRESS_VERB pairing already used for exfiltration.
 *
 * Same-line only. A payload split across lines is not caught here; widening
 * to a window would spend a false-positive budget this rule has not earned.
 */
const DOWNLOAD_TO_FILE =
  /\b(?:curl|wget)\b[^\n]{0,200}(?:\s-[oO]\b|\s--output(?:-document)?\b|>)/i;
const SHELL_EXEC_AFTER =
  /(?:&&|;|\|\|)\s*(?:sudo(?:\s+-\w+)*\s+)?(?:\/bin\/)?(?:ba|z|da)?sh\s+\S/i;
const POWERSHELL_DOWNLOAD_EXEC =
  /\b(?:iex\s*\(|Invoke-Expression\b)[^\n]{0,200}(?:Invoke-WebRequest|iwr|DownloadString)/i;
const BASE64_EXEC =
  /\bbase64\s+(?:-d|--decode)\b[^\n]{0,120}\|\s*(?:ba|z)?sh\b|\batob\([^)]{0,200}\)[^\n]{0,50}(?:eval|Function)\s*\(|\beval\s*\(\s*(?:atob|Buffer\.from)\s*\(/i;

const SHELL_COMMAND = /^(?:\/bin\/)?(?:sh|bash|zsh|dash)$|^(?:cmd(?:\.exe)?|powershell(?:\.exe)?|pwsh)$/i;
/** A raw shell metacharacter inside a single arg — chaining, substitution, or piping. */
const SHELL_METACHAR = /[|;`]|&&|\$\(/;
const AUTO_APPROVE_KEYS = ["alwaysAllow", "autoApprove", "autoApproveTools", "yolo", "dangerouslySkipPermissions"];
const WILDCARD_PERMISSION = /^\*$|\(\s*\*(?:\s*:\s*\*)?\s*\)/;

// ---------------------------------------------------------------------------
// Tier 2 — linguistic. Narrow scope or corroboration required.
// ---------------------------------------------------------------------------

const INJECTION_PHRASE =
  /\bignore\s+(?:all\s+)?(?:previous|prior|the\s+above)\s+instructions\b|\bdisregard\s+(?:the\s+)?(?:above|previous|prior)\b|\byou\s+are\s+now\s+(?:a|an)\b|\bnew\s+system\s+prompt\b|\boverride\s+your\s+(?:instructions|rules|guidelines|safety)\b|\bdo\s+not\s+(?:tell|inform|mention\s+this\s+to)\s+the\s+user\b|\bwithout\s+(?:informing|telling|notifying)\s+the\s+user\b/i;

/**
 * Requires a credential path AND an egress verb within a 3-line window — the
 * two-part requirement is what keeps an ordinary security note (e.g. "secrets
 * only live in .env, never committed") silent: a path alone is not a finding.
 */
const CREDENTIAL_PATH =
  /\.env\b|~\/\.ssh\b|id_rsa\b|~\/\.aws\/credentials\b|~\/\.npmrc\b|\.npmrc\b|~\/\.config\/gh\b|credentials\.json\b/i;
const EGRESS_VERB =
  /\bcurl\b|\bwget\b|\bfetch\(|\bPOST\s|\bupload\b|\bexfiltrat\w*\b|\bsend\s+(?:it|them|these)\s+to\b|\bwebhook\b|https?:\/\//i;

/**
 * Window sizes for canonicalized phrase matching, smallest first so the
 * tightest span that explains a payload is the one reported.
 */
const PHRASE_WINDOW_SIZES = [1, 2, 3] as const;

/** Short, non-reversible key for deduplicating findings by their evidence. */
function fingerprintEvidence(evidence: string): string {
  return createHash("sha256").update(evidence).digest("hex").slice(0, 12);
}

/** Bounded so a huge unclosed `<!--` can't force a runaway scan. */
const HTML_COMMENT = /<!--([\s\S]{0,500}?)-->/g;

function lineOfIndex(text: string, index: number): number {
  if (index < 0) return 1;
  let line = 1;
  for (let i = 0; i < index && i < text.length; i++) if (text[i] === "\n") line++;
  return line;
}

function isPinnedSpecifier(candidate: string): boolean {
  return candidate.lastIndexOf("@") > 0;
}

/**
 * The single choke point through which repo text may describe an
 * agent-config finding. A prompt-injection scanner that echoes the payload's
 * mechanism verbatim (an invisible character, a forged markdown table row)
 * republishes the attack in whatever surface reads the finding next.
 */
export function redactSnippet(raw: string): string {
  let out = "";
  for (const ch of raw) {
    const cp = ch.codePointAt(0) ?? 0;
    const isInvisibleOrControl =
      cp < 0x20 ||
      (cp >= 0x7f && cp <= 0x9f) ||
      (cp >= 0x200b && cp <= 0x200f) ||
      (cp >= 0x202a && cp <= 0x202e) ||
      (cp >= 0x2066 && cp <= 0x2069) ||
      (cp >= 0xe0000 && cp <= 0xe007f) ||
      cp === 0xfeff;
    out += isInvisibleOrControl ? `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>` : ch;
  }
  out = out.replace(/\s+/g, " ").trim();
  out = out.replace(/[`<>|]/g, "").replace(/^[#>\-=+]+/, "");
  return out.length > 120 ? `${out.slice(0, 120)}…` : out;
}

/**
 * Scans free text (markdown instructions, skill files, README corroboration)
 * for hidden characters and injection-shaped language. JSON structural risks
 * (auto-approve flags, shell commands, wildcard permissions) are a separate
 * pass — see `auditAgentJson` — because they need a parsed object, not text.
 */
export function scanAgentText(text: string, filePath: string, surface: AgentSurface): AgentConfigFinding[] {
  const findings: AgentConfigFinding[] = [];
  const seen = new Set<string>();

  const push = (
    category: AgentConfigCategory,
    rule: string,
    severity: "critical" | "high" | "medium",
    tier: 1 | 2,
    line: number,
    message: string,
    evidence: string,
    extra?: { canonicalized: true; transformations: CanonicalizationStep[] },
  ) => {
    // Keyed by evidence as well as rule and line: a canonicalized window and
    // a raw line can share a start line while describing different spans.
    const key = `${rule}:${line}:${fingerprintEvidence(evidence)}`;
    if (seen.has(key)) return;
    seen.add(key);
    findings.push({
      filePath, line, category, rule, severity, tier, surface, message,
      evidence: redactSnippet(evidence),
      ...(extra ?? {}),
    });
  };

  // A BOM at the very start of a file is a byte-order mark, not an attack.
  let content = text;
  if (content.charCodeAt(0) === 0xfeff) content = content.slice(1);

  const lines = content.split("\n");
  let hasTier1Hit = false;

  lines.forEach((rawLine, idx) => {
    const line = rawLine.slice(0, 2000);
    const lineNumber = idx + 1;

    // Hidden/invisible characters — iterate by code point so surrogate-pair
    // emoji are treated as single units, not two suspicious halves.
    const codePoints = Array.from(line);
    for (let i = 0; i < codePoints.length; i++) {
      const cp = codePoints[i].codePointAt(0) ?? 0;
      if (cp === 0x200b || cp === 0x200c) {
        push(
          "hidden_text", "zero_width", "critical", 1, lineNumber,
          "Invisible zero-width character in a file the agent trusts as instructions.", line,
        );
        hasTier1Hit = true;
      } else if (cp === 0x200d) {
        // U+200D between two non-ASCII pictographs is an emoji ZWJ sequence
        // (e.g. a family emoji) — entirely ordinary in hand-written prose.
        const prev = i > 0 ? (codePoints[i - 1].codePointAt(0) ?? 0) : 0;
        const next = i < codePoints.length - 1 ? (codePoints[i + 1].codePointAt(0) ?? 0) : 0;
        const isEmojiJoin = prev > 0x2000 && next > 0x2000;
        if (!isEmojiJoin) {
          push(
            "hidden_text", "zero_width", "critical", 1, lineNumber,
            "Invisible zero-width joiner found outside an emoji sequence.", line,
          );
          hasTier1Hit = true;
        }
      } else if (cp >= 0xe0000 && cp <= 0xe007f) {
        push(
          "hidden_text", "unicode_tag", "critical", 1, lineNumber,
          "Unicode tag-block character found — this block has no legitimate use in ordinary text.", line,
        );
        hasTier1Hit = true;
      } else if ((cp >= 0x202a && cp <= 0x202e) || (cp >= 0x2066 && cp <= 0x2069)) {
        push(
          "hidden_text", "bidi_override", "critical", 1, lineNumber,
          "Bidirectional text-override character found; can visually reorder text to hide instructions.", line,
        );
        hasTier1Hit = true;
      }
    }

    // MIXED_SCRIPT_WORD — tier 1, and the only rule here that is independent
    // of wording: it reports the tampering rather than the payload, so it
    // catches homoglyph attacks whose phrasing no list anticipated.
    //
    // Deliberately does NOT set hasTier1Hit. That flag unlocks tier-2 phrase
    // matching on README/CONTRIBUTING, and a single stray Greek character in
    // a README is far weaker evidence than a zero-width character — not
    // enough to change how the rest of the file is judged.
    const mixedScriptWords = findMixedScriptWords(line);
    if (mixedScriptWords.length) {
      push(
        "hidden_text", "mixed_script_word", "medium", 1, lineNumber,
        `Word mixes Latin with Cyrillic or Greek characters (${mixedScriptWords.length} on this line) — visually identical to plain text, but a different string to every matcher.`,
        line,
      );
    }

    if (CURL_PIPE_SHELL.test(line) || POWERSHELL_DOWNLOAD_EXEC.test(line)) {
      push(
        "instruction_injection", "curl_pipe_shell", "critical", 1, lineNumber,
        "Instructs downloading and piping remote content directly into a shell.", line,
      );
      hasTier1Hit = true;
    }
    if (DOWNLOAD_TO_FILE.test(line) && SHELL_EXEC_AFTER.test(line)) {
      push(
        "instruction_injection", "download_then_exec", "critical", 1, lineNumber,
        "Instructs downloading remote content to a file and then executing it.", line,
      );
      hasTier1Hit = true;
    }
    if (BASE64_EXEC.test(line)) {
      push(
        "instruction_injection", "base64_exec", "critical", 1, lineNumber,
        "Instructs decoding a base64 payload and executing it.", line,
      );
      hasTier1Hit = true;
    }
  });

  // injection_phrase — tier 2. On corroborate_only (README/CONTRIBUTING) this
  // fires only alongside a tier-1 hit in the same file, so a security-focused
  // README describing these exact phrases doesn't self-trigger.
  const PHRASE_MESSAGE =
    "Contains phrasing associated with prompt-injection attacks (role hijack, instruction override).";
  const boundedLines = lines.map((l) => l.slice(0, 2000));
  /** Line indices already accounted for, so one payload yields one finding. */
  const phraseReported = new Set<number>();

  // Pass A — raw, per line. Unchanged on purpose: a payload written plainly
  // keeps the rule id, severity and evidence it has always had, so nothing
  // downstream (scoring, dashboards, the PR comment) sees a different shape.
  boundedLines.forEach((line, idx) => {
    if (!INJECTION_PHRASE.test(line)) return;
    if (surface === "corroborate_only" && !hasTier1Hit) return;
    push("instruction_injection", "injection_phrase", "high", 2, idx + 1, PHRASE_MESSAGE, line);
    phraseReported.add(idx);
  });

  // Pass B — canonicalized, over a bounded sliding window.
  //
  // Each line is canonicalized ONCE and windows are assembled from the cached
  // results, which the composition property in canonicalize.ts makes exact.
  // The naive form — canonicalize every window — would triple the work for an
  // identical answer.
  //
  // Bounded at three lines, matching the budget credential_exfiltration
  // already spends. A whole-file join is the tempting version and the wrong
  // one: it manufactures phrases out of unrelated paragraphs.
  const canonicalLines = boundedLines.map((line) => canonicalizeWithTrace(line));
  for (let i = 0; i < boundedLines.length; i++) {
    if (phraseReported.has(i)) continue;
    for (const size of PHRASE_WINDOW_SIZES) {
      if (i + size > boundedLines.length) break;
      // Skip a window that reaches into a line already reported. Checking
      // only the START line was not enough: a raw hit on line 3 and a
      // three-line window opening at line 1 are one phrase, and were being
      // reported as two findings. Found against a real corpus, not in
      // review. A larger window can only overlap more, so stop rather than
      // continue.
      let overlapsReported = false;
      for (let k = i; k < i + size; k++) {
        if (phraseReported.has(k)) { overlapsReported = true; break; }
      }
      if (overlapsReported) break;
      const slice = canonicalLines.slice(i, i + size);
      const canonical = slice.map((c) => c.text).join(" ").trim();
      if (!INJECTION_PHRASE.test(canonical)) continue;
      if (surface === "corroborate_only" && !hasTier1Hit) break;
      const steps = [...new Set(slice.flatMap((c) => c.transformations))];
      push(
        "instruction_injection", "injection_phrase_canonicalized", "high", 2, i + 1,
        `${PHRASE_MESSAGE} Matched only after canonicalization (${steps.join(", ")}), meaning the text was written to read normally while defeating a literal matcher.`,
        boundedLines.slice(i, i + size).join("\n"),
        { canonicalized: true, transformations: steps },
      );
      // Smallest matching window wins, and every line it covers is spent.
      for (let k = i; k < i + size; k++) phraseReported.add(k);
      break;
    }
  }

  // credential_exfiltration — tier 2, two-part requirement within a 3-line window.
  const credLines: number[] = [];
  const egressLines: number[] = [];
  lines.forEach((rawLine, idx) => {
    const line = rawLine.slice(0, 2000);
    if (CREDENTIAL_PATH.test(line)) credLines.push(idx);
    if (EGRESS_VERB.test(line)) egressLines.push(idx);
  });
  for (const c of credLines) {
    if (egressLines.some((e) => Math.abs(e - c) <= 1)) {
      push(
        "credential_exfiltration", "credential_exfiltration", "critical", 2, c + 1,
        "References a credential file alongside an instruction to send data externally.",
        lines[c].slice(0, 2000),
      );
    }
  }

  // hidden_html_instruction — tier 2. An HTML comment alone is ordinary
  // markdown; only a comment whose body matches another rule is a finding.
  HTML_COMMENT.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = HTML_COMMENT.exec(content)) !== null) {
    const body = m[1];
    const looksLikeExfil = CREDENTIAL_PATH.test(body) && EGRESS_VERB.test(body);
    if (INJECTION_PHRASE.test(body) || CURL_PIPE_SHELL.test(body) || BASE64_EXEC.test(body) || looksLikeExfil) {
      const lineNumber = content.slice(0, m.index).split("\n").length;
      push(
        "instruction_injection", "hidden_html_instruction", "high", 2, lineNumber,
        "HTML comment hides instruction-like text from rendered markdown views.", body,
      );
    }
  }

  return findings;
}

/**
 * Audits parsed JSON agent config (MCP server definitions, permission
 * allow-lists) for structural risk. Silently returns nothing for
 * non-JSON-shaped surfaces or unparseable content — a malformed config is a
 * usage problem for the agent, not evidence of an attack.
 */
export function auditAgentJson(text: string, filePath: string, surface: AgentSurface): AgentConfigFinding[] {
  if (surface !== "mcp_config" && surface !== "permissions") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const findings: AgentConfigFinding[] = [];

  const push = (
    category: AgentConfigCategory,
    rule: string,
    severity: "critical" | "high" | "medium",
    tier: 1 | 2,
    line: number,
    message: string,
    evidence: string,
  ) => {
    findings.push({ filePath, line, category, rule, severity, tier, surface, message, evidence: redactSnippet(evidence) });
  };

  const checkAutoApprove = (obj: Record<string, unknown>, line: number, label: string) => {
    for (const key of AUTO_APPROVE_KEYS) {
      const value = obj[key];
      const isTruthy = value === true || (Array.isArray(value) && value.length > 0);
      if (isTruthy) {
        push(
          "dangerous_agent_config", "always_allow", "critical", 1, line,
          `${label} sets "${key}", granting standing approval without per-action confirmation.`,
          `${key}: ${JSON.stringify(value)}`,
        );
      }
    }
  };

  if (surface === "mcp_config") {
    checkAutoApprove(root, lineOfIndex(text, 0), "The config");
    const servers = root.mcpServers && typeof root.mcpServers === "object"
      ? (root.mcpServers as Record<string, unknown>)
      : {};
    for (const [key, serverRaw] of Object.entries(servers)) {
      if (!serverRaw || typeof serverRaw !== "object") continue;
      const server = serverRaw as Record<string, unknown>;
      const line = lineOfIndex(text, text.indexOf(`"${key}"`));
      const command = typeof server.command === "string" ? server.command : "";
      const args = Array.isArray(server.args)
        ? server.args.filter((a): a is string => typeof a === "string")
        : [];

      checkAutoApprove(server, line, `MCP server "${key}"`);

      if (SHELL_COMMAND.test(command)) {
        push(
          "dangerous_agent_config", "mcp_shell_command", "critical", 1, line,
          `MCP server "${key}" invokes a shell directly ("${command}") instead of a specific binary.`,
          `${command} ${args.join(" ")}`,
        );
      } else if (args.some((a) => SHELL_METACHAR.test(a))) {
        push(
          "dangerous_agent_config", "mcp_shell_command", "critical", 1, line,
          `MCP server "${key}" passes shell metacharacters in its arguments.`,
          `${command} ${args.join(" ")}`,
        );
      }

      if ((command === "npx" || command === "uvx") && args.some((a) => a === "-y" || a === "--yes")) {
        const candidate = args.find((a) => a !== "-y" && a !== "--yes" && !a.startsWith("-"));
        if (candidate && !isPinnedSpecifier(candidate)) {
          push(
            "unverified_mcp_package", "unpinned_npx", "medium", 2, line,
            `MCP server "${key}" runs an unpinned package on every start ("${command} -y ${candidate}").`,
            `${command} -y ${candidate}`,
          );
        }
      }
    }
  }

  if (surface === "permissions") {
    checkAutoApprove(root, lineOfIndex(text, 0), "The settings file");
    const permissions = root.permissions && typeof root.permissions === "object"
      ? (root.permissions as Record<string, unknown>)
      : {};
    const allow = Array.isArray(permissions.allow) ? permissions.allow : [];
    for (const entry of allow) {
      if (typeof entry === "string" && WILDCARD_PERMISSION.test(entry)) {
        const line = lineOfIndex(text, text.indexOf(JSON.stringify(entry)));
        push(
          "dangerous_agent_config", "wildcard_permission", "high", 1, line,
          `Permission entry "${entry}" grants a wildcard rather than a specific, scoped command.`, entry,
        );
      }
    }
  }

  return findings;
}

/**
 * Extracts npm/PyPI package references from an MCP config so a caller can
 * verify them via the existing registry checks (`verifyPackage`). Kept
 * separate from `auditAgentJson` because verification needs the network —
 * see `agentPackages.ts`.
 */
export function collectMcpPackageRefs(text: string, filePath: string): McpPackageRef[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return [];
  }
  if (!parsed || typeof parsed !== "object") return [];
  const root = parsed as Record<string, unknown>;
  const servers = root.mcpServers && typeof root.mcpServers === "object"
    ? (root.mcpServers as Record<string, unknown>)
    : {};
  const refs: McpPackageRef[] = [];

  for (const [key, serverRaw] of Object.entries(servers)) {
    if (!serverRaw || typeof serverRaw !== "object") continue;
    const server = serverRaw as Record<string, unknown>;
    const command = typeof server.command === "string" ? server.command : "";
    const args = Array.isArray(server.args)
      ? server.args.filter((a): a is string => typeof a === "string")
      : [];

    let candidate: string | null = null;
    let ecosystem: "npm" | "pypi" = "npm";
    if (command === "npx") {
      candidate = args.find((a) => a !== "-y" && a !== "--yes" && !a.startsWith("-")) ?? null;
    } else if (command === "uvx") {
      candidate = args.find((a) => !a.startsWith("-")) ?? null;
      ecosystem = "pypi";
    }
    if (!candidate) continue;

    const pinned = isPinnedSpecifier(candidate);
    const atIndex = candidate.lastIndexOf("@");
    const packageName = pinned ? candidate.slice(0, atIndex) : candidate;
    const line = lineOfIndex(text, text.indexOf(`"${key}"`));
    refs.push({ filePath, line, packageName, ecosystem, pinned, serverKey: key });
  }

  return refs;
}

/**
 * Walks the repository collecting MCP package references for callers that
 * want to verify them against the registry — see `agentPackages.ts`. A
 * separate walk from `findAgentConfigIssues` because that verification needs
 * the network and callers may want to run it on its own schedule/try-catch.
 */
export function findMcpPackageRefs(repoDir: string): McpPackageRef[] {
  const refs: McpPackageRef[] = [];
  const stack = [repoDir];

  while (stack.length) {
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
      if (!entry.isFile() || classifyAgentSurface(rel) !== "mcp_config") continue;
      try {
        refs.push(...collectMcpPackageRefs(fs.readFileSync(full, "utf8"), rel));
      } catch {
        // unreadable or non-UTF8 file — skip, never fail a scan for one file
      }
    }
  }

  return refs;
}

const MAX_FILE_BYTES = 256 * 1024;
const MAX_FINDINGS = 100;

/** Walks the repository looking only at files an agent would trust as config or instructions. */
export function findAgentConfigIssues(repoDir: string): AgentConfigFinding[] {
  const findings: AgentConfigFinding[] = [];
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
      if (!entry.isFile()) continue;
      const surface = classifyAgentSurface(rel);
      if (!surface) continue;
      try {
        if (fs.statSync(full).size > MAX_FILE_BYTES) continue;
        const text = fs.readFileSync(full, "utf8");
        findings.push(...scanAgentText(text, rel, surface));
        findings.push(...auditAgentJson(text, rel, surface));
      } catch {
        // unreadable or non-UTF8 file — skip, never fail a scan for one file
      }
    }
  }

  return findings.slice(0, MAX_FINDINGS);
}

// ---------------------------------------------------------------------------
// Tool-description auditing — the poisoning surface a repo scan cannot see.
// ---------------------------------------------------------------------------

export interface ToolDescriptionAudit {
  toolCount: number;
  findings: AgentConfigFinding[];
  /** sha256 over the sorted (name, description) pairs. Store it in
   *  codeorion-mcp.lock and a later description change — a rug pull —
   *  surfaces as a lock mismatch instead of silently entering the context. */
  toolsHash: string;
}

/**
 * Audits the tool descriptions an MCP server EXPOSES, from a tools/list
 * result the caller obtained. Descriptions enter the agent's context as
 * trusted text, which makes them the premier injection carrier (the
 * "tool poisoning" class) — and none of the repo-file scanning here ever
 * sees them, because they live in the server, not the repo.
 *
 * Deliberately takes JSON, never a server to launch: assessing a server must
 * not require executing it. The caller that already ran the server passes
 * what it saw.
 *
 * Accepts either a bare array of {name, description} or the standard MCP
 * tools/list result shape ({ tools: [...] }).
 */
export function auditToolDescriptions(toolsJson: string): ToolDescriptionAudit | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(toolsJson);
  } catch {
    return null;
  }
  const list = Array.isArray(parsed)
    ? parsed
    : Array.isArray((parsed as { tools?: unknown[] })?.tools)
      ? (parsed as { tools: unknown[] }).tools
      : null;
  if (!list) return null;

  const tools = list
    .filter((t): t is { name?: unknown; description?: unknown } => !!t && typeof t === "object")
    .map((t) => ({
      name: typeof t.name === "string" ? t.name : "(unnamed)",
      description: typeof t.description === "string" ? t.description : "",
    }))
    .sort((a, b) => a.name.localeCompare(b.name));

  const findings: AgentConfigFinding[] = [];
  for (const tool of tools) {
    if (!tool.description) continue;
    // The existing instruction-surface rules apply unchanged: a hidden
    // Unicode payload or exfiltration instruction is the same attack whether
    // it lives in a CLAUDE.md or a tool description. The synthetic path keeps
    // findings attributable per tool without pretending a file exists.
    findings.push(...scanAgentText(tool.description, `mcp-tool:${tool.name}`, "instructions"));
  }

  const hash = createHash("sha256");
  for (const tool of tools) hash.update(`${tool.name}\u0000${tool.description}\u0000`);
  return { toolCount: tools.length, findings, toolsHash: hash.digest("hex") };
}
