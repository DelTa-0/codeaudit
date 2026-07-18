import { Link } from "react-router-dom";
import { useScanDemo, useCopyCommand } from "../../lib/useScanDemo";

export function Hero() {
  const { word } = useScanDemo();
  const { copied, copy } = useCopyCommand();

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        padding: "72px 60px 20px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          font: "500 12px 'JetBrains Mono',monospace",
          color: "#127a4f",
          background: "#e4f7ec",
          border: "1px solid #bfeacf",
          padding: "5px 12px",
          borderRadius: 99,
          marginBottom: 28,
        }}
      >
        <span
          style={{
            width: 6,
            height: 6,
            borderRadius: 99,
            background: "#12b673",
            animation: "cd-pulse 1.6s infinite",
          }}
        />
        ~20% of AI-recommended packages are hallucinated · 2026 study, 576k samples
      </div>
      <h1
        style={{
          margin: 0,
          font: "600 64px/1.06 Geist,sans-serif",
          letterSpacing: "-.03em",
          maxWidth: 900,
          textWrap: "balance",
        }}
      >
        Catch{" "}
        <span
          style={{
            background:
              "linear-gradient(transparent 8%, #b9f0cf 8%, #b9f0cf 92%, transparent 92%)",
            padding: "0 6px",
            whiteSpace: "nowrap",
          }}
        >
          {word}
        </span>
        <br />
        before it merges.
      </h1>
      <p
        style={{
          margin: "24px 0 0",
          font: "400 18px/1.55 Geist,sans-serif",
          color: "#565b51",
          maxWidth: 580,
          textWrap: "pretty",
        }}
      >
        CodeAudit continuously audits your GitHub repos for AI-generated technical debt — with a
        health score, PR comments, and merge gates. You stay in control.
      </p>
      <div style={{ display: "flex", alignItems: "center", gap: 14, marginTop: 32 }}>
        <Link
          to="/register"
          style={{
            font: "500 15px Geist,sans-serif",
            background: "#101512",
            color: "#f7f6f1",
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
            background: "#fff",
            border: "1px solid #ddd9cf",
            padding: "12px 18px",
            borderRadius: 99,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          npx codeaudit scan . <span style={{ color: "#8d9187", fontSize: 12 }}>{copied ? "✓ copied" : "⧉"}</span>
        </span>
      </div>
    </section>
  );
}
