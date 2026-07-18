import type { ReactNode, ButtonHTMLAttributes, InputHTMLAttributes } from "react";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-xl border border-border bg-surface p-5 ${className}`}>{children}</div>
  );
}

export function Button({
  variant = "primary",
  className = "",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "ghost" | "danger" }) {
  const styles = {
    primary: "bg-primary hover:bg-primary-hover text-white",
    ghost: "border border-border bg-transparent hover:bg-surface-2 text-foreground",
    danger: "bg-danger/10 border border-danger/40 text-danger hover:bg-danger/20",
  }[variant];
  return (
    <button
      className={`inline-flex cursor-pointer items-center justify-center gap-2 rounded-lg px-4 py-2 text-sm font-medium transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 disabled:cursor-not-allowed disabled:opacity-50 ${styles} ${className}`}
      {...props}
    />
  );
}

export function Input(props: InputHTMLAttributes<HTMLInputElement>) {
  return (
    <input
      {...props}
      className={`w-full rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm text-foreground placeholder:text-muted focus:outline-none focus:ring-2 focus:ring-primary/50 ${props.className ?? ""}`}
    />
  );
}

const badgeStyles: Record<string, string> = {
  phantom: "bg-danger/15 text-danger border-danger/30",
  suspicious: "bg-warning/15 text-warning border-warning/30",
  unused: "bg-warning/10 text-warning/90 border-warning/20",
  healthy: "bg-success/15 text-success border-success/30",
  complete: "bg-success/15 text-success border-success/30",
  failed: "bg-danger/15 text-danger border-danger/30",
  pending: "bg-muted/15 text-muted border-muted/30",
  cloning: "bg-primary/15 text-primary border-primary/30",
  analyzing: "bg-primary/15 text-primary border-primary/30",
  owner: "bg-primary/15 text-primary border-primary/30",
  admin: "bg-warning/15 text-warning border-warning/30",
  developer: "bg-muted/15 text-muted border-muted/30",
};

export function Badge({ label }: { label: string }) {
  const style = badgeStyles[label] ?? "bg-muted/15 text-muted border-muted/30";
  return (
    <span
      className={`inline-flex items-center rounded-full border px-2 py-0.5 text-xs font-medium ${style}`}
    >
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
