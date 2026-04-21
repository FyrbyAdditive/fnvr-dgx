import { NavLink, Outlet, Link } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const tabs = [
  { to: "/live", label: "Live" },
  { to: "/events", label: "Events" },
  { to: "/cameras", label: "Cameras" },
  { to: "/rules", label: "Rules" },
  { to: "/timeline", label: "Timeline" },
  { to: "/plates", label: "Plates" },
  { to: "/faces", label: "Faces" },
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
        <div className="ml-auto text-xs text-neutral-500">
          {info ? `${info.milestone} · ${info.version}` : ""}
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
