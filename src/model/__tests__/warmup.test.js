// Tests for src/model/warmup.js — focused on the May 2026 rebuild:
// two-handed load scaling, the progressive strength ladder, and the
// margin-based (in-range) perfusion loads.

import { generateWarmupProtocol, BILATERAL_FACTOR } from "../warmup.js";
import { predForceThreeExp } from "../threeExp.js";

// Synthetic Crusher + Micro history spanning several durations so the
// per-grip curves fit. Each rep is a single-hand (T, F) failure point;
// peak_force_kg present so the MVC/ladder anchor uses peak.
function rep(grip, hand, T, F, peak) {
  return {
    grip, hand, date: "2026-05-10",
    rep_num: 1, set_num: 1,
    actual_time_s: T, avg_force_kg: F, peak_force_kg: peak,
    target_duration: Math.round(T),
  };
}
const history = [
  // Crusher: ~ decaying curve, peak ~60
  rep("Crusher", "L", 7, 58, 62), rep("Crusher", "R", 7, 57, 61),
  rep("Crusher", "L", 45, 33, 60), rep("Crusher", "R", 45, 32, 59),
  rep("Crusher", "L", 120, 24, 58), rep("Crusher", "R", 120, 23, 58),
  // Micro: peak ~22
  rep("Micro", "L", 7, 19, 22), rep("Micro", "R", 7, 18, 21),
  rep("Micro", "L", 45, 11, 21), rep("Micro", "R", 45, 10, 20),
  rep("Micro", "L", 120, 7, 20), rep("Micro", "R", 120, 7, 20),
];
const BW = 75;

describe("generateWarmupProtocol — two-handed + ladder rebuild", () => {
  test("fails cleanly without bodyweight or Crusher data", () => {
    expect(generateWarmupProtocol({ history, wLog: [], bodyWeightKg: 0 }).ok).toBe(false);
    expect(generateWarmupProtocol({ history: [], wLog: [], bodyWeightKg: BW }).ok).toBe(false);
  });

  test("boulder protocol has perfusion, a strength ladder, BORK, pullups", () => {
    const p = generateWarmupProtocol({ history, wLog: [], bodyWeightKg: BW, mode: "boulder" });
    expect(p.ok).toBe(true);
    const ids = p.steps.map(s => s.id);
    expect(ids).toContain("perfusion-crusher-easy");
    expect(ids.some(id => id.startsWith("ladder-"))).toBe(true);
    expect(ids).toContain("bork-micro");
    expect(ids).toContain("pullup-finisher");
    // Boulder ladder has 3 rungs topping near-max (88%).
    const rungs = p.steps.filter(s => s.id.startsWith("ladder-"));
    expect(rungs.length).toBe(3);
  });

  test("route protocol: longer perfusion, lower-topping ladder, no BORK", () => {
    const p = generateWarmupProtocol({ history, wLog: [], bodyWeightKg: BW, mode: "route" });
    const ids = p.steps.map(s => s.id);
    expect(ids).not.toContain("bork-micro");
    const rungs = p.steps.filter(s => s.id.startsWith("ladder-"));
    expect(rungs.length).toBe(2);          // route tops lower, fewer rungs
  });

  test("ladder loads are two-handed (~1.9× the one-hand % of MVC)", () => {
    const p = generateWarmupProtocol({ history, wLog: [], bodyWeightKg: BW, mode: "boulder" });
    const microMVC = p.mvcSource.microKg;           // one-hand peak ~22
    const topRung = p.steps.filter(s => s.id.startsWith("ladder-")).at(-1);
    // top rung is 88% MVC, two-handed
    const expected = microMVC * 0.88 * BILATERAL_FACTOR;
    expect(topRung.targetLoadKg).toBeCloseTo(expected, 1);
    // and it's clearly heavier than a single-hand 88% would be
    expect(topRung.targetLoadKg).toBeGreaterThan(microMVC * 0.88 * 1.5);
  });

  test("perfusion load comes from the curve in-range (margin-based), two-handed", () => {
    const p = generateWarmupProtocol({ history, wLog: [], bodyWeightKg: BW, mode: "boulder" });
    const easy = p.steps.find(s => s.id === "perfusion-crusher-easy");
    // 45s hold at failFrac 0.45 → load = F(100) one-hand, ×1.9
    // (we don't have crusherAmps here, but it must be a positive,
    // two-handed-scale load — bigger than a one-hand F(60s) would be).
    expect(easy.targetLoadKg).toBeGreaterThan(0);
    expect(easy.targetSec).toBe(45);
    // sanity: two-handed perfusion should exceed the one-hand F(120)≈24
    expect(easy.targetLoadKg).toBeGreaterThan(24);
  });

  test("BORK reference MVC is two-handed", () => {
    const p = generateWarmupProtocol({ history, wLog: [], bodyWeightKg: BW, mode: "boulder" });
    const bork = p.steps.find(s => s.id === "bork-micro");
    expect(bork.referenceMvcKg).toBeCloseTo(p.mvcSource.microKg * BILATERAL_FACTOR, 1);
  });
});
