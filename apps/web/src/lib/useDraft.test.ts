import { describe, expect, it } from "vitest";
import { deepEqual, reseed } from "./useDraft";

describe("deepEqual", () => {
  it("compares primitives, arrays and nested objects", () => {
    expect(deepEqual(1, 1)).toBe(true);
    expect(deepEqual("a", "b")).toBe(false);
    expect(deepEqual(null, null)).toBe(true);
    expect(deepEqual(null, {})).toBe(false);
    expect(deepEqual([1, 2], [1, 2])).toBe(true);
    expect(deepEqual([1, 2], [2, 1])).toBe(false); // order matters
    expect(deepEqual({ a: { b: [1] } }, { a: { b: [1] } })).toBe(true);
    expect(deepEqual({ a: 1 }, { a: 1, b: 2 })).toBe(false);
    expect(deepEqual({ a: undefined }, { a: undefined })).toBe(true);
  });
});

describe("reseed (useDraft seeding policy)", () => {
  const eq = deepEqual as (a: unknown, b: unknown) => boolean;

  it("seeds when there is no draft yet", () => {
    expect(reseed(undefined, undefined, { a: 1 }, eq)).toEqual({ a: 1 });
  });

  it("re-seeds a clean draft when the server moves", () => {
    const seeded = { a: 1 };
    // draft untouched since seeding → follow the server
    expect(reseed(seeded, seeded, { a: 2 }, eq)).toEqual({ a: 2 });
  });

  it("keeps a dirty draft when the server moves", () => {
    const seeded = { a: 1 };
    const edited = { a: 99 };
    expect(reseed(edited, seeded, { a: 2 }, eq)).toEqual({ a: 99 });
  });

  it("treats structurally-equal (not identical) drafts as clean", () => {
    // draft was re-created (e.g. via setDraft({...d})) but not changed
    expect(reseed({ a: 1 }, { a: 1 }, { a: 2 }, eq)).toEqual({ a: 2 });
  });
});
