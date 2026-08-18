import { useEffect, useRef } from "react";
import { prefersReducedMotion } from "../../lib/useFx";

/**
 * Sticky-scrub pipeline: the section pins while you scroll and your scroll
 * position drives the elapsed clock (T+0s → T+61s), the progress line, and
 * which stages have ignited. The timestamps are the proof of the headline's
 * "about a minute" — scrubbing them makes the reader feel the duration.
 */
const STEPS = [
  {
    t: "T+0s",
    title: "Push or scan",
    body: "A webhook fires on push, or you run the CLI. No agent installed in your repo.",
  },
  {
    t: "T+4s",
    title: "Clone & parse",
    body: "We clone the repo, walk the tree, and build the full dependency and import graph.",
  },
  {
    t: "T+12s",
    title: "Verify & analyze",
    body: "Every dependency checked against the live npm registry; static analysis flags dead code.",
  },
  {
    t: "T+38s",
    title: "LLM review",
    body: "An AI second pass confirms findings and assigns confidence scores — fewer false alarms.",
  },
  {
    t: "T+61s",
    title: "Score & report",
    body: "Health score, PR comment, dashboard trend — and a merge gate if you've turned it on.",
  },
];

const SCAN_SECONDS = 61;

export function HowItWorks() {
  const spaceRef = useRef<HTMLDivElement>(null);
  const stepsRef = useRef<HTMLDivElement>(null);
  const clockRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const space = spaceRef.current;
    const steps = stepsRef.current;
    const clock = clockRef.current;
    if (!space || !steps || !clock) return;

    const apply = (p: number) => {
      steps.style.setProperty("--p", p.toFixed(4));
      clock.textContent = `T+${Math.round(p * SCAN_SECONDS)}s`;
      const kids = steps.querySelectorAll(".ca-step");
      kids.forEach((el, i) => {
        // a stage ignites as the line's leading edge crosses its node
        el.classList.toggle("is-lit", p * 5 >= i + 0.35);
      });
    };

    if (prefersReducedMotion()) {
      apply(1);
      return;
    }

    const onScroll = () => {
      const r = space.getBoundingClientRect();
      const travel = r.height - window.innerHeight;
      const p = travel > 0 ? Math.max(0, Math.min(1, -r.top / travel)) : 1;
      apply(p);
    };
    onScroll();
    window.addEventListener("scroll", onScroll, { passive: true });
    window.addEventListener("resize", onScroll, { passive: true });
    return () => {
      window.removeEventListener("scroll", onScroll);
      window.removeEventListener("resize", onScroll);
    };
  }, []);

  return (
    <section id="how" className="ca-section ca-scrub-section">
      <div className="ca-scrub-space" ref={spaceRef}>
        <div className="ca-scrub-pin">
          <div className="ca-wrap" style={{ width: "100%" }}>
            <div className="ca-file">
              <span className="ca-file-no">FILE 02</span>
              <span>THE PROCEDURE</span>
            </div>
            <div className="ca-scrub-head">
              <h2 className="ca-h2" style={{ maxWidth: 560 }}>
                From push to verdict in <em>about a minute</em>.
              </h2>
              <span className="ca-scrub-clock" ref={clockRef}>
                T+0s
              </span>
            </div>
            <div className="ca-steps" ref={stepsRef}>
              <span className="ca-steps-fill" aria-hidden="true" />
              {STEPS.map((s) => (
                <div key={s.t} className="ca-step">
                  <span className="ca-step-t">{s.t}</span>
                  <span className="ca-step-title">{s.title}</span>
                  <span className="ca-step-body">{s.body}</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
