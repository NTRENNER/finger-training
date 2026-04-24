// Tests for src/model/threeExp.js — three-exponential F-D model.
// Covers fitThreeExpAmps (with and without prior + weights),
// fitThreeExpAmpsWithSuccessFloor, predForceThreeExp, buildThreeExpPriors.

import {
  THREE_EXP_LAMBDA_DEFAULT,
  fitThreeExpAmps, fitThreeExpAmpsWithSuccessFloor,
  predForceThreeExp, buildThreeExpPriors,
} from "../threeExp.js";
import { PHYS_MODEL_DEFAULT } from "../fatigue.js";

const TAU_D = [
  PHYS_MODEL_DEFAULT.tauD.fast,
  PHYS_MODEL_DEFAULT.tauD.medium,
  PHYS_MODEL_DEFAULT.tauD.slow,
];

// ─────────────────────────────────────────────────────────────
// fitThreeExpAmps — basic NNLS with optional prior + weights
// ─────────────────────────────────────────────────────────────
describe("fitThreeExpAmps", () => {
  test("returns prior copy when given no points", () => {
    const out = fitThreeExpAmps([], { prior: [10, 5, 2] });
    expect(out).toEqual([10, 5, 2]);
    // Should be a copy, not the same reference (so caller mutation is safe)
    out[0] = 999;
    const out2 = fitThreeExpAmps([], { prior: [10, 5, 2] });
    expect(out2[0]).toBe(10);
  });

  test("recovers known amplitudes from synthetic data", () => {
    // Build F(T) = 30*exp(-T/10) + 15*exp(-T/30) + 8*exp(-T/180)
    const trueAmps = [30, 15, 8];
    const Ts = [3, 7, 15, 30, 60, 120, 240];
    const pts = Ts.map(T => ({
      T,
      F: trueAmps[0]*Math.exp(-T/TAU_D[0])
       + trueAmps[1]*Math.exp(-T/TAU_D[1])
       + trueAmps[2]*Math.exp(-T/TAU_D[2]),
    }));
    const amps = fitThreeExpAmps(pts);
    // Allow some slack — three closely-spaced exponentials are notoriously
    // ill-conditioned, but with a clean signal we should be within 5%.
    expect(amps[0]).toBeCloseTo(trueAmps[0], 0);
    expect(amps[1]).toBeCloseTo(trueAmps[1], 0);
    expect(amps[2]).toBeCloseTo(trueAmps[2], 0);
  });

  test("returns non-negative amplitudes even for noisy data", () => {
    // Synthetic data with adversarial noise pushing toward negative amps.
    const pts = [
      { T: 5,  F: 10 },   // very low at short T (would want negative `a`)
      { T: 30, F: 15 },
      { T: 90, F: 12 },
    ];
    const amps = fitThreeExpAmps(pts);
    expect(amps[0]).toBeGreaterThanOrEqual(0);
    expect(amps[1]).toBeGreaterThanOrEqual(0);
    expect(amps[2]).toBeGreaterThanOrEqual(0);
  });

  test("shrinkage prior pulls fit toward prior when lambda is large", () => {
    const prior = [50, 25, 10];
    const pts = [{ T: 10, F: 1 }, { T: 30, F: 1 }];  // data wants tiny amps
    const noShrink = fitThreeExpAmps(pts, { prior, lambda: 0 });
    const heavyShrink = fitThreeExpAmps(pts, { prior, lambda: 10000 });
    // Heavy shrinkage should drag amplitudes toward prior, away from 0.
    const noShrinkSum = noShrink[0] + noShrink[1] + noShrink[2];
    const heavyShrinkSum = heavyShrink[0] + heavyShrink[1] + heavyShrink[2];
    expect(heavyShrinkSum).toBeGreaterThan(noShrinkSum);
    // And heavy shrinkage should land closer to the prior.
    const distTo = (a, b) =>
      Math.sqrt((a[0]-b[0])**2 + (a[1]-b[1])**2 + (a[2]-b[2])**2);
    expect(distTo(heavyShrink, prior)).toBeLessThan(distTo(noShrink, prior));
  });

  test("per-point weights bias the fit toward heavy-weight points", () => {
    const pts = [
      { T: 10, F: 50, w: 1 },
      { T: 30, F: 25, w: 1 },
      { T: 60, F: 18, w: 1 },
      { T: 30, F: 10, w: 100 },  // heavy outlier at T=30
    ];
    const amps = fitThreeExpAmps(pts);
    // The fit at T=30 should be pulled toward 10 (the outlier value),
    // not the unweighted ~25.
    const predAt30 = predForceThreeExp(amps, 30);
    expect(predAt30).toBeLessThan(20);
  });

  test("uses tauD basis by default (post-fix)", () => {
    // The fit should use depletion taus, not recovery. We verify by
    // checking that fitting clean data generated from tauD recovers
    // amps better than data generated from tauR would.
    const tauR = [
      PHYS_MODEL_DEFAULT.tauR.fast,
      PHYS_MODEL_DEFAULT.tauR.medium,
      PHYS_MODEL_DEFAULT.tauR.slow,
    ];
    const trueAmps = [25, 12, 5];
    const Ts = [5, 15, 45, 120];
    // Generate data with tauD (matches default)
    const ptsD = Ts.map(T => ({
      T,
      F: trueAmps[0]*Math.exp(-T/TAU_D[0])
       + trueAmps[1]*Math.exp(-T/TAU_D[1])
       + trueAmps[2]*Math.exp(-T/TAU_D[2]),
    }));
    // Generate matching data with tauR
    const ptsR = Ts.map(T => ({
      T,
      F: trueAmps[0]*Math.exp(-T/tauR[0])
       + trueAmps[1]*Math.exp(-T/tauR[1])
       + trueAmps[2]*Math.exp(-T/tauR[2]),
    }));
    const ampsD = fitThreeExpAmps(ptsD);   // should recover trueAmps
    const ampsR = fitThreeExpAmps(ptsR);   // basis mismatch → won't recover

    const errD = Math.abs(ampsD[0] - trueAmps[0])
              + Math.abs(ampsD[1] - trueAmps[1])
              + Math.abs(ampsD[2] - trueAmps[2]);
    const errR = Math.abs(ampsR[0] - trueAmps[0])
              + Math.abs(ampsR[1] - trueAmps[1])
              + Math.abs(ampsR[2] - trueAmps[2]);
    expect(errD).toBeLessThan(errR);
  });
});

