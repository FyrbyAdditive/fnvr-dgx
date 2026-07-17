import { useCallback, useMemo, useRef } from "react";
import { useSearchParams } from "react-router-dom";
import { useMe } from "@/lib/me";
import { useConfirm } from "@/components/ui/ConfirmDialog";
import { SettingsDirtyContext } from "./dirty";
import { DetectionTab } from "./DetectionTab";
import { UsersTab } from "./UsersTab";
import { IntegrationsTab } from "./IntegrationsTab";
import { SystemTab } from "./SystemTab";

// Settings shell: four URL-addressable tabs over cards with uniform
// draft/Save semantics. Cards report dirty state through
// SettingsDirtyContext so switching tabs with unsaved changes prompts
// first (the tab content unmounts, which would silently drop drafts).

type TabKey = "detection" | "users" | "integrations" | "system";

const TABS: { key: TabKey; label: string; adminOnly?: boolean }[] = [
  { key: "detection", label: "Detection" },
  { key: "users", label: "Users & access", adminOnly: true },
  { key: "integrations", label: "Integrations" },
  { key: "system", label: "System" },
];

export function Settings() {
  const { data: me } = useMe();
  const isAdmin = !!me?.is_admin;
  const [searchParams, setSearchParams] = useSearchParams();
  const confirm = useConfirm();

  const visibleTabs = TABS.filter((t) => isAdmin || !t.adminOnly);
  const requested = searchParams.get("tab") as TabKey | null;
  const tab: TabKey = visibleTabs.some((t) => t.key === requested)
    ? (requested as TabKey)
    : "detection";

  // Dirty registry — a plain ref map, no re-renders needed; the guard
  // only reads it at the moment of a tab switch.
  const dirtyMap = useRef(new Map<string, boolean>());
  const report = useCallback((id: string, dirty: boolean) => {
    if (dirty) dirtyMap.current.set(id, true);
    else dirtyMap.current.delete(id);
  }, []);
  const anyDirty = useCallback(() => dirtyMap.current.size > 0, []);
  const dirtyCtx = useMemo(() => ({ report, anyDirty }), [report, anyDirty]);

  const switchTab = async (next: TabKey) => {
    if (next === tab) return;
    if (anyDirty()) {
      const ok = await confirm({
        title: "Discard unsaved changes?",
        body: "This tab has unsaved changes that will be lost.",
        confirmLabel: "Discard",
        tone: "danger",
      });
      if (!ok) return;
    }
    setSearchParams({ tab: next });
  };

  return (
    <SettingsDirtyContext.Provider value={dirtyCtx}>
      <div className="p-4 max-w-4xl">
        <div className="flex items-center gap-3 mb-3">
          <h1 className="text-lg font-semibold">Settings</h1>
          {!isAdmin && (
            <span className="text-xs bg-neutral-800 text-neutral-400 rounded px-2 py-0.5">
              read-only
            </span>
          )}
        </div>

        <div className="flex gap-1 border-b border-neutral-800 mb-4">
          {visibleTabs.map((t) => (
            <button
              key={t.key}
              onClick={() => switchTab(t.key)}
              className={`px-3 py-1.5 text-sm rounded-t-md ${
                t.key === tab
                  ? "bg-neutral-900 text-neutral-100 border border-neutral-800 border-b-transparent -mb-px"
                  : "text-neutral-400 hover:text-neutral-200"
              }`}
            >
              {t.label}
            </button>
          ))}
        </div>

        <div className="space-y-4">
          {tab === "detection" && <DetectionTab isAdmin={isAdmin} />}
          {tab === "users" && isAdmin && <UsersTab />}
          {tab === "integrations" && <IntegrationsTab isAdmin={isAdmin} />}
          {tab === "system" && <SystemTab isAdmin={isAdmin} />}
        </div>
      </div>
    </SettingsDirtyContext.Provider>
  );
}
