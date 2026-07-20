import { Segment } from "@/lib/api";

// Pure time helpers for the Timeline page. Everything works in
// "ms into the local day" — the ruler's native coordinate — with
// dayRange() providing the absolute anchors.

export function todayKey(): string {
  return dayKeyFrom(new Date());
}

export function dayKeyFrom(d: Date): string {
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

export function pad(n: number): string {
  return n < 10 ? `0${n}` : `${n}`;
}

/** Local-midnight bounds of a YYYY-MM-DD key. On DST-transition days
 *  the span is 23h or 25h — callers must measure with dayRangeMs, not
 *  assume 24h. */
export function dayRange(key: string): { from: Date; to: Date } {
  const [y, m, d] = key.split("-").map(Number);
  const from = new Date(y, m - 1, d, 0, 0, 0, 0);
  const to = new Date(y, m - 1, d + 1, 0, 0, 0, 0);
  return { from, to };
}

export function dayRangeMs(from: Date, to: Date): number {
  return to.getTime() - from.getTime();
}

/** Render an ms-into-day value as local HH:MM (zoom chip). */
export function msToHHMM(ms: number): string {
  const totalMin = Math.floor(ms / 60_000);
  const h = Math.floor(totalMin / 60);
  const m = totalMin % 60;
  return `${pad(h)}:${pad(m)}`;
}

/** Render an ms-into-day value as local HH:MM:SS (hover readout). */
export function msToHHMMSS(ms: number): string {
  const totalSec = Math.floor(ms / 1000);
  const s = totalSec % 60;
  return `${msToHHMM(ms)}:${pad(s)}`;
}

/** Hour gridline ticks for [from, to], as ms offsets into the day.
 *  Iterates real wall-clock hours instead of assuming h*3600000 from
 *  midnight, so DST days come out right: a fall-back day yields 26
 *  ticks with a repeated hour label, spring-forward 24. The final
 *  tick (= next local midnight) is labelled "24". */
export function hourTicks(from: Date, to: Date): { ms: number; label: string }[] {
  const out: { ms: number; label: string }[] = [];
  const fromMs = from.getTime();
  const toMs = to.getTime();
  for (let t = fromMs; t <= toMs; t += 3_600_000) {
    out.push({
      ms: t - fromMs,
      label: t === toMs ? "24" : pad(new Date(t).getHours()),
    });
  }
  return out;
}

export function clampFrac(f: number): number {
  return Math.max(0, Math.min(1, f));
}

/** Map a fraction of the visible window to ms-into-day. */
export function fracToMs(frac: number, visFromMs: number, visMs: number): number {
  return visFromMs + clampFrac(frac) * visMs;
}

/** Map ms-into-day to a percentage across the visible window; null
 *  when outside (caller skips rendering). */
export function msToPct(ms: number, visFromMs: number, visMs: number): number | null {
  if (ms < visFromMs || ms > visFromMs + visMs) return null;
  return ((ms - visFromMs) / visMs) * 100;
}

// estimateDurMs is a last-resort fallback when a segment has neither
// ended_at nor duration_ms (storage-manager now tracks both from file
// mtime, so this almost never runs). Matches the pipeline's H.264
// encoder bitrate — 6 Mbps ≈ 750 KB/s → bytes/750000 ≈ seconds.
export function estimateDurMs(s: Segment): number {
  if (!s.bytes) return 60_000;
  const sec = Math.min(3600, Math.max(10, s.bytes / 750_000));
  return sec * 1000;
}

/** Compose a drag selection (fractions of the CURRENT visible window,
 *  in any order) onto the existing zoom, producing the new zoom in
 *  day fractions. Pure so nested-zoom math stays testable. */
export function applyDragZoom(
  zoom: { from: number; to: number },
  a: number,
  b: number,
): { from: number; to: number } {
  const lo = clampFrac(Math.min(a, b));
  const hi = clampFrac(Math.max(a, b));
  const span = zoom.to - zoom.from;
  return { from: zoom.from + lo * span, to: zoom.from + hi * span };
}
