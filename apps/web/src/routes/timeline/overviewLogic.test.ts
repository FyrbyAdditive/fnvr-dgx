declare const process: { env: Record<string, string | undefined> };
process.env.TZ = "Europe/London";

import { describe, expect, it } from "vitest";
import type { HistoricDetection, Incident, SummaryBucket } from "@/lib/api";
import {
  buildDigest,
  coalesceSpans,
  collapseNotables,
  fleetP95,
  incidentSpan,
  laneGeometry,
  laneIndexFromYPct,
  mergeSummaryBuckets,
  toNotable,
} from "./overviewLogic";

const bucket = (i: number, count: number, extra: Partial<SummaryBucket> = {}): SummaryBucket => ({
  i,
  count,
  max_confidence: 0.5,
  top_classes: [],
  kinds: ["object"],
  ...extra,
});

describe("coalesceSpans", () => {
  it("merges spans within the gap and keeps distinct ones", () => {
    const out = coalesceSpans(
      [
        { startMs: 0, endMs: 100 },
        { startMs: 150, endMs: 300 },
        { startMs: 10_000, endMs: 11_000 },
      ],
      100,
    );
    expect(out).toEqual([
      { startMs: 0, endMs: 300 },
      { startMs: 10_000, endMs: 11_000 },
    ]);
  });
  it("handles unsorted + overlapping input", () => {
    const out = coalesceSpans(
      [
        { startMs: 500, endMs: 900 },
        { startMs: 0, endMs: 600 },
      ],
      0,
    );
    expect(out).toEqual([{ startMs: 0, endMs: 900 }]);
  });
  it("gap exactly at threshold merges", () => {
    const out = coalesceSpans(
      [
        { startMs: 0, endMs: 100 },
        { startMs: 200, endMs: 300 },
      ],
      100,
    );
    expect(out).toHaveLength(1);
  });
  it("empty input", () => {
    expect(coalesceSpans([], 100)).toEqual([]);
  });
});

describe("mergeSummaryBuckets", () => {
  it("factor 1 is identity", () => {
    const b = [bucket(0, 5)];
    expect(mergeSummaryBuckets(b, 1)).toBe(b);
  });
  it("groups sparse buckets, sums counts, unions kinds", () => {
    const out = mergeSummaryBuckets(
      [
        bucket(0, 5, { kinds: ["object"] }),
        bucket(2, 7, { kinds: ["face"], max_confidence: 0.9 }),
        bucket(3, 1),
      ],
      3,
    );
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ i: 0, count: 12, max_confidence: 0.9 });
    expect(out[0].kinds).toEqual(["face", "object"]);
    expect(out[1]).toMatchObject({ i: 1, count: 1 });
  });
  it("re-aggregates top classes deterministically", () => {
    const out = mergeSummaryBuckets(
      [
        bucket(0, 3, { top_classes: [{ class: "person", count: 2 }, { class: "car", count: 1 }] }),
        bucket(1, 4, { top_classes: [{ class: "car", count: 3 }, { class: "dog", count: 1 }] }),
      ],
      2,
    );
    expect(out[0].top_classes).toEqual([
      { class: "car", count: 4 },
      { class: "person", count: 2 },
      { class: "dog", count: 1 },
    ]);
  });
});

describe("fleetP95", () => {
  it("computes across all lanes", () => {
    const lanes = [
      Array.from({ length: 50 }, (_, i) => bucket(i, 10)),
      Array.from({ length: 50 }, (_, i) => bucket(i, 1000)),
    ];
    expect(fleetP95(lanes)).toBe(1000);
  });
  it("floors at 1 and survives empty", () => {
    expect(fleetP95([])).toBe(1);
    expect(fleetP95([[bucket(0, 0)]])).toBe(1);
  });
});

describe("laneGeometry / laneIndexFromYPct", () => {
  it("round-trips lane centers", () => {
    const lanes = laneGeometry(7);
    lanes.forEach((l, i) => {
      expect(laneIndexFromYPct(l.topPct + l.heightPct / 2, 7)).toBe(i);
    });
  });
  it("header band and out-of-range map to null", () => {
    expect(laneIndexFromYPct(4, 7)).toBeNull();
    expect(laneIndexFromYPct(101, 7)).toBeNull();
    expect(laneIndexFromYPct(50, 0)).toBeNull();
  });
  it("single lane fills everything below the header", () => {
    expect(laneIndexFromYPct(10, 1)).toBe(0);
    expect(laneIndexFromYPct(99, 1)).toBe(0);
  });
});

const inc = (startIso: string, lastIso: string, extra: Partial<Incident> = {}): Incident =>
  ({
    id: Math.random().toString(36).slice(2),
    rule_id: "r",
    camera_id: "cam-a",
    started_at: startIso,
    ended_at: null,
    severity: "warning",
    summary: "",
    acknowledged: false,
    classes: ["person"],
    rule_ids: ["r"],
    last_detection_at: lastIso,
    detection_count: 3,
    ...extra,
  }) as Incident;

