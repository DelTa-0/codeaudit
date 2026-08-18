import { Link } from "react-router-dom";

export function Pricing() {
  return (
    <section id="pricing" className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 08</span>
          <span>PRICING</span>
        </div>
        <h2 className="ca-h2" data-reveal style={{ maxWidth: 560 }}>
          Start free. The CLI is <em>free forever</em>.
        </h2>
        <div className="ca-price-grid" data-reveal style={{ transitionDelay: "0.1s" }}>
          <div className="ca-price-col">
            <div className="ca-plan-name">
              <span>FREE</span>
            </div>
            <div className="ca-plan-price">$0</div>
            <div className="ca-plan-list">
              <span>Unlimited CLI scans, local</span>
              <span>3 public repos connected</span>
              <span>5 cloud scans / day</span>
              <span>README score badge</span>
            </div>
            <Link to="/register" className="ca-plan-cta">
              Get started
            </Link>
          </div>

          <div className="ca-price-col is-featured">
            <div className="ca-plan-name">
              <span style={{ color: "var(--accent-bright)" }}>PRO</span>
              <span className="ca-plan-pop">MOST POPULAR</span>
            </div>
            <div className="ca-plan-price">
              $19<span className="per"> /mo</span>
            </div>
            <div className="ca-plan-list">
              <span>Private repos</span>
              <span>20 repos · 50 scans / day</span>
              <span>Webhook auto-scans</span>
              <span>Merge gate + auto-fix PRs</span>
              <span>AI-authorship metrics</span>
            </div>
            <Link to="/register" className="ca-plan-cta is-primary">
              Start 14-day trial
            </Link>
          </div>

          <div className="ca-price-col">
            <div className="ca-plan-name">
              <span>TEAM</span>
            </div>
            <div className="ca-plan-price">
              $49<span className="per"> /user/mo</span>
            </div>
            <div className="ca-plan-list">
              <span>Everything in Pro</span>
              <span>Unlimited repos & scans</span>
              <span>Org-wide policies</span>
              <span>SSO & audit log</span>
            </div>
            <span className="ca-plan-cta" style={{ cursor: "pointer" }}>
              Talk to us
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
