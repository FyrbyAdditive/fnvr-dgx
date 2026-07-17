import type { Camera } from "@/lib/api";

// Pure grid-layout helpers, unit-tested in layouts.test.ts.

// The column ladder: deterministic tile placement by visible count.
// (auto-fill minmax was considered and rejected — with a fixed camera
// fleet a predictable ladder beats responsive tile-count surprises.)
export function gridColsForCount(n: number): string {
  if (n <= 1) return "grid-cols-1";
  if (n <= 4) return "grid-cols-2";
  if (n <= 9) return "grid-cols-3";
  return "grid-cols-4";
}

export function gridColCount(n: number): number {
  if (n <= 1) return 1;
  if (n <= 4) return 2;
  if (n <= 9) return 3;
  return 4;
}

// applyOrder sorts cameras by the saved id order; ids not in the list
// append in server order (new cameras land at the end, stale saved ids
// are simply ignored).
export function applyOrder(cameras: Camera[], order: string[]): Camera[] {
  if (order.length === 0) return cameras;
  const rank = new Map(order.map((id, i) => [id, i]));
  return [...cameras].sort((a, b) => {
    const ra = rank.get(a.id);
    const rb = rank.get(b.id);
    if (ra !== undefined && rb !== undefined) return ra - rb;
    if (ra !== undefined) return -1;
    if (rb !== undefined) return 1;
    return 0; // both unknown → keep server order (sort is stable)
  });
}

// moveId returns a new id list with `dragged` placed before/after
// `target`. No-op when dragging onto itself. Ids are deduped and
// stale entries survive only if still present in `ids`.
export function moveId(
  ids: string[],
  dragged: string,
  target: string,
  before: boolean,
): string[] {
  if (dragged === target) return ids;
  const without = ids.filter((id) => id !== dragged);
  const ti = without.indexOf(target);
  if (ti === -1) return ids;
  const at = before ? ti : ti + 1;
  return [...without.slice(0, at), dragged, ...without.slice(at)];
}

export function visibleCameras(cameras: Camera[], hidden: string[]): Camera[] {
  if (hidden.length === 0) return cameras;
  const h = new Set(hidden);
  return cameras.filter((c) => !h.has(c.id));
}
