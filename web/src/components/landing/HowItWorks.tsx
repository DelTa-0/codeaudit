import { useIsMobile, useIsCompact } from "../../lib/useMediaQuery";

const STEPS = [
  { n: "01", title: "Push or scan", body: "A webhook fires on push, or you run the CLI. No agent installed in your repo.", highlight: false },
  { n: "02", title: "Clone & parse", body: "We clone the repo, walk the tree, and build the full dependency and import graph.", highlight: false },
  { n: "03", title: "Verify & analyze", body: "Every dependency checked against the live npm registry; static analysis flags dead code.", highlight: false },
  { n: "04", title: "LLM review", body: "An AI second pass confirms findings and assigns confidence scores — fewer false alarms.", highlight: false },
  { n: "05", title: "Score & report", body: "Health score, PR comment, dashboard trend — and a merge gate if you've turned it on.", highlight: true },
];

export function HowItWorks() {
  const isMobile = useIsMobile();
  const isCompact = useIsCompact();

  return (
    <section
      id="how"
      style={{
        borderTop: "1px solid #e6e4dc",
        background: "#f2f1ea",
        padding: isMobile ? "56px 20px" : "96px 48px",
      }}
    >
      <div style={{ maxWidth: 1024, margin: "0 auto" }}>
        <span style={{ font: "500 12px 'JetBrains Mono',monospace", color: "#127a4f", letterSpacing: ".08em" }}>
          HOW IT WORKS
        </span>
        <h2
          style={{
            margin: isMobile ? "12px 0 0" : "16px 0 0",
            font: isMobile ? "600 26px/1.2 Geist,sans-serif" : "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            maxWidth: 560,
            textWrap: "balance",
          }}
        >
          From push to verdict in about a minute.
        </h2>
        <div
          style={{
            display: "grid",
            // Five columns at 375px gives each step ~66px — narrower than one
            // word. One column on phones, a 2x3 arrangement on small tablets.
            gridTemplateColumns: isMobile ? "1fr" : isCompact ? "repeat(2,1fr)" : "repeat(5,1fr)",
            gap: 1,
            background: "#ddd9cf",
            border: "1px solid #ddd9cf",
            borderRadius: 12,
            overflow: "hidden",
            marginTop: isMobile ? 28 : 44,
          }}
        >
          {STEPS.map((s) => (
            <div
              key={s.n}
              style={{
                background: s.highlight ? "#e4f7ec" : "#f7f6f1",
                padding: "24px 20px 28px",
                display: "flex",
                flexDirection: "column",
                gap: 10,
              }}
            >
              <span
                style={{
                  font: "600 12px 'JetBrains Mono',monospace",
                  color: s.highlight ? "#127a4f" : "#a3a79a",
                }}
              >
                {s.n}
              </span>
              <span
                style={{
                  font: "600 16px Geist,sans-serif",
                  color: s.highlight ? "#0c2a1c" : undefined,
                }}
              >
                {s.title}
              </span>
              <span
                style={{
                  font: "400 13.5px/1.5 Geist,sans-serif",
                  color: s.highlight ? "#12503a" : "#565b51",
                }}
              >
                {s.body}
              </span>
            </div>
          ))}
        </div>
      </div>
    </section>
  );
}
