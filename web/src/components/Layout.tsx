import { Link, NavLink, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";
import { ThemeToggle } from "./ThemeToggle";

export function Layout() {
  const { user, orgs, logout } = useAuth();
  const navigate = useNavigate();
  const org = orgs[0];

  const navLinkClass = ({ isActive }: { isActive: boolean }) =>
    `rounded-md px-1.5 py-1 transition-colors ${
      isActive ? "text-foreground" : "hover:text-foreground"
    }`;

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link
              to="/dashboard"
              className="flex items-center gap-1.5 font-mono text-sm font-semibold tracking-tight"
            >
              <span className="text-primary">◆</span> CodeAudit
            </Link>
            {org && (
              <nav className="flex items-center gap-1 text-sm text-muted">
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
          <div className="flex items-center gap-3 text-sm">
            {org && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                {org.name} · {org.plan}
              </span>
            )}
            <span className="hidden text-muted sm:inline">{user?.email}</span>
            <button
              className="cursor-pointer rounded-md px-1 text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
            <ThemeToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
