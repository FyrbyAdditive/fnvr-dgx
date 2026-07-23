import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api, ApiError } from "@/lib/api";

// Forced password-change screen. Shown (via Layout) whenever the
// session still carries a bootstrap/admin-assigned password — the
// server blocks every other endpoint until it's changed.
export function ChangePassword() {
  const qc = useQueryClient();
  const [current, setCurrent] = useState("");
  const [next, setNext] = useState("");
  const [confirm, setConfirm] = useState("");
  const [err, setErr] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const submit = async (e: React.FormEvent) => {
    e.preventDefault();
    setErr(null);
    if (next.length < 12) {
      setErr("New password must be at least 12 characters.");
      return;
    }
    if (next !== confirm) {
      setErr("Passwords don't match.");
      return;
    }
    setBusy(true);
    try {
      await api.changePassword(current, next);
      // Refresh /me so must_change_password clears and the app renders.
      await qc.invalidateQueries({ queryKey: ["me"] });
    } catch (e) {
      setErr(e instanceof ApiError ? e.message : "Change failed. Check your current password.");
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="h-full flex items-center justify-center p-6">
      <form onSubmit={submit} className="w-[min(92vw,26rem)] space-y-4">
        <div>
          <h1 className="text-lg font-semibold">Set a new password</h1>
          <p className="text-sm text-neutral-400 mt-1">
            This account uses a temporary password. Choose a new one (at least 12
            characters) to continue.
          </p>
        </div>
        <input
          type="password"
          autoComplete="current-password"
          placeholder="Current password"
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm"
          value={current}
          onChange={(e) => setCurrent(e.target.value)}
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="New password (≥ 12 characters)"
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm"
          value={next}
          onChange={(e) => setNext(e.target.value)}
          required
        />
        <input
          type="password"
          autoComplete="new-password"
          placeholder="Confirm new password"
          className="w-full bg-neutral-900 border border-neutral-800 rounded px-3 py-2 text-sm"
          value={confirm}
          onChange={(e) => setConfirm(e.target.value)}
          required
        />
        {err && <div className="text-sm text-red-400">{err}</div>}
        <button
          type="submit"
          disabled={busy}
          className="w-full bg-emerald-700 hover:bg-emerald-600 disabled:opacity-50 rounded px-3 py-2 text-sm font-medium"
        >
          {busy ? "Saving…" : "Set password"}
        </button>
      </form>
    </div>
  );
}
