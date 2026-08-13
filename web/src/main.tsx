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
import { Spinner } from "./components/ui";

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
