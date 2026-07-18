const FINDINGS = [
  { type: "PHANTOM", tc: "#c2452d", finding: "currency-format-pro not on npm", sev: "CRITICAL", conf: "1.00" },
  { type: "PHANTOM", tc: "#c2452d", finding: "react-hooks-utils2 not on npm", sev: "CRITICAL", conf: "1.00" },
  { type: "ZOMBIE", tc: "#b07d1e", finding: "src/legacy/parse.ts unreferenced", sev: "MEDIUM", conf: "0.94" },
  { type: "UNUSED", tc: "#565b51", finding: "9 unused deps in package.json", sev: "LOW", conf: "0.88" },
];

export function PrExample() {
  return (
    <section style={{ borderTop: "1px solid #e6e4dc", padding: "96px 48px" }}>
      <div
        style={{
          maxWidth: 1024,
          margin: "0 auto",
          display: "grid",
          gridTemplateColumns: "0.8fr 1.2fr",
          gap: 56,
          alignItems: "start",
        }}
      >
        <div
          style={{
            display: "flex",
            flexDirection: "column",
            alignItems: "flex-start",
            position: "sticky",
            top: 96,
          }}
        >
          <span
            style={{
              font: "500 12px 'JetBrains Mono',monospace",
              color: "#127a4f",
              letterSpacing: ".08em",
              marginBottom: 18,
            }}
          >
            IN YOUR PULL REQUESTS
          </span>
          <h2
            style={{
              margin: 0,
              font: "600 40px/1.12 Geist,sans-serif",
              letterSpacing: "-.02em",
              textWrap: "balance",
            }}
          >
            One sticky comment. Updated on every push.
          </h2>
          <p
            style={{
              margin: "18px 0 0",
              font: "400 16.5px/1.6 Geist,sans-serif",
              color: "#565b51",
              textWrap: "pretty",
            }}
          >
            No comment spam — a single bot comment that edits itself with the latest score, delta,
            and findings. This is a real comment from a real PR.
          </p>
        </div>
        <div style={{ background: "#fff", border: "1px solid #e6e4dc", borderRadius: 12, overflow: "hidden" }}>
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: 10,
              padding: "12px 18px",
              background: "#faf9f5",
              borderBottom: "1px solid #efede6",
            }}
          >
            <div
              style={{
                width: 26,
                height: 26,
                borderRadius: 99,
                background: "#101512",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                font: "600 12px 'JetBrains Mono',monospace",
                color: "#9ef0c6",
              }}
            >
              ✓
            </div>
            <span style={{ font: "600 13.5px Geist,sans-serif" }}>codeaudit</span>
            <span
              style={{
                font: "500 10.5px 'JetBrains Mono',monospace",
                color: "#565b51",
                background: "#efede6",
                padding: "2px 7px",
                borderRadius: 5,
              }}
            >
              bot
            </span>
            <span style={{ font: "400 12.5px Geist,sans-serif", color: "#8d9187" }}>commented 2 minutes ago</span>
          </div>
          <div style={{ padding: "20px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
            <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
              <span style={{ font: "600 22px Geist,sans-serif" }}>CodeAudit report</span>
              <span
                style={{
                  font: "600 13px 'JetBrains Mono',monospace",
                  color: "#127a4f",
                  background: "#e4f7ec",
                  border: "1px solid #bfeacf",
                  padding: "4px 12px",
                  borderRadius: 99,
                }}
              >
                82/100 ▲ +6
              </span>
            </div>
            <div style={{ border: "1px solid #efede6", borderRadius: 8, overflow: "hidden" }}>
              <div
                style={{
                  display: "grid",
                  gridTemplateColumns: "0.9fr 2fr 0.8fr 0.8fr",
                  padding: "9px 14px",
                  background: "#faf9f5",
                  font: "600 11px 'JetBrains Mono',monospace",
                  color: "#8d9187",
                  letterSpacing: ".05em",
                }}
              >
                <span>TYPE</span>
                <span>FINDING</span>
                <span>SEVERITY</span>
                <span>CONFIDENCE</span>
              </div>
              {FINDINGS.map((row, i) => (
                <div
                  key={i}
                  style={{
                    display: "grid",
                    gridTemplateColumns: "0.9fr 2fr 0.8fr 0.8fr",
                    padding: "10px 14px",
                    borderTop: "1px solid #f3f1ea",
                    font: "400 12.5px 'JetBrains Mono',monospace",
                    alignItems: "center",
                  }}
                >
                  <span style={{ fontWeight: 600, color: row.tc }}>{row.type}</span>
                  <span style={{ color: "#101512" }}>{row.finding}</span>
                  <span style={{ color: row.tc }}>{row.sev}</span>
                  <span style={{ color: "#565b51" }}>{row.conf}</span>
                </div>
              ))}
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 10, font: "400 13px 'JetBrains Mono',monospace", color: "#127a4f" }}>
              <span style={{ width: 8, height: 8, borderRadius: 99, background: "#12b673" }} />
              Merge gate: passing — threshold 70, score 82
            </div>
            <span style={{ font: "400 12px Geist,sans-serif", color: "#8d9187" }}>
              Findings are proposals. CodeAudit never blocks, merges, or deletes without your
              explicit opt-in.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
