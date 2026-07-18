import { Link } from "react-router-dom";

export function Pricing() {
  return (
    <section id="pricing" style={{ borderTop: "1px solid #e6e4dc", padding: "96px 48px" }}>
      <div style={{ maxWidth: 1024, margin: "0 auto", display: "flex", flexDirection: "column", alignItems: "center" }}>
        <span style={{ font: "500 12px 'JetBrains Mono',monospace", color: "#127a4f", letterSpacing: ".08em" }}>
          PRICING
        </span>
        <h2
          style={{
            margin: "16px 0 0",
            font: "600 40px/1.12 Geist,sans-serif",
            letterSpacing: "-.02em",
            textAlign: "center",
            textWrap: "balance",
          }}
        >
          Start free. The CLI is free forever.
        </h2>
        <div style={{ display: "grid", gridTemplateColumns: "repeat(3,1fr)", gap: 20, marginTop: 44, width: "100%" }}>
          <div style={{ background: "#fff", border: "1px solid #e6e4dc", borderRadius: 14, padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
            <span style={{ font: "600 15px 'JetBrains Mono',monospace", color: "#565b51" }}>FREE</span>
            <span style={{ font: "600 40px Geist,sans-serif", letterSpacing: "-.02em" }}>$0</span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, font: "400 14px/1.4 Geist,sans-serif", color: "#44483f" }}>
              <span>✓ Unlimited CLI scans, local</span>
              <span>✓ 3 public repos connected</span>
              <span>✓ 5 cloud scans / day</span>
              <span>✓ README score badge</span>
            </div>
            <Link
              to="/register"
              style={{
                marginTop: "auto",
                font: "500 14px Geist,sans-serif",
                border: "1px solid #101512",
                padding: "11px 0",
                borderRadius: 99,
                textAlign: "center",
              }}
            >
              Get started
            </Link>
          </div>

          <div style={{ background: "#101512", borderRadius: 14, padding: 28, display: "flex", flexDirection: "column", gap: 18, position: "relative" }}>
            <span
              style={{
                position: "absolute",
                top: -11,
                left: 28,
                font: "600 10.5px 'JetBrains Mono',monospace",
                color: "#0c2a1c",
                background: "#b9f0cf",
                padding: "4px 10px",
                borderRadius: 99,
              }}
            >
              MOST POPULAR
            </span>
            <span style={{ font: "600 15px 'JetBrains Mono',monospace", color: "#9ef0c6" }}>PRO</span>
            <span style={{ font: "600 40px Geist,sans-serif", letterSpacing: "-.02em", color: "#f7f6f1" }}>
              $19<span style={{ fontSize: 15, fontWeight: 400, color: "#9aa39b" }}> /mo</span>
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, font: "400 14px/1.4 Geist,sans-serif", color: "#c9cfc9" }}>
              <span>✓ Private repos</span>
              <span>✓ 20 repos · 50 scans / day</span>
              <span>✓ Webhook auto-scans</span>
              <span>✓ Merge gate + auto-fix PRs</span>
              <span>✓ AI-authorship metrics</span>
            </div>
            <Link
              to="/register"
              style={{
                marginTop: "auto",
                font: "500 14px Geist,sans-serif",
                background: "#b9f0cf",
                color: "#0c2a1c",
                padding: "12px 0",
                borderRadius: 99,
                textAlign: "center",
              }}
            >
              Start 14-day trial
            </Link>
          </div>

          <div style={{ background: "#fff", border: "1px solid #e6e4dc", borderRadius: 14, padding: 28, display: "flex", flexDirection: "column", gap: 18 }}>
            <span style={{ font: "600 15px 'JetBrains Mono',monospace", color: "#565b51" }}>TEAM</span>
            <span style={{ font: "600 40px Geist,sans-serif", letterSpacing: "-.02em" }}>
              $49<span style={{ fontSize: 15, fontWeight: 400, color: "#8d9187" }}> /user/mo</span>
            </span>
            <div style={{ display: "flex", flexDirection: "column", gap: 9, font: "400 14px/1.4 Geist,sans-serif", color: "#44483f" }}>
              <span>✓ Everything in Pro</span>
              <span>✓ Unlimited repos & scans</span>
              <span>✓ Org-wide policies</span>
              <span>✓ SSO & audit log</span>
            </div>
            <span
              style={{
                marginTop: "auto",
                font: "500 14px Geist,sans-serif",
                border: "1px solid #101512",
                padding: "11px 0",
                borderRadius: 99,
                textAlign: "center",
              }}
            >
              Talk to us
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
