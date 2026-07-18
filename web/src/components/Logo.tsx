/**
 * The CodeAudit mark — a target ring with a "C" cut into it and an export
 * arrow, standing in for "scan, isolate, ship clean." Renders with
 * `currentColor` so it can be recolored per context (light bg / dark bg /
 * brand accent) just by setting the surrounding text color.
 */
export function LogoMark({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="130 50 240 240"
      fill="none"
      className={className}
      aria-hidden="true"
    >
      <circle cx="250" cy="170" r="110" stroke="currentColor" strokeWidth="24" strokeLinecap="round" strokeLinejoin="round" />
      <path
        d="M 292 128 A 60 60 0 1 0 292 212"
        stroke="currentColor"
        strokeWidth="24"
        strokeLinecap="round"
        strokeLinejoin="round"
        fill="none"
      />
      <path d="M 252 170 L 315 170" stroke="currentColor" strokeWidth="24" strokeLinecap="square" />
      <polygon points="310,140 355,170 310,200" fill="currentColor" />
    </svg>
  );
}

export function Logo({ size = 24, className = "" }: { size?: number; className?: string }) {
  return (
    <span className={`inline-flex items-center gap-2 ${className}`}>
      <LogoMark size={size} />
      <span className="font-semibold tracking-tight">CodeAudit</span>
    </span>
  );
}
