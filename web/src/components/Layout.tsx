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
      <div className="mx-auto max-w-6xl px-4 pt-4">
        <header className="flex items-center justify-between rounded-2xl border border-border bg-surface px-4 py-2.5 shadow-soft">
          <div className="flex items-center gap-6">
            <Link to="/dashboard" className="flex items-center gap-2 font-mono text-sm font-semibold tracking-tight">
              <span className="flex h-7 w-7 items-center justify-center rounded-lg bg-primary text-white">
                <LogoMark size={18} />
              </span>
              CodeAudit
            </Link>
            {org && (
              <nav className="flex items-center gap-1">
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
          </div>
          <div className="flex items-center gap-3">
            {org && (
              <span className="hidden rounded-full bg-surface-2 px-3 py-1 text-xs font-medium text-muted sm:inline">
                {org.name} · {org.plan}
              </span>
            )}
            <ThemeToggle />
            <button
              className="cursor-pointer rounded-full border border-border px-3 py-1.5 text-sm text-muted transition-colors hover:bg-surface-2 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
            {user && <Avatar label={user.email} size={36} />}
          </div>
        </header>
      </div>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
