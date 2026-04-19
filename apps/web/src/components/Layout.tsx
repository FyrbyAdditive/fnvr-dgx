import { NavLink, Outlet } from "react-router-dom";
import { useQuery } from "@tanstack/react-query";
import { api } from "@/lib/api";

const tabs = [
  { to: "/live", label: "Live" },
  { to: "/events", label: "Events" },
  { to: "/cameras", label: "Cameras" },
  { to: "/rules", label: "Rules" },
  { to: "/timeline", label: "Timeline" },
  { to: "/settings", label: "Settings" },
];

export function Layout() {
  const { data: info } = useQuery({
    queryKey: ["info"],
    queryFn: api.systemInfo,
    staleTime: 60_000,
  });
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
      <main className="flex-1 overflow-auto">
        <Outlet />
      </main>
    </div>
  );
}
