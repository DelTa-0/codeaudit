import { Link } from "react-router-dom";
import { useCopyCommand } from "../../lib/useScanDemo";

export function FinalCta() {
  const { copied, copy } = useCopyCommand();

  return (
    <section
      style={{
        background: "#101512",
        padding: "110px 48px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h2
        style={{
          margin: 0,
          font: "600 52px/1.1 Geist,sans-serif",
          letterSpacing: "-.03em",
          color: "#f7f6f1",
          maxWidth: 720,
          textWrap: "balance",
        }}
      >
        Your AI writes code fast. Make sure it's code you can trust.
      </h2>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 36 }}>
        <Link
          to="/register"
          style={{
            font: "500 15px Geist,sans-serif",
            background: "#b9f0cf",
            color: "#0c2a1c",
            padding: "13px 26px",
            borderRadius: 99,
            whiteSpace: "nowrap",
          }}
        >
          Get started free
        </Link>
        <span
          onClick={copy}
          style={{
            display: "flex",
            alignItems: "center",
            gap: 10,
            font: "500 14px 'JetBrains Mono',monospace",
            color: "#9ef0c6",
            border: "1px solid #2c362e",
            padding: "12px 18px",
            borderRadius: 99,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          npx codeaudit scan . <span style={{ color: "#5d675e", fontSize: 12 }}>{copied ? "✓ copied" : "⧉"}</span>
        </span>
      </div>
      <span style={{ marginTop: 22, font: "400 12.5px 'JetBrains Mono',monospace", color: "#5d675e" }}>
        Every automation is opt-in and off by default. CodeAudit proposes — you decide.
      </span>
    </section>
  );
}
