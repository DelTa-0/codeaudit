import { Link } from "react-router-dom";

export function Nav() {
  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        padding: "16px 48px",
        background: "rgba(247,246,241,.92)",
        backdropFilter: "blur(8px)",
        borderBottom: "1px solid #e6e4dc",
      }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 9 }}>
        <div
          style={{
            width: 26,
            height: 26,
            borderRadius: 7,
            background: "#101512",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            font: "600 13px 'JetBrains Mono',monospace",
            color: "#9ef0c6",
          }}
        >
          ✓
        </div>
        <span style={{ font: "600 16px Geist,sans-serif", letterSpacing: "-.01em" }}>CodeAudit</span>
      </div>
      <div style={{ display: "flex", gap: 26, font: "500 13.5px Geist,sans-serif", color: "#44483f" }}>
        <a href="#how" style={{ color: "#44483f" }}>How it works</a>
        <a href="#features" style={{ color: "#44483f" }}>Features</a>
        <a href="#cli" style={{ color: "#44483f" }}>CLI</a>
        <a href="#pricing" style={{ color: "#44483f" }}>Pricing</a>
      </div>
      <div style={{ display: "flex", alignItems: "center", gap: 14 }}>
        <Link to="/login" style={{ font: "500 13.5px Geist,sans-serif", color: "#44483f" }}>
          Log in
        </Link>
        <Link
          to="/register"
          style={{
            font: "500 13.5px Geist,sans-serif",
            background: "#101512",
            color: "#f7f6f1",
            padding: "8px 16px",
            borderRadius: 99,
          }}
        >
          Get started free
        </Link>
      </div>
    </nav>
  );
}