// ─────────────────────────────────────────────────────────────
// fitThreeExpAmpsWithSuccessFloor — successes act as lower bounds
// ─────────────────────────────────────────────────────────────
describe("fitThreeExpAmpsWithSuccessFloor", () => {
  test("with no successes, matches the failure-only fit", () => {
    const failures = [
      { T: 10, F: 50 },
      { T: 30, F: 25 },
      { T: 60, F: 18 },
    ];
    const baseline = fitThreeExpAmps(failures);
    const withFloor = fitThreeExpAmpsWithSuccessFloor(failures, []);
    expect(withFloor[0]).toBeCloseTo(baseline[0], 4);
    expect(withFloor[1]).toBeCloseTo(baseline[1], 4);
    expect(withFloor[2]).toBeCloseTo(baseline[2], 4);
  });

  test("a success above the curve bumps the curve up at that T", () => {
    const failures = [
      { T: 10, F: 50 },
      { T: 30, F: 25 },
      { T: 60, F: 18 },
    ];
    // Success at T=45 with F=30 (above what the failure curve predicts)
    const successes = [{ T: 45, F: 30 }];
    const baseline = fitThreeExpAmps(failures);
    const withFloor = fitThreeExpAmpsWithSuccessFloor(failures, successes);
    const baselinePred = predForceThreeExp(baseline, 45);
    const floorPred = predForceThreeExp(withFloor, 45);
    expect(floorPred).toBeGreaterThan(baselinePred);
    expect(floorPred).toBeGreaterThanOrEqual(30 - 0.5);
  });

  test("returns null when both lists are empty", () => {
    expect(fitThreeExpAmpsWithSuccessFloor([], [])).toBeNull();
    expect(fitThreeExpAmpsWithSuccessFloor([{ T: 10, F: 30 }], [])).toBeNull();
  });

  test("successes far below the curve are non-binding", () => {
    const failures = [
      { T: 10, F: 50 },
      { T: 30, F: 25 },
      { T: 60, F: 18 },
    ];
    const successes = [{ T: 45, F: 5 }];  // way below
    const baseline = fitThreeExpAmps(failures);
    const withFloor = fitThreeExpAmpsWithSuccessFloor(failures, successes);
    expect(withFloor[0]).toBeCloseTo(baseline[0], 4);
    expect(withFloor[1]).toBeCloseTo(baseline[1], 4);
    expect(withFloor[2]).toBeCloseTo(baseline[2], 4);
  });
});

