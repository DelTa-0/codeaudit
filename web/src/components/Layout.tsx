import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ThemeToggle } from "./ThemeToggle";
import { Avatar } from "./ui";
import { LogoMark } from "./Logo";

export function Layout() {
  const { user, orgs, logout } = useAuth();
  const navigate = useNavigate();
  const org = orgs[0];

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-full px-3 py-1.5 text-sm font-medium transition-colors ${
      isActive ? "bg-ink text-ink-foreground" : "text-muted hover:text-foreground"
    }`;

  return (
    <div className="min-h-screen bg-background">
      <div className="mx-auto max-w-6xl px-3 pt-3 sm:px-4 sm:pt-4">
        {/* One non-wrapping row of seven controls overflowed 375px. Wrapping
            plus `order-last` lets the section nav drop to its own full-width
            line on phones while staying inline beside the logo from `sm` up —
            one nav in the markup, two layouts, and desktop is unchanged. */}
        <header className="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-2xl border border-border bg-surface px-3 py-2 shadow-soft sm:gap-x-6 sm:px-4 sm:py-2.5">
          <Link
            to="/dashboard"
            className="flex shrink-0 items-center gap-2 font-mono text-sm font-semibold tracking-tight"
          >
            <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
              <LogoMark size={18} />
            </span>
            CodeAudit
          </Link>
          {org && (
            <nav
              className="order-last -mx-1 flex w-full items-center gap-1 overflow-x-auto px-1 pb-0.5 sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0 sm:pb-0"
              aria-label="Sections"
            >
              <NavLink className={navLinkClass} to="/dashboard" end>
                Repositories
              </NavLink>
              <NavLink className={navLinkClass} to={`/orgs/${org.id}/members`}>
                Members
              </NavLink>
              <NavLink className={navLinkClass} to={`/orgs/${org.id}/billing`}>
                Billing
              </NavLink>
            </nav>
          )}
          <div className="ml-auto flex items-center gap-2 sm:gap-3">
            {/* Only platform operators see this. Hiding it is a courtesy, not a
                control — the console's routes are refused server-side. */}
            {user?.platform_role === "admin" && (
              <Link
                to="/admin"
                className="rounded-full bg-ink px-3 py-1.5 font-mono text-xs font-medium tracking-wide text-ink-foreground uppercase transition-opacity hover:opacity-90"
              >
                Admin
              </Link>
            )}
            {org && (
              <span className="hidden rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted lg:inline">
                {org.name} · {org.plan}
              </span>
            )}
            <ThemeToggle />
            <button
              className="cursor-pointer rounded-full border border-border px-3 py-2 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50 sm:py-1.5"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              {/* The avatar already identifies the account, so the full label
                  is dead width on a phone. Screen readers keep it either way. */}
              <span aria-hidden="true" className="sm:hidden">
                Exit
              </span>
              <span aria-hidden="true" className="hidden sm:inline">
                Sign out
              </span>
              <span className="sr-only">Sign out</span>
            </button>
            {user && <Avatar label={user.email} size={36} />}
          </div>
        </header>
      </div>
      <main className="mx-auto max-w-6xl px-3 py-6 sm:px-4 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
