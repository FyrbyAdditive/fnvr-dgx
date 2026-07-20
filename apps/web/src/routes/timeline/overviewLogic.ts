import { DetectionSummary, HistoricDetection, Incident, SummaryBucket } from "@/lib/api";

// Pure helpers for the all-cameras overview mode — vitest-covered.
// Everything here is time-in-ms-into-day and plain data; no React.

export type Span = { startMs: number; endMs: number };

/** Merge spans whose gap is ≤ maxGapMs into contiguous runs. Input
 *  need not be sorted; overlaps collapse. Used to coalesce recording
 *  segments into a handful of coverage strips per lane. */
export function coalesceSpans(spans: Span[], maxGapMs: number): Span[] {
  if (spans.length === 0) return [];
  const sorted = [...spans].sort((a, b) => a.startMs - b.startMs);
  const out: Span[] = [{ ...sorted[0] }];
  for (let i = 1; i < sorted.length; i++) {
    const s = sorted[i];
    const last = out[out.length - 1];
    if (s.startMs - last.endMs <= maxGapMs) {
      last.endMs = Math.max(last.endMs, s.endMs);
    } else {
      out.push({ ...s });
    }
  }
  return out;
}

/** Downsample sparse summary buckets by an integer factor: groups by
 *  floor(i/factor), sums counts, maxes confidence, unions kinds and
 *  re-aggregates top_classes (top 3, count desc then name for
 *  determinism). Output stays sparse and ascending. srcCount is the
 *  ORIGINAL requested bucket count so callers can recompute spans. */
export function mergeSummaryBuckets(
  buckets: SummaryBucket[],
  factor: number,
): SummaryBucket[] {
  if (factor <= 1 || buckets.length === 0) return buckets;
  const groups = new Map<number, SummaryBucket>();
  for (const b of buckets) {
    const g = Math.floor(b.i / factor);
    const cur = groups.get(g);
    if (!cur) {
      groups.set(g, {
        i: g,
        count: b.count,
        max_confidence: b.max_confidence,
        top_classes: b.top_classes.map((c) => ({ ...c })),
        kinds: [...b.kinds],
      });
      continue;
    }
    cur.count += b.count;
    cur.max_confidence = Math.max(cur.max_confidence, b.max_confidence);
    for (const c of b.top_classes) {
      const hit = cur.top_classes.find((x) => x.class === c.class);
      if (hit) hit.count += c.count;
      else cur.top_classes.push({ ...c });
    }
    for (const k of b.kinds) if (!cur.kinds.includes(k)) cur.kinds.push(k);
  }
  const out = [...groups.values()].sort((a, b) => a.i - b.i);
  for (const g of out) {
    g.top_classes.sort((a, b) => b.count - a.count || a.class.localeCompare(b.class));
    g.top_classes = g.top_classes.slice(0, 3);
    g.kinds.sort();
  }
  return out;
}

/** p95 of bucket counts across ALL lanes — the overview normalises
 *  density against the fleet, not per-lane, so a quiet camera reads
 *  quiet next to a busy one. Floor 1 so division is always safe. */
export function fleetP95(all: SummaryBucket[][]): number {
  const counts = all.flat().map((b) => b.count).sort((a, b) => a - b);
  if (counts.length === 0) return 1;
  return Math.max(1, counts[Math.floor(0.95 * (counts.length - 1))]);
}

/** Vertical lane geometry: the top headerPct% is reserved for hour
 *  tick labels, the rest splits evenly across n lanes. */
export function laneGeometry(
  n: number,
  headerPct = 8,
): { topPct: number; heightPct: number }[] {
  if (n <= 0) return [];
  const h = (100 - headerPct) / n;
  return Array.from({ length: n }, (_, i) => ({
    topPct: headerPct + i * h,
    heightPct: h,
  }));
}

/** Inverse of laneGeometry for pointer hit-tests. null in the header
 *  band or out of range. */
export function laneIndexFromYPct(yPct: number, n: number, headerPct = 8): number | null {
  if (n <= 0 || yPct < headerPct || yPct > 100) return null;
  const i = Math.floor(((yPct - headerPct) / (100 - headerPct)) * n);
  return i >= 0 && i < n ? i : null;
}

/** An incident's [start, lastDetection] span in ms-into-day. */
export function incidentSpan(inc: Incident, dayFromMs: number): Span {
  const startMs = new Date(inc.started_at).getTime() - dayFromMs;
  const endMs = new Date(inc.last_detection_at).getTime() - dayFromMs;
  return { startMs, endMs: Math.max(endMs, startMs) };
}

// ---- events digest ------------------------------------------------------

/** A notable detection worth listing in the day-log: matched faces,
 *  plate reads, print-defect sightings. identity drives collapsing. */
export type Notable = {
  d: HistoricDetection;
  msInDay: number;
  /** e.g. "face:tim", "anpr:AB12CDE", "print:spaghetti" */
  identity: string;
  label: string;
  detail: string;
};

