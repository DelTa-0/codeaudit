import { useState, type FormEvent } from "react";
import { useNavigate } from "react-router-dom";
import { api } from "../lib/api";
import { Button, Input } from "../components/ui";
import { AuthShell } from "./Auth";

/**
 * Offered after a first sign-in by link, and skippable on purpose.
 *
 * Nothing breaks if the user closes the tab here: requesting another link is
 * always available and always works, which is what makes skipping safe — and is
 * also the only password reset this product has. Forcing the step before the
 * dashboard would strand anyone who wandered off, in exchange for nothing.
 */
export function SetPasswordPage() {
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const navigate = useNavigate();

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/set-password", { method: "POST", body: { password } });
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Set a password">
      <p className="mb-4 text-sm text-muted">
        Optional. With one you can use the sign-in form; without one, ask for a link whenever you
        need to get in.
      </p>
      <form onSubmit={submit} className="space-y-3">
        <Input
          type="password"
          required
          minLength={8}
          placeholder="Password (min 8 characters)"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy || password.length < 8} className="w-full">
          {busy ? "Saving…" : "Set password"}
        </Button>
      </form>
      <p className="mt-4 text-center text-sm text-muted">
        <button type="button" className="text-primary hover:underline" onClick={() => navigate("/dashboard")}>
          Skip for now
        </button>
      </p>
    </AuthShell>
  );
}
