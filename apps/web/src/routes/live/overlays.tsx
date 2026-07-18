import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { api, fetchDetectionClasses } from "@/lib/api";
import { DetectionEvent } from "@/lib/events";

// Detection-overlay building blocks shared by the Live tiles, the
// enlarged modal, and the Timeline player (PlayerOverlay imports BBox +
// FlagPopover). Moved verbatim out of Live.tsx — signatures are a
// compatibility contract; Live.tsx re-exports them.

export function BBox({
  d,
  highlighted,
  onPick,
}: {
  d: DetectionEvent;
  highlighted?: boolean;
  /** Non-nullable enables pointer events + hover + click-to-flag. */
  onPick?: () => void;
}) {
  const isPlate = d.kind === "anpr";
  const isFace = d.kind === "face";
  const isPrintDefect = d.kind === "print_defect";
  const person = isFace ? d.attributes?.person : undefined;
  // Fixed-colour boxes for the special detectors so they stand apart
  // from the COCO palette: green for plates, sky-blue for matched
  // faces. Unmatched faces fall back to the class-palette "face".
  // Highlighted box (operator clicked it) gets an amber border so it
  // stands out above everything else.
  const color = highlighted
    ? "#fbbf24"
    : isPlate
    ? "#22c55e"
    : isPrintDefect
    ? "#f97316"
    : person
    ? "#38bdf8"
    : colorForClass(d.class_name);
  const style: React.CSSProperties = {
    position: "absolute",
    left: `${d.bbox.x * 100}%`,
    top: `${d.bbox.y * 100}%`,
    width: `${d.bbox.w * 100}%`,
    height: `${d.bbox.h * 100}%`,
    border: `${highlighted ? 3 : 2}px solid ${color}`,
    boxShadow: `0 0 0 1px rgba(0,0,0,0.5)`,
    // Only bboxes an operator can act on accept pointer events.
    // Everything else stays click-through so WHEP gestures reach the
    // video underneath.
    pointerEvents: onPick ? "auto" : "none",
    cursor: onPick ? "pointer" : "default",
  };
  // Label priority: plate text → matched-person name + similarity →
  // class + detection confidence.
  let label: string;
  if (isPlate) {
    label = d.attributes?.plate ?? "plate";
  } else if (person) {
    const sim = d.attributes?.similarity;
    label = sim
      ? `${person} ${Math.round(Number(sim) * 100)}%`
      : person;
  } else {
    label = `${d.class_name} ${(d.confidence * 100).toFixed(0)}%`;
  }
  return (
    <div
      style={style}
      onClick={onPick ? (e) => { e.stopPropagation(); onPick(); } : undefined}
      title={onPick ? "Flag this detection" : undefined}
    >
      <div
        className="absolute top-0 left-0 text-[10px] px-1 font-medium leading-tight tabular-nums"
        style={{ background: color, color: "#000", transform: "translateY(-100%)" }}
      >
        {label}
      </div>
    </div>
  );
}

// Stable per-class colours. A hash of the class name gives consistent
// colours across sessions without needing a lookup table.
export function colorForClass(cls: string): string {
  let h = 0;
  for (let i = 0; i < cls.length; i++) h = (h * 31 + cls.charCodeAt(i)) & 0xffffff;
  const hue = h % 360;
  return `hsl(${hue}, 85%, 55%)`;
}

