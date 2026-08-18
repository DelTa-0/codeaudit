import { useScanDemo } from "../../lib/useScanDemo";
import { useTilt, useCountUp } from "../../lib/useFx";
import { Seal } from "./Seal";

/**
 * The scan certificate — a live terminal record typed character by character,
 * tilting toward the cursor, that gets the verdict seal stamped onto it the
 * moment the health score lands (the seal's own number counts up 0→82).
 */
export function HeroScanDemo() {
  const { visibleLines, typing, score, stamped } = useScanDemo();
  const tiltRef = useTilt<HTMLDivElement>(4.5);
  const sealCount = useCountUp(82, stamped, 700);

  return (
    <div className="ca-cert" ref={tiltRef}>
      <div className="ca-cert-head">
        <span className="ca-cert-title">SCAN RECORD — ACME/CHECKOUT-SERVICE</span>
        <span className="ca-cert-score">{score > 0 ? `SCORE ${score}/100` : "SCANNING…"}</span>
      </div>
      <div className="ca-cert-body">
        {visibleLines.map((ln, i) => (
          <div key={i} className="ca-cert-line" style={{ color: ln.c }}>
            {ln.t}
            {typing && i === visibleLines.length - 1 && <span className="ca-caret">▌</span>}
          </div>
        ))}
        {!typing && <div className="ca-caret">▌</div>}
      </div>
      <div className={`ca-cert-seal${stamped ? " is-stamped" : ""}`}>
        <Seal size={96} centerText={String(sealCount)} centerSub="HEALTH" />
      </div>
    </div>
  );
}
