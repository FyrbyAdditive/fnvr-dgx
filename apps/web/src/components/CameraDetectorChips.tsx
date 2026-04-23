import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";

type Variant = "overlay" | "inline";

const KINDS: { value: string; label: string; title: string }[] = [
  { value: "object", label: "obj", title: "object detection" },
  { value: "anpr", label: "anpr", title: "number plates (ANPR)" },
  { value: "face", label: "face", title: "face ID" },
];

export function CameraDetectorChips({
  cameraId,
  enabledDetectors,
  disabled,
  variant = "inline",
}: {
  cameraId: string;
  enabledDetectors: string[];
  disabled?: boolean;
  variant?: Variant;
}) {
  const qc = useQueryClient();
  const [busy, setBusy] = useState(false);
  // Encoding of the stored enabled_detectors array:
  //   []          → all detectors enabled (legacy default, survives
  //                 adding new detector families later)
  //   ["none"]    → no detectors enabled (explicit opt-out)
  //   otherwise   → whitelist of kinds
  // Normalise up front so the rest of the component works with a
  // concrete set of real kinds only.
  const isNone = enabledDetectors?.length === 1 && enabledDetectors[0] === "none";
  const resolved = isNone
    ? new Set<string>()
    : !enabledDetectors || enabledDetectors.length === 0
      ? new Set(KINDS.map((k) => k.value))
      : new Set(enabledDetectors.filter((k) => k !== "none"));
  const [optimistic, setOptimistic] = useState<Set<string> | null>(null);
  const effective = optimistic ?? resolved;

  async function toggle(kind: string, e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy || disabled) return;
    const next = new Set(effective);
    if (next.has(kind)) next.delete(kind);
    else next.add(kind);
    // Encode:
    //   all real kinds selected → [] (all, forward-compatible default)
    //   zero real kinds selected → ["none"] (explicit opt-out)
    //   subset → the explicit list
    const arr =
      next.size === KINDS.length ? [] : next.size === 0 ? ["none"] : Array.from(next);
    setOptimistic(next);
    setBusy(true);
    try {
      await api.updateCameraDetectors(cameraId, { enabled_detectors: arr });
      qc.invalidateQueries({ queryKey: ["cameras"] });
    } catch (err) {
      setOptimistic(null);
      alert(`failed to update detectors: ${err instanceof Error ? err.message : String(err)}`);
    } finally {
      setBusy(false);
      // Clear optimistic so it re-reads the server truth once the
      // invalidated query settles.
      setOptimistic(null);
    }
  }

  const base =
    "text-[10px] rounded px-1.5 py-0.5 font-medium disabled:opacity-40 disabled:cursor-not-allowed";
  const chrome =
    variant === "overlay"
      ? "backdrop-blur-sm border"
      : "border";

  return (
    <div className="inline-flex gap-1">
      {KINDS.map((k) => {
        const active = effective.has(k.value);
        const colors = active
          ? variant === "overlay"
            ? "bg-emerald-600/80 border-emerald-500/70 text-white"
            : "bg-emerald-700 border-emerald-600 text-white"
          : variant === "overlay"
            ? "bg-black/60 border-neutral-600 text-neutral-400 hover:text-neutral-100"
            : "bg-neutral-900 border-neutral-700 text-neutral-500 hover:text-neutral-200";
        return (
          <button
            key={k.value}
            type="button"
            onClick={(e) => toggle(k.value, e)}
            disabled={busy || disabled}
            title={`${active ? "disable" : "enable"} ${k.title}`}
            className={`${base} ${chrome} ${colors}`}
          >
            {k.label}
          </button>
        );
      })}
    </div>
  );
}
