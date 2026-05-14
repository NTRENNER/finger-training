// Tests for src/model/perceivedFatigueLearning.js — adaptive gain
// on top of climbingFatigue.fatigueToModifier.

import {
  computePersonalGains,
  applyPersonalGain,
} from "../perceivedFatigueLearning.js";
import { fatigueToModifier } from "../climbingFatigue.js";

// Build a synthetic three-exp curve for the test.
const trueAmps = [30, 12, 6];
const tau = [10, 30, 180];
const F_curve = (T) => trueAmps[0]*Math.exp(-T/tau[0])
                     + trueAmps[1]*Math.exp(-T/tau[1])
                     + trueAmps[2]*Math.exp(-T/tau[2]);

// rep helper — same shape as the real reps.
const buildRep = (hand, T, F, perceivedRpe = null) => ({
  id: `r-${hand}-${T}-${perceivedRpe}-${Math.random()}`,
  hand, grip: "Crusher",
  target_duration: T, actual_time_s: T,
  avg_force_kg: F,
  rep_num: 1,
  perceived_rpe: perceivedRpe,
  date: new Date().toISOString().slice(0, 10),
  session_id: `s-${Math.random()}`,
});

describe("computePersonalGains", () => {
  test("empty / null history returns all-1.0 gains", () => {
    const { gains, counts } = computePersonalGains([]);
    for (const z of Object.keys(gains)) {
      expect(gains[z]).toBe(1.0);
      expect(counts[z]).toBe(0);
    }
    const empty2 = computePersonalGains(null);
    expect(empty2.gains.power).toBe(1.0);
  });

  test("history without any perceived_rpe-tagged reps stays at 1.0", () => {
    // Plenty of reps, no slider engagement → no learning signal.
    const history = [
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 120, F_curve(120)),
    ];
    const { gains, counts } = computePersonalGains(history);
    expect(gains.power).toBe(1.0);
    expect(counts.power).toBe(0);
  });

  test("user who hits the curve at high RPE drives gain DOWN (less cooked than predicted)", () => {
    // Build a fittable history (so the curve exists), then add many
    // RPE-9 reps where avg_force_kg lands very close to the curve —
    // i.e., barely any observed suppression. Predicted suppression at
    // RPE 9 in Power = 0.9 × 0.55 = 0.495. Observed should be near 0.
    // ratio ≈ 0 → many such ratios pull the gain toward 0 + shrinkage.
    const history = [];
    // Anchor curve with a wide spread of fresh reps
    for (const T of [10, 30, 60, 90, 120, 150, 180]) {
      history.push(buildRep("L", T, F_curve(T)));
      history.push(buildRep("R", T, F_curve(T)));
    }
    // Plenty of RPE-9 Power reps where user hit ~98% of curve
    for (let i = 0; i < 12; i++) {
      history.push(buildRep("L", 30, F_curve(30) * 0.98, 9));
    }
    const { gains, counts } = computePersonalGains(history);
    expect(counts.power).toBeGreaterThanOrEqual(12);
    // Gain should drop noticeably below 1.0
    expect(gains.power).toBeLessThan(0.8);
    // But not collapse to the GAIN_MIN floor
    expect(gains.power).toBeGreaterThan(0.2);
  });

  test("user who under-performs at high RPE drives gain UP (more cooked than predicted)", () => {
    const history = [];
    for (const T of [10, 30, 60, 90, 120, 150, 180]) {
      history.push(buildRep("L", T, F_curve(T)));
      history.push(buildRep("R", T, F_curve(T)));
    }
    // RPE-7 Power reps where user only hit 40% of curve — way more
    // cooked than the population curve would predict.
    // Predicted suppression at RPE 7 Power = 0.7 × 0.55 = 0.385.
    // Observed suppression = 0.6. ratio ≈ 1.56, drift gain UP.
    for (let i = 0; i < 12; i++) {
      history.push(buildRep("L", 30, F_curve(30) * 0.4, 7));
    }
    const { gains } = computePersonalGains(history);
    expect(gains.power).toBeGreaterThan(1.1);
  });

  test("only 2-3 observations stay close to 1.0 due to shrinkage", () => {
    const history = [];
    for (const T of [10, 30, 60, 90, 120, 150, 180]) {
      history.push(buildRep("L", T, F_curve(T)));
      history.push(buildRep("R", T, F_curve(T)));
    }
    // Just 2 RPE-tagged reps, both showing strong over-performance
    for (let i = 0; i < 2; i++) {
      history.push(buildRep("L", 30, F_curve(30) * 0.99, 9));
    }
    const { gains, counts } = computePersonalGains(history);
    expect(counts.power).toBe(2);
    // PRIOR_WEIGHT=5, n=2, ratios near 0 → gain ≈ (5+0)/(5+2) ≈ 0.71.
    // Should still be visibly close to 1.0 — not yet far drifted.
    expect(gains.power).toBeGreaterThan(0.6);
    expect(gains.power).toBeLessThan(1.0);
  });

  test("learning is per-zone — Power evidence doesn't move Endurance", () => {
    const history = [];
    for (const T of [10, 30, 60, 90, 120, 150, 180]) {
      history.push(buildRep("L", T, F_curve(T)));
      history.push(buildRep("R", T, F_curve(T)));
    }
    // RPE-8 reps in Power only (T=30 is power); user over-performs
    for (let i = 0; i < 10; i++) {
      history.push(buildRep("L", 30, F_curve(30) * 0.97, 8));
    }
    const { gains } = computePersonalGains(history);
    expect(gains.power).toBeLessThan(0.85);
    // Endurance never tagged — stays at 1.0
    expect(gains.endurance).toBe(1.0);
  });

  test("ratio is capped — single absurd outlier can't blow up the mean", () => {
    const history = [];
    for (const T of [10, 30, 60, 90, 120, 150, 180]) {
      history.push(buildRep("L", T, F_curve(T)));
      history.push(buildRep("R", T, F_curve(T)));
    }
    // One absurd over-suppression: avg_force = 1 kg at curve ~22 kg
    // Observed suppression ~ 0.95. Predicted at RPE 5 Power = 0.275.
    // Raw ratio = 3.45. Capped to 3.0. With shrinkage (PRIOR=5, n=1)
    // gain = (5 + 3) / 6 ≈ 1.33 — moved but not unhinged.
    history.push(buildRep("L", 30, 1, 5));
    const { gains } = computePersonalGains(history);
    expect(gains.power).toBeLessThan(1.5);
    expect(gains.power).toBeGreaterThan(1.0);
  });
});

