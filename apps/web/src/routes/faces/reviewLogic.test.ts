import { describe, expect, it } from "vitest";
import type { RecentFace } from "@/lib/api";
import {
  buildDismissItems,
  buildEnrolVectors,
  enrolToastMessage,
  nextLimit,
  parseClusterRunState,
} from "./reviewLogic";

const face = (id: number, extra: Partial<RecentFace> = {}): RecentFace =>
  ({
    detection_id: id,
    event_id: `e${id}`,
    camera_id: "cam1",
    ts: "2026-07-17T12:00:00Z",
    confidence: 0.9,
    bbox: { x: 0, y: 0, w: 0.1, h: 0.1 },
    vector: [id, id],
    thumbnail_url: `/t/${id}.jpg`,
    ...extra,
  }) as RecentFace;

describe("buildDismissItems", () => {
  it("flattens selected representatives + collapsed members", () => {
    const faces = [
      face(1, { members: [10, 11], member_vectors: [[10, 10], [11, 11]], count: 3 }),
      face(2),
      face(3), // not selected
    ];
    const items = buildDismissItems(faces, new Set([1, 2]), "not_a_face");
    expect(items.map((i) => i.detection_id)).toEqual([1, 10, 11, 2]);
    expect(items.every((i) => i.reason === "not_a_face")).toBe(true);
  });

  it("skips faces without vectors", () => {
    const items = buildDismissItems(
      [face(1, { vector: undefined })],
      new Set([1]),
      "deleted",
    );
    expect(items).toEqual([]);
  });
});

describe("buildEnrolVectors", () => {
  it("sources each vector from its detection", () => {
    const faces = [face(5, { members: [6], member_vectors: [[6, 6]] })];
    const out = buildEnrolVectors(faces, new Set([5]));
    expect(out).toEqual([
      { vector: [5, 5], source: "enrol-live-5", detection_id: 5 },
      { vector: [6, 6], source: "enrol-cluster-6", detection_id: 6 },
    ]);
  });
});

describe("nextLimit", () => {
  it("steps by 120 and caps at 480", () => {
    expect(nextLimit(60)).toBe(180);
    expect(nextLimit(180)).toBe(300);
    expect(nextLimit(420)).toBe(480);
    expect(nextLimit(480)).toBe(480);
  });
});

describe("parseClusterRunState", () => {
  it("accepts known states and rejects junk", () => {
    expect(parseClusterRunState({ state: "ok", noise: 3 })?.noise).toBe(3);
    expect(parseClusterRunState({ state: "running" })?.state).toBe("running");
    expect(parseClusterRunState({ state: "weird" })).toBeNull();
    expect(parseClusterRunState(null)).toBeNull();
    expect(parseClusterRunState("ok")).toBeNull();
  });
});

describe("enrolToastMessage", () => {
  it("plain add", () => {
    expect(enrolToastMessage({ added: 3 })).toBe("Enrolled 3 face samples");
    expect(enrolToastMessage({ added: 1 })).toBe("Enrolled 1 face sample");
  });
  it("mentions skipped near-duplicates", () => {
    expect(enrolToastMessage({ added: 5, skipped_near_duplicates: 18 })).toBe(
      "Enrolled 5 face samples · 18 near-duplicates skipped",
    );
    expect(enrolToastMessage({ added: 2, skipped_near_duplicates: 1 })).toBe(
      "Enrolled 2 face samples · 1 near-duplicate skipped",
    );
  });
  it("all-duplicates outcome is explicit", () => {
    expect(enrolToastMessage({ added: 0, skipped_near_duplicates: 4 })).toBe(
      "No new samples — all 4 were near-duplicates of the existing enrolment",
    );
  });
  it("appends retro-match count", () => {
    expect(
      enrolToastMessage({ added: 5, skipped_near_duplicates: 2, retro_matched: 40 }),
    ).toBe(
      "Enrolled 5 face samples · 2 near-duplicates skipped · 40 earlier sightings auto-matched",
    );
    expect(enrolToastMessage({ added: 0, skipped_near_duplicates: 4, retro_matched: 1 })).toBe(
      "No new samples — all 4 were near-duplicates of the existing enrolment · 1 earlier sighting auto-matched",
    );
  });
  it("degenerate empty result", () => {
    expect(enrolToastMessage({ added: 0 })).toBe("No samples enrolled");
  });
});

describe("enrolToastMessage quality gates", () => {
  it("mentions low-quality skips", () => {
    expect(
      enrolToastMessage({ added: 4, skipped_near_duplicates: 2, skipped_low_quality: 3 }),
    ).toBe("Enrolled 4 face samples · 2 near-duplicates skipped · 3 low-quality skipped");
  });
  it("all-low-quality outcome is explicit", () => {
    expect(enrolToastMessage({ added: 0, skipped_low_quality: 5 })).toBe(
      "No new samples — all 5 failed the quality gates (turned/blurred/marginal)",
    );
  });
});
