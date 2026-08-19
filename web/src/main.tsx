import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { BrowserRouter, Routes, Route, Navigate, Outlet, useLocation } from "react-router-dom";
import "./styles.css";
import { AuthProvider, useAuth } from "./lib/auth";
import { Layout } from "./components/Layout";
import { Landing } from "./pages/Landing";
import { AuthPage } from "./pages/Auth";
import { Dashboard } from "./pages/Dashboard";
import { RepoDetail } from "./pages/RepoDetail";
import { ScanDetail } from "./pages/ScanDetail";
import { ScanReport } from "./pages/ScanReport";
import { Members } from "./pages/Members";
import { Billing } from "./pages/Billing";
import { GithubSetup } from "./pages/GithubSetup";
import { AdminLayout } from "./pages/admin/AdminLayout";
import { AdminOverview } from "./pages/admin/Overview";
import { AdminUsers } from "./pages/admin/Users";
import { AdminOrganizations } from "./pages/admin/Organizations";
import { AdminActivity } from "./pages/admin/Activity";
import { AdminEvents } from "./pages/admin/Events";
import { AdminProcesses } from "./pages/admin/Processes";
import { AdminHealth } from "./pages/admin/Health";
import { Spinner } from "./components/ui";

/**
 * Client-side gate on the console. This is an affordance, not the security
 * boundary — every /api/admin route re-reads the caller's platform role from
 * the database and answers a non-admin with 404 regardless of what the browser
 * decided to render.
 */
function RequireAdmin() {
  const { user, loading } = useAuth();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  if (!user) return <Navigate to="/login?next=/admin" replace />;
  if (user.platform_role !== "admin") return <Navigate to="/dashboard" replace />;
  return <Outlet />;
}

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();
  if (loading)
    return (
      <div className="flex min-h-screen items-center justify-center">
        <Spinner />
      </div>
    );
  if (!user) {
    // Carry the intended destination through login. Without this, arriving at
    // /github/setup?installation_id=… while signed out drops the id on the
    // floor and the installation is silently never linked.
    const next = `${location.pathname}${location.search}`;
    return <Navigate to={`/login?next=${encodeURIComponent(next)}`} replace />;
  }
  return <Outlet />;
}

function App() {
  return (
    <BrowserRouter>
      <Routes>
        <Route path="/" element={<Landing />} />
        <Route path="/login" element={<AuthPage mode="login" />} />
        <Route path="/register" element={<AuthPage mode="register" />} />
        <Route element={<RequireAuth />}>
          <Route element={<Layout />}>
            <Route path="/dashboard" element={<Dashboard />} />
            {/* GitHub's post-install Setup URL lands here. Inside RequireAuth
                because linking an installation to an org needs to know who is
                asking — the install itself carries no CodeAudit identity. */}
            <Route path="/github/setup" element={<GithubSetup />} />
            <Route path="/repos/:repoId" element={<RepoDetail />} />
            <Route path="/scans/:scanId" element={<ScanDetail />} />
            <Route path="/orgs/:orgId/members" element={<Members />} />
            <Route path="/orgs/:orgId/billing" element={<Billing />} />
          </Route>
          {/* Outside <Layout> on purpose — the printable report carries no app
              nav/chrome so Save-as-PDF produces a clean document. */}
          <Route path="/scans/:scanId/report" element={<ScanReport />} />
        </Route>
        {/* The operator console. Outside <Layout> — it has its own chrome, so
            it is never ambiguous whether you are looking at your own workspace
            or at everyone's. */}
        <Route element={<RequireAdmin />}>
          <Route path="/admin" element={<AdminLayout />}>
            <Route index element={<AdminOverview />} />
            <Route path="users" element={<AdminUsers />} />
            <Route path="orgs" element={<AdminOrganizations />} />
            <Route path="activity" element={<AdminActivity />} />
            <Route path="events" element={<AdminEvents />} />
            <Route path="processes" element={<AdminProcesses />} />
            <Route path="health" element={<AdminHealth />} />
          </Route>
        </Route>
        <Route path="*" element={<Navigate to="/" replace />} />
      </Routes>
    </BrowserRouter>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <AuthProvider>
      <App />
    </AuthProvider>
  </StrictMode>,
);