describe("applyPersonalGain", () => {
  test("no gain or unit gain returns the base unchanged", () => {
    expect(applyPersonalGain(0.7, null)).toBe(0.7);
    expect(applyPersonalGain(0.7, 1.0)).toBe(0.7);
    expect(applyPersonalGain(0.7, undefined)).toBe(0.7);
  });

  test("gain < 1 reduces the suppression (modifier closer to 1)", () => {
    // base modifier = 0.7 → suppression = 0.3. gain 0.5 → adj suppression
    // = 0.15 → adj modifier = 0.85. User is half as suppressed.
    expect(applyPersonalGain(0.7, 0.5)).toBeCloseTo(0.85, 5);
  });

  test("gain > 1 increases the suppression (modifier closer to 0)", () => {
    // base modifier = 0.7 → suppression = 0.3. gain 2.0 → adj suppression
    // = 0.6 → adj modifier = 0.4. User is twice as suppressed.
    expect(applyPersonalGain(0.7, 2.0)).toBeCloseTo(0.4, 5);
  });

  test("composes with fatigueToModifier as expected", () => {
    // Population curve at RPE 7 in Power: 1 - 0.7 × 0.55 = 0.615.
    // With personal gain 0.5: 1 - 0.5 × 0.385 = 0.8075.
    const base = fatigueToModifier("power", 7, 0);
    const adj  = applyPersonalGain(base, 0.5);
    expect(base).toBeCloseTo(0.615, 3);
    expect(adj).toBeCloseTo(0.8075, 3);
  });
});
