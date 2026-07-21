const DEPS = [
  { name: "currency-format-pro", status: "PHANTOM", sc: "#ff8a70", meta: "not on npm" },
  { name: "react-hooks-utils2", status: "PHANTOM", sc: "#ff8a70", meta: "not on npm" },
  { name: "concurrently", status: "UNUSED", sc: "#f0c064", meta: "0 imports" },
  { name: "zod", status: "HEALTHY", sc: "#9ef0c6", meta: "v3.24.1" },
];

const TREND = [58, 61, 60, 66, 70, 73, 76, 82];

export function DashboardPreview() {
  return (
    <section style={{ borderTop: "1px solid #e6e4dc", background: "#f2f1ea", padding: "96px 48px" }}>
      <div
        style={{
          maxWidth: 1024,
          margin: "0 auto",
          display: "flex",
          flexDirection: "column",
          alignItems: "center",
          textAlign: "center",
        }}
      >
        <span style={{ font: "500 12px 'JetBrains Mono',monospace", color: "#127a4f", letterSpacing: ".08em" }}>
          DASHBOARD
        </span>
        <h2
          style={{
            margin: "16px 0 0",
            font: "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            maxWidth: 560,
            textWrap: "balance",
          }}
        >
          Debt, trending down and to the right.
        </h2>
        <div
          style={{
            width: "100%",
            marginTop: 44,
            background: "#0a0c12",
            borderRadius: 14,
            overflow: "hidden",
            boxShadow: "0 24px 60px -24px rgba(16,21,18,.4)",
            textAlign: "left",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              padding: "14px 22px",
              borderBottom: "1px solid #1c2029",
            }}
          >
            <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
              <div
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 6,
                  background: "#11141d",
                  border: "1px solid #262b38",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  font: "600 11px 'JetBrains Mono',monospace",
                  color: "#9ef0c6",
                }}
              >
                ✓
              </div>
              <span style={{ font: "500 13px 'JetBrains Mono',monospace", color: "#e8ebf2" }}>
                acme/checkout-service
              </span>
            </div>
            <span style={{ font: "500 11px 'JetBrains Mono',monospace", color: "#6b7280" }}>
              LAST SCAN 2 MIN AGO · WEBHOOK
            </span>
          </div>
          <div style={{ display: "grid", gridTemplateColumns: "0.9fr 1.4fr 1fr", gap: 1, background: "#1c2029" }}>
            <div
              style={{
                background: "#0a0c12",
                padding: 26,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                gap: 14,
              }}
            >
              <div
                style={{
                  width: 128,
                  height: 128,
                  borderRadius: 99,
                  background: "conic-gradient(#12b673 295deg, #1c2029 0deg)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 100,
                    height: 100,
                    borderRadius: 99,
                    background: "#0a0c12",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ font: "600 34px 'JetBrains Mono',monospace", color: "#e8ebf2" }}>82</span>
                  <span style={{ font: "500 9px 'JetBrains Mono',monospace", color: "#6b7280", letterSpacing: ".12em" }}>
                    HEALTH
                  </span>
                </div>
              </div>
              <span style={{ font: "500 11.5px 'JetBrains Mono',monospace", color: "#9ef0c6" }}>
                ▲ +6 THIS WEEK
              </span>
            </div>
            <div style={{ background: "#0a0c12", padding: "22px 24px" }}>
              <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#6b7280", letterSpacing: ".08em" }}>
                DEPENDENCIES
              </span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 14 }}>
                {DEPS.map((d) => (
                  <div
                    key={d.name}
                    style={{
                      display: "grid",
                      gridTemplateColumns: "1.6fr 0.9fr 0.7fr",
                      padding: "9px 12px",
                      background: "#11141d",
                      font: "400 12px 'JetBrains Mono',monospace",
                      alignItems: "center",
                    }}
                  >
                    <span style={{ color: "#e8ebf2" }}>{d.name}</span>
                    <span style={{ fontWeight: 600, color: d.sc }}>{d.status}</span>
                    <span style={{ color: "#6b7280", textAlign: "right" }}>{d.meta}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ background: "#0a0c12", padding: "22px 24px", display: "flex", flexDirection: "column" }}>
              <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#6b7280", letterSpacing: ".08em" }}>
                SCORE · 8 WEEKS
              </span>
              <div style={{ flex: 1, display: "flex", alignItems: "flex-end", gap: 8, marginTop: 14, minHeight: 120 }}>
                {TREND.map((v, i) => (
                  <div
                    key={i}
                    style={{
                      flex: 1,
                      height: `${v}%`,
                      background: i === TREND.length - 1 ? "#12b673" : "#2c362e",
                      borderRadius: "3px 3px 0 0",
                    }}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  font: "400 9.5px 'JetBrains Mono',monospace",
                  color: "#3c414d",
                  marginTop: 8,
                }}
              >
                <span>MAY</span>
                <span>JUN</span>
                <span>JUL</span>
              </div>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
