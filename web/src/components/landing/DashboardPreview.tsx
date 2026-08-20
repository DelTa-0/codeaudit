import { useInViewOnce, useCountUp } from "../../lib/useFx";

const DEPS = [
  { name: "currency-format-pro", status: "PHANTOM", sc: "#ff8a70", meta: "not on npm" },
  { name: "react-hooks-utils2", status: "PHANTOM", sc: "#ff8a70", meta: "not on npm" },
  { name: "concurrently", status: "UNUSED", sc: "#f0c064", meta: "0 imports" },
  { name: "zod", status: "HEALTHY", sc: "#9ef0c6", meta: "v3.24.1" },
];

const TREND = [58, 61, 60, 66, 70, 73, 76, 82];

export function DashboardPreview() {
  const [panelRef, powered] = useInViewOnce<HTMLDivElement>(0.8);
  // power-on: the dial sweeps and the number counts together
  const num = useCountUp(82, powered, 1200);
  const deg = Math.round((num / 100) * 360);
  return (
    <section className="ca-section">
      <div className="ca-wrap" style={{ textAlign: "center" }}>
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 05</span>
          <span>THE DASHBOARD</span>
        </div>
        <h2 className="ca-h2" data-reveal style={{ maxWidth: 620, margin: "0 auto" }}>
          Debt, trending <em>down and to the right</em>.
        </h2>
        {/* reveal lives on the wrapper: React rewrites this panel's className
            when `powered` flips, which would wipe the scroll-added .is-in */}
        <div data-reveal style={{ transitionDelay: "0.1s" }}>
        <div className={`ca-dash${powered ? " is-powered" : ""}`} ref={panelRef}>
          <div className="ca-dash-head">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <span
                style={{
                  width: 22,
                  height: 22,
                  borderRadius: 5,
                  border: "1px solid #262b38",
                  display: "inline-flex",
                  alignItems: "center",
                  justifyContent: "center",
                  font: "600 11px var(--mono)",
                  color: "#9ef0c6",
                }}
              >
                ✓
              </span>
              <span style={{ font: "500 13px var(--mono)", color: "#e8ebf2" }}>
                acme/checkout-service
              </span>
            </div>
            <span style={{ font: "500 10.5px var(--mono)", letterSpacing: ".1em", color: "#6b7280" }}>
              LAST SCAN 2 MIN AGO · WEBHOOK
            </span>
          </div>
          <div className="ca-dash-grid">
            <div
              style={{
                padding: 28,
                display: "flex",
                flexDirection: "column",
                alignItems: "center",
                justifyContent: "center",
                gap: 14,
              }}
            >
              <div
                style={{
                  width: 128,
                  height: 128,
                  borderRadius: 999,
                  background: `conic-gradient(#12b673 ${deg}deg, #1c2029 0deg)`,
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                }}
              >
                <div
                  style={{
                    width: 102,
                    height: 102,
                    borderRadius: 999,
                    background: "#0a0c12",
                    display: "flex",
                    flexDirection: "column",
                    alignItems: "center",
                    justifyContent: "center",
                  }}
                >
                  <span style={{ font: "700 36px var(--serif)", color: "#e8ebf2" }}>{num}</span>
                  <span
                    style={{
                      font: "500 8.5px var(--mono)",
                      color: "#6b7280",
                      letterSpacing: ".18em",
                    }}
                  >
                    HEALTH
                  </span>
                </div>
              </div>
              <span
                className="ca-dash-fade"
                style={{ font: "600 11px var(--mono)", letterSpacing: ".08em", color: "#9ef0c6", "--d": "1.2s" } as React.CSSProperties}
              >
                ▲ +6 THIS WEEK
              </span>
            </div>
            <div style={{ padding: "24px 24px 26px" }}>
              <span className="ca-dash-label">DEPENDENCIES</span>
              <div style={{ display: "flex", flexDirection: "column", gap: 1, marginTop: 14 }}>
                {DEPS.map((d, i) => (
                  <div
                    className="ca-dep-row ca-dash-fade"
                    key={d.name}
                    style={{ "--d": `${0.3 + i * 0.12}s` } as React.CSSProperties}
                  >
                    <span style={{ color: "#e8ebf2" }}>{d.name}</span>
                    <span style={{ fontWeight: 600, color: d.sc }}>{d.status}</span>
                    <span style={{ color: "#6b7280", textAlign: "right" }}>{d.meta}</span>
                  </div>
                ))}
              </div>
            </div>
            <div style={{ padding: "24px 24px 26px", display: "flex", flexDirection: "column" }}>
              <span className="ca-dash-label">SCORE · 8 WEEKS</span>
              <div
                style={{
                  flex: 1,
                  display: "flex",
                  alignItems: "flex-end",
                  gap: 8,
                  marginTop: 14,
                  minHeight: 120,
                }}
              >
                {TREND.map((v, i) => (
                  <div
                    className="ca-bar"
                    key={i}
                    style={{
                      flex: 1,
                      height: `${v}%`,
                      background: i === TREND.length - 1 ? "#12b673" : "#2c362e",
                      borderRadius: "2px 2px 0 0",
                      "--d": `${0.15 + i * 0.08}s`,
                    } as React.CSSProperties}
                  />
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  justifyContent: "space-between",
                  font: "400 9.5px var(--mono)",
                  color: "#3c414d",
                  marginTop: 8,
                  letterSpacing: ".08em",
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
      </div>
    </section>
  );
}
