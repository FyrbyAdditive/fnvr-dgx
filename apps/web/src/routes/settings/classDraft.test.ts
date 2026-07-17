import { describe, expect, it } from "vitest";
import {
  applyMutes,
  countChanges,
  emptyDraft,
  taxonomyChanges,
  toggleMute,
  toggleTaxonomy,
} from "./classDraft";

describe("classDraft", () => {
  it("toggling to a non-server value records a diff; back to server removes it", () => {
    let d = emptyDraft();
    d = toggleTaxonomy(d, 7, false, true); // server enabled, user disables
    expect(d.taxonomy).toEqual({ 7: false });
    expect(countChanges(d)).toBe(1);
    d = toggleTaxonomy(d, 7, true, true); // back to server value
    expect(d.taxonomy).toEqual({});
    expect(countChanges(d)).toBe(0);
  });

  it("mute diffs are per-bucket and independent", () => {
    let d = emptyDraft();
    d = toggleMute(d, "indoor", "car", true, false);
    d = toggleMute(d, "global", "dog", false, true); // server-muted, user unmutes
    expect(countChanges(d)).toBe(2);
    expect(d.mutes.indoor).toEqual({ car: true });
    expect(d.mutes.global).toEqual({ dog: false });
    expect(d.mutes.outdoor).toEqual({});
  });

  it("taxonomyChanges emits numeric ids", () => {
    let d = emptyDraft();
    d = toggleTaxonomy(d, 12, false, true);
    d = toggleTaxonomy(d, 3, true, false);
    expect(taxonomyChanges(d).sort((a, b) => a.id - b.id)).toEqual([
      { id: 3, enabled: true },
      { id: 12, enabled: false },
    ]);
  });

  it("applyMutes applies diffs and preserves unrendered slugs", () => {
    const server = {
      global: ["tv", "kite"], // "kite" belongs to a disabled class the table doesn't render
      indoor: [],
      outdoor: ["bird"],
    };
    let d = emptyDraft();
    d = toggleMute(d, "global", "tv", false, true); // unmute tv
    d = toggleMute(d, "indoor", "car", true, false); // mute car indoors
    const next = applyMutes(server, d);
    expect(next.global).toEqual(["kite"]); // kite preserved, tv removed
    expect(next.indoor).toEqual(["car"]);
    expect(next.outdoor).toEqual(["bird"]); // untouched bucket unchanged
  });
});
