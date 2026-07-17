import { describe, expect, it } from "vitest";
import type { Camera } from "@/lib/api";
import { applyOrder, gridColCount, gridColsForCount, moveId, visibleCameras } from "./layouts";

const cam = (id: string) => ({ id }) as Camera;

describe("gridColsForCount", () => {
  it("follows the ladder", () => {
    expect(gridColsForCount(1)).toBe("grid-cols-1");
    expect(gridColsForCount(4)).toBe("grid-cols-2");
    expect(gridColsForCount(7)).toBe("grid-cols-3");
    expect(gridColsForCount(16)).toBe("grid-cols-4");
    expect(gridColCount(7)).toBe(3);
  });
});

describe("applyOrder", () => {
  const cams = [cam("a"), cam("b"), cam("c"), cam("d")];

  it("orders by saved ids, appending unknowns in server order", () => {
    expect(applyOrder(cams, ["c", "a"]).map((c) => c.id)).toEqual(["c", "a", "b", "d"]);
  });

  it("ignores stale saved ids", () => {
    expect(applyOrder(cams, ["zombie", "b"]).map((c) => c.id)).toEqual(["b", "a", "c", "d"]);
  });

  it("empty order = server order", () => {
    expect(applyOrder(cams, []).map((c) => c.id)).toEqual(["a", "b", "c", "d"]);
  });
});

describe("moveId", () => {
  const ids = ["a", "b", "c", "d"];

  it("moves before the target", () => {
    expect(moveId(ids, "d", "b", true)).toEqual(["a", "d", "b", "c"]);
  });

  it("moves after the target", () => {
    expect(moveId(ids, "a", "c", false)).toEqual(["b", "c", "a", "d"]);
  });

  it("drop on self is a no-op", () => {
    expect(moveId(ids, "b", "b", true)).toEqual(ids);
  });

  it("unknown target is a no-op", () => {
    expect(moveId(ids, "a", "zombie", true)).toEqual(ids);
  });
});

describe("visibleCameras", () => {
  it("filters hidden ids", () => {
    const cams = [cam("a"), cam("b")];
    expect(visibleCameras(cams, ["a"]).map((c) => c.id)).toEqual(["b"]);
    expect(visibleCameras(cams, [])).toBe(cams);
  });
});
