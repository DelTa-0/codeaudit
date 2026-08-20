import { useEffect, useState, type FormEvent } from "react";
import { useNavigate, Link } from "react-router-dom";
import { api } from "../lib/api";
import { useAuth } from "../lib/auth";
import { Button, Input } from "../components/ui";
import { AuthShell, safeNext } from "./Auth";

/**
 * The landing page for an emailed sign-in link.
 *
 * The failure state matters more than the success one. Corporate mail scanners
 * and link previewers fetch URLs automatically, which consumes a single-use
 * token before the human clicks it — so a user arriving here to be told the
 * link is spent has usually done nothing wrong. The copy says that, and offers
 * the code from the same email, which the scanner never saw.
 */
export function SignInLinkPage() {
  const [state, setState] = useState<"working" | "spent">("working");
  const [email, setEmail] = useState("");
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  useEffect(() => {
    const token = new URLSearchParams(window.location.search).get("token");
    if (!token) {
      setState("spent");
      return;
    }
    void (async () => {
      try {
        const data = await api<{ token: string; mustSetPassword: boolean }>("/api/auth/signin-verify", {
          method: "POST",
          body: { token },
        });
        // Drop the token from the address bar before anything can log it.
        window.history.replaceState(null, "", "/signin");
        await login(data.token);
        navigate(data.mustSetPassword ? "/set-password" : safeNext());
      } catch {
        setState("spent");
      }
    })();
  }, []);

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
      navigate(data.mustSetPassword ? "/set-password" : safeNext());
    } catch (err) {
      setError(err instanceof Error ? err.message : "That code is not valid");
    } finally {
      setBusy(false);
    }
  };

  if (state === "working") {
    return (
      <AuthShell title="Signing you in">
        <p className="text-sm text-muted">One moment…</p>
      </AuthShell>
    );
  }

  return (
    <AuthShell title="That link has been used">
      <p className="text-sm text-muted">
        Sign-in links work once. Some email providers open links automatically to scan them, which
        can use yours up before you get to it — if that happened, nothing is wrong with your account.
      </p>
      <p className="mt-3 text-sm text-muted">Enter the 6-digit code from the same email instead.</p>
      <form onSubmit={submitCode} className="mt-4 space-y-3">
        <Input type="email" required placeholder="Email" value={email} onChange={(e) => setEmail(e.target.value)} />
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
        <Link className="text-primary hover:underline" to="/register">
          Send a new link
        </Link>
      </p>
    </AuthShell>
  );
}
