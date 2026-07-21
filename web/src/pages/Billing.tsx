import { useEffect, useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card, Button, Badge, Spinner } from "../components/ui";

const PLANS = [
  {
    id: "free",
    name: "Free",
    price: "$0",
    features: ["3 repositories", "1 private repo", "10 scans/day", "Manual scans"],
  },
  {
    id: "pro",
    name: "Pro",
    price: "$29/dev/mo",
    features: ["25 repositories", "10 private repos", "200 scans/day", "Webhook auto-scans", "PR comments"],
  },
  {
    id: "team",
    name: "Team",
    price: "Custom",
    features: ["Unlimited repositories", "Unlimited private repos", "2000 scans/day", "Roles & audit log"],
  },
];

export function Billing() {
  const { orgId } = useParams();
  const { orgs, refresh } = useAuth();
  const org = orgs.find((o) => o.id === orgId);
  const currentPlan = org?.plan ?? "free";
  const [error, setError] = useState<string | null>(null);
  const [selfServe, setSelfServe] = useState<boolean | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  useEffect(() => {
    void api<{ selfServePlans: boolean }>("/api/billing/config")
      .then((c) => setSelfServe(c.selfServePlans))
      .catch(() => setSelfServe(false));
  }, []);

  // Stripe path — redirect to a real checkout session.
  const upgrade = async (plan: string) => {
    setError(null);
    setBusy(plan);
    try {
      const session = await api<{ url: string }>(`/api/orgs/${orgId}/billing/checkout`, {
        method: "POST",
        body: { plan },
      });
      window.location.href = session.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
      setBusy(null);
    }
  };

  // Development path — switch directly, no payment. Server-side this route only
  // exists while Stripe is unconfigured; tier limits still apply either way.
  const switchPlan = async (plan: string) => {
    setError(null);
    setBusy(plan);
    try {
      await api(`/api/orgs/${orgId}/billing/plan`, { method: "POST", body: { plan } });
      await refresh();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Could not switch plan");
    } finally {
      setBusy(null);
    }
  };

  if (selfServe === null)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Billing</h1>
        <p className="mt-1 text-sm text-muted">
          Current plan: <Badge label={currentPlan} />
        </p>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>

      {selfServe && (
        <Card className="border-warning/40">
          <p className="text-sm font-medium text-warning">Development mode — no payment required</p>
          <p className="mt-1 text-sm text-muted">
            Stripe isn't configured on this server, so you can switch plans freely to test each
            tier. <span className="font-medium">Plan limits still apply</span> — switching to Free
            really does enforce 3 repositories and 10 scans/day, so you can verify the gating
            works. This switcher disables itself automatically once{" "}
            <code className="font-mono text-xs">STRIPE_SECRET_KEY</code> is set.
          </p>
        </Card>
      )}

      <div className="grid gap-4 sm:grid-cols-3">
        {PLANS.map((plan) => {
          const isPro = plan.id === "pro";
          const isCurrent = plan.id === currentPlan;
          // Stripe checkout can't sell the free tier; dev mode can switch to it.
          const disabled = isCurrent || busy !== null || (!selfServe && plan.id === "free");
          const label = isCurrent
            ? "Current plan"
            : busy === plan.id
              ? "Switching…"
              : selfServe
                ? "Switch to this plan"
                : "Upgrade";
          return (
            <Card
              key={plan.id}
              tone={isPro ? "ink" : "default"}
              className={!isPro && isCurrent ? "border-primary/60" : ""}
            >
              <p className={`text-sm font-semibold ${isPro ? "text-primary" : ""}`}>{plan.name}</p>
              <p className="mt-1 font-mono text-2xl font-bold">{plan.price}</p>
              <ul className={`mt-3 space-y-1 text-sm ${isPro ? "text-ink-foreground/70" : "text-muted"}`}>
                {plan.features.map((f) => (
                  <li key={f}>· {f}</li>
                ))}
              </ul>
              <Button
                variant={isCurrent ? "ghost" : isPro ? "primary" : "ghost"}
                disabled={disabled}
                className={`mt-4 w-full ${isCurrent && isPro ? "border-ink-foreground/30 text-ink-foreground hover:bg-ink-foreground/10" : ""}`}
                onClick={() => void (selfServe ? switchPlan(plan.id) : upgrade(plan.id))}
              >
                {label}
              </Button>
            </Card>
          );
        })}
      </div>
    </div>
  );
}
