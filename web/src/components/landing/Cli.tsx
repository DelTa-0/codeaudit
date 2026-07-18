import { useCopyCommand } from "../../lib/useScanDemo";

export function Cli() {
  const { copied, copy } = useCopyCommand();

  return (
    <section id="cli" style={{ background: "#101512", padding: "96px 48px" }}>
      <div
        style={{
          maxWidth: 1024,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "0.85fr 1.15fr",
          gap: 56,
          alignItems: "center",
        }}
      >
        <div style={{ display: "flex", flexDirection: "column", alignItems: "flex-start" }}>
          <span
            style={{
              font: "500 12px 'JetBrains Mono',monospace",
              color: "#9ef0c6",
              letterSpacing: ".08em",
              marginBottom: 18,
            }}
          >
            ZERO-SIGNUP CLI
          </span>
          <h2
            style={{
              margin: 0,
              font: "600 40px/1.12 Geist,sans-serif",
              letterSpacing: "-.02em",
              color: "#f7f6f1",
              textWrap: "balance",
            }}
          >
            Try it before you trust it.
          </h2>
          <p
            style={{
              margin: "18px 0 0",
              font: "400 16.5px/1.6 Geist,sans-serif",
              color: "#9aa39b",
              textWrap: "pretty",
            }}
          >
            One command, no account, nothing leaves your machine. The real output from a real repo
            is on the right.
          </p>
          <span
            onClick={copy}
            style={{
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 26,
              font: "500 15px 'JetBrains Mono',monospace",
              color: "#9ef0c6",
              background: "#1a221c",
              border: "1px solid #2c362e",
              padding: "14px 20px",
              borderRadius: 10,
              cursor: "pointer",
            }}
          >
            $ npx codeaudit scan . <span style={{ color: "#5d675e", fontSize: 12 }}>{copied ? "✓ copied" : "⧉"}</span>
          </span>
        </div>
        <div
          style={{
            background: "#0b0f0c",
            border: "1px solid #232a24",
            borderRadius: 12,
            padding: "20px 22px",
            font: "400 13px/1.75 'JetBrains Mono',monospace",
          }}
        >
          <div><span style={{ color: "#7b857c" }}>~/vibe/codeaudit ›</span> <span style={{ color: "#f0c064" }}>npx</span> <span style={{ color: "#e8ede8" }}>codeaudit scan</span></div>
          <div style={{ marginTop: 12 }}><span style={{ color: "#e8ede8", fontWeight: 600 }}>CodeAudit</span> <span style={{ color: "#7b857c" }}>· static scan of ~/vibe/codeaudit</span></div>
          <div style={{ marginTop: 12, color: "#e8ede8", fontWeight: 600 }}>Dependencies</div>
          <div><span style={{ color: "#ff8a70" }}>  phantom</span><span style={{ color: "#e8ede8" }}>    react-toolkitz</span></div>
          <div><span style={{ color: "#ff8a70" }}>  phantom</span><span style={{ color: "#e8ede8" }}>    @codeaudit/engine</span></div>
          <div><span style={{ color: "#f0c064" }}>  unused</span><span style={{ color: "#e8ede8" }}>     concurrently</span></div>
          <div style={{ color: "#7b857c" }}>  22 healthy packages not shown</div>
          <div style={{ marginTop: 12 }}><span style={{ color: "#e8ede8", fontWeight: 600 }}>Dead-code candidates</span> <span style={{ color: "#7b857c" }}>(static analysis only)</span></div>
          <div><span style={{ color: "#f0c064" }}>  candidate</span><span style={{ color: "#e8ede8" }}>  listSourceFiles</span><span style={{ color: "#7b857c" }}>  packages/engine/src/imports.ts:36</span></div>
          <div style={{ marginTop: 12 }}><span style={{ color: "#e8ede8", fontWeight: 600 }}>Score:</span> <span style={{ color: "#f0c064", fontWeight: 600 }}>66.3 (C)</span> <span style={{ color: "#7b857c" }}>· 50 files analyzed</span></div>
          <div style={{ color: "#ff8a70", fontWeight: 600 }}>2 phantom dependencies — remove before shipping</div>
          <div style={{ marginTop: 12, color: "#7b857c" }}>→ Track trends, gate PRs, and get AI-reviewed findings: connect this repo at <span style={{ color: "#9ef0c6" }}>codeaudit.dev</span></div>
        </div>
      </div>
    </section>
  );
}
