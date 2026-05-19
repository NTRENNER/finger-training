// Tests for src/model/limiter.js — cross-zone residual limiter detection
// used by the F-D chart's colored limiter-zone band on Analysis.
//
// The headline property under test: reps are bucketed into zones by
// ACTUAL hold time, not by what the user intended. A rep targeting
// 115s (Strength) that failed at 60s physically tested power_strength,
// so its data point belongs in the power_strength bucket — not Strength.

import { computeLimiterZone } from "../limiter.js";

const trueAmps = [30, 12, 6];
const tau = [10, 30, 180];
const F_curve = (T) => trueAmps[0]*Math.exp(-T/tau[0])
                     + trueAmps[1]*Math.exp(-T/tau[1])
                     + trueAmps[2]*Math.exp(-T/tau[2]);

const today = new Date().toISOString().slice(0, 10);
const buildRep = (overrides) => ({
  hand: "L", grip: "Crusher",
  rep_num: 1, date: today,
  ...overrides,
});

describe("computeLimiterZone", () => {
  test("returns null with empty history", () => {
    expect(computeLimiterZone([])).toBeNull();
  });

  test("returns null below minimum failure count", () => {
    const history = [
      buildRep({ target_duration: 30,  actual_time_s: 30,  avg_force_kg: F_curve(30) }),
      buildRep({ target_duration: 60,  actual_time_s: 60,  avg_force_kg: F_curve(60) }),
    ];
    expect(computeLimiterZone(history)).toBeNull();
  });

  test("buckets failures by actual_time_s, not target_duration", () => {
    // Setup: most zones on-curve, plus a single big-shortfall rep that
    // targeted Strength (115s) but failed at 60s with low force. Under
    // the OLD logic (bucket by target_duration) this rep would land in
    // Strength → Strength looks weak → false limiter call. Under the
    // NEW logic (bucket by actual_time_s) the rep lands in
    // power_strength where it physically belongs → power_strength
    // residual carries the signal.
    const history = [
      // max_strength on-curve
      buildRep({ target_duration: 10, actual_time_s: 10, avg_force_kg: F_curve(10) }),
      // power on-curve
      buildRep({ target_duration: 30, actual_time_s: 30, avg_force_kg: F_curve(30) }),
      buildRep({ target_duration: 30, actual_time_s: 30, avg_force_kg: F_curve(30) }),
      // power_strength: limited (low force) — but logged with the next
      // higher target. Three reps so the bucket can fit + win.
      buildRep({ target_duration: 115, actual_time_s: 60, avg_force_kg: F_curve(60) * 0.55 }),
      buildRep({ target_duration: 115, actual_time_s: 65, avg_force_kg: F_curve(65) * 0.55 }),
      buildRep({ target_duration: 115, actual_time_s: 70, avg_force_kg: F_curve(70) * 0.55 }),
      // strength upper on-curve (so Strength bucket has real anchors
      // not just the misclassified power_strength reps)
      buildRep({ target_duration: 115, actual_time_s: 120, avg_force_kg: F_curve(120) }),
      buildRep({ target_duration: 115, actual_time_s: 125, avg_force_kg: F_curve(125) }),
      // endurance on-curve
      buildRep({ target_duration: 220, actual_time_s: 220, avg_force_kg: F_curve(220) }),
      buildRep({ target_duration: 220, actual_time_s: 222, avg_force_kg: F_curve(222) }),
    ];
    const result = computeLimiterZone(history);
    expect(result).not.toBeNull();
    expect(result.grip).toBe("Crusher");
    // Limiter signal should land at power_strength (where the under-
    // performing reps physically tested), not Strength (their target).
    expect(result.zone).toBe("power_strength");
  });

  test("falls back to target_duration when actual_time_s missing (legacy rows)", () => {
    // Legacy rep without actual_time_s — bucket by target_duration.
    // Set up so all three "ok" reps have actual; legacy rep has only
    // target. The legacy rep at target=160 (strength_endurance) should
    // bucket into strength_endurance via the fallback.
    const history = [
      buildRep({ target_duration: 10,  actual_time_s: 10,  avg_force_kg: F_curve(10) }),
      buildRep({ target_duration: 30,  actual_time_s: 30,  avg_force_kg: F_curve(30) }),
      buildRep({ target_duration: 70,  actual_time_s: 70,  avg_force_kg: F_curve(70) }),
      buildRep({ target_duration: 120, actual_time_s: 120, avg_force_kg: F_curve(120) }),
      // Legacy rep — no actual_time_s, low force → S·E limiter via target
      buildRep({ target_duration: 160, actual_time_s: 160, avg_force_kg: F_curve(160) * 0.5 }),
      buildRep({ target_duration: 160, actual_time_s: 160, avg_force_kg: F_curve(160) * 0.5 }),
      buildRep({ target_duration: 220, actual_time_s: 220, avg_force_kg: F_curve(220) }),
    ];
    const result = computeLimiterZone(history);
    expect(result).not.toBeNull();
    expect(result.zone).toBe("strength_endurance");
  });
});
