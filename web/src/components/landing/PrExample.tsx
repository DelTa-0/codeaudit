import { useInViewOnce, useCountUp } from "../../lib/useFx";

const FINDINGS = [
  { type: "PHANTOM", tc: "#c2452d", finding: "currency-format-pro not on npm", sev: "CRITICAL", conf: "1.00" },
  { type: "PHANTOM", tc: "#c2452d", finding: "react-hooks-utils2 not on npm", sev: "CRITICAL", conf: "1.00" },
  { type: "ZOMBIE", tc: "#b07d1e", finding: "src/legacy/parse.ts unreferenced", sev: "MEDIUM", conf: "0.94" },
  { type: "UNUSED", tc: "#565b51", finding: "9 unused deps in package.json", sev: "LOW", conf: "0.88" },
];

export function PrExample() {
  const [docRef, inView] = useInViewOnce<HTMLDivElement>();
  // the pill counts up from the previous scan's 76 to today's 82
  const score = 76 + useCountUp(6, inView, 800);
  return (
    <section className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 05</span>
          <span>IN YOUR PULL REQUESTS</span>
        </div>
        <div className="ca-split">
          <div className="ca-split-copy" data-reveal>
            <h2 className="ca-h2">
              One sticky comment. Updated on <em>every push</em>.
            </h2>
            <p className="ca-lede">
              No comment spam — a single bot comment that edits itself with the latest score,
              delta, and findings. This is a real comment from a real PR.
            </p>
          </div>
          <div className="ca-doc" data-reveal style={{ transitionDelay: "0.12s" }} ref={docRef}>
            <div className="ca-doc-head">
              <span style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span
                  style={{
                    width: 20,
                    height: 20,
                    borderRadius: 999,
                    background: "#101512",
                    color: "#9ef0c6",
                    display: "inline-flex",
                    alignItems: "center",
                    justifyContent: "center",
                    fontSize: 10,
                  }}
                >
                  ✓
                </span>
                codeaudit <span style={{ opacity: 0.6 }}>· bot</span>
              </span>
              <span>commented 2 minutes ago</span>
            </div>
            <div style={{ padding: "20px 20px 22px", display: "flex", flexDirection: "column", gap: 16 }}>
              <div style={{ display: "flex", alignItems: "center", gap: 14, flexWrap: "wrap" }}>
                <span style={{ font: "700 22px var(--serif, serif)" }}>CodeAudit report</span>
                <span className="ca-pr-score">
                  {score}/100{" "}
                  <span className={`ca-pr-delta${inView ? " is-on" : ""}`} style={{ animationDelay: "0.9s" }}>
                    ▲ +6
                  </span>
                </span>
              </div>
              <div className="ca-pr-table">
                <div className="ca-pr-thead">
                  <span>TYPE</span>
                  <span>FINDING</span>
                  <span>SEVERITY</span>
                  <span>CONFIDENCE</span>
                </div>
                {FINDINGS.map((row, i) => (
                  <div
                    className={`ca-pr-tr ca-stamp-row${inView ? " is-on" : ""}`}
                    style={{ animationDelay: `${0.2 + i * 0.16}s` }}
                    key={row.finding}
                  >
                    <span style={{ fontWeight: 600, color: row.tc }}>{row.type}</span>
                    <span style={{ color: "#101512" }}>{row.finding}</span>
                    <span style={{ color: row.tc }}>{row.sev}</span>
                    <span style={{ color: "#8d9187" }}>{row.conf}</span>
                  </div>
                ))}
              </div>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: 10,
                  font: "500 12.5px 'IBM Plex Mono', monospace",
                  color: "#127a4f",
                }}
              >
                <span style={{ width: 8, height: 8, borderRadius: 999, background: "#12b673" }} />
                Merge gate: passing — threshold 70, score 82
              </div>
              <span style={{ font: "400 12px Geist, sans-serif", color: "#8d9187" }}>
                Findings are proposals. CodeAudit never blocks, merges, or deletes without your
                explicit opt-in.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
