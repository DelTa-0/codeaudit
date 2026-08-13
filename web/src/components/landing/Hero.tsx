import { Link } from "react-router-dom";
import { useScanDemo, useCopyCommand } from "../../lib/useScanDemo";
import { useIsMobile } from "../../lib/useMediaQuery";

export function Hero() {
  const { word } = useScanDemo();
  const { copied, copy } = useCopyCommand();
  const isMobile = useIsMobile();

  return (
    <section
      style={{
        display: "flex",
        flexDirection: "column",
        alignItems: "center",
        textAlign: "center",
        padding: isMobile ? "48px 20px 16px" : "72px 60px 20px",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          font: isMobile
            ? "500 11px/1.4 'JetBrains Mono',monospace"
            : "500 12px 'JetBrains Mono',monospace",
          color: "#127a4f",
          background: "#e4f7ec",
          border: "1px solid #bfeacf",
          padding: isMobile ? "6px 12px" : "5px 12px",
          borderRadius: 99,
          marginBottom: isMobile ? 20 : 28,
          // The stat line is a long sentence; on a phone it must wrap inside
          // the pill instead of forcing the pill wider than the viewport.
          textAlign: "center",
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
          // 64px is 17 characters at 375px — the single biggest source of
          // overflow on the old layout.
          font: isMobile ? "600 34px/1.15 Geist,sans-serif" : "600 64px/1.06 Geist,sans-serif",
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
            // The rotating word can be long ("hallucinated packages"). Pinned
            // nowrap it measured 662px inside a 375px viewport and dragged the
            // whole document wide; on a phone it has to be allowed to wrap.
            whiteSpace: isMobile ? "normal" : "nowrap",
          }}
        >
          {word}
        </span>
        {isMobile ? " " : <br />}
        before it merges.
      </h1>
      <p
        style={{
          margin: isMobile ? "16px 0 0" : "24px 0 0",
          // Stays at 16px on phones — the readable-body-text floor.
          font: isMobile ? "400 16px/1.6 Geist,sans-serif" : "400 18px/1.55 Geist,sans-serif",
          color: "#565b51",
          maxWidth: 580,
          textWrap: "pretty",
        }}
      >
        CodeAudit continuously audits your GitHub repos for hallucinated packages, leaked secrets,
        poisoned agent configs and AI-generated debt — across npm and PyPI, with a health score, PR
        comments, and merge gates. You stay in control.
      </p>
      <div
        style={{
          display: "flex",
          // Side by side these two measured 405px. Stacking is what actually
          // fits; full-width targets also clear the 44px minimum comfortably.
          flexDirection: isMobile ? "column" : "row",
          alignItems: isMobile ? "stretch" : "center",
          gap: isMobile ? 10 : 14,
          marginTop: isMobile ? 24 : 32,
          width: isMobile ? "100%" : undefined,
        }}
      >
        <Link
          to="/register"
          style={{
            font: "500 15px Geist,sans-serif",
            background: "#101512",
            color: "#f7f6f1",
            padding: isMobile ? "16px 26px" : "13px 26px",
            borderRadius: 99,
            whiteSpace: "nowrap",
            textAlign: "center",
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
            background: "#fff",
            border: "1px solid #ddd9cf",
            padding: isMobile ? "14px 18px" : "12px 18px",
            borderRadius: 99,
            cursor: "pointer",
            whiteSpace: "nowrap",
          }}
        >
          npx codeorion scan . <span style={{ color: "#8d9187", fontSize: 12 }}>{copied ? "✓ copied" : "⧉"}</span>
        </span>
      </div>
    </section>
  );
}
