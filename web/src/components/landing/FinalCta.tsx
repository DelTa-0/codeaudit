import { Link } from "react-router-dom";
import { useCopyCommand } from "../../lib/useScanDemo";
import { useIsMobile } from "../../lib/useMediaQuery";

export function FinalCta() {
  const { copied, copy } = useCopyCommand();
  const isMobile = useIsMobile();

  return (
    <section
      style={{
        background: "#101512",
        padding: isMobile ? "64px 20px" : "110px 48px",
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
      }}
    >
      <h2
        style={{
          margin: 0,
          font: isMobile ? "600 28px/1.2 Geist,sans-serif" : "600 52px/1.1 Geist,sans-serif",
          letterSpacing: "-.03em",
          color: "#f7f6f1",
          maxWidth: 720,
          textWrap: "balance",
        }}
      >
        Your AI writes code fast. Make sure it's code you can trust.
      </h2>
      <div
        style={{
          display: "flex",
          // Same stacking fix as the hero — this section repeats that CTA pair
          // and was the second element dragging the document to 554px.
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          gap: isMobile ? 10 : 14,
          marginTop: isMobile ? 26 : 36,
          width: isMobile ? "100%" : undefined,
        }}
      >
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
          role="button"
          tabIndex={0}
          aria-label="Copy the scan command to your clipboard"
          onKeyDown={(e) => {
            if (e.key === "Enter" || e.key === " ") {
              e.preventDefault();
              copy();
            }
          }}
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            gap: 10,
            font: "500 14px 'JetBrains Mono',monospace",
            color: "#9ef0c6",
            border: "1px solid #2c362e",
            padding: isMobile ? "14px 18px" : "12px 18px",
            borderRadius: 99,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          npx codeorion scan . <span style={{ color: "#5d675e", fontSize: 12 }}>{copied ? "✓ copied" : "⧉"}</span>
        </span>
      </div>
      <span style={{ marginTop: 22, font: "400 12.5px 'JetBrains Mono',monospace", color: "#5d675e" }}>
        Every automation is opt-in and off by default. CodeAudit proposes — you decide.
      </span>
    </section>
  );
}
