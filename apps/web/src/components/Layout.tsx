import { NavLink, Outlet, Link } from "react-router-dom";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useRef, useState } from "react";
import { api, AlarmStateValue } from "@/lib/api";
import { useMe, isAdmin as isAdminFn } from "@/lib/me";

const tabs = [
  { to: "/live", label: "Live" },
  { to: "/events", label: "Events" },
  { to: "/cameras", label: "Cameras" },
  { to: "/rules", label: "Rules" },
  { to: "/timeline", label: "Timeline" },
  { to: "/plates", label: "Plates" },
  { to: "/faces", label: "Faces" },
  { to: "/flags", label: "Flags" },
  { to: "/storage", label: "Storage" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  const { data: info } = useQuery({
    queryKey: ["info"],
    queryFn: api.systemInfo,
    staleTime: 60_000,
  });
  const { data: pipelineState } = useQuery({
    queryKey: ["pipeline-state"],
    queryFn: api.getPipelineState,
    refetchInterval: 3_000,
  });
  const ps = pipelineState?.state;
  const showBanner = ps && ps.state !== "ready" && ps.state !== "unknown";

  return (
    <div className="flex flex-col h-full">
      <header className="border-b border-neutral-800 px-6 py-3 flex items-center gap-6">
        <div className="font-semibold tracking-tight">fnvr</div>
        <nav className="flex gap-1">
          {tabs.map((t) => (
            <NavLink
              key={t.to}
              to={t.to}
              className={({ isActive }) =>
                `px-3 py-1.5 rounded text-sm ${
                  isActive
                    ? "bg-neutral-800 text-white"
                    : "text-neutral-400 hover:text-white hover:bg-neutral-900"
                }`
              }
            >
              {t.label}
            </NavLink>
          ))}
        </nav>
        <div className="ml-auto flex items-center gap-4">
          <AlarmPill />
          <div className="text-xs text-neutral-500">
            {info ? `${info.milestone} · ${info.version}` : ""}
          </div>
        </div>
      </header>
      {showBanner && ps && (
        <Link
          to="/settings"
          className={`px-6 py-2 text-sm flex items-center gap-3 ${
            ps.state === "failed"
              ? "bg-red-900/60 text-red-100"
              : "bg-amber-900/60 text-amber-100"
          }`}
        >
          {ps.state !== "failed" && (
            <span className="inline-block w-2 h-2 rounded-full bg-amber-300 animate-pulse" />
          )}
          <span>
            {ps.message ??
              (ps.state === "calibrating"
                ? "Calibrating INT8…"
                : ps.state === "compiling_engine"
                ? "Building TensorRT engine…"
                : `Pipeline ${ps.state}`)}
          </span>
          {ps.variant && <span className="opacity-70">({ps.variant} · {ps.precision})</span>}
          <span className="ml-auto underline opacity-80">Settings →</span>
        </Link>
      )}
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}

// AlarmPill shows the current global alarm state in the top bar. Admins
// can click to change; viewers see a read-only indicator. The pill
// reads via react-query (poll every 10s so a state flip made from
// another session or via curl shows up) and updates optimistically.
const ALARM_OPTIONS: Array<{ value: AlarmStateValue; label: string; emoji: string; color: string }> = [
  { value: "disarmed", label: "disarmed", emoji: "🔓", color: "text-neutral-400" },
  { value: "home", label: "home", emoji: "🏠", color: "text-emerald-400" },
  { value: "away", label: "away", emoji: "🚪", color: "text-amber-400" },
];

function AlarmPill() {
  const qc = useQueryClient();
  const { data: me } = useMe();
  const admin = isAdminFn(me);
  const { data: alarm } = useQuery({
    queryKey: ["alarm"],
    queryFn: api.getAlarm,
    refetchInterval: 10_000,
    staleTime: 2_000,
  });
  const mut = useMutation({
    mutationFn: (state: AlarmStateValue) => api.updateAlarm({ state }),
    onSuccess: () => qc.invalidateQueries({ queryKey: ["alarm"] }),
  });
  const [open, setOpen] = useState(false);
  const ref = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (!open) return;
    const onDoc = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener("mousedown", onDoc);
    return () => document.removeEventListener("mousedown", onDoc);
  }, [open]);

  const current = alarm?.state ?? "disarmed";
  const meta = ALARM_OPTIONS.find((o) => o.value === current) ?? ALARM_OPTIONS[0];

  return (
    <div className="relative" ref={ref}>
      <button
        type="button"
        disabled={!admin}
        onClick={() => admin && setOpen((v) => !v)}
        className={`text-xs rounded px-2 py-1 border border-neutral-700 bg-neutral-900 hover:bg-neutral-800 disabled:cursor-default disabled:hover:bg-neutral-900 flex items-center gap-1.5 ${meta.color}`}
        title={admin ? "change alarm state" : `alarm: ${current}`}
      >
        <span aria-hidden>{meta.emoji}</span>
        <span className="font-medium">{meta.label}</span>
      </button>
      {open && admin && (
        <div className="absolute right-0 mt-1 w-36 rounded border border-neutral-700 bg-neutral-900 shadow-lg z-20">
          {ALARM_OPTIONS.map((o) => (
            <button
              key={o.value}
              type="button"
              onClick={() => {
                setOpen(false);
                if (o.value !== current) mut.mutate(o.value);
              }}
              className={`w-full text-left text-xs px-3 py-2 flex items-center gap-2 hover:bg-neutral-800 ${
                o.value === current ? "font-semibold" : ""
              } ${o.color}`}
            >
              <span aria-hidden>{o.emoji}</span>
              <span>{o.label}</span>
              {o.value === current && <span className="ml-auto text-neutral-500">✓</span>}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
