import { Link, Outlet, useNavigate } from "react-router-dom";
import { useAuth } from "../lib/auth";

export function Layout() {
  const { user, orgs, logout } = useAuth();
  const navigate = useNavigate();
  const org = orgs[0];

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-10 border-b border-border bg-background/80 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-6xl items-center justify-between px-4">
          <div className="flex items-center gap-6">
            <Link to="/" className="font-mono text-sm font-semibold tracking-tight">
              <span className="text-primary">◆</span> CodeAudit
            </Link>
            {org && (
              <nav className="flex items-center gap-4 text-sm text-muted">
                <Link className="hover:text-foreground" to="/">
                  Repositories
                </Link>
                <Link className="hover:text-foreground" to={`/orgs/${org.id}/members`}>
                  Members
                </Link>
                <Link className="hover:text-foreground" to={`/orgs/${org.id}/billing`}>
                  Billing
                </Link>
              </nav>
            )}
          </div>
          <div className="flex items-center gap-3 text-sm">
            {org && (
              <span className="rounded-full border border-border px-2 py-0.5 text-xs text-muted">
                {org.name} · {org.plan}
              </span>
            )}
            <span className="text-muted">{user?.email}</span>
            <button
              className="text-muted hover:text-foreground"
              onClick={() => {
                logout();
                navigate("/login");
              }}
            >
              Sign out
            </button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
