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
 *
 * The MCP panel shows both steps of the install, not one. A single
 * `claude mcp add` line was shorter but it was also incomplete: it connects a
 * server the agent has no reason to call, and it used the `npx` form the mcp
 * README singles out as unreliable on Windows. The global install is the
 * paste-and-go path in that README because it is the one that works on every
 * platform, so it is the one shown here.
 */

type Surface = "cli" | "mcp";

const NPM: Record<Surface, string> = {
  cli: "https://www.npmjs.com/package/codeorion",
  mcp: "https://www.npmjs.com/package/codeorion-mcp",
};

/** The mcp README's per-client setup — Cursor, Cline, Codex, raw JSON. */
const MCP_CLIENTS = "https://github.com/DelTa-0/codeaudit/tree/main/mcp#1-connect-the-server";

export function Try() {
  const [surface, setSurface] = useState<Surface>("cli");

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

            {surface === "cli" ? <CliInstall /> : <McpInstall />}
          </div>

          <div className="ca-term" data-reveal style={{ transitionDelay: "0.12s" }}>
            {surface === "cli" ? <CliTerminal /> : <McpTerminal />}
          </div>
        </div>
      </div>
    </section>
  );
}

/**
 * One copyable command.
 *
 * A component rather than state on the section, because the MCP install is
 * four commands across two steps and each needs its own "copied" flag — one
 * shared flag would tick every chip on the page at once.
 */
function CmdChip({ command, magnetic = false }: { command: string; magnetic?: boolean }) {
  const { copied, copy } = useCopyCommand(command);
  const ref = useMagnetic<HTMLSpanElement>(0.25, 8);
  // A prompt marker, not part of what gets copied. `/plugin` is typed into a
  // Claude Code session; everything else goes to a shell.
  const prompt = command.startsWith("/") ? ">" : "$";

  return (
    <span
      className="ca-cmd-chip"
      ref={magnetic ? ref : undefined}
      onClick={copy}
      role="button"
      tabIndex={0}
      aria-label={`Copy "${command}" to your clipboard`}
      onKeyDown={(e) => {
        if (e.key === "Enter" || e.key === " ") {
          e.preventDefault();
          copy();
        }
      }}
    >
      {prompt} {command}
      <span className="ca-copy-hint" style={{ fontSize: 11 }}>
        {copied ? "✓ copied" : "⧉"}
      </span>
    </span>
  );
}

function NpmLink({ surface }: { surface: Surface }) {
  return (
    <a className="ca-pkg-link" href={NPM[surface]} target="_blank" rel="noreferrer">
      <span className="ca-pkg-mark">npm</span>
      {surface === "cli" ? "codeorion" : "codeorion-mcp"}
      <span aria-hidden="true"> ↗</span>
    </a>
  );
}

function CliInstall() {
  return (
    <>
      <p className="ca-try-note">
        The whole scan, offline. Works in CI, and in a pre-commit hook that blocks the commit
        rather than commenting on it afterwards.
      </p>
      <div className="ca-cmd-stack">
        <CmdChip command="npx codeorion scan ." magnetic />
      </div>
      <p className="ca-try-meta">
        Any terminal, Node 18 or newer, nothing to install first. <NpmLink surface="cli" />
      </p>
    </>
  );
}

function McpInstall() {
  return (
    <>
      <p className="ca-try-note">
        Eight guardrail tools your agent calls at the moment of the decision — verify a package,
        assess an MCP server before adding it, audit tool descriptions for poisoning, review
        staged changes before the commit.
      </p>

      <ol className="ca-setup">
        <li>
          <span className="ca-setup-label">1 — Connect the server</span>
          <span className="ca-setup-where">in your terminal</span>
          <div className="ca-cmd-stack">
            <CmdChip command="npm install -g codeorion-mcp" />
            <CmdChip command="claude mcp add codeaudit -- codeorion-mcp" />
          </div>
        </li>
        <li>
          <span className="ca-setup-label">2 — Install the skill that calls it</span>
          <span className="ca-setup-where">in a Claude Code session, after restarting it</span>
          <div className="ca-cmd-stack">
            <CmdChip command="/plugin marketplace add DelTa-0/codeaudit" />
            <CmdChip command="/plugin install codeorion-guardrails@codeaudit" />
          </div>
        </li>
      </ol>

      <p className="ca-try-meta">
        <code>claude</code> is the Claude Code CLI, so step 1 is an ordinary terminal command on
        macOS, Linux and Windows alike — step 2 is typed inside a session. Both are required: the
        server on its own is eight tools your agent never thinks to reach for.
      </p>
      <p className="ca-try-meta">
        Cursor, Cline, Codex or another MCP client: run <code>codeorion-mcp</code> as a stdio
        command —{" "}
        <a href={MCP_CLIENTS} target="_blank" rel="noreferrer">
          config for each client ↗
        </a>
        . <NpmLink surface="mcp" />
      </p>
    </>
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
