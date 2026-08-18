import { Link } from "react-router-dom";
import { useCopyCommand } from "../../lib/useScanDemo";
import { useMagnetic } from "../../lib/useFx";
import { Seal } from "./Seal";

export function FinalCta() {
  const { copied, copy } = useCopyCommand();
  const btnRef = useMagnetic<HTMLAnchorElement>(0.22, 8);
  const ghostRef = useMagnetic<HTMLSpanElement>(0.22, 8);

  return (
    <section className="ca-final" style={{ borderTop: "1px solid var(--line)" }}>
      <div className="ca-wrap">
        <div className="ca-final-seal" data-reveal>
          <Seal size={116} />
        </div>
        <h2 className="ca-h1" data-reveal>
          Your AI writes code fast.
          <br />
          Make sure it's code you can <em>trust</em>.
        </h2>
        <div className="ca-final-ctas" data-reveal style={{ transitionDelay: "0.12s" }}>
          <Link to="/register" className="ca-btn" ref={btnRef}>
            Get started free
          </Link>
          <span
            className="ca-btn-ghost"
            ref={ghostRef}
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
        <div className="ca-final-note" data-reveal>
          EVERY AUTOMATION IS OPT-IN AND OFF BY DEFAULT. CODEAUDIT PROPOSES — YOU DECIDE.
        </div>
      </div>
    </section>
  );
}
