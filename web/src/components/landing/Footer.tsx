import { LogoMark } from "../Logo";

export function Footer() {
  return (
    <footer className="ca-footer">
      <div className="ca-wrap">
        <div className="ca-footer-grid">
          <div className="ca-footer-col">
            <div style={{ display: "flex", alignItems: "center", gap: 10 }}>
              <div
                style={{
                  width: 26,
                  height: 26,
                  borderRadius: 6,
                  border: "1px solid var(--line)",
                  display: "flex",
                  alignItems: "center",
                  justifyContent: "center",
                  color: "var(--accent)",
                }}
              >
                <LogoMark size={15} />
              </div>
              <span style={{ font: "700 16px var(--serif)", color: "var(--paper)" }}>
                CodeAudit
              </span>
            </div>
            <span style={{ font: "400 13px/1.6 var(--sans)", color: "var(--muted)", maxWidth: 240 }}>
              Continuous audits for AI-generated technical debt.
            </span>
          </div>
          <div className="ca-footer-col">
            <span className="ca-footer-head">PRODUCT</span>
            <a href="#how">How it works</a>
            <a href="#features">Features</a>
            <a href="#pricing">Pricing</a>
          </div>
          <div className="ca-footer-col">
            <span className="ca-footer-head">DEVELOPERS</span>
            <a href="#cli">CLI</a>
            <span className="ca-footer-item">Docs</span>
            <span className="ca-footer-item">GitHub App</span>
          </div>
          <div className="ca-footer-col">
            <span className="ca-footer-head">COMPANY</span>
            <span className="ca-footer-item">Security</span>
            <span className="ca-footer-item">Privacy</span>
            <span className="ca-footer-item">Contact</span>
          </div>
        </div>
        <div className="ca-footer-base">
          <span>© 2026 CODEAUDIT</span>
          <span>SCAN RESPONSIBLY.</span>
        </div>
      </div>
    </footer>
  );
}
