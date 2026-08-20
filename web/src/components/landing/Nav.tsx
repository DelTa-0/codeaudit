import { Link } from "react-router-dom";
import { LogoMark } from "../Logo";

export function Nav() {
  return (
    <nav className="ca-nav">
      <div className="ca-nav-brand">
        <div className="ca-logo-tile">
          <LogoMark size={16} />
        </div>
        <span className="ca-brand-name">CodeAudit</span>
      </div>
      <div className="ca-nav-links">
        <a href="#how">How it works</a>
        <a href="#features">Features</a>
        <a href="#try">CLI &amp; MCP</a>
        <a href="#pricing">Pricing</a>
      </div>
      <div className="ca-nav-cta">
        <Link to="/login" className="ca-nav-login">
          Log in
        </Link>
        <Link to="/register" className="ca-nav-register">
          Get started
        </Link>
      </div>
    </nav>
  );
}
