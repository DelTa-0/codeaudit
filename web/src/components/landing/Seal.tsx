import { useId } from "react";
import { LogoMark } from "../Logo";

/**
 * The verdict seal — a notary-style ring of circular text that slowly turns.
 * Used twice: stamped onto the hero scan certificate when the score lands,
 * and as the emblem above the final CTA. Inherits `currentColor` (brass).
 */
export function Seal({
  size = 108,
  centerText,
  centerSub,
}: {
  size?: number;
  centerText?: string;
  centerSub?: string;
}) {
  const id = useId();
  return (
    <svg width={size} height={size} viewBox="0 0 120 120" fill="none" aria-hidden="true">
      <circle cx="60" cy="60" r="57.5" stroke="currentColor" strokeWidth="1.5" />
      <circle cx="60" cy="60" r="36" stroke="currentColor" strokeWidth="0.75" opacity="0.7" />
      <g className="ca-seal-spin">
        <defs>
          <path
            id={id}
            d="M 60,60 m -46,0 a 46,46 0 1,1 92,0 a 46,46 0 1,1 -92,0"
            fill="none"
          />
        </defs>
        {/* 37 chars × (8px × 0.6 advance + 3.0 tracking) ≈ 289px — the exact
            circumference of the r=46 path, so the ring reads as continuous */}
        <text
          fontSize="8"
          letterSpacing="3"
          fill="currentColor"
          fontFamily="'IBM Plex Mono', monospace"
          fontWeight="500"
        >
          <textPath href={`#${id}`}>CODEAUDIT · VERIFIED ON EVERY PUSH · </textPath>
        </text>
      </g>
      {centerText ? (
        <>
          <text
            x="60"
            y={centerSub ? "60" : "64"}
            textAnchor="middle"
            fontSize="20"
            fill="currentColor"
            fontFamily="'IBM Plex Mono', monospace"
            fontWeight="600"
          >
            {centerText}
          </text>
          {centerSub && (
            <text
              x="60"
              y="74"
              textAnchor="middle"
              fontSize="6.5"
              letterSpacing="1.8"
              fill="currentColor"
              fontFamily="'IBM Plex Mono', monospace"
            >
              {centerSub}
            </text>
          )}
        </>
      ) : (
        <g transform="translate(44, 44)" color="currentColor">
          <LogoMark size={32} />
        </g>
      )}
    </svg>
  );
}
