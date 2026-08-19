import { Link, NavLink, Outlet } from "react-router-dom";
import { useAuth } from "../../lib/auth";
import { ThemeToggle } from "../../components/ThemeToggle";
import { LogoMark } from "../../components/Logo";

const SECTIONS = [
  { to: "/admin", end: true, label: "Overview", glyph: "◎" },
  { to: "/admin/users", label: "Users", glyph: "◇" },
  { to: "/admin/orgs", label: "Organizations", glyph: "▤" },
  { to: "/admin/activity", label: "Activity log", glyph: "≡" },
  { to: "/admin/events", label: "System events", glyph: "⚠" },
  { to: "/admin/processes", label: "Processes", glyph: "⟳" },
  { to: "/admin/health", label: "Health", glyph: "✚" },
];

/**
 * The console gets its own chrome — a persistent rail and an "operator" mark —
 * rather than reusing the product header. That is a deliberate safety
 * affordance: everything inside these pages is cross-tenant, and it should never
 * be ambiguous whether you are looking at your own workspace or at everybody's.
 */
export function AdminLayout() {
  const { user } = useAuth();

  const linkClass = ({ isActive }: { isActive: boolean }) =>
    `flex items-center gap-2.5 rounded-xl px-3 py-2 text-sm font-medium transition-colors ${
      isActive
        ? "bg-primary/12 text-primary"
        : "text-muted hover:bg-surface-2 hover:text-foreground"
    }`;

  return (
    <div className="min-h-screen bg-background">
      <header className="sticky top-0 z-30 border-b border-border bg-ink text-ink-foreground">
        <div className="mx-auto flex max-w-7xl flex-wrap items-center gap-x-4 gap-y-2 px-3 py-2.5 sm:px-5">
          <Link to="/admin" className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold">
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
              <LogoMark size={18} />
            </span>
            CodeAudit
            <span className="rounded-md bg-primary/20 px-1.5 py-0.5 font-mono text-[10px] tracking-widest text-primary uppercase">
              Operator
            </span>
          </Link>
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            <Link
              to="/dashboard"
              className="rounded-full border border-white/15 px-3 py-1.5 text-xs font-medium text-ink-foreground/80 transition-colors hover:bg-white/10 hover:text-ink-foreground"
            >
              Leave console
            </Link>
            <ThemeToggle />
            {user && (
              <span className="hidden font-mono text-xs text-ink-foreground/60 lg:inline">
                {user.email}
              </span>
            )}
          </div>
        </div>
      </header>

      <div className="mx-auto flex max-w-7xl gap-6 px-3 py-4 sm:px-5 sm:py-6">
        {/* Rail on desktop, a horizontal scroller on phones — one nav in the
            markup, two layouts, so a section can never exist in one and not the
            other. */}
        <nav
          aria-label="Admin sections"
          className="fixed inset-x-0 bottom-0 z-20 flex gap-1 overflow-x-auto border-t border-border bg-surface px-2 py-2 lg:static lg:w-52 lg:shrink-0 lg:flex-col lg:overflow-visible lg:border-t-0 lg:bg-transparent lg:px-0 lg:py-0"
        >
          {SECTIONS.map((s) => (
            <NavLink key={s.to} to={s.to} end={s.end} className={linkClass}>
              <span aria-hidden="true" className="text-base leading-none opacity-70">
                {s.glyph}
              </span>
              <span className="whitespace-nowrap">{s.label}</span>
            </NavLink>
          ))}
        </nav>

        {/* Bottom padding clears the fixed mobile nav. */}
        <main className="min-w-0 flex-1 pb-20 lg:pb-0">
          <Outlet />
        </main>
      </div>
    </div>
  );
}
