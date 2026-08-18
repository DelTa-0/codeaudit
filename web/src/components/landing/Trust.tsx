import { useEffect, useState } from "react";
import { useInViewOnce } from "../../lib/useFx";

const OPT_INS = [
  { title: "Webhook auto-scan", body: "Scan automatically on every push", on: true },
  { title: "Merge gate", body: "Block PRs below your score threshold", on: false },
  { title: "Auto-fix PRs", body: "Bot opens dependency-cleanup PRs", on: false },
];

/**
 * The one light section on the page — the terms of engagement, set on paper
 * like the agreement you actually sign. The one default-on switch flips
 * itself as the section enters: you watch the opt-in happen.
 */
export function Trust() {
  const [cardsRef, inView] = useInViewOnce<HTMLDivElement>();
  const [flipped, setFlipped] = useState(false);
  useEffect(() => {
    if (!inView) return;
    const t = setTimeout(() => setFlipped(true), 550);
    return () => clearTimeout(t);
  }, [inView]);
  return (
    <section className="ca-trust">
      <div className="ca-wrap" style={{ padding: "clamp(72px, 9vw, 128px) clamp(20px, 4vw, 48px)" }}>
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 07</span>
          <span>TERMS OF ENGAGEMENT</span>
        </div>
        <div className="ca-split">
          <div className="ca-split-copy" data-reveal>
            <h2 className="ca-h2">
              We propose. <em>You decide.</em>
            </h2>
            <p className="ca-lede">
              Every automation ships <strong>off by default</strong> and requires an explicit
              toggle. CodeAudit never merges, blocks, or deletes anything without a human
              decision. Auto-fix PRs are opened — never auto-merged.
            </p>
          </div>
          <div
            data-reveal
            ref={cardsRef}
            style={{ display: "flex", flexDirection: "column", gap: 12, transitionDelay: "0.12s" }}
          >
            {OPT_INS.map((o) => (
              <div className="ca-toggle-card" key={o.title}>
                <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                  <span className="tc-title">{o.title}</span>
                  <span className="tc-body">{o.body}</span>
                </div>
                <div className={`ca-switch${o.on && flipped ? " is-on" : ""}`}>
                  <span className="knob" />
                </div>
              </div>
            ))}
            <span
              style={{
                font: "600 10.5px var(--mono)",
                letterSpacing: ".14em",
                color: "#12503a",
                padding: "4px 4px 0",
              }}
            >
              DEFAULT STATE SHOWN — YOU FLIP THE SWITCHES.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
