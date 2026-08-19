import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Button, Input } from "../ui";
import { ErrorNote } from "./primitives";

/**
 * The step-up prompt for the two privileged actions in the panel: changing
 * someone's platform role, and suspending an account.
 *
 * A bearer token proves the session authenticated at some point in the last
 * seven days. Re-entering the password proves someone who knows it is at the
 * keyboard now, which is the property that matters for an action whose whole
 * purpose is to grant the ability to perform it again. The server enforces
 * this; the dialog is how it gets asked for.
 */
export function ConfirmAction({
  open,
  title,
  description,
  confirmLabel,
  destructive = false,
  reasonLabel,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  description: ReactNode;
  confirmLabel: string;
  destructive?: boolean;
  reasonLabel?: string;
  onConfirm: (password: string, reason: string) => Promise<void>;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [reason, setReason] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (!open) return;
    // Never leave a typed password sitting in state between openings.
    setPassword("");
    setReason("");
    setError(null);
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await onConfirm(password, reason);
      setPassword("");
      onClose();
    } catch (err) {
      setError(err instanceof Error ? err.message : "Something went wrong");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className="fixed inset-0 z-50 flex items-end justify-center bg-ink/60 p-4 backdrop-blur-sm sm:items-center"
      role="dialog"
      aria-modal="true"
      aria-label={title}
      onMouseDown={(e) => e.target === e.currentTarget && onClose()}
    >
      <form
        onSubmit={submit}
        className="w-full max-w-md rounded-2xl border border-border bg-surface p-5 shadow-soft"
      >
        <h2 className="text-base font-semibold text-foreground">{title}</h2>
        <div className="mt-2 text-sm text-muted">{description}</div>

        <label className="mt-4 block text-xs font-medium text-muted">
          Confirm with your password
          <Input
            type="password"
            autoFocus
            autoComplete="current-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
            required
            className="mt-1.5"
          />
        </label>

        {reasonLabel && (
          <label className="mt-3 block text-xs font-medium text-muted">
            {reasonLabel}
            <Input
              value={reason}
              onChange={(e) => setReason(e.target.value)}
              placeholder="Recorded in the audit log"
              className="mt-1.5"
            />
          </label>
        )}

        {error && (
          <div className="mt-3">
            <ErrorNote message={error} />
          </div>
        )}

        <div className="mt-5 flex justify-end gap-2">
          <Button type="button" variant="ghost" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button type="submit" variant={destructive ? "danger" : "primary"} disabled={busy || !password}>
            {busy ? "Working…" : confirmLabel}
          </Button>
        </div>
      </form>
    </div>
  );
}
