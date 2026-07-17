import { useState } from "react";
import { useParams } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Card, Button, Badge } from "../components/ui";

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
  const { orgs } = useAuth();
  const org = orgs.find((o) => o.id === orgId);
  const currentPlan = org?.plan ?? "free";
  const [error, setError] = useState<string | null>(null);

  const upgrade = async (plan: string) => {
    setError(null);
    try {
      const session = await api<{ url: string }>(`/api/orgs/${orgId}/billing/checkout`, {
        method: "POST",
        body: { plan },
      });
      window.location.href = session.url;
    } catch (err) {
      setError(err instanceof Error ? err.message : "Checkout failed");
    }
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-xl font-semibold">Billing</h1>
        <p className="mt-1 text-sm text-muted">
          Current plan: <Badge label={currentPlan} />
        </p>
        {error && <p className="mt-2 text-sm text-danger">{error}</p>}
      </div>
      <div className="grid gap-4 sm:grid-cols-3">
        {PLANS.map((plan) => (
          <Card key={plan.id} className={plan.id === currentPlan ? "border-primary/60" : ""}>
            <p className="text-sm font-semibold">{plan.name}</p>
            <p className="mt-1 font-mono text-2xl font-bold">{plan.price}</p>
            <ul className="mt-3 space-y-1 text-sm text-muted">
              {plan.features.map((f) => (
                <li key={f}>· {f}</li>
              ))}
            </ul>
            <Button
              variant={plan.id === currentPlan ? "ghost" : "primary"}
              disabled={plan.id === currentPlan}
              className="mt-4 w-full"
              onClick={() => void upgrade(plan.id)}
            >
              {plan.id === currentPlan ? "Current plan" : "Upgrade"}
            </Button>
          </Card>
        ))}
      </div>
    </div>
  );
}
