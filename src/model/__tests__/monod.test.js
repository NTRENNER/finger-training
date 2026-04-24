// Tests for src/model/monod.js — Monod-Scherrer F-D model.
// Covers fitCF (failure-only OLS), fitCFWithSuccessFloor (success
// constraints), predForce, computeAUC, fitAdaptiveHandCurve.

import {
  fitCF, fitCFWeighted, fitCFWithSuccessFloor,
  predForce, computeAUC, fitAdaptiveHandCurve,
} from "../monod.js";

// ─────────────────────────────────────────────────────────────
// fitCF — failure-only OLS on 1/T vs F
// ─────────────────────────────────────────────────────────────
describe("fitCF", () => {
  test("recovers known CF and W' from clean synthetic data", () => {
    // F = 20 + 200/T  →  CF=20, W'=200
    const pts = [10, 30, 60, 120].map(T => ({ x: 1/T, y: 20 + 200/T }));
    const fit = fitCF(pts);
    expect(fit).not.toBeNull();
    expect(fit.CF).toBeCloseTo(20, 6);
    expect(fit.W).toBeCloseTo(200, 6);
    expect(fit.n).toBe(4);
  });

  test("returns null for fewer than 2 points", () => {
    expect(fitCF([])).toBeNull();
    expect(fitCF([{ x: 0.1, y: 30 }])).toBeNull();
    expect(fitCF(null)).toBeNull();
  });

  test("returns null when fit is degenerate (all same x)", () => {
    const pts = [
      { x: 0.1, y: 30 },
      { x: 0.1, y: 32 },
      { x: 0.1, y: 28 },
    ];
    expect(fitCF(pts)).toBeNull();
  });

  test("returns null for unphysical fits (CF < 0 or W < 0)", () => {
    // Force a negative-slope fit: high y at low T... wait that's normal.
    // The rejection fires when CF or W comes out negative. Construct a
    // dataset where CF would solve to negative.
    // F decreasing as 1/T increases → negative slope (negative W').
    const pts = [
      { x: 0.01, y: 50 },  // T=100
      { x: 0.10, y: 30 },  // T=10
    ];
    expect(fitCF(pts)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// fitCFWeighted — same model, with per-point weights
// ─────────────────────────────────────────────────────────────
describe("fitCFWeighted", () => {
  test("matches fitCF when all weights are 1", () => {
    const pts = [10, 30, 60, 120].map(T => ({ x: 1/T, y: 20 + 200/T, w: 1 }));
    const fit = fitCFWeighted(pts);
    expect(fit.CF).toBeCloseTo(20, 6);
    expect(fit.W).toBeCloseTo(200, 6);
  });

  test("a high-weight point pulls the curve toward it", () => {
    // Five clean points + one outlier with high weight → curve shifts.
    const pts = [
      { x: 1/10,  y: 50, w: 1 },
      { x: 1/30,  y: 27, w: 1 },
      { x: 1/60,  y: 23, w: 1 },
      { x: 1/120, y: 22, w: 1 },
      { x: 1/45,  y: 30, w: 100 },  // outlier with 100x weight
    ];
    const fit = fitCFWeighted(pts);
    const fitNoOutlier = fitCF(pts.slice(0, 4));
    expect(fit).not.toBeNull();
    expect(fitNoOutlier).not.toBeNull();
    // The pull should make the prediction at T=45 closer to 30 than the
    // unweighted fit predicts.
    const predOutlierT = fit.CF + fit.W / 45;
    const predNoOutlierT = fitNoOutlier.CF + fitNoOutlier.W / 45;
    expect(Math.abs(predOutlierT - 30)).toBeLessThan(Math.abs(predNoOutlierT - 30));
  });

  test("ignores points with zero or negative weight", () => {
    const pts = [
      { x: 1/10,  y: 50, w: 1 },
      { x: 1/30,  y: 27, w: 1 },
      { x: 1/60,  y: 999, w: 0 },  // ignored
      { x: 1/120, y: 22, w: 1 },
    ];
    const fit = fitCFWeighted(pts);
    const fitNoZero = fitCFWeighted([
      { x: 1/10,  y: 50, w: 1 },
      { x: 1/30,  y: 27, w: 1 },
      { x: 1/120, y: 22, w: 1 },
    ]);
    expect(fit.CF).toBeCloseTo(fitNoZero.CF, 6);
    expect(fit.W).toBeCloseTo(fitNoZero.W, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// fitCFWithSuccessFloor — failures anchor, successes lower-bound
// ─────────────────────────────────────────────────────────────
describe("fitCFWithSuccessFloor", () => {
  test("with no successes, matches the failure-only fit", () => {
    const failPts = [10, 30, 60, 120].map(T => ({ x: 1/T, y: 20 + 200/T }));
    const baseline = fitCF(failPts);
    const withFloor = fitCFWithSuccessFloor(failPts, []);
    expect(withFloor).not.toBeNull();
    expect(withFloor.CF).toBeCloseTo(baseline.CF, 4);
    expect(withFloor.W).toBeCloseTo(baseline.W, 4);
  });

  test("a success above the curve bumps the curve up at that T", () => {
    // Failures define a curve that predicts F(45) = 24.4 kg.
    const failPts = [10, 30, 60, 120].map(T => ({ x: 1/T, y: 20 + 200/T }));
    // Now claim a success at T=45 with F=30 (above the curve).
    const succPts = [{ x: 1/45, y: 30 }];
    const baseline = fitCF(failPts);
    const withFloor = fitCFWithSuccessFloor(failPts, succPts);
    const baselinePred45 = baseline.CF + baseline.W / 45;
    const floorPred45 = withFloor.CF + withFloor.W / 45;
    // The success-floor fit should predict at-or-above 30 at T=45,
    // strictly higher than the failure-only baseline.
    expect(floorPred45).toBeGreaterThan(baselinePred45);
    expect(floorPred45).toBeGreaterThanOrEqual(30 - 0.1);  // tol matches algorithm
  });

  test("successes below the curve don't disturb it", () => {
    const failPts = [10, 30, 60, 120].map(T => ({ x: 1/T, y: 20 + 200/T }));
    const succPts = [{ x: 1/45, y: 10 }];  // way below curve at 45s
    const baseline = fitCF(failPts);
    const withFloor = fitCFWithSuccessFloor(failPts, succPts);
    expect(withFloor.CF).toBeCloseTo(baseline.CF, 4);
    expect(withFloor.W).toBeCloseTo(baseline.W, 4);
  });

  test("returns null when both lists are too small", () => {
    expect(fitCFWithSuccessFloor([], [])).toBeNull();
    expect(fitCFWithSuccessFloor([{ x: 0.1, y: 30 }], [])).toBeNull();
  });

  test("works with successes only when failures are empty", () => {
    // Two successes: the floor-iteration should fit a curve that
    // passes through (or above) both.
    const succPts = [
      { x: 1/10, y: 40 },
      { x: 1/60, y: 25 },
    ];
    const fit = fitCFWithSuccessFloor([], succPts);
    expect(fit).not.toBeNull();
    expect(fit.CF + fit.W / 10).toBeGreaterThanOrEqual(40 - 0.5);
    expect(fit.CF + fit.W / 60).toBeGreaterThanOrEqual(25 - 0.5);
  });
});

// ─────────────────────────────────────────────────────────────
// predForce, computeAUC — analytical helpers
// ─────────────────────────────────────────────────────────────
describe("predForce", () => {
  test("evaluates F(T) = CF + W/T at the given T", () => {
    const fit = { CF: 20, W: 200 };
    expect(predForce(fit, 10)).toBeCloseTo(40, 6);
    expect(predForce(fit, 100)).toBeCloseTo(22, 6);
  });
});

describe("computeAUC", () => {
  test("integrates F = CF + W/t analytically", () => {
    // ∫(CF + W/t)dt from a to b = CF*(b-a) + W*ln(b/a)
    const auc = computeAUC(20, 200, 10, 100);
    const expected = 20 * (100 - 10) + 200 * Math.log(100 / 10);
    expect(auc).toBeCloseTo(expected, 6);
  });

  test("uses default T range (10..120)", () => {
    const auc = computeAUC(20, 200);
    const expected = 20 * (120 - 10) + 200 * Math.log(120 / 10);
    expect(auc).toBeCloseTo(expected, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// fitAdaptiveHandCurve — pools when symmetric, picks ceiling when not
// ─────────────────────────────────────────────────────────────
describe("fitAdaptiveHandCurve", () => {
  // Build matching L and R rows with same CF (symmetric case)
  const makeRow = (hand, T, F) => ({
    hand, target_duration: T, actual_time_s: T, avg_force_kg: F, failed: true,
  });
  const symmetric = [
    makeRow("L", 10, 40), makeRow("L", 30, 26), makeRow("L", 60, 23),
    makeRow("R", 10, 40), makeRow("R", 30, 26), makeRow("R", 60, 23),
  ];

  test("pools when L and R have similar CFs", () => {
    const fit = fitAdaptiveHandCurve(symmetric);
    expect(fit).not.toBeNull();
    expect(fit.n).toBe(6);  // pooled
  });

  test("picks the stronger hand when CFs diverge by >tolerance", () => {
    const asymmetric = [
      // L is much weaker
      makeRow("L", 10, 20), makeRow("L", 30, 13), makeRow("L", 60, 11),
      // R is much stronger
      makeRow("R", 10, 50), makeRow("R", 30, 35), makeRow("R", 60, 30),
    ];
    const fit = fitAdaptiveHandCurve(asymmetric);
    expect(fit).not.toBeNull();
    // Should pick the R-only fit (3 points, not 6 pooled)
    expect(fit.n).toBe(3);
  });

  test("returns null when neither hand has 2+ distinct durations", () => {
    const sparse = [
      makeRow("L", 30, 26),
      makeRow("R", 30, 26),
    ];
    expect(fitAdaptiveHandCurve(sparse)).toBeNull();
  });
});
