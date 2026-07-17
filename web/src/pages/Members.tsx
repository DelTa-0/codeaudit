import { useEffect, useState, type FormEvent } from "react";
import { useParams } from "react-router-dom";
import { api, type Member } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Card, Input, Badge, Spinner } from "../components/ui";

export function Members() {
  const { orgId } = useParams();
  const { orgs } = useAuth();
  const myRole = orgs.find((o) => o.id === orgId)?.role ?? "developer";
  const [members, setMembers] = useState<Member[] | null>(null);
  const [email, setEmail] = useState("");
  const [role, setRole] = useState<"developer" | "admin">("developer");
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = async () => setMembers(await api<Member[]>(`/api/orgs/${orgId}/members`));

  useEffect(() => {
    void load().catch((err) => setError(err.message));
  }, [orgId]);

  const invite = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setMessage(null);
    try {
      const inv = await api<{ token: string }>(`/api/orgs/${orgId}/invites`, {
        method: "POST",
        body: { email, role },
      });
      setMessage(`Invite created. Local dev link token: ${inv.token}`);
      setEmail("");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to invite");
    }
  };

  if (!members)
    return (
      <div className="flex justify-center py-12">
        <Spinner />
      </div>
    );

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-semibold">Members</h1>

      {(myRole === "owner" || myRole === "admin") && (
        <Card>
          <form onSubmit={invite} className="flex gap-3">
            <Input
              type="email"
              required
              placeholder="colleague@company.com"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <select
              className="rounded-lg border border-border bg-surface-2 px-3 py-2 text-sm"
              value={role}
              onChange={(e) => setRole(e.target.value as "developer" | "admin")}
            >
              <option value="developer">Developer</option>
              <option value="admin">Admin</option>
            </select>
            <Button type="submit">Invite</Button>
          </form>
          {message && <p className="mt-2 text-sm text-success">{message}</p>}
          {error && <p className="mt-2 text-sm text-danger">{error}</p>}
        </Card>
      )}

      <Card>
        <div className="divide-y divide-border">
          {members.map((m) => (
            <div key={m.id} className="flex items-center justify-between py-3">
              <div>
                <p className="text-sm font-medium">{m.name ?? m.email}</p>
                <p className="text-xs text-muted">{m.email}</p>
              </div>
              <Badge label={m.role} />
            </div>
          ))}
        </div>
      </Card>
    </div>
  );
}
