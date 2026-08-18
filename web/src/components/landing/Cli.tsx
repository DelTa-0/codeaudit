import { useCopyCommand } from "../../lib/useScanDemo";
import { useMagnetic } from "../../lib/useFx";

export function Cli() {
  const { copied, copy } = useCopyCommand();
  const chipRef = useMagnetic<HTMLSpanElement>(0.25, 8);

  return (
    <section id="cli" className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 04</span>
          <span>ZERO-SIGNUP CLI</span>
        </div>
        <div className="ca-split">
          <div className="ca-split-copy" data-reveal>
            <h2 className="ca-h2">
              Try it before you <em>trust it</em>.
            </h2>
            <p className="ca-lede">
              One command, no account, nothing leaves your machine. The real output from a real
              repo is on the right.
            </p>
            <span
              className="ca-cmd-chip"
              ref={chipRef}
              onClick={copy}
              role="button"
              tabIndex={0}
              aria-label="Copy the scan command to your clipboard"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  copy();
                }
              }}
            >
              $ npx codeorion scan .
              <span className="ca-copy-hint" style={{ fontSize: 11 }}>
                {copied ? "✓ copied" : "⧉"}
              </span>
            </span>
          </div>
          <div className="ca-term" data-reveal style={{ transitionDelay: "0.12s" }}>
            <div>
              <span className="t-dim">~/vibe/codeaudit ›</span>{" "}
              <span className="t-accent">npx</span> <span className="t-fg">codeorion scan</span>
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
              → Track trends, gate PRs, and get AI-reviewed findings: connect this repo at{" "}
              <span className="t-accent">codeaudit.dev</span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
