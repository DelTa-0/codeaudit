import type { ReactNode } from "react";
import { absoluteTime, compactNumber, fullNumber, relativeTime } from "../../lib/format";

/**
 * Admin-panel building blocks. They use only the app's existing design tokens
 * (`--color-surface`, `--color-ink`, `--color-primary`, the state colours) — the
 * panel should read as the same product wearing a different hat, not as a
 * second design system.
 */

export function Panel({
  title,
  subtitle,
  actions,
  children,
  padded = true,
}: {
  title?: string;
  subtitle?: string;
  actions?: ReactNode;
  children: ReactNode;
  padded?: boolean;
}) {
  return (
    <section className="overflow-hidden rounded-2xl border border-border bg-surface shadow-soft">
      {(title || actions) && (
        <header className="flex flex-wrap items-center justify-between gap-3 border-b border-border px-4 py-3 sm:px-5">
          <div className="min-w-0">
            {title && <h2 className="truncate text-sm font-semibold text-foreground">{title}</h2>}
            {subtitle && <p className="mt-0.5 truncate text-xs text-muted">{subtitle}</p>}
          </div>
          {actions && <div className="flex flex-wrap items-center gap-2">{actions}</div>}
        </header>
      )}
      <div className={padded ? "p-4 sm:p-5" : ""}>{children}</div>
    </section>
  );
}

const TONE_TEXT: Record<string, string> = {
  default: "text-foreground",
  primary: "text-primary",
  success: "text-success",
  warning: "text-warning",
  danger: "text-danger",
};

export function StatTile({
  label,
  value,
  hint,
  tone = "default",
  live = false,
  series,
}: {
  label: string;
  value: number | string;
  hint?: string;
  tone?: keyof typeof TONE_TEXT;
  /** Renders the pulsing dot that says "this number is current, not cached". */
  live?: boolean;
  series?: number[];
}) {
  const display = typeof value === "number" ? compactNumber(value) : value;
  const title = typeof value === "number" ? fullNumber(value) : undefined;
  return (
    <div className="flex flex-col justify-between rounded-2xl border border-border bg-surface p-4 shadow-soft">
      <div className="flex items-start justify-between gap-2">
        <span className="text-xs font-medium tracking-wide text-muted uppercase">{label}</span>
        {live && <LiveDot />}
      </div>
      <div className="mt-2 flex items-end justify-between gap-3">
        <span
          title={title}
          className={`font-mono text-3xl leading-none font-semibold tabular-nums ${TONE_TEXT[tone]}`}
        >
          {display}
        </span>
        {series && series.length > 1 && (
          <Sparkline values={series} tone={tone === "default" ? "primary" : tone} />
        )}
      </div>
      {hint && <p className="mt-2 text-xs text-muted">{hint}</p>}
    </div>
  );
}

const TONE_STROKE: Record<string, string> = {
  primary: "var(--color-primary)",
  success: "var(--color-success)",
  warning: "var(--color-warning)",
  danger: "var(--color-danger)",
};

/**
 * A hand-rolled sparkline rather than a Recharts chart. At 64×24 with no axes,
 * no tooltip, and no legend, everything a charting library provides is overhead;
 * this is a polyline and a baseline.
 */
export function Sparkline({
  values,
  width = 68,
  height = 26,
  tone = "primary",
}: {
  values: number[];
  width?: number;
  height?: number;
  tone?: string;
}) {
  const max = Math.max(...values, 1);
  const step = values.length > 1 ? width / (values.length - 1) : width;
  const y = (v: number) => height - 2 - (v / max) * (height - 4);
  const points = values.map((v, i) => `${(i * step).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const stroke = TONE_STROKE[tone] ?? TONE_STROKE.primary;
  return (
    <svg width={width} height={height} viewBox={`0 0 ${width} ${height}`} aria-hidden="true">
      <polyline
        points={`0,${height} ${points} ${width},${height}`}
        fill={stroke}
        fillOpacity="0.1"
        stroke="none"
      />
      <polyline
        points={points}
        fill="none"
        stroke={stroke}
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

export function LiveDot({ tone = "success" }: { tone?: "success" | "danger" | "warning" }) {
  const color = { success: "bg-success", danger: "bg-danger", warning: "bg-warning" }[tone];
  return (
    <span className="relative flex h-2 w-2" aria-hidden="true">
      <span className={`absolute inline-flex h-full w-full animate-ping rounded-full ${color} opacity-60`} />
      <span className={`relative inline-flex h-2 w-2 rounded-full ${color}`} />
    </span>
  );
}

const LEVEL_STYLES: Record<string, string> = {
  error: "bg-danger/10 text-danger ring-danger/25",
  warn: "bg-warning/10 text-warning ring-warning/25",
  info: "bg-primary/10 text-primary ring-primary/20",
  debug: "bg-surface-2 text-muted ring-border",
};

export function LevelBadge({ level }: { level: string }) {
  return (
    <span
      className={`inline-flex items-center rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium uppercase ring-1 ring-inset ${
        LEVEL_STYLES[level] ?? LEVEL_STYLES.debug
      }`}
    >
      {level}
    </span>
  );
}

/** HTTP status, coloured by class. 2xx is quiet; 4xx and 5xx are the story. */
export function StatusPill({ status }: { status: number | null }) {
  if (status === null) return <span className="text-muted">—</span>;
  const style =
    status >= 500
      ? "bg-danger/10 text-danger"
      : status >= 400
        ? "bg-warning/10 text-warning"
        : "bg-surface-2 text-muted";
  return (
    <span className={`inline-flex rounded-md px-1.5 py-0.5 font-mono text-[11px] font-medium ${style}`}>
      {status}
    </span>
  );
}

export function Dot({ ok, size = 8 }: { ok: boolean; size?: number }) {
  return (
    <span
      aria-hidden="true"
      className={`inline-block shrink-0 rounded-full ${ok ? "bg-success" : "bg-danger"}`}
      style={{ width: size, height: size }}
    />
  );
}

/** Relative label, exact timestamp on hover — the operator wants both, rarely at once. */
export function Time({ iso }: { iso: string | null | undefined }) {
  return (
    <span className="whitespace-nowrap text-muted" title={absoluteTime(iso)}>
      {relativeTime(iso)}
    </span>
  );
}

export function JsonBlock({ value }: { value: unknown }) {
  if (value === null || value === undefined) return null;
  return (
    <pre className="overflow-x-auto rounded-xl bg-surface-2 p-3 font-mono text-[11px] leading-relaxed text-muted">
      {JSON.stringify(value, null, 2)}
    </pre>
  );
}

export function Skeleton({ rows = 5 }: { rows?: number }) {
  return (
    <div className="space-y-2" aria-hidden="true">
      {Array.from({ length: rows }).map((_, i) => (
        <div key={i} className="h-9 animate-pulse rounded-lg bg-surface-2" />
      ))}
    </div>
  );
}

export function ErrorNote({ message }: { message: string }) {
  return (
    <p className="rounded-xl border border-danger/40 bg-danger/10 px-3 py-2 text-sm text-danger">
      {message}
    </p>
  );
}
