import { FormEvent, useState } from "react";
import { useNavigate } from "react-router-dom";

export function Login() {
  const nav = useNavigate();
  const [username, setU] = useState("admin");
  const [password, setP] = useState("");
  const [err, setErr] = useState("");
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setErr("");
    setBusy(true);
    try {
      const res = await fetch("/api/v1/auth/login", {
        method: "POST",
        credentials: "include",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ username, password }),
      });
      if (!res.ok) {
        setErr("Invalid credentials");
        return;
      }
      nav("/live");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-full grid place-items-center p-6">
      <form onSubmit={submit} className="w-full max-w-sm space-y-3 border border-neutral-800 rounded p-6 bg-neutral-900/40">
        <div className="text-lg font-semibold">fnvr</div>
        <input className="w-full bg-neutral-900 rounded px-3 py-2 text-sm"
          value={username} onChange={(e) => setU(e.target.value)} placeholder="username" autoFocus />
        <input className="w-full bg-neutral-900 rounded px-3 py-2 text-sm"
          value={password} onChange={(e) => setP(e.target.value)} placeholder="password" type="password" />
        {err && <div className="text-red-400 text-sm">{err}</div>}
        <button className="w-full bg-blue-600 hover:bg-blue-500 rounded px-3 py-2 text-sm"
          type="submit" disabled={busy}>{busy ? "…" : "Sign in"}</button>
        <div className="text-xs text-neutral-500 pt-2">
          First run default: <code>admin / admin</code>. Change it in Settings.
        </div>
      </form>
    </div>
  );
}
