import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Input, Card } from "../components/ui";
import { ThemeToggle } from "../components/ThemeToggle";
import { LogoMark } from "../components/Logo";

/**
 * Where to land after signing in. RequireAuth sets ?next when it bounces an
 * unauthenticated visitor, which is what carries /github/setup's installation_id
 * through the login detour instead of losing it. Only same-site paths are
 * honoured, so ?next cannot bounce a freshly-signed-in user to an attacker's URL.
 */
export function safeNext(): string {
  const raw = new URLSearchParams(window.location.search).get("next");
  return raw && raw.startsWith("/") && !raw.startsWith("//") ? raw : "/dashboard";
}

/**
 * The chrome every auth screen shares. Extracted when signup, the emailed-link
 * landing and set-password all needed it — three copies of a centred card is
 * how the back-link and theme toggle drift apart.
 */
export function AuthShell({ title, children }: { title: string; children: ReactNode }) {
  return (
    <div className="relative flex min-h-screen items-center justify-center px-4">
      <Link
        to="/"
        className="absolute left-4 top-4 flex items-center gap-1.5 rounded-full border border-border bg-surface px-3 py-3 text-sm sm:py-1.5 text-muted transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary/50"
      >
        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
          <path d="M19 12H5M12 19l-7-7 7-7" />
        </svg>
        Back to site
      </Link>
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <div className="w-full max-w-sm">
        <div className="mb-6 text-center">
          <div className="flex items-center justify-center gap-2 font-mono text-lg font-semibold tracking-tight">
            <span className="text-primary">
              <LogoMark size={22} />
            </span>
            CodeAudit
          </div>
          <p className="mt-1 text-sm text-muted">AI technical debt intelligence</p>
        </div>
        <Card>
          <h1 className="mb-4 text-lg font-semibold">{title}</h1>
          {children}
        </Card>
      </div>
    </div>
  );
}

export function AuthPage({ mode }: { mode: "login" | "register" }) {
  return mode === "login" ? <LoginPage /> : <SignUpPage />;
}

/** Unchanged: email and password, for accounts that have one. */
function LoginPage() {
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const next = safeNext();

  // GitHub OAuth callback hands the JWT back via URL fragment.
  useEffect(() => {
    const match = window.location.hash.match(/token=([^&]+)/);
    if (match) {
      window.history.replaceState(null, "", window.location.pathname + window.location.search);
      void login(match[1]).then(() => navigate(next));
    }
  }, []);

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ token: string }>("/api/auth/login", {
        method: "POST",
        body: { email, password },
      });
      await login(data.token);
      navigate(next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <AuthShell title="Sign in">
      <form onSubmit={submit} className="space-y-3">
        <Input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        <Input
          type="password"
          required
          minLength={8}
          placeholder="Password"
          value={password}
          onChange={(e) => setPassword(e.target.value)}
        />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Please wait…" : "Sign in"}
        </Button>
      </form>
      <div className="my-4 flex items-center gap-3 text-xs text-muted">
        <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
      </div>
      <Button variant="ghost" className="w-full" onClick={() => (window.location.href = "/api/auth/github")}>
        Continue with GitHub
      </Button>
      <p className="mt-4 text-center text-sm text-muted">
        No password, or no account?{" "}
        <Link className="text-primary hover:underline" to="/register">
          Email me a link
        </Link>
      </p>
    </AuthShell>
  );
}

/**
 * Signup, which is now a magic link rather than a form.
 *
 * There is no password field, and that is the entire point: an account can only
 * come into existence when someone clicks a link in a mailbox they control, so
 * an address nobody owns cannot become an account. The same flow signs in an
 * existing account, which is also the only password reset this product has.
 */
function SignUpPage() {
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [sent, setSent] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();
  const next = safeNext();

  const requestLink = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      await api("/api/auth/signin-link", { method: "POST", body: { email } });
      // Always the same outcome, because the API always answers the same way.
      // The screen cannot say "check your mail, that account exists" without
      // undoing the reason signup works like this.
      setSent(true);
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  const submitCode = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      const data = await api<{ token: string; mustSetPassword: boolean }>("/api/auth/signin-verify", {
        method: "POST",
        body: { email, code },
      });
      await login(data.token);
      navigate(data.mustSetPassword ? "/set-password" : next);
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code is not valid");
    } finally {
      setBusy(false);
    }
  };

  if (sent) {
    return (
      <AuthShell title="Check your email">
        <p className="text-sm text-muted">
          If <span className="text-foreground">{email}</span> can receive mail, a sign-in link and a
          6-digit code are on their way. Both expire in 15 minutes.
        </p>
        <form onSubmit={submitCode} className="mt-4 space-y-3">
          <Input
            inputMode="numeric"
            pattern="\d{6}"
            maxLength={6}
            required
            placeholder="6-digit code"
            value={code}
            onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
          />
          {error && <p className="text-sm text-danger">{error}</p>}
          <Button type="submit" disabled={busy || code.length !== 6} className="w-full">
            {busy ? "Please wait…" : "Continue"}
          </Button>
        </form>
        <p className="mt-4 text-center text-sm text-muted">
          <button
            type="button"
            className="text-primary hover:underline"
            onClick={() => {
              setSent(false);
              setCode("");
              setError(null);
            }}
          >
            Use a different address
          </button>
        </p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="Sign up or sign in">
      <p className="mb-4 text-sm text-muted">
        Enter your email and we'll send a link. No password needed — you can set one afterwards.
      </p>
      <form onSubmit={requestLink} className="space-y-3">
        <Input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
        {error && <p className="text-sm text-danger">{error}</p>}
        <Button type="submit" disabled={busy} className="w-full">
          {busy ? "Sending…" : "Email me a link"}
        </Button>
      </form>
      <div className="my-4 flex items-center gap-3 text-xs text-muted">
        <div className="h-px flex-1 bg-border" /> or <div className="h-px flex-1 bg-border" />
      </div>
      <Button variant="ghost" className="w-full" onClick={() => (window.location.href = "/api/auth/github")}>
        Continue with GitHub
      </Button>
      <p className="mt-4 text-center text-sm text-muted">
        Have a password?{" "}
        <Link className="text-primary hover:underline" to="/login">
          Sign in
        </Link>
      </p>
    </AuthShell>
  );
}
