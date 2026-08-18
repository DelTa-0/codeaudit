/**
 * The features render as an audit ledger — grouped registers, indexed rows —
 * rather than a wall of cards. Indices are derived so they cannot drift.
 */
const GROUPS: { label: string; items: { title: string; body: string }[] }[] = [
  {
    label: "DETECTION",
    items: [
      {
        title: "Phantom & typosquat detection",
        body: "Every dependency checked against the live npm and PyPI registries. Hallucinated packages are flagged before an attacker can slopsquat them, and near-miss names get a “did you mean” against the real package.",
      },
      {
        title: "Hardcoded secret detection",
        body: "API keys, tokens and connection strings found in your source — and in your git history, where deleting the line never actually removed them. Findings show a fingerprint, never the secret.",
      },
      {
        title: "Agent-config auditing",
        body: "The files your coding agent obeys — CLAUDE.md, AGENTS.md, .cursorrules, copilot-instructions, MCP server configs — audited for prompt injection, over-broad permissions, and MCP servers pointed at packages that don't exist.",
      },
      {
        title: "Known vulnerabilities",
        body: "Every resolved version, direct and transitive, checked against the OSV advisory database with severity and a link to the advisory.",
      },
      {
        title: "Zombie & dead-code detection",
        body: "Static analysis finds unreferenced code; an LLM pass assigns a confidence score so you only see credible candidates. Bring your own key, or run without one and get the raw static candidates.",
      },
      {
        title: "Licence & duplicate audit",
        body: "Copyleft licences that conflict with your project's, and three libraries doing the same job — the kind of drift that accumulates when every prompt picks its own favourite.",
      },
    ],
  },
  {
    label: "AT AGENT-TIME",
    items: [
      {
        title: "MCP server & CLI",
        body: "Eight guardrail tools your agent calls at the moment of the decision — verify a package, assess an MCP server, audit tool descriptions for poisoning, self-review staged changes. The CLI runs the whole scan offline in CI.",
      },
      {
        title: "Pre-commit guardrail",
        body: "npx codeorion install-hook blocks a commit that stages a secret, a poisoned agent config, or a dependency that doesn't exist — in seconds, on the staged content itself.",
      },
      {
        title: "MCP lockfile",
        body: "codeorion-mcp.lock commits your MCP approvals to the repo. A server that silently changes what it runs fails the scan until a human re-locks — approval that survives the clone, not one laptop.",
      },
    ],
  },
  {
    label: "REPORTING & CONTROL",
    items: [
      {
        title: "Fix-first ordering",
        body: "Findings ranked by severity, confidence and effort, so the report opens with the handful that actually matter instead of a wall of everything.",
      },
      {
        title: "Merge gate",
        body: "A GitHub check that can block PRs below your score threshold. Off by default — you set the bar.",
      },
      {
        title: "Auto-fix PRs",
        body: "The bot opens PRs that remove unused dependencies. You review and merge — it never merges itself.",
      },
      {
        title: "AI-authorship metrics",
        body: "Debt density split by AI-touched vs human-written code — hard data for justifying your AI tooling.",
      },
      {
        title: "README score badge",
        body: "A live health-score badge for your README. Green looks good on you.",
      },
    ],
  },
];

const TOTAL = GROUPS.reduce((n, g) => n + g.items.length, 0);

export function Features() {
  let idx = 0;
  return (
    <section id="features" className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 03</span>
          <span>THE CAPABILITIES</span>
        </div>
        <h2 className="ca-h2" data-reveal style={{ maxWidth: 620 }}>
          {TOTAL} things it does <em>today</em>. Not a roadmap.
        </h2>
        <div className="ca-ledger">
          {GROUPS.map((g) => (
            <div key={g.label}>
              <div className="ca-ledger-group" data-reveal>
                {g.label}
              </div>
              {g.items.map((f, i) => {
                idx += 1;
                return (
                  <div
                    className="ca-ledger-row"
                    key={f.title}
                    data-reveal
                    style={{ transitionDelay: `${(i % 6) * 0.07}s` }}
                  >
                    <span className="ca-ledger-idx">F-{String(idx).padStart(2, "0")}</span>
                    <span className="ca-ledger-title">{f.title}</span>
                    <span className="ca-ledger-body">{f.body}</span>
                  </div>
                );
              })}
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
