import { useState } from "react";
import { useCopyCommand } from "../../lib/useScanDemo";
import { useMagnetic } from "../../lib/useFx";

/**
 * The two ways to use CodeAudit without an account.
 *
 * Replaces the CLI-only section. The product has three surfaces — dashboard,
 * CLI, MCP server — and the landing page described one and a half of them: the
 * MCP server appeared only as a line inside a feature card, which is where a
 * major part of the project goes to be missed. Someone arriving here should be
 * able to see both things they can run in the next minute.
 *
 * Two panels rather than two sections, because they answer the same question —
 * "can I try this right now" — and stacking them would make the second look
 * like an afterthought again.
 */

type Surface = "cli" | "mcp";

const COMMANDS: Record<Surface, string> = {
  cli: "npx codeorion scan .",
  mcp: "claude mcp add codeaudit -- npx -y codeorion-mcp",
};

export function Try() {
  const [surface, setSurface] = useState<Surface>("cli");
  const { copied, copy } = useCopyCommand(COMMANDS[surface]);
  const chipRef = useMagnetic<HTMLSpanElement>(0.25, 8);

  return (
    <section id="try" className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 04</span>
          <span>RUN IT YOURSELF</span>
        </div>
        <div className="ca-split">
          <div className="ca-split-copy" data-reveal>
            <h2 className="ca-h2">
              Try it before you <em>trust it</em>.
            </h2>
            <p className="ca-lede">
              Two surfaces, no account, nothing leaves your machine. Scan a repository from your
              terminal, or put the same detectors inside your coding agent so it checks a package
              before it installs it.
            </p>

            <div className="ca-try-tabs" role="tablist" aria-label="Choose a surface">
              <button
                type="button"
                role="tab"
                aria-selected={surface === "cli"}
                className={`ca-try-tab${surface === "cli" ? " is-on" : ""}`}
                onClick={() => setSurface("cli")}
              >
                CLI
              </button>
              <button
                type="button"
                role="tab"
                aria-selected={surface === "mcp"}
                className={`ca-try-tab${surface === "mcp" ? " is-on" : ""}`}
                onClick={() => setSurface("mcp")}
              >
                MCP server
              </button>
            </div>

            <p className="ca-try-note">
              {surface === "cli"
                ? "The whole scan, offline. Works in CI, and in a pre-commit hook that blocks the commit rather than commenting on it afterwards."
                : "Eight guardrail tools your agent calls at the moment of the decision — verify a package, assess an MCP server before adding it, audit tool descriptions for poisoning, review staged changes before the commit."}
            </p>

            <span
              className="ca-cmd-chip"
              ref={chipRef}
              onClick={copy}
              role="button"
              tabIndex={0}
              aria-label={`Copy the ${surface === "cli" ? "scan" : "install"} command to your clipboard`}
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  copy();
                }
              }}
            >
              $ {COMMANDS[surface]}
              <span className="ca-copy-hint" style={{ fontSize: 11 }}>
                {copied ? "✓ copied" : "⧉"}
              </span>
            </span>
          </div>

          <div className="ca-term" data-reveal style={{ transitionDelay: "0.12s" }}>
            {surface === "cli" ? <CliTerminal /> : <McpTerminal />}
          </div>
        </div>
      </div>
    </section>
  );
}

/** Real output shape from a real scan of this repository. */
function CliTerminal() {
  return (
    <>
      <div>
        <span className="t-dim">~/vibe/codeaudit ›</span>{" "}
        <span className="t-accent">npx</span> <span className="t-fg">codeorion scan .</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-b">CodeAudit</span>{" "}
        <span className="t-dim">· static scan of ~/vibe/codeaudit</span>
      </div>
      <div className="t-b" style={{ marginTop: 12 }}>
        Dependencies
      </div>
      <div>
        <span className="t-crit">  phantom</span>
        <span className="t-fg">    react-toolkitz</span>
      </div>
      <div>
        <span className="t-crit">  phantom</span>
        <span className="t-fg">    @codeaudit/engine</span>
      </div>
      <div>
        <span className="t-warn">  unused</span>
        <span className="t-fg">     concurrently</span>
      </div>
      <div className="t-dim">  22 healthy packages not shown</div>
      <div style={{ marginTop: 12 }}>
        <span className="t-b">Dead-code candidates</span>{" "}
        <span className="t-dim">(static analysis only)</span>
      </div>
      <div>
        <span className="t-warn">  candidate</span>
        <span className="t-fg">  listSourceFiles</span>
        <span className="t-dim">  packages/engine/src/imports.ts:36</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-b">Score:</span>{" "}
        <span className="t-warn" style={{ fontWeight: 600 }}>
          66.3 (C)
        </span>{" "}
        <span className="t-dim">· 50 files analyzed</span>
      </div>
      <div className="t-crit" style={{ fontWeight: 600 }}>
        2 phantom dependencies — remove before shipping
      </div>
      <div className="t-dim" style={{ marginTop: 12 }}>
        → Track trends, gate PRs, and get AI-reviewed findings: connect this repo in the dashboard
      </div>
    </>
  );
}

/**
 * The MCP server doing the thing that only it can do: refusing an install
 * before it happens, rather than reporting it after the fact.
 */
function McpTerminal() {
  return (
    <>
      <div>
        <span className="t-dim">agent ›</span>{" "}
        <span className="t-fg">installing </span>
        <span className="t-accent">fastimagepro</span>
        <span className="t-fg"> for image resizing…</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-b">codeaudit</span>{" "}
        <span className="t-dim">· verify_package(fastimagepro, pypi)</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-crit">  phantom</span>
        <span className="t-fg">    fastimagepro</span>
      </div>
      <div>
        <span className="t-dim">  reason     does not exist on PyPI</span>
      </div>
      <div>
        <span className="t-dim">  known      a name LLMs are documented to invent</span>
      </div>
      <div>
        <span className="t-dim">  instead    Pillow · imageio</span>
      </div>
      <div className="t-crit" style={{ fontWeight: 600, marginTop: 12 }}>
        → install refused before it ran
      </div>
      <div style={{ marginTop: 16 }}>
        <span className="t-dim">agent ›</span>{" "}
        <span className="t-fg">reading </span>
        <span className="t-accent">CLAUDE.md</span>
        <span className="t-fg"> from the cloned repo…</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-b">codeaudit</span>{" "}
        <span className="t-dim">· audit_agent_config(CLAUDE.md)</span>
      </div>
      <div style={{ marginTop: 12 }}>
        <span className="t-crit">  critical</span>
        <span className="t-fg">   instruction_injection</span>
      </div>
      <div>
        <span className="t-dim">  line 14    hidden instruction to read ~/.aws/credentials</span>
      </div>
      <div className="t-dim" style={{ marginTop: 12 }}>
        → caught before the agent trusted the file, not after
      </div>
    </>
  );
}
