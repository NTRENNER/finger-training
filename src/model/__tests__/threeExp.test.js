// Tests for src/model/threeExp.js — three-exponential F-D model.
// Covers fitThreeExpAmps (with and without prior + weights),
// predForceThreeExp, buildThreeExpPriors.

import {
  THREE_EXP_LAMBDA_DEFAULT,
  fitThreeExpAmps, fitThreeExpAmpsLOO,
  predForceThreeExp, buildThreeExpPriors,
  computeZoneShares, ZONE_SHARE_BUCKETS,
  THREE_EXP_TAUS,
} from "../threeExp.js";
import { PHYS_MODEL_DEFAULT } from "../fatigue.js";
// These tests exercise the F-D curve functions (fit / predForce), which
// default to THREE_EXP_TAUS — decoupled from the fatigue depletion tauD
// at the slow constant (July 2026). Generate + verify against the curve
// taus so synthetic round-trips stay self-consistent.
const TAU_D = THREE_EXP_TAUS;

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
    // Build F(T) from the curve taus (THREE_EXP_TAUS) so a clean
    // synthetic signal round-trips back to the amplitudes.
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

  test("uses the THREE_EXP_TAUS curve basis by default (not recovery taus)", () => {
    // The fit should use the curve envelope taus (THREE_EXP_TAUS), not the
    // recovery taus. We verify by checking that clean data generated from
    // the curve taus recovers amps better than data generated from tauR.
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

  test("skips grips with fewer than 2 data points", () => {
    const history = [
      { grip: "Crusher", hand: "L", actual_time_s: 10, avg_force_kg: 50 },
      { grip: "Crusher", hand: "R", actual_time_s: 30, avg_force_kg: 25 },
      { grip: "OnlyOne", hand: "L", actual_time_s: 10, avg_force_kg: 20 },
    ];
    const priors = buildThreeExpPriors(history);
    expect(priors.has("Crusher")).toBe(true);
    expect(priors.has("OnlyOne")).toBe(false);
  });

  test("treats every rep as a data point regardless of failed flag", () => {
    // Train-to-failure model: legacy `failed` flag no longer gates.
    // Both 'failures' (failed: true) and 'successes' (failed: false)
    // contribute to the prior — every rep is a (T, F) data point.
    const history = [
      { failed: true,  grip: "Crusher", actual_time_s: 10, avg_force_kg: 50 },
      { failed: false, grip: "Crusher", actual_time_s: 30, avg_force_kg: 25 },
    ];
    const priors = buildThreeExpPriors(history);
    expect(priors.has("Crusher")).toBe(true);
  });

  test("ignores missing fields and out-of-range forces", () => {
    const history = [
      { grip: null,      actual_time_s: 10, avg_force_kg: 50 }, // no grip
      { grip: "Crusher", actual_time_s: 0,  avg_force_kg: 50 }, // bad T
      { grip: "Crusher", actual_time_s: 10, avg_force_kg: 0 },  // bad F
      { grip: "Crusher", actual_time_s: 10, avg_force_kg: 600 }, // out-of-range F
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

// ─────────────────────────────────────────────────────────────
// fitThreeExpAmpsLOO — closed-form leave-one-out residual ratios
// ─────────────────────────────────────────────────────────────
describe("fitThreeExpAmpsLOO", () => {
  test("returns the same amps as fitThreeExpAmps plus aligned ratios", () => {
    const pts = [{T:5,F:60},{T:30,F:40},{T:115,F:22}];
    const plain = fitThreeExpAmps(pts, { lambda: 0 });
    const { amps, ratios } = fitThreeExpAmpsLOO(pts, { lambda: 0 });
    expect(amps).toEqual(plain);
    expect(ratios).toHaveLength(pts.length);
  });

  test("empty input → empty ratios, no throw", () => {
    const { ratios } = fitThreeExpAmpsLOO([], { lambda: 0 });
    expect(ratios).toEqual([]);
  });

  test("LOO residuals are MORE pronounced than in-sample (de-biasing)", () => {
    // A clean curve plus one under-performing point. Leaving that point
    // out makes the fit predict higher there, so its LOO ratio sits
    // further below 1 than the in-sample ratio — the whole purpose of
    // the closed-form LOO: the in-sample fit chases its own outlier.
    const base = [
      {T:5,F:60},{T:10,F:54},{T:30,F:40},{T:60,F:31},{T:120,F:23},{T:180,F:19},
    ];
    const lowIdx = 2;                 // the 30s point, pulled 30% low
    const pts = base.map((p, i) => i === lowIdx ? { ...p, F: p.F * 0.7 } : p);
    const { amps, ratios } = fitThreeExpAmpsLOO(pts, { lambda: 0 });
    const inSample = pts[lowIdx].F / predForceThreeExp(amps, pts[lowIdx].T);
    const loo = ratios[lowIdx];
    expect(loo).toBeLessThan(1);            // still reads as below-curve
    expect(loo).toBeLessThan(inSample);     // and MORE so than in-sample
  });

  test("leverage floor prevents blow-ups on a high-leverage lone point", () => {
    // One isolated long-duration point (high leverage) shouldn't produce
    // an absurd ratio; the (1 - h) floor keeps it finite and sane.
    const pts = [{T:5,F:60},{T:8,F:56},{T:10,F:53},{T:200,F:14}];
    const { ratios } = fitThreeExpAmpsLOO(pts, { lambda: 0 });
    for (const r of ratios) {
      expect(Number.isFinite(r)).toBe(true);
      expect(r).toBeGreaterThan(0);
      expect(r).toBeLessThan(5);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// computeZoneShares — capacity-shape decomposition
// ─────────────────────────────────────────────────────────────
describe("computeZoneShares", () => {
  test("null on unusable amps", () => {
    expect(computeZoneShares(null)).toBeNull();
    expect(computeZoneShares([1, 2])).toBeNull();
    expect(computeZoneShares([0, 0, 0])).toBeNull();
  });

  test("buckets cover all six zones exactly once", () => {
    const all = Object.values(ZONE_SHARE_BUCKETS).flat();
    expect(all.sort()).toEqual([
      "endurance", "max_strength", "power",
      "power_strength", "strength", "strength_endurance",
    ].sort());
    expect(all.length).toBe(6);
  });

  test("shares are positive and sum to ~100", () => {
    const s = computeZoneShares([30, 12, 6]);
    expect(s).not.toBeNull();
    const sum = s.power + s.strength + s.endurance;
    expect(sum).toBeGreaterThan(99.5);
    expect(sum).toBeLessThan(100.5);
    for (const v of Object.values(s)) expect(v).toBeGreaterThan(0);
  });

  test("a slow-heavy curve has a higher endurance share than a fast-heavy one", () => {
    const fastHeavy = computeZoneShares([40, 8, 3]);
    const slowHeavy = computeZoneShares([10, 8, 12]);
    expect(slowHeavy.endurance).toBeGreaterThan(fastHeavy.endurance);
    expect(fastHeavy.power).toBeGreaterThan(slowHeavy.power);
  });

  test("shape is scale-invariant — doubling every amp leaves shares unchanged", () => {
    const a = computeZoneShares([30, 12, 6]);
    const b = computeZoneShares([60, 24, 12]);
    expect(b.power).toBeCloseTo(a.power, 1);
    expect(b.strength).toBeCloseTo(a.strength, 1);
    expect(b.endurance).toBeCloseTo(a.endurance, 1);
  });
});
