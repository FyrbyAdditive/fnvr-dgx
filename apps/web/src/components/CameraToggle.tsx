import { useState } from "react";
import { useQueryClient } from "@tanstack/react-query";
import { api } from "../lib/api";
import { useToast } from "./ui/Toast";

type Variant = "overlay" | "inline";

export function CameraToggle({
  cameraId,
  enabled,
  onChange,
  variant = "inline",
}: {
  cameraId: string;
  enabled: boolean;
  onChange?: (next: boolean) => void;
  variant?: Variant;
}) {
  const qc = useQueryClient();
  const toast = useToast();
  const [busy, setBusy] = useState(false);
  const [local, setLocal] = useState(enabled);
  const effective = busy ? local : enabled;

  async function toggle(e: React.MouseEvent) {
    e.stopPropagation();
    e.preventDefault();
    if (busy) return;
    const next = !effective;
    setLocal(next);
    setBusy(true);
    try {
      if (next) await api.enableCamera(cameraId);
      else await api.disableCamera(cameraId);
      qc.invalidateQueries({ queryKey: ["cameras"] });
      onChange?.(next);
    } catch (err) {
      setLocal(!next);
      toast.error(
        `Failed to ${next ? "enable" : "disable"} camera: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      setBusy(false);
    }
  }

  const label = effective ? "on" : "off";
  const dot = effective ? "bg-green-500" : "bg-neutral-500";
  const base =
    "inline-flex items-center gap-1.5 text-xs rounded disabled:opacity-50";
  const chrome =
    variant === "overlay"
      ? "bg-black/60 hover:bg-black/80 text-neutral-100 px-2 py-1 backdrop-blur-sm"
      : "bg-neutral-800 hover:bg-neutral-700 text-neutral-200 px-2 py-1 border border-neutral-700";

  return (
    <button
      type="button"
      onClick={toggle}
      disabled={busy}
      title={effective ? "disable camera" : "enable camera"}
      className={`${base} ${chrome}`}
    >
      <span className={`inline-block w-2 h-2 rounded-full ${dot}`} />
      <span>{label}</span>
    </button>
  );
}
