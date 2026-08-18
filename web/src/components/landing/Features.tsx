import { useIsMobile, useIsCompact } from "../../lib/useMediaQuery";

const FEATURES = [
  {
    tag: "REGISTRY-VERIFIED",
    tagFg: "#c2452d",
    tagBg: "#fdeae5",
    title: "Phantom & typosquat detection",
    body: "Every dependency checked against the live npm and PyPI registries. Hallucinated packages are flagged before an attacker can slopsquat them, and near-miss names get a “did you mean” against the real package.",
  },
  {
    tag: "REDACTED BY DEFAULT",
    tagFg: "#c2452d",
    tagBg: "#fdeae5",
    title: "Hardcoded secret detection",
    body: "API keys, tokens and connection strings found in your source — and in your git history, where deleting the line never actually removed them. Values are redacted at the boundary: findings show a fingerprint, never the secret.",
  },
  {
    tag: "AGENT SURFACE",
    tagFg: "#c2452d",
    tagBg: "#fdeae5",
    title: "Agent-config auditing",
    body: "The files your coding agent obeys — CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions, MCP server configs — audited for prompt injection, over-broad permissions, and MCP servers pointed at packages that don't exist on the registry.",
  },
  {
    tag: "OSV.DEV",
    tagFg: "#b07d1e",
    tagBg: "#fdf3dd",
    title: "Known vulnerabilities",
    body: "Every resolved version, direct and transitive, checked against the OSV advisory database with severity and a link to the advisory.",
  },
  {
    tag: "AI-REVIEWED",
    tagFg: "#b07d1e",
    tagBg: "#fdf3dd",
    title: "Zombie & dead-code detection",
    body: "Static analysis finds unreferenced code; an LLM pass assigns a confidence score so you only see credible candidates. Bring your own key, or run it without one and get the raw static candidates.",
  },
  {
    tag: "SUPPLY CHAIN",
    tagFg: "#b07d1e",
    tagBg: "#fdf3dd",
    title: "Licence & duplicate audit",
    body: "Copyleft licences that conflict with your project's, and three libraries doing the same job — the kind of drift that accumulates when every prompt picks its own favourite.",
  },
  {
    tag: "RANKED",
    tagFg: "#565b51",
    tagBg: "#efede6",
    title: "Fix-first ordering",
    body: "Findings ranked by severity, confidence and effort, so the report opens with the handful that actually matter instead of a wall of everything.",
  },
  {
    tag: "GITHUB CHECK",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "Merge gate",
    body: "A GitHub check that can block PRs below your score threshold. Off by default — you set the bar.",
  },
  {
    tag: "NEVER AUTO-MERGED",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "Auto-fix PRs",
    body: "The bot opens PRs that remove unused dependencies. You review and merge — it never merges itself.",
  },
  {
    tag: "AGENT-TIME",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "MCP server & CLI",
    body: "Eight guardrail tools your agent calls at the moment of the decision — verify a package, assess an MCP server, audit tool descriptions for poisoning, self-review staged changes. The CLI runs the whole scan offline in CI.",
  },
  {
    tag: "AGENT-TIME",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "Pre-commit guardrail",
    body: "npx codeorion install-hook blocks a commit that stages a secret, a poisoned agent config, or a dependency that doesn't exist — in seconds, on the staged content itself.",
  },
  {
    tag: "TEAM TRUST",
    tagFg: "#127a4f",
    tagBg: "#e4f7ec",
    title: "MCP lockfile",
    body: "codeorion-mcp.lock commits your MCP approvals to the repo. A server that silently changes what it runs fails the scan as a critical mismatch until a human re-locks — approval that survives the clone, not one laptop.",
  },
  {
    tag: "METRICS",
    tagFg: "#565b51",
    tagBg: "#efede6",
    title: "AI-authorship metrics",
    body: "Debt density split by AI-touched vs human-written code — hard data for justifying your AI tooling.",
  },
  {
    tag: "BADGE",
    tagFg: "#565b51",
    tagBg: "#efede6",
    title: "README score badge",
    body: "A live health-score badge for your README. Green looks good on you.",
  },
];

export function Features() {
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();
  return (
    <section id="features" style={{ borderTop: "1px solid #e6e4dc", padding: isMobile ? "56px 20px" : "96px 48px" }}>
      <div style={{ maxWidth: 1024, margin: "0 auto" }}>
        <span style={{ font: "500 12px 'JetBrains Mono',monospace", color: "#127a4f", letterSpacing: ".08em" }}>
          FEATURES
        </span>
        <h2
          style={{
            margin: "16px 0 0",
            font: isMobile ? "600 26px/1.2 Geist,sans-serif" : "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            maxWidth: 520,
            textWrap: "balance",
          }}
        >
          {/* Derived from the array so the claim cannot drift out of date the
              way "Six things" did once the list grew to twelve. */}
          {FEATURES.length} things it does today. Not a roadmap.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: isMobile ? "1fr" : isCompact ? "repeat(2,1fr)" : "repeat(3,1fr)", gap: 20, marginTop: 44 }}>
          {FEATURES.map((f) => (
            <div
              key={f.title}
              style={{
                background: "#fff",
                border: "1px solid #e6e4dc",
                borderRadius: 12,
                padding: 24,
                display: "flex",
                flexDirection: "column",
                gap: 12,
              }}
            >
              <span
                style={{
                  font: "600 12px 'JetBrains Mono',monospace",
                  color: f.tagFg,
                  background: f.tagBg,
                  padding: "4px 10px",
                  borderRadius: 99,
                  width: "fit-content",
                }}
              >
                {f.tag}
              </span>
              <span style={{ font: "600 17px Geist,sans-serif" }}>{f.title}</span>
              <span style={{ font: "400 14px/1.55 Geist,sans-serif", color: "#565b51" }}>{f.body}</span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
