import { useState } from "react";

// All Live-page preferences, persisted per browser under fnvr.live.*.
// Every read/write is try/catch'd (sandboxed iframes throw on
// localStorage) and bad JSON falls back to the default.

export type LiveLayout = "auto" | "focus" | "wall";
export type FocusQuality = "proxy" | "full";
export type ModalQuality = "auto" | "full" | "proxy";

export type LivePrefs = {
  showStats: boolean;
  layout: LiveLayout;
  /** Camera-id tile order; unknown ids append in server order. */
  order: string[];
  /** Camera ids hidden from the grid. */
  hidden: string[];
  /** Focused camera in the Focus layout ("" = first visible). */
  focusCam: string;
  focusQuality: FocusQuality;
  modalQuality: ModalQuality;
};

function read<T>(key: string, def: T, parse: (raw: string) => T): T {
  try {
    const raw = localStorage.getItem(key);
    if (raw === null) return def;
    return parse(raw);
  } catch {
    return def;
  }
}

function write(key: string, raw: string) {
  try {
    localStorage.setItem(key, raw);
  } catch {
    /* sandboxed iframe, no-op */
  }
}

function readStringArray(key: string): string[] {
  return read(key, [] as string[], (raw) => {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((x) => typeof x === "string") : [];
  });
}

export function useLivePrefs() {
  const [prefs, setPrefs] = useState<LivePrefs>(() => ({
    showStats: read("fnvr.live.showStats", false, (r) => r === "1"),
    layout: read("fnvr.live.layout", "auto" as LiveLayout, (r) =>
      r === "focus" || r === "wall" ? r : "auto",
    ),
    order: readStringArray("fnvr.live.order"),
    hidden: readStringArray("fnvr.live.hidden"),
    focusCam: read("fnvr.live.focusCam", "", (r) => r),
    focusQuality: read("fnvr.live.focusQuality", "proxy" as FocusQuality, (r) =>
      r === "full" ? "full" : "proxy",
    ),
    modalQuality: read("fnvr.live.modalQuality", "auto" as ModalQuality, (r) =>
      r === "full" || r === "proxy" ? r : "auto",
    ),
  }));

  const patch = (p: Partial<LivePrefs>) => setPrefs((cur) => ({ ...cur, ...p }));

  return {
    prefs,
    setShowStats: (v: boolean) => {
      write("fnvr.live.showStats", v ? "1" : "0");
      patch({ showStats: v });
    },
    setLayout: (v: LiveLayout) => {
      write("fnvr.live.layout", v);
      patch({ layout: v });
    },
    setOrder: (ids: string[]) => {
      write("fnvr.live.order", JSON.stringify(ids));
      patch({ order: ids });
    },
    toggleHidden: (id: string) => {
      setPrefs((cur) => {
        const hidden = cur.hidden.includes(id)
          ? cur.hidden.filter((h) => h !== id)
          : [...cur.hidden, id];
        write("fnvr.live.hidden", JSON.stringify(hidden));
        return { ...cur, hidden };
      });
    },
    showAllHidden: () => {
      write("fnvr.live.hidden", "[]");
      patch({ hidden: [] });
    },
    setFocusCam: (id: string) => {
      write("fnvr.live.focusCam", id);
      patch({ focusCam: id });
    },
    setFocusQuality: (v: FocusQuality) => {
      write("fnvr.live.focusQuality", v);
      patch({ focusQuality: v });
    },
    setModalQuality: (v: ModalQuality) => {
      write("fnvr.live.modalQuality", v);
      patch({ modalQuality: v });
    },
  };
}
