// TZ must be pinned before any Date math runs so the DST cases are
// deterministic wherever the tests execute. Europe/London: 2026
// transitions are Mar 29 (spring forward) and Oct 25 (fall back).
// (Local declaration instead of @types/node — vitest runs on Node,
// but the app tsconfig doesn't ship node types.)
declare const process: { env: Record<string, string | undefined> };
process.env.TZ = "Europe/London";

import { describe, expect, it } from "vitest";
import {
  dayRange,
  dayRangeMs,
  fracToMs,
  hourTicks,
  msToHHMM,
  msToHHMMSS,
  msToPct,
} from "./timeMath";

describe("dayRange", () => {
  it("spans local midnight to next local midnight", () => {
    const { from, to } = dayRange("2026-07-16");
    expect(from.getHours()).toBe(0);
    expect(from.getDate()).toBe(16);
    expect(to.getDate()).toBe(17);
    expect(dayRangeMs(from, to)).toBe(24 * 3_600_000);
  });

  it("is 23h on spring-forward day, 25h on fall-back day", () => {
    const spring = dayRange("2026-03-29");
    expect(dayRangeMs(spring.from, spring.to)).toBe(23 * 3_600_000);
    const fall = dayRange("2026-10-25");
    expect(dayRangeMs(fall.from, fall.to)).toBe(25 * 3_600_000);
  });
});

describe("hourTicks", () => {
  it("normal day: 25 ticks labelled 00..24", () => {
    const { from, to } = dayRange("2026-07-16");
    const ticks = hourTicks(from, to);
    expect(ticks).toHaveLength(25);
    expect(ticks[0]).toEqual({ ms: 0, label: "00" });
    expect(ticks[12].label).toBe("12");
    expect(ticks[24]).toEqual({ ms: 24 * 3_600_000, label: "24" });
  });

  it("spring-forward day: 24 ticks, hour 01 skipped", () => {
    const { from, to } = dayRange("2026-03-29");
    const ticks = hourTicks(from, to);
    expect(ticks).toHaveLength(24);
    expect(ticks.map((t) => t.label)).not.toContain("01");
    expect(ticks[1].label).toBe("02"); // 00:00 GMT + 1h = 02:00 BST
    expect(ticks[23].label).toBe("24");
  });

  it("fall-back day: 26 ticks, hour 01 repeated", () => {
    const { from, to } = dayRange("2026-10-25");
    const ticks = hourTicks(from, to);
    expect(ticks).toHaveLength(26);
    const ones = ticks.filter((t) => t.label === "01");
    expect(ones).toHaveLength(2); // 01:00 BST then 01:00 GMT
    expect(ticks[25].label).toBe("24");
  });
});

describe("window mapping", () => {
  it("fracToMs and msToPct round-trip inside the window", () => {
    const visFromMs = 6 * 3_600_000;
    const visMs = 2 * 3_600_000;
    const ms = fracToMs(0.25, visFromMs, visMs);
    expect(ms).toBe(visFromMs + 0.5 * 3_600_000);
    expect(msToPct(ms, visFromMs, visMs)).toBe(25);
  });

  it("fracToMs clamps out-of-range fractions", () => {
    expect(fracToMs(-1, 0, 1000)).toBe(0);
    expect(fracToMs(2, 0, 1000)).toBe(1000);
  });

  it("msToPct returns null outside the window", () => {
    expect(msToPct(999, 1000, 1000)).toBeNull();
    expect(msToPct(2001, 1000, 1000)).toBeNull();
    expect(msToPct(1000, 1000, 1000)).toBe(0);
    expect(msToPct(2000, 1000, 1000)).toBe(100);
  });
});

describe("formatting", () => {
  it("msToHHMM / msToHHMMSS", () => {
    expect(msToHHMM(0)).toBe("00:00");
    expect(msToHHMM(13 * 3_600_000 + 5 * 60_000)).toBe("13:05");
    expect(msToHHMMSS(13 * 3_600_000 + 5 * 60_000 + 7_500)).toBe("13:05:07");
  });
});
