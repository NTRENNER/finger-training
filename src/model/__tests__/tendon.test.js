import {
  TENDON_PRESET, buildIntervals, totalSets, totalWorkSeconds, tendonAdherence,
} from "../tendon.js";

describe("tendon preset", () => {
  test("Emil's 6 grips expand to 10 hang intervals (3+3+1+1+1+1)", () => {
    const iv = buildIntervals();
    expect(iv.length).toBe(10);
    expect(totalSets()).toBe(10);
    expect(totalWorkSeconds()).toBe(100); // 10 x 10s
  });

  test("every grip carries the flat 40% effort cue", () => {
    for (const iv of buildIntervals()) expect(iv.effortPct).toBe(40);
    expect(new Set(TENDON_PRESET.grips.length ? [40] : [])).toEqual(new Set([40]));
  });
});

describe("tendonAdherence", () => {
  test("counts this week, streak, and total from session dates", () => {
    // today = 2026-07-14; sessions on 14th, 13th, 11th.
    const sessions = [{ date: "2026-07-14" }, { date: "2026-07-13" }, { date: "2026-07-11" }];
    const a = tendonAdherence(sessions, "2026-07-14", 3);
    expect(a.weekCount).toBe(3);     // all three within the last 7 days
    expect(a.onTrack).toBe(true);
    expect(a.streak).toBe(2);        // 14th + 13th consecutive, gap on 12th
    expect(a.total).toBe(3);
    expect(a.last7.length).toBe(7);
    expect(a.last7[a.last7.length - 1]).toEqual({ date: "2026-07-14", done: true });
  });

  test("empty history → nothing done", () => {
    const a = tendonAdherence([], "2026-07-14", 3);
    expect(a.weekCount).toBe(0);
    expect(a.streak).toBe(0);
    expect(a.onTrack).toBe(false);
  });
});

describe("tendon presets", () => {
  const { TENDON_PRESETS, getPreset, resolvePreset, presetName } = require("../tendon.js");

  test("has Emil (10s) and Barr (30s) presets", () => {
    const emil = getPreset("abrahangs-emil");
    const barr = getPreset("barr");
    expect(emil.workSec).toBe(10);
    expect(barr.workSec).toBe(30);
    expect(TENDON_PRESETS.length).toBeGreaterThanOrEqual(2);
  });

  test("resolvePreset applies + clamps time overrides", () => {
    const p = resolvePreset("abrahangs-emil", { workSec: 25, restSec: 40 });
    expect(p.workSec).toBe(25);
    expect(p.restSec).toBe(40);
    // out-of-range clamps to bounds; junk falls back to base
    expect(resolvePreset("barr", { workSec: 9999 }).workSec).toBe(30);
    expect(resolvePreset("barr", { workSec: "x" }).workSec).toBe(30);
    expect(resolvePreset("barr", { effortPct: 90 }).effortPct).toBe(50);
  });

  test("presetName resolves display names", () => {
    expect(presetName("abrahangs-emil")).toBe("Emil");
    expect(presetName("barr")).toBe("Barr");
  });
});
