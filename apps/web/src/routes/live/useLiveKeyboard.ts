import { useEffect } from "react";

// Live-page keyboard map. Inert while typing / with modifiers held /
// while the enlarged modal is open (Dialog owns Esc; the modal owns f).
//
//   arrows  move the roving tile focus (up/down also swap the Focus
//           layout's focused camera)
//   Enter   enlarge the focused tile
//   Esc     clear tile focus
//   s       toggle stats
//   f       fullscreen (wall layout → grid fullscreen)
//   1-9     enlarge the Nth visible camera
export function useLiveKeyboard(opts: {
  enabled: boolean;
  visibleIds: string[];
  cols: number;
  kbFocusId: string | null;
  setKbFocusId: (id: string | null) => void;
  focusLayout: boolean;
  setFocusCam: (id: string) => void;
  onEnlarge: (id: string) => void;
  onToggleStats: () => void;
  onFullscreen?: () => void;
}) {
  const {
    enabled, visibleIds, cols, kbFocusId, setKbFocusId,
    focusLayout, setFocusCam, onEnlarge, onToggleStats, onFullscreen,
  } = opts;

  useEffect(() => {
    if (!enabled) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      const t = e.target as HTMLElement | null;
      if (t && t.closest("input,textarea,select,[contenteditable=true]")) return;

      const idx = kbFocusId ? visibleIds.indexOf(kbFocusId) : -1;
      const move = (delta: number) => {
        e.preventDefault();
        const next = idx === -1
          ? 0
          : Math.max(0, Math.min(visibleIds.length - 1, idx + delta));
        const id = visibleIds[next];
        if (!id) return;
        setKbFocusId(id);
        if (focusLayout) setFocusCam(id);
      };

      switch (e.key) {
        case "ArrowLeft": move(-1); break;
        case "ArrowRight": move(1); break;
        case "ArrowUp": move(-cols); break;
        case "ArrowDown": move(cols); break;
        case "Enter":
          if (kbFocusId) {
            e.preventDefault();
            onEnlarge(kbFocusId);
          }
          break;
        case "Escape":
          setKbFocusId(null);
          break;
        case "s":
          onToggleStats();
          break;
        case "f":
          onFullscreen?.();
          break;
        default: {
          const n = Number(e.key);
          if (n >= 1 && n <= 9 && visibleIds[n - 1]) {
            onEnlarge(visibleIds[n - 1]);
          }
        }
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [enabled, visibleIds, cols, kbFocusId, setKbFocusId, focusLayout, setFocusCam, onEnlarge, onToggleStats, onFullscreen]);
}
