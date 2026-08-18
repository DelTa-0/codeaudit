import { useEffect, useState } from "react";
import { useInViewOnce, prefersReducedMotion } from "../../lib/useFx";

const ADD_LINE = "+ import { formatMoney } from 'currency-format-pro'";

const CONTEXT_AFTER = [
  "  export function lineTotal(qty, price) {",
  "    return formatMoney(round(qty * price, 2))",
  "  }",
];

/**
 * Live commit replay: when the document scrolls into view, the diff plays
 * once — context appears, the bad import types itself in red, the rest of
 * the file follows, and the PHANTOM finding stamps down.
 */
export function Problem() {
  const [docRef, inView] = useInViewOnce<HTMLDivElement>();
  const [stage, setStage] = useState(0); // 0 idle · 1 ctx · 2 typing · 3 rest · 4 callout
  const [typed, setTyped] = useState(0);

  useEffect(() => {
    if (!inView) return;
    if (prefersReducedMotion()) {
      setStage(4);
      setTyped(ADD_LINE.length);
      return;
    }
    const timers: ReturnType<typeof setTimeout>[] = [];
    setStage(1);
    timers.push(setTimeout(() => setStage(2), 350));
    const typeStart = 500;
    for (let i = 1; i <= ADD_LINE.length; i++) {
      timers.push(setTimeout(() => setTyped(i), typeStart + i * 26));
    }
    const typeEnd = typeStart + ADD_LINE.length * 26;
    timers.push(setTimeout(() => setStage(3), typeEnd + 180));
    timers.push(setTimeout(() => setStage(4), typeEnd + 650));
    return () => timers.forEach(clearTimeout);
  }, [inView]);

  return (
    <section className="ca-section">
      <div className="ca-wrap">
        <div className="ca-file" data-reveal>
          <span className="ca-file-no">FILE 01</span>
          <span>THE PROBLEM</span>
        </div>
        <div className="ca-split">
          <div className="ca-split-copy" data-reveal>
            <h2 className="ca-h2">
              Your AI just imported a package that <em>doesn't exist</em>.
            </h2>
            <p className="ca-lede">
              LLMs invent plausible-sounding package names — a 2026 multi-LLM study across 576k
              samples found <strong>~20% of AI-recommended packages are hallucinated</strong>.
              Attackers register those exact names before you notice. It's called slopsquatting,
              and it's happening now.
            </p>
            <p className="ca-lede" style={{ marginTop: 14 }}>
              CodeAudit verifies every dependency against the live npm registry, on every push.
            </p>
          </div>
          <div className="ca-doc ca-replay" data-reveal ref={docRef}>
            <div className="ca-doc-head">
              <span>src/utils/pricing.ts</span>
              <span>PR #241</span>
            </div>
            <div className="ca-doc-mono" style={{ padding: "14px 0" }}>
              <div className={`ca-diff-row${stage >= 1 ? " is-on" : ""}`}>
                {"  import { round } from 'lodash'"}
              </div>
              <div
                className={`ca-diff-row is-add${stage >= 2 ? " is-on" : ""}${
                  stage === 2 ? " ca-type-caret" : ""
                }`}
              >
                {ADD_LINE.slice(0, typed) || " "}
              </div>
              {CONTEXT_AFTER.map((t, i) => (
                <div key={i} className={`ca-diff-row${stage >= 3 ? " is-on" : ""}`}>
                  {t}
                </div>
              ))}
            </div>
            <div className={`ca-finding-callout${stage >= 4 ? " is-on" : ""}`}>
              <span className="ca-tag-crit">PHANTOM</span>
              <p>
                currency-format-pro is not on npm. This exact name is a known slopsquatting
                target.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