describe("incidentSpan", () => {
  it("converts to ms-into-day and clamps degenerate spans", () => {
    const day = Date.parse("2026-07-15T00:00:00+01:00");
    const s = incidentSpan(
      inc("2026-07-15T10:00:00+01:00", "2026-07-15T09:00:00+01:00"),
      day,
    );
    expect(s.startMs).toBe(10 * 3_600_000);
    expect(s.endMs).toBe(s.startMs);
  });
});

const det = (
  ts: string,
  kind: string,
  extra: Partial<HistoricDetection> = {},
): HistoricDetection =>
  ({
    id: 1,
    event_id: "e",
    camera_id: "cam-a",
    ts,
    class_name: "face",
    kind,
    confidence: 0.8,
    bbox: { x: 0, y: 0, w: 1, h: 1 },
    ...extra,
  }) as HistoricDetection;

describe("toNotable", () => {
  const day = Date.parse("2026-07-15T00:00:00+01:00");
  it("matched face → notable; unmatched face → null", () => {
    const matched = toNotable(
      det("2026-07-15T08:00:00+01:00", "face", { attributes: { person: "tim", similarity: "0.72" } }),
      day,
    );
    expect(matched).toMatchObject({ identity: "face:tim", label: "tim" });
    expect(toNotable(det("2026-07-15T08:00:00+01:00", "face"), day)).toBeNull();
  });
  it("plate + print defects classify", () => {
    expect(
      toNotable(det("2026-07-15T08:00:00+01:00", "anpr", { attributes: { plate: "AB12CDE" } }), day),
    ).toMatchObject({ identity: "anpr:AB12CDE" });
    expect(
      toNotable(det("2026-07-15T08:00:00+01:00", "print_defect", { class_name: "print_failure" }), day),
    ).toMatchObject({ label: "PRINT FAILURE" });
    expect(toNotable(det("2026-07-15T08:00:00+01:00", "object"), day)).toBeNull();
  });
});

describe("collapseNotables", () => {
  const day = Date.parse("2026-07-15T00:00:00+01:00");
  const face = (min: number, cam = "cam-a", person = "tim") =>
    toNotable(
      det(`2026-07-15T08:${String(min).padStart(2, "0")}:00+01:00`, "face", {
        camera_id: cam,
        attributes: { person },
      }),
      day,
    )!;
  it("collapses same camera+identity within the gap", () => {
    const out = collapseNotables([face(0), face(3), face(6)]);
    expect(out).toHaveLength(1);
    expect(out[0].count).toBe(3);
  });
  it("splits across the gap, across cameras and identities", () => {
    const out = collapseNotables([face(0), face(20), face(1, "cam-b"), face(2, "cam-a", "bob")]);
    expect(out).toHaveLength(4);
  });
});

describe("buildDigest", () => {
  const day = Date.parse("2026-07-15T00:00:00+01:00");
  const ticks = Array.from({ length: 24 }, (_, h) => ({
    ms: h * 3_600_000,
    label: `${String(h).padStart(2, "0")}:00`,
  }));
  const i1 = inc("2026-07-15T02:30:00+01:00", "2026-07-15T02:31:00+01:00");
  const n1 = collapseNotables([
    toNotable(
      det("2026-07-15T05:00:00+01:00", "anpr", { attributes: { plate: "X1" } }),
      day,
    )!,
  ]);
  it("orders ascending with hour headers on wide windows", () => {
    const rows = buildDigest([i1], n1, day, 0, 24 * 3_600_000, ticks);
    const types = rows.map((r) => r.type);
    expect(types.filter((t) => t === "incident")).toHaveLength(1);
    expect(types.filter((t) => t === "notable")).toHaveLength(1);
    expect(types[0]).toBe("hour"); // headers precede first entry
    const incIdx = rows.findIndex((r) => r.type === "incident");
    const notIdx = rows.findIndex((r) => r.type === "notable");
    expect(incIdx).toBeLessThan(notIdx);
  });
  it("filters by window overlap (straddling incident included)", () => {
    const rows = buildDigest([i1], n1, day, 2.5 * 3_600_000, 3 * 3_600_000, ticks);
    expect(rows.some((r) => r.type === "incident")).toBe(true);
    expect(rows.some((r) => r.type === "notable")).toBe(false);
  });
  it("no hour headers on narrow windows", () => {
    const rows = buildDigest([i1], [], day, 2 * 3_600_000, 3.5 * 3_600_000, ticks);
    expect(rows.every((r) => r.type !== "hour")).toBe(true);
  });
});
