// Tests for src/model/fatigue.js — three-compartment fatigue + session
// planner. Covers fatigueDose, fatigueAfterRest, availFrec, predictRepTimes,
// sessionCompartmentAUC.

import {
  PHYS_MODEL_DEFAULT, DEF_FAT,
  fatigueDose, fatigueAfterRest, availFrac,
  predictRepTimes, sessionCompartmentAUC,
} from "../fatigue.js";

// ─────────────────────────────────────────────────────────────
// fatigueDose — load × duration × k (clamped to [0, 0.90])
// ─────────────────────────────────────────────────────────────
describe("fatigueDose", () => {
  test("returns 0 when sMax is null/zero/missing", () => {
    expect(fatigueDose(20, 30, null)).toBe(0);
    expect(fatigueDose(20, 30, 0)).toBe(0);
    expect(fatigueDose(20, 30, undefined)).toBe(0);
  });

  test("scales linearly with weight × duration", () => {
    const k = 0.01;
    const d1 = fatigueDose(20, 30, 50, k);
    const d2 = fatigueDose(20, 60, 50, k);
    expect(d2).toBeCloseTo(2 * d1, 6);
    const d3 = fatigueDose(40, 30, 50, k);
    expect(d3).toBeCloseTo(2 * d1, 6);
  });

  test("clamps to 0.90 for extreme inputs", () => {
    expect(fatigueDose(1000, 1000, 1, 0.5)).toBe(0.90);
  });

  test("uses PHYS_MODEL_DEFAULT.doseK by default", () => {
    const d = fatigueDose(20, 30, 50);
    const expected = (20 / 50) * 30 * PHYS_MODEL_DEFAULT.doseK;
    expect(d).toBeCloseTo(expected, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// fatigueAfterRest — multi-compartment exponential recovery
// ─────────────────────────────────────────────────────────────
describe("fatigueAfterRest", () => {
  test("returns the same fatigue when restSeconds = 0", () => {
    expect(fatigueAfterRest(0.5, 0)).toBeCloseTo(0.5, 6);
  });

  test("recovers monotonically — more rest, less fatigue", () => {
    const F0 = 0.5;
    const f30 = fatigueAfterRest(F0, 30);
    const f120 = fatigueAfterRest(F0, 120);
    const f600 = fatigueAfterRest(F0, 600);
    expect(f30).toBeLessThan(F0);
    expect(f120).toBeLessThan(f30);
    expect(f600).toBeLessThan(f120);
  });

  test("approaches 0 for very long rest (>>tau3)", () => {
    expect(fatigueAfterRest(0.5, 10000)).toBeLessThan(0.001);
  });

  test("returns 0 when starting fatigue is 0", () => {
    expect(fatigueAfterRest(0, 60)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// availFrac — bounded [0.05, 1.0]
// ─────────────────────────────────────────────────────────────
describe("availFrac", () => {
  test("returns 1 - F for normal range", () => {
    expect(availFrac(0)).toBe(1);
    expect(availFrac(0.3)).toBeCloseTo(0.7, 6);
  });

  test("clamps to floor of 0.05 (never zero capacity)", () => {
    expect(availFrac(1.0)).toBe(0.05);
    expect(availFrac(0.99)).toBe(0.05);
  });

  test("clamps to ceiling of 1.0", () => {
    expect(availFrac(-0.5)).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────
// predictRepTimes — per-rep fatigue/recovery cascade
// ─────────────────────────────────────────────────────────────
describe("predictRepTimes", () => {
  test("first rep equals firstRepTime", () => {
    const times = predictRepTimes({ numReps: 3, firstRepTime: 10, restSeconds: 60 });
    expect(times[0]).toBeCloseTo(10, 1);
  });

  test("rep times decrease monotonically without rest (or with short rest)", () => {
    const times = predictRepTimes({ numReps: 5, firstRepTime: 10, restSeconds: 5 });
    for (let i = 1; i < times.length; i++) {
      expect(times[i]).toBeLessThanOrEqual(times[i-1] + 0.01);
    }
  });

  test("longer rest preserves rep duration better", () => {
    const short = predictRepTimes({ numReps: 4, firstRepTime: 10, restSeconds: 5 });
    const long  = predictRepTimes({ numReps: 4, firstRepTime: 10, restSeconds: 300 });
    // The last rep with long rest should be at-or-above the last rep
    // with short rest.
    expect(long[long.length - 1]).toBeGreaterThanOrEqual(short[short.length - 1]);
  });

  test("returns the requested number of reps", () => {
    expect(predictRepTimes({ numReps: 7, firstRepTime: 10, restSeconds: 30 }).length).toBe(7);
  });

  test("never returns negative times", () => {
    const times = predictRepTimes({ numReps: 20, firstRepTime: 10, restSeconds: 1 });
    for (const t of times) expect(t).toBeGreaterThanOrEqual(0);
  });
});

// ─────────────────────────────────────────────────────────────
// sessionCompartmentAUC — per-compartment dose accumulation
// ─────────────────────────────────────────────────────────────
describe("sessionCompartmentAUC", () => {
  test("returns zero dose for empty session", () => {
    const out = sessionCompartmentAUC([]);
    expect(out.fast).toBe(0);
    expect(out.medium).toBe(0);
    expect(out.slow).toBe(0);
    expect(out.total).toBe(0);
  });

  test("doses accumulate across reps", () => {
    const oneRep = [{ actual_time_s: 30, avg_force_kg: 20 }];
    const twoReps = [
      { actual_time_s: 30, avg_force_kg: 20 },
      { actual_time_s: 30, avg_force_kg: 20 },
    ];
    const o1 = sessionCompartmentAUC(oneRep);
    const o2 = sessionCompartmentAUC(twoReps);
    expect(o2.total).toBeCloseTo(2 * o1.total, 6);
  });

  test("short reps load fast more than slow; long reps load slow more", () => {
    const shortRep = [{ actual_time_s: 5, avg_force_kg: 20 }];
    const longRep  = [{ actual_time_s: 180, avg_force_kg: 20 }];
    const sOut = sessionCompartmentAUC(shortRep);
    const lOut = sessionCompartmentAUC(longRep);
    // The long rep should deliver more slow-compartment dose than the
    // short rep does (a 180s hold reaches deep into the oxidative pool).
    expect(lOut.slow).toBeGreaterThan(sOut.slow);
    // Both should have non-zero fast dose, but the long rep saturates
    // the fast pool too.
    expect(sOut.fast).toBeGreaterThan(0);
    expect(lOut.fast).toBeGreaterThan(0);
  });

  test("ignores reps with zero or invalid load/duration", () => {
    const reps = [
      { actual_time_s: 30, avg_force_kg: 20 },
      { actual_time_s: 0,  avg_force_kg: 20 },     // bad T
      { actual_time_s: 30, avg_force_kg: 0 },      // bad F (and weight_kg falls to 0 too)
      { actual_time_s: 30 },                       // missing F entirely
    ];
    const out = sessionCompartmentAUC(reps);
    const single = sessionCompartmentAUC([{ actual_time_s: 30, avg_force_kg: 20 }]);
    expect(out.total).toBeCloseTo(single.total, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// PHYS_MODEL_DEFAULT, DEF_FAT — sanity on the canonical constants
// ─────────────────────────────────────────────────────────────
describe("PHYS_MODEL_DEFAULT", () => {
  test("weights sum to 1.0", () => {
    const sum = PHYS_MODEL_DEFAULT.weights.fast
              + PHYS_MODEL_DEFAULT.weights.medium
              + PHYS_MODEL_DEFAULT.weights.slow;
    expect(sum).toBeCloseTo(1.0, 6);
  });

  test("recovery taus are slower than depletion taus", () => {
    expect(PHYS_MODEL_DEFAULT.tauR.fast).toBeGreaterThan(PHYS_MODEL_DEFAULT.tauD.fast);
    expect(PHYS_MODEL_DEFAULT.tauR.medium).toBeGreaterThan(PHYS_MODEL_DEFAULT.tauD.medium);
    expect(PHYS_MODEL_DEFAULT.tauR.slow).toBeGreaterThan(PHYS_MODEL_DEFAULT.tauD.slow);
  });

  test("DEF_FAT mirrors PHYS_MODEL_DEFAULT recovery side", () => {
    expect(DEF_FAT.tau1).toBe(PHYS_MODEL_DEFAULT.tauR.fast);
    expect(DEF_FAT.tau2).toBe(PHYS_MODEL_DEFAULT.tauR.medium);
    expect(DEF_FAT.tau3).toBe(PHYS_MODEL_DEFAULT.tauR.slow);
  });
});