/** Classify a raw detection row into a Notable, or null when it isn't
 *  digest-worthy (unmatched faces, raw objects). */
export function toNotable(d: HistoricDetection, dayFromMs: number): Notable | null {
  const msInDay = Date.parse(d.ts) - dayFromMs;
  const attrs = d.attributes ?? {};
  if (d.kind === "face") {
    const person = attrs.person;
    if (!person) return null;
    const sim = attrs.similarity ? ` ${(parseFloat(attrs.similarity) * 100).toFixed(0)}%` : "";
    return { d, msInDay, identity: `face:${person}`, label: person, detail: `face${sim}` };
  }
  if (d.kind === "anpr") {
    const plate = attrs.plate;
    if (!plate) return null;
    return { d, msInDay, identity: `anpr:${plate}`, label: plate, detail: "plate" };
  }
  if (d.kind === "print_defect") {
    return {
      d,
      msInDay,
      identity: `print:${d.class_name}`,
      label: d.class_name === "print_failure" ? "PRINT FAILURE" : "spaghetti sighting",
      detail: `${Math.round(d.confidence * 100)}%`,
    };
  }
  return null;
}

export type CollapsedNotable = Notable & { count: number; lastMsInDay: number };

/** Collapse consecutive notables with the same camera+identity within
 *  gapMs into one row ×N. Input any order; output ascending. */
export function collapseNotables(
  notables: Notable[],
  gapMs = 5 * 60_000,
): CollapsedNotable[] {
  const sorted = [...notables].sort((a, b) => a.msInDay - b.msInDay);
  const out: CollapsedNotable[] = [];
  const openByKey = new Map<string, CollapsedNotable>();
  for (const n of sorted) {
    const key = `${n.d.camera_id}|${n.identity}`;
    const open = openByKey.get(key);
    if (open && n.msInDay - open.lastMsInDay <= gapMs) {
      open.count++;
      open.lastMsInDay = n.msInDay;
      continue;
    }
    const row: CollapsedNotable = { ...n, count: 1, lastMsInDay: n.msInDay };
    openByKey.set(key, row);
    out.push(row);
  }
  return out.sort((a, b) => a.msInDay - b.msInDay);
}

export type DigestRow =
  | { type: "hour"; label: string; ms: number }
  | { type: "incident"; inc: Incident; msInDay: number }
  | { type: "notable"; n: CollapsedNotable };

/** Build the digest for the visible window: incidents overlapping it
 *  + collapsed notables inside it, chronological ascending, with hour
 *  headers (from DST-safe hourTicks output) when the window exceeds
 *  2h. */
export function buildDigest(
  incidents: Incident[],
  notables: CollapsedNotable[],
  dayFromMs: number,
  visFromMs: number,
  visToMs: number,
  ticks: { ms: number; label: string }[],
): DigestRow[] {
  const entries: (DigestRow & { sortMs: number })[] = [];
  for (const inc of incidents) {
    const span = incidentSpan(inc, dayFromMs);
    if (span.endMs < visFromMs || span.startMs > visToMs) continue;
    entries.push({ type: "incident", inc, msInDay: span.startMs, sortMs: span.startMs });
  }
  for (const n of notables) {
    if (n.msInDay < visFromMs || n.msInDay > visToMs) continue;
    entries.push({ type: "notable", n, sortMs: n.msInDay });
  }
  entries.sort((a, b) => a.sortMs - b.sortMs);

  const withHeaders = visToMs - visFromMs > 2 * 3_600_000;
  if (!withHeaders || entries.length === 0) {
    return entries.map(({ sortMs: _sortMs, ...row }) => row as DigestRow);
  }
  const out: DigestRow[] = [];
  const relevant = ticks.filter((t) => t.ms >= visFromMs && t.ms <= visToMs);
  let ti = 0;
  for (const e of entries) {
    while (ti < relevant.length && relevant[ti].ms <= e.sortMs) {
      out.push({ type: "hour", label: relevant[ti].label, ms: relevant[ti].ms });
      ti++;
    }
    const { sortMs: _sortMs, ...row } = e;
    out.push(row as DigestRow);
  }
  return out;
}

/** Group per-camera summaries for density lanes: merge + position
 *  data the OverviewRuler consumes. Kept here for testability. */
export function laneBuckets(
  summary: DetectionSummary | undefined,
  dayFromMs: number,
  factor: number,
): { startMs: number; endMs: number; bucket: SummaryBucket }[] {
  if (!summary || summary.buckets.length === 0) return [];
  const sumFromMs = Date.parse(summary.from) - dayFromMs;
  const sumToMs = Date.parse(summary.to) - dayFromMs;
  const n = Math.max(1, Math.round((sumToMs - sumFromMs) / summary.bucket_ms));
  const merged = mergeSummaryBuckets(summary.buckets, factor);
  const span = ((sumToMs - sumFromMs) / n) * factor;
  return merged.map((bucket) => {
    const startMs = sumFromMs + bucket.i * span;
    return { startMs, endMs: startMs + span, bucket };
  });
}
