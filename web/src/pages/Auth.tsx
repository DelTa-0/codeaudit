import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Input, Card } from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  // GitHub OAuth callback hands the JWT back via URL fragment.
  useEffect(() => {
    const match = window.location.hash.match(/token=([^&]+)/);
    if (match) {
      window.history.replaceState(null, "", window.location.pathname);
      void login(match[1]).then(() => navigate("/dashboard"));
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const body = mode === "register" ? { email, password, name: name || undefined } : { email, password };
      const data = await api<{ token: string }>(`/api/auth/${mode}`, { method: "POST", body });
      await login(data.token);
      navigate("/dashboard");
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="font-mono text-lg font-semibold tracking-tight">
            <span className="text-primary">◆</span> CodeAudit
          </div>
          <p className="mt-1 text-sm text-muted">AI technical debt intelligence</p>
        </div>
        <Card>
          <h1 className="mb-4 text-lg font-semibold">
            {mode === "login" ? "Sign in" : "Create your account"}
          </h1>
          <form onSubmit={submit} className="space-y-3">
            {mode === "register" && (
              <Input placeholder="Name" value={name} onChange={(e) => setName(e.target.value)} />
            )}
            <Input
              type="email"
              required
              placeholder="Email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
            />
            <Input
              type="password"
              required
              minLength={8}
              placeholder="Password (min 8 characters)"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
            />
            {error && <p className="text-sm text-danger">{error}</p>}
            <Button type="submit" disabled={busy} className="w-full">
              {busy ? "Please wait…" : mode === "login" ? "Sign in" : "Create account"}
            </Button>
          </form>
          <div className="my-4 flex items-center gap-3 text-xs text-muted">
            <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
          </div>
          <Button variant="ghost" className="w-full" onClick={() => (window.location.href = "/api/auth/github")}>
            Continue with GitHub
          </Button>
          <p className="mt-4 text-center text-sm text-muted">
            {mode === "login" ? (
              <>
                No account?{" "}
                <Link className="text-primary hover:underline" to="/register">
                  Register
                </Link>
              </>
            ) : (
              <>
                Already registered?{" "}
                <Link className="text-primary hover:underline" to="/login">
                  Sign in
                </Link>
              </>
            )}
          </p>
        </Card>
      </div>
    </div>
  );
}
