import { useEffect, useRef } from "react";
import { Link } from "react-router-dom";
import { useScanDemo, useCopyCommand } from "../../lib/useScanDemo";
import { prefersReducedMotion } from "../../lib/useFx";
import { HeroScanDemo } from "./HeroScanDemo";

/** The rotating word, split-flap style: each character flips in with a stagger. */
function FlapWord({ word }: { word: string }) {
  return (
    <em className="ca-word" key={word} aria-label={word}>
      {word.split("").map((ch, i) => (
        <span
          className="ca-flap"
          key={`${word}-${i}`}
          style={{ animationDelay: `${i * 24}ms` }}
          aria-hidden="true"
        >
          {ch === " " ? " " : ch}
        </span>
      ))}
    </em>
  );
}

export function Hero() {
  const { word } = useScanDemo();
  const { copied, copy } = useCopyCommand();

  return (
    <header className="ca-hero">
      <div className="ca-wrap ca-hero-grid">
        <div>
          <div className="ca-stat ca-load" style={{ animationDelay: "0.05s" }}>
            <span className="ca-stat-fig">1 in 5</span>
            <span className="ca-stat-cap">
              AI-recommended packages don't exist on the registry
              <br />
              <em>576k-sample multi-LLM study, 2026</em>
            </span>
          </div>
          <h1 className="ca-h1">
            <span className="ca-line">
              <span className="ca-line-inner" style={{ "--d": "0.15s" } as React.CSSProperties}>
                Catch <FlapWord word={word} />
              </span>
            </span>
            <span className="ca-line">
              <span className="ca-line-inner" style={{ "--d": "0.28s" } as React.CSSProperties}>
                before it merges.
              </span>
            </span>
          </h1>
          <p className="ca-lede ca-hero-sub ca-load" style={{ animationDelay: "0.42s" }}>
            CodeAudit continuously audits your GitHub repos for hallucinated packages, leaked
            secrets, poisoned agent configs and AI-generated debt — with a health score, PR
            comments, and merge gates. You stay in control.
          </p>
          <div className="ca-hero-ctas ca-load" style={{ animationDelay: "0.54s" }}>
            <Link to="/register" className="ca-btn">
              Get started free
            </Link>
            <span
              className="ca-btn-ghost"
              onClick={copy}
              role="button"
              tabIndex={0}
              aria-label="Copy the scan command to your clipboard"
              onKeyDown={(e) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  copy();
                }
              }}
            >
              npx codeorion scan .
              <span className="ca-copy-hint">{copied ? "✓ copied" : "⧉ copy"}</span>
            </span>
          </div>
          <div className="ca-hero-note ca-load" style={{ animationDelay: "0.64s" }}>
            npm · PyPI · no agent installed in your repo
          </div>
        </div>
        <div className="ca-load" style={{ animationDelay: "0.4s" }}>
          <HeroScanDemo />
        </div>
      </div>
    </header>
  );
}

const THREATS = [
  "PHANTOM PACKAGES",
  "LEAKED SECRETS",
  "POISONED AGENT CONFIGS",
  "TYPOSQUATS",
  "DEAD CODE",
  "CVE ADVISORIES",
  "LICENCE CONFLICTS",
  "DUPLICATE LIBRARIES",
];

/**
 * Hairline ticker of everything a scan looks for. Velocity-reactive: drifts
 * slowly at rest, accelerates with scroll speed, eases back when you stop.
 * JS-driven so the loop wraps seamlessly at one copy's width.
 */
export function ThreatMarquee() {
  const beltRef = useRef<HTMLDivElement>(null);
  const trackRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    const belt = beltRef.current;
    const track = trackRef.current;
    if (!belt || !track || prefersReducedMotion()) return;

    let pos = 0;
    let vel = 0;
    let lastY = window.scrollY;
    let raf = 0;
    const onScroll = () => {
      const y = window.scrollY;
      vel = Math.min(80, vel + Math.abs(y - lastY));
      lastY = y;
    };
    const step = () => {
      const w = track.offsetWidth;
      if (w > 0) {
        vel *= 0.92;
        pos = (pos + 0.45 + vel * 0.06) % w;
        belt.style.transform = `translateX(${-pos}px)`;
      }
      raf = requestAnimationFrame(step);
    };
    window.addEventListener("scroll", onScroll, { passive: true });
    raf = requestAnimationFrame(step);
    return () => {
      window.removeEventListener("scroll", onScroll);
      cancelAnimationFrame(raf);
    };
  }, []);

  return (
    <div className="ca-marquee" aria-hidden="true">
      <div className="ca-marquee-belt" ref={beltRef}>
        {[0, 1].map((half) => (
          <div className="ca-marquee-track" key={half} ref={half === 0 ? trackRef : undefined}>
            {THREATS.map((t) => (
              <span key={t}>{t}</span>
            ))}
          </div>
        ))}
      </div>
    </div>
  );
}
