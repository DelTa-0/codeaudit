import { useScanDemo } from "../../lib/useScanDemo";

export function HeroScanDemo() {
  const { visibleLines, score } = useScanDemo();

  return (
    <section style={{ padding: "44px 0 80px", display: "flex", justifyContent: "center" }}>
      <div
        style={{
          width: "min(880px, calc(100% - 96px))",
          background: "#101512",
          borderRadius: 14,
          overflow: "hidden",
          boxShadow: "0 24px 60px -24px rgba(16,21,18,.45)",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            padding: "11px 18px",
            borderBottom: "1px solid #232a24",
          }}
        >
          <div style={{ display: "flex", gap: 6 }}>
            <span style={{ width: 9, height: 9, borderRadius: 99, background: "#3a423b" }} />
            <span style={{ width: 9, height: 9, borderRadius: 99, background: "#3a423b" }} />
            <span style={{ width: 9, height: 9, borderRadius: 99, background: "#3a423b" }} />
          </div>
          <span style={{ font: "500 11px 'JetBrains Mono',monospace", color: "#7b857c" }}>
            acme/checkout-service — codeaudit
          </span>
          <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#9ef0c6" }}>
            SCORE {score}/100
          </span>
        </div>
        <div
          style={{
            padding: "18px 22px",
            minHeight: 210,
            display: "flex",
            flexDirection: "column",
            gap: 6,
          }}
        >
          {visibleLines.map((ln, i) => (
            <div
              key={i}
              style={{
                font: "400 13px/1.5 'JetBrains Mono',monospace",
                color: ln.c,
                whiteSpace: "pre-wrap",
              }}
            >
              {ln.t}
            </div>
          ))}
          <div
            style={{
              font: "400 13px 'JetBrains Mono',monospace",
              color: "#9ef0c6",
              animation: "cd-blink 1.1s infinite",
            }}
          >
            ▌
          </div>
        </div>
      </div>
    </section>
  );
}
