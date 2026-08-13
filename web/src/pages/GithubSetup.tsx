import { useEffect, useRef, useState } from "react";
import { Link, useNavigate, useSearchParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Spinner } from "../components/ui";

/**
 * Where GitHub sends the user after they install the App.
 *
 * The installation only becomes usable once it is linked to an org, and the
 * server cannot infer which org that is: the install happens on GitHub, under
 * a GitHub account, with no reference to a CodeAudit organisation. That is why
 * the `installation` webhook deliberately ignores `created` — the ownership
 * decision belongs to a signed-in user, which is this page.
 *
 * Configure it as the App's **Setup URL**:
 *   https://codeaudit.madhavaryal.info.np/github/setup
 */
export function GithubSetup() {
  const [params] = useSearchParams();
  const navigate = useNavigate();
  const { orgs } = useAuth();
  const org = orgs[0];
  const [error, setError] = useState<string | null>(null);
  // React 18 StrictMode mounts effects twice in development; without this the
  // link call fires twice and the second one races the redirect.
  const started = useRef(false);

  const installationId = Number(params.get("installation_id"));
  const setupAction = params.get("setup_action"); // "install" | "update" | "request"

  useEffect(() => {
    if (started.current || !org) return;
    started.current = true;

    if (!Number.isFinite(installationId) || installationId <= 0) {
      setError(
        setupAction === "request"
          ? "Your installation request was sent to an organisation owner. Once they approve it, come back and install again."
          : "GitHub did not send an installation id. Try installing the App again from the dashboard.",
      );
      return;
    }

    void api(`/api/orgs/${org.id}/installations`, {
      method: "POST",
      body: { installationId },
    })
      .then(() => navigate("/dashboard", { replace: true }))
      .catch((err: unknown) =>
        setError(err instanceof Error ? err.message : "Could not link the installation"),
      );
  }, [org?.id, installationId, setupAction, navigate]);

  if (error) {
    return (
      <Card>
        <h1 className="text-lg font-semibold">Could not finish connecting GitHub</h1>
        <p className="mt-2 text-sm text-muted">{error}</p>
        <Link to="/dashboard" className="mt-4 inline-block">
          <Button variant="ghost">Back to dashboard</Button>
        </Link>
      </Card>
    );
  }

  return (
    <Card>
      <div className="flex items-center gap-3 text-sm text-muted">
        <Spinner />
        Connecting your GitHub installation…
      </div>
    </Card>
  );
}
