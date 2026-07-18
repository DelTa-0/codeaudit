import { LogoMark } from "../Logo";

export function Footer() {
  return (
    <footer style={{ background: "#0b0f0c", borderTop: "1px solid #1c231d", padding: "56px 48px 40px" }}>
      <div style={{ maxWidth: 1024, margin: "0 auto", display: "grid", gridTemplateColumns: "1.4fr 1fr 1fr 1fr", gap: 40 }}>
        <div style={{ display: "flex", flexDirection: "column", gap: 12 }}>
          <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
            <div
              style={{
                width: 24,
                height: 24,
                borderRadius: 7,
                background: "#1a221c",
                border: "1px solid #2c362e",
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
                color: "#9ef0c6",
              }}
            >
              <LogoMark size={14} />
            </div>
            <span style={{ font: "600 15px Geist,sans-serif", color: "#f7f6f1" }}>CodeAudit</span>
          </div>
          <span style={{ font: "400 13px/1.55 Geist,sans-serif", color: "#7b857c", maxWidth: 240 }}>
            Continuous audits for AI-generated technical debt.
          </span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, font: "400 13px Geist,sans-serif" }}>
          <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#5d675e", letterSpacing: ".08em" }}>PRODUCT</span>
          <a href="#how" style={{ color: "#c9cfc9" }}>How it works</a>
          <a href="#features" style={{ color: "#c9cfc9" }}>Features</a>
          <a href="#pricing" style={{ color: "#c9cfc9" }}>Pricing</a>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, font: "400 13px Geist,sans-serif" }}>
          <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#5d675e", letterSpacing: ".08em" }}>DEVELOPERS</span>
          <a href="#cli" style={{ color: "#c9cfc9" }}>CLI</a>
          <span style={{ color: "#c9cfc9" }}>Docs</span>
          <span style={{ color: "#c9cfc9" }}>GitHub App</span>
        </div>
        <div style={{ display: "flex", flexDirection: "column", gap: 10, font: "400 13px Geist,sans-serif" }}>
          <span style={{ font: "600 11px 'JetBrains Mono',monospace", color: "#5d675e", letterSpacing: ".08em" }}>COMPANY</span>
          <span style={{ color: "#c9cfc9" }}>Security</span>
          <span style={{ color: "#c9cfc9" }}>Privacy</span>
          <span style={{ color: "#c9cfc9" }}>Contact</span>
        </div>
      </div>
      <div style={{ maxWidth: 1024, margin: "40px auto 0", paddingTop: 20, borderTop: "1px solid #1c231d", font: "400 11.5px 'JetBrains Mono',monospace", color: "#5d675e" }}>
        © 2026 CodeAudit. Scan responsibly.
      </div>
    </footer>
  );
}