// FlagPopover floats near the clicked bbox inside the CameraTile and
// lets the operator mark the detection as a false positive or relabel
// it. Either choice hits `POST /detections/{event_id}/flag` via the
// api client; on success the popover closes and the caller's state
// unfreezes the bbox overlay.
export function FlagPopover({
  detection,
  onClose,
}: {
  detection: DetectionEvent;
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Close on Escape. Mouse-outside is handled by a full-tile
  // invisible overlay behind the popover so the main Live click
  // handlers on the video layer aren't disturbed.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  // Auto-close after 15 s so an abandoned popover doesn't wedge the
  // tile forever.
  useEffect(() => {
    const t = setTimeout(onClose, 15000);
    return () => clearTimeout(t);
  }, [onClose]);

  async function submit(classCorrected: string | null) {
    setSubmitting(true);
    setError(null);
    try {
      // Prefer pg_id — unambiguous and avoids the event_id→row race
      // on freshly-published detections. Fall back to event_id for
      // builds that haven't shipped pg_id yet on the SSE stream.
      const key = detection.pg_id != null ? String(detection.pg_id) : detection.id;
      await api.flagDetection(key, classCorrected);
      onClose();
    } catch (e) {
      setError((e as Error).message || "flag failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Position relative to the bbox: anchor the popover just below the
  // box, clamped to the tile. Popover uses absolute% so it scales
  // with the tile.
  const left = `${Math.max(0, Math.min(70, detection.bbox.x * 100))}%`;
  const top = `${Math.min(90, (detection.bbox.y + detection.bbox.h) * 100)}%`;

  return (
    <>
      {/* Click-outside overlay. Captures the click so it doesn't
          reach the WHEP video. */}
      <div
        className="absolute inset-0 z-10"
        style={{ background: "rgba(0,0,0,0.25)" }}
        onClick={onClose}
      />
      <div
        className="absolute z-20 bg-neutral-900 border border-neutral-700 rounded p-2 text-xs shadow-xl min-w-[14rem]"
        style={{ left, top, transform: "translate(0, 0.25rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-neutral-400 mb-2">
          Flag <span className="font-medium text-neutral-200">{detection.class_name}</span> on this camera?
        </div>
        <div className="space-y-1">
          <button
            className="w-full text-left px-2 py-1 rounded bg-red-900/60 hover:bg-red-800 disabled:opacity-50"
            disabled={submitting}
            onClick={() => submit(null)}
          >
            False positive — suppress future matches
          </button>
          <RelabelPicker
            currentClass={detection.class_name}
            disabled={submitting}
            onPick={submit}
          />
        </div>
        {error && <div className="text-red-400 mt-2">{error}</div>}
        <div className="text-neutral-500 text-[10px] mt-2">
          Esc or click outside to cancel.
        </div>
      </div>
    </>
  );
}

// RelabelPicker fetches the enabled detection_classes list and renders
// a clickable grid. Disabled / unknown classes are filtered out so the
// user can't relabel into a class the trained model wouldn't emit.
function RelabelPicker({
  currentClass,
  disabled,
  onPick,
}: {
  currentClass: string;
  disabled: boolean;
  onPick: (slug: string) => void;
}) {
  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const options = classes
    .filter((c) => c.enabled && c.slug !== currentClass)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));
  return (
    <details className="px-1">
      <summary className="cursor-pointer text-neutral-400 hover:text-neutral-200 py-1">
        Relabel as…
      </summary>
      <div className="max-h-40 overflow-auto mt-1 grid grid-cols-2 gap-1">
        {isLoading && <div className="text-neutral-500">loading…</div>}
        {!isLoading && options.length === 0 && (
          <div className="text-neutral-500 col-span-2">
            no other enabled classes — manage in Settings → Classes
          </div>
        )}
        {options.map((c) => (
          <button
            key={c.slug}
            className="text-left px-1 py-0.5 rounded hover:bg-neutral-800 disabled:opacity-50"
            disabled={disabled}
            onClick={() => onPick(c.slug)}
          >
            {c.display_name}
          </button>
        ))}
      </div>
    </details>
  );
}

// ManualLabelPopover anchors below the user-drawn rect and asks for a
// class. On submit it POSTs to /api/v1/flags/manual which captures the
// camera's most recent live JPEG and writes a YOLO training row.
export function ManualLabelPopover({
  cameraId,
  bbox,
  onClose,
}: {
  cameraId: string;
  bbox: { x: number; y: number; w: number; h: number };
  onClose: () => void;
}) {
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const { data: classes = [], isLoading } = useQuery({
    queryKey: ["detection-classes"],
    queryFn: fetchDetectionClasses,
  });
  const enabled = classes
    .filter((c) => c.enabled)
    .sort((a, b) => a.display_name.localeCompare(b.display_name));

  // Esc / click-outside cancel — same affordance as FlagPopover.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function submit(slug: string) {
    setSubmitting(true);
    setError(null);
    try {
      await api.flagManual({ camera_id: cameraId, bbox, class: slug });
      onClose();
    } catch (e) {
      setError((e as Error).message || "manual label failed");
    } finally {
      setSubmitting(false);
    }
  }

  // Anchor the popover just under the drawn box, clamped inside the
  // tile so it never escapes off the right edge.
  const left = `${Math.max(0, Math.min(70, bbox.x * 100))}%`;
  const top = `${Math.min(90, (bbox.y + bbox.h) * 100)}%`;

  return (
    <>
      <div
        className="absolute inset-0 z-10"
        style={{ background: "rgba(0,0,0,0.25)" }}
        onClick={onClose}
      />
      {/* Re-render the locked rect so it stays visible while choosing. */}
      <div
        className="absolute pointer-events-none border-2 border-emerald-400 bg-emerald-400/10 z-10"
        style={{
          left: `${bbox.x * 100}%`,
          top: `${bbox.y * 100}%`,
          width: `${bbox.w * 100}%`,
          height: `${bbox.h * 100}%`,
        }}
      />
      <div
        className="absolute z-20 bg-neutral-900 border border-neutral-700 rounded p-2 text-xs shadow-xl min-w-[14rem]"
        style={{ left, top, transform: "translate(0, 0.25rem)" }}
        onClick={(e) => e.stopPropagation()}
      >
        <div className="text-neutral-400 mb-2">
          Label this box as…
        </div>
        <div className="max-h-56 overflow-auto grid grid-cols-2 gap-1">
          {isLoading && <div className="text-neutral-500">loading…</div>}
          {!isLoading && enabled.length === 0 && (
            <div className="text-neutral-500 col-span-2">
              no enabled classes — add one in Settings → Detection classes
            </div>
          )}
          {enabled.map((c) => (
            <button
              key={c.slug}
              className="text-left px-1 py-0.5 rounded hover:bg-neutral-800 disabled:opacity-50"
              disabled={submitting}
              onClick={() => submit(c.slug)}
            >
              {c.display_name}
            </button>
          ))}
        </div>
        {error && <div className="text-red-400 mt-2">{error}</div>}
        <div className="text-neutral-500 text-[10px] mt-2">
          Esc or click outside to cancel.
        </div>
      </div>
    </>
  );
}
