import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";

export function Card({
  children,
  className = "",
  tone = "default",
}: {
  children: ReactNode;
  className?: string;
  /** "ink" swaps the surface for the solid dark navy panel (e.g. a highlighted pricing tier)
   *  instead of composing conflicting bg-* utilities through className. */
  tone?: "default" | "ink";
}) {
  const toneStyles =
    tone === "ink" ? "border-ink bg-ink text-ink-foreground" : "border-border bg-surface";
  return (
    <div className={`rounded-2xl border p-5 shadow-soft ${toneStyles} ${className}`}>{children}</div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" | "ink" }) {
  const styles = {
    primary: "bg-primary hover:bg-primary-hover text-white",
    ghost: "border border-border bg-transparent hover:bg-surface-2 text-foreground",
    danger: "bg-danger/10 border border-danger/40 text-danger hover:bg-danger/20",
    ink: "bg-ink hover:bg-ink/90 text-ink-foreground",
  }[variant];
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-full px-4 py-2.5 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-xl border border-border bg-surface-2 px-3.5 py-2.5 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 ${props.className ?? ""}`}
    />
  );
}

// "Solid" pills read as dark navy chips (like the reference's "Paid" badge) for
// states worth calling out; everything else stays a soft tinted pill.
const badgeStyles: Record<string, string> = {
  phantom: "bg-danger/10 text-danger",
  suspicious: "bg-warning/10 text-warning",
  unused: "bg-warning/10 text-warning",
  healthy: "bg-ink text-ink-foreground",
  complete: "bg-ink text-ink-foreground",
  failed: "bg-danger/10 text-danger",
  pending: "bg-surface-2 text-muted",
  cloning: "bg-primary/10 text-primary",
  analyzing: "bg-primary/10 text-primary",
  owner: "bg-ink text-ink-foreground",
  admin: "bg-warning/10 text-warning",
  developer: "bg-surface-2 text-muted",
};

export function Badge({ label }: { label: string }) {
  const style = badgeStyles[label] ?? "bg-surface-2 text-muted";
  return (
    <span className={`inline-flex items-center rounded-full px-2.5 py-1 text-xs font-medium ${style}`}>
      {label}
    </span>
  );
}

export function ScoreRing({ score, size = 96 }: { score: number | null; size?: number }) {
  const value = score ?? 0;
  const color = value >= 75 ? "var(--color-success)" : value >= 50 ? "var(--color-warning)" : "var(--color-danger)";
  const r = size / 2 - 6;
  const c = 2 * Math.PI * r;
  return (
    <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`}>
      <circle cx={size / 2} cy={size / 2} r={r} fill="none" stroke="var(--color-border)" strokeWidth="6" />
      <circle
        cx={size / 2}
        cy={size / 2}
        r={r}
        fill="none"
        stroke={color}
        strokeWidth="6"
        strokeLinecap="round"
        strokeDasharray={`${(value / 100) * c} ${c}`}
        transform={`rotate(-90 ${size / 2} ${size / 2})`}
      />
      <text
        x="50%"
        y="50%"
        dominantBaseline="central"
        textAnchor="middle"
        fill="var(--color-foreground)"
        fontSize={size / 4}
        fontWeight="700"
        fontFamily="var(--font-mono)"
      >
        {score === null ? "—" : value}
      </text>
    </svg>
  );
}

export function Spinner() {
  return (
    <div className="h-5 w-5 animate-spin rounded-full border-2 border-border border-t-primary" />
  );
}

export function EmptyState({ title, hint }: { title: string; hint?: string }) {
  return (
    <div className="py-12 text-center">
      <p className="text-sm font-medium text-foreground">{title}</p>
      {hint && <p className="mt-1 text-sm text-muted">{hint}</p>}
    </div>
  );
}

export function Avatar({ label, size = 36 }: { label: string; size?: number }) {
  const initial = label.trim().charAt(0).toUpperCase() || "?";
  return (
    <div
      className="flex shrink-0 items-center justify-center rounded-full bg-primary/15 font-semibold text-primary"
      style={{ width: size, height: size, fontSize: size / 2.4 }}
    >
      {initial}
    </div>
  );
}