// ─────────────────────────────────────────────────────────────
// predForceThreeExp — analytical evaluation
// ─────────────────────────────────────────────────────────────
describe("predForceThreeExp", () => {
  test("evaluates F(T) at given T", () => {
    const amps = [10, 5, 2];
    const T = 30;
    const expected = 10*Math.exp(-T/TAU_D[0])
                   + 5*Math.exp(-T/TAU_D[1])
                   + 2*Math.exp(-T/TAU_D[2]);
    expect(predForceThreeExp(amps, T)).toBeCloseTo(expected, 6);
  });

  test("F(0) = a + b + c (sum of amplitudes)", () => {
    const amps = [10, 5, 2];
    expect(predForceThreeExp(amps, 0)).toBeCloseTo(17, 6);
  });

  test("F(T) → 0 as T → ∞ (no asymptote — all terms decay)", () => {
    const amps = [10, 5, 2];
    expect(predForceThreeExp(amps, 10000)).toBeLessThan(0.01);
  });

  test("accepts custom taus", () => {
    const amps = [10, 0, 0];
    const out = predForceThreeExp(amps, 5, [5, 1000, 1000]);
    // exp(-5/5) = exp(-1) ≈ 0.368
    expect(out).toBeCloseTo(10 * Math.exp(-1), 4);
  });
});

// ─────────────────────────────────────────────────────────────
// buildThreeExpPriors — pool failures by grip across hands
// ─────────────────────────────────────────────────────────────
describe("buildThreeExpPriors", () => {
  test("produces one prior per grip with ≥2 failures", () => {
    const history = [
      { failed: true, grip: "Crusher", hand: "L", actual_time_s: 10, avg_force_kg: 50 },
      { failed: true, grip: "Crusher", hand: "R", actual_time_s: 30, avg_force_kg: 25 },
      { failed: true, grip: "Crusher", hand: "L", actual_time_s: 60, avg_force_kg: 18 },
      { failed: true, grip: "Micro",   hand: "L", actual_time_s: 10, avg_force_kg: 20 },
      { failed: true, grip: "Micro",   hand: "R", actual_time_s: 30, avg_force_kg: 12 },
    ];
    const priors = buildThreeExpPriors(history);
    expect(priors.has("Crusher")).toBe(true);
    expect(priors.has("Micro")).toBe(true);
    expect(priors.get("Crusher").length).toBe(3);
    expect(priors.get("Micro").length).toBe(3);
  });

  test("skips grips with fewer than 2 failures", () => {
    const history = [
      { failed: true, grip: "Crusher", hand: "L", actual_time_s: 10, avg_force_kg: 50 },
      { failed: true, grip: "Crusher", hand: "R", actual_time_s: 30, avg_force_kg: 25 },
      { failed: true, grip: "OnlyOne", hand: "L", actual_time_s: 10, avg_force_kg: 20 },
    ];
    const priors = buildThreeExpPriors(history);
    expect(priors.has("Crusher")).toBe(true);
    expect(priors.has("OnlyOne")).toBe(false);
  });

  test("ignores successes, missing fields, and out-of-range forces", () => {
    const history = [
      { failed: false, grip: "Crusher", actual_time_s: 10, avg_force_kg: 50 }, // success
      { failed: true,  grip: null,      actual_time_s: 10, avg_force_kg: 50 }, // no grip
      { failed: true,  grip: "Crusher", actual_time_s: 0,  avg_force_kg: 50 }, // bad T
      { failed: true,  grip: "Crusher", actual_time_s: 10, avg_force_kg: 0 },  // bad F
      { failed: true,  grip: "Crusher", actual_time_s: 10, avg_force_kg: 600 }, // out-of-range F
    ];
    const priors = buildThreeExpPriors(history);
    expect(priors.size).toBe(0);
  });

  test("returns empty map for empty history", () => {
    expect(buildThreeExpPriors([]).size).toBe(0);
    expect(buildThreeExpPriors(null).size).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// THREE_EXP_LAMBDA_DEFAULT — sanity check that the constant exists
// ─────────────────────────────────────────────────────────────
describe("THREE_EXP_LAMBDA_DEFAULT", () => {
  test("is a positive number", () => {
    expect(typeof THREE_EXP_LAMBDA_DEFAULT).toBe("number");
    expect(THREE_EXP_LAMBDA_DEFAULT).toBeGreaterThan(0);
  });
});
