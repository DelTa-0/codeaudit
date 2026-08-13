import { Link } from "react-router-dom";
import { LogoMark } from "../Logo";
import { useIsCompact } from "../../lib/useMediaQuery";

export function Nav() {
  const isCompact = useIsCompact();

  return (
    <nav
      style={{
        position: "sticky",
        top: 0,
        zIndex: 50,
        display: "flex",
        alignItems: "center",
        justifyContent: "space-between",
        gap: 12,
        padding: isCompact ? "12px 16px" : "16px 48px",
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
            color: "#f7f6f1",
          }}
        >
          <LogoMark size={16} />
        </div>
        <span style={{ font: "600 16px Geist,sans-serif", letterSpacing: "-.01em" }}>CodeAudit</span>
      </div>
      {/* Section anchors are the first thing to go: they point at content the
          reader reaches by scrolling anyway, and four of them cannot share a
          375px row with the logo and the primary CTA. */}
      {!isCompact && (
        <div style={{ display: "flex", gap: 26, font: "500 13.5px Geist,sans-serif", color: "#44483f" }}>
          <a href="#how" style={{ color: "#44483f" }}>How it works</a>
          <a href="#features" style={{ color: "#44483f" }}>Features</a>
          <a href="#cli" style={{ color: "#44483f" }}>CLI</a>
          <a href="#pricing" style={{ color: "#44483f" }}>Pricing</a>
        </div>
      )}
      <div style={{ display: "flex", alignItems: "center", gap: isCompact ? 10 : 14, flexShrink: 0 }}>
        <Link
          to="/login"
          style={{
            font: "500 13.5px Geist,sans-serif",
            color: "#44483f",
            // Padding here is what gets the tap target to the 44px minimum
            // without changing how the link looks.
            padding: isCompact ? "13px 8px" : undefined,
          }}
        >
          Log in
        </Link>
        <Link
          to="/register"
          style={{
            font: "500 13.5px Geist,sans-serif",
            background: "#101512",
            color: "#f7f6f1",
            padding: isCompact ? "13px 16px" : "8px 16px",
            borderRadius: 99,
            whiteSpace: "nowrap",
          }}
        >
          {isCompact ? "Get started" : "Get started free"}
        </Link>
      </div>
    </nav>
  );
}
