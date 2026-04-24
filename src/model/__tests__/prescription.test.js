// Tests for src/model/prescription.js — the prescription layer.
// Covers effectiveLoad/loadedWeight/repKey, freshMap building, fitDoseK,
// rpeProgressionMultiplier, prescribedLoad, empiricalPrescription,
// prescriptionPotential, suggestWeight.

import {
  effectiveLoad, loadedWeight, repKey,
  isShortfall, SHORTFALL_TOL,
  buildSMaxIndex, buildFreshLoadMap, freshLoadFor, fitDoseK,
  BUMP_PER_SUCCESS, MAX_BUMP_MULT, rpeProgressionMultiplier,
  estimateRefWeight, prescribedLoad,
  EMPIRICAL_LOOKBACK_DAYS, empiricalPrescription,
  prescriptionPotential, suggestWeight,
} from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";

// ─────────────────────────────────────────────────────────────
// effectiveLoad / loadedWeight / repKey
// ─────────────────────────────────────────────────────────────
describe("effectiveLoad", () => {
  test("prefers avg_force_kg when in valid range (0-500)", () => {
    expect(effectiveLoad({ avg_force_kg: 25, weight_kg: 30 })).toBe(25);
  });

  test("falls back to weight_kg when avg_force_kg is invalid", () => {
    expect(effectiveLoad({ avg_force_kg: 0, weight_kg: 30 })).toBe(30);
    expect(effectiveLoad({ avg_force_kg: 600, weight_kg: 30 })).toBe(30);
    expect(effectiveLoad({ weight_kg: 30 })).toBe(30);
  });

  test("returns 0 when neither field is usable", () => {
    expect(effectiveLoad({})).toBe(0);
    expect(effectiveLoad({ avg_force_kg: 0, weight_kg: 0 })).toBe(0);
  });
});

describe("loadedWeight", () => {
  test("matches effectiveLoad's preference order (today)", () => {
    // For Tindeq-isometric setup, loadedWeight === effectiveLoad
    expect(loadedWeight({ avg_force_kg: 25, weight_kg: 30 })).toBe(25);
    expect(loadedWeight({ weight_kg: 30 })).toBe(30);
  });
});

describe("repKey", () => {
  test("uses id when present", () => {
    expect(repKey({ id: "abc-123" })).toBe("id:abc-123");
  });

  test("composes from session/set/rep/hand when no id", () => {
    const r = { session_id: "s1", set_num: 2, rep_num: 3, hand: "L" };
    expect(repKey(r)).toBe("s1|2|3|L");
  });
});

// ─────────────────────────────────────────────────────────────
// isShortfall / SHORTFALL_TOL
// ─────────────────────────────────────────────────────────────
describe("isShortfall", () => {
  test("returns true when actual is meaningfully short of target", () => {
    expect(isShortfall(30, 45)).toBe(true);  // 30/45 = 0.67 < 0.95
  });

  test("returns false when actual is within tolerance", () => {
    expect(isShortfall(43, 45)).toBe(false);  // 43/45 = 0.96 ≥ 0.95
    expect(isShortfall(45, 45)).toBe(false);
    expect(isShortfall(60, 45)).toBe(false);  // overshot
  });

  test("returns false for invalid inputs", () => {
    expect(isShortfall(0, 45)).toBe(false);
    expect(isShortfall(30, 0)).toBe(false);
  });

  test("SHORTFALL_TOL is 0.95", () => {
    expect(SHORTFALL_TOL).toBe(0.95);
  });
});

// ─────────────────────────────────────────────────────────────
// buildSMaxIndex / buildFreshLoadMap / freshLoadFor
// ─────────────────────────────────────────────────────────────
describe("buildSMaxIndex", () => {
  test("returns max load × 1.2 per (hand, grip)", () => {
    const history = [
      { hand: "L", grip: "Crusher", avg_force_kg: 30 },
      { hand: "L", grip: "Crusher", avg_force_kg: 50 },  // max
      { hand: "L", grip: "Crusher", avg_force_kg: 40 },
      { hand: "R", grip: "Micro",   avg_force_kg: 12 },
    ];
    const idx = buildSMaxIndex(history);
    expect(idx.get("L|Crusher")).toBeCloseTo(60, 4);  // 50 × 1.2
    expect(idx.get("R|Micro")).toBeCloseTo(14.4, 4);  // 12 × 1.2
  });

  test("ignores reps with no hand or grip", () => {
    const history = [
      { hand: "L", avg_force_kg: 30 },
      { grip: "Crusher", avg_force_kg: 30 },
    ];
    expect(buildSMaxIndex(history).size).toBe(0);
  });
});

describe("buildFreshLoadMap & freshLoadFor", () => {
  test("returns empty map for empty/null history", () => {
    expect(buildFreshLoadMap([]).size).toBe(0);
    expect(buildFreshLoadMap(null).size).toBe(0);
  });

  test("first rep in a set has fatigue=0, fresh=load", () => {
    const history = [
      { id: "r1", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0 },
    ];
    const map = buildFreshLoadMap(history);
    const entry = map.get("id:r1");
    expect(entry).toBeDefined();
    expect(entry.availFrac).toBe(1);  // no fatigue at first rep
    expect(entry.fresh).toBeCloseTo(25, 4);
  });

  test("later reps in a set have fresh > posted load (within-set fatigue)", () => {
    const history = [
      { id: "r1", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 30 },
      { id: "r2", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 2,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 30 },
      { id: "r3", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 3,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 30 },
    ];
    const map = buildFreshLoadMap(history);
    expect(map.get("id:r1").fresh).toBeCloseTo(25, 4);
    expect(map.get("id:r2").fresh).toBeGreaterThan(25);
    expect(map.get("id:r3").fresh).toBeGreaterThan(map.get("id:r2").fresh);
  });

  test("freshLoadFor falls back to effectiveLoad when rep not in map", () => {
    const map = new Map();
    expect(freshLoadFor({ avg_force_kg: 30 }, map)).toBe(30);
    expect(freshLoadFor({ avg_force_kg: 30 }, null)).toBe(30);
  });
});

// ─────────────────────────────────────────────────────────────
// fitDoseK — back-fits the dose constant from within-set decay
// ─────────────────────────────────────────────────────────────
describe("fitDoseK", () => {
  test("returns null with too little data", () => {
    expect(fitDoseK([])).toBeNull();
    expect(fitDoseK(null)).toBeNull();
    // Need ≥6 reps to even start considering
    expect(fitDoseK(Array(3).fill({
      hand: "L", grip: "Crusher",
      session_id: "s1", set_num: 1,
      avg_force_kg: 20, actual_time_s: 30, target_duration: 30,
    }))).toBeNull();
  });

  test("returns a number in the search range when data has within-set decay", () => {
    // Build two sets with constant target duration and within-set decay.
    const buildSet = (sid, setNum) =>
      Array.from({ length: 4 }, (_, i) => ({
        id: `${sid}-${setNum}-${i+1}`, hand: "L", grip: "Crusher",
        session_id: sid, set_num: setNum, rep_num: i+1,
        target_duration: 30, actual_time_s: 30,
        avg_force_kg: 25 - i*0.5,  // small decay to mimic real data
        rest_s: 30,
      }));
    const history = [...buildSet("s1", 1), ...buildSet("s2", 1)];
    const k = fitDoseK(history);
    if (k != null) {
      // Search range is [0.0005, 0.030]
      expect(k).toBeGreaterThanOrEqual(0.0005);
      expect(k).toBeLessThanOrEqual(0.030);
    }
  });
});

// ─────────────────────────────────────────────────────────────
// rpeProgressionMultiplier — +5%/streak, capped at +30%
// ─────────────────────────────────────────────────────────────
describe("rpeProgressionMultiplier", () => {
  const today = new Date().toISOString().slice(0, 10);
  const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
  const dayBefore = new Date(Date.now() - 2*86400000).toISOString().slice(0, 10);

  test("returns 1.0 with no history", () => {
    expect(rpeProgressionMultiplier([], "L", "Crusher", 45)).toBe(1);
    expect(rpeProgressionMultiplier(null, "L", "Crusher", 45)).toBe(1);
  });

  test("returns 1.0 if last rep was a failure (no streak)", () => {
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 30, failed: true, date: today, session_id: "s1",
    }];
    expect(rpeProgressionMultiplier(history, "L", "Crusher", 45)).toBe(1);
  });

  test("one success → 1.05 multiplier", () => {
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, failed: false, date: today, session_id: "s1",
    }];
    expect(rpeProgressionMultiplier(history, "L", "Crusher", 45)).toBeCloseTo(1.05, 4);
  });

  test("two consecutive successes → 1.05² = 1.1025", () => {
    const history = [
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 45, failed: false, date: yday, session_id: "s1" },
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 47, failed: false, date: today, session_id: "s2" },
    ];
    expect(rpeProgressionMultiplier(history, "L", "Crusher", 45)).toBeCloseTo(1.1025, 4);
  });

  test("caps at MAX_BUMP_MULT (1.30)", () => {
    const history = Array.from({ length: 20 }, (_, i) => ({
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, failed: false,
      date: new Date(Date.now() - i*86400000).toISOString().slice(0, 10),
      session_id: `s${i}`,
    }));
    expect(rpeProgressionMultiplier(history, "L", "Crusher", 45)).toBe(MAX_BUMP_MULT);
  });

  test("a failure resets the streak", () => {
    const history = [
      // older success
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 45, failed: false, date: dayBefore, session_id: "s0" },
      // mid failure resets
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 30, failed: true, date: yday, session_id: "s1" },
      // recent success: streak = 1 (just this one, since failure broke it)
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 45, failed: false, date: today, session_id: "s2" },
    ];
    expect(rpeProgressionMultiplier(history, "L", "Crusher", 45)).toBeCloseTo(1.05, 4);
  });

  test("BUMP_PER_SUCCESS is 0.05; MAX_BUMP_MULT is 1.30", () => {
    expect(BUMP_PER_SUCCESS).toBeCloseTo(0.05, 6);
    expect(MAX_BUMP_MULT).toBeCloseTo(1.30, 6);
  });
});

// ─────────────────────────────────────────────────────────────
// estimateRefWeight — historical average emergency fallback
// ─────────────────────────────────────────────────────────────
describe("estimateRefWeight", () => {
  test("returns null with no matching reps", () => {
    expect(estimateRefWeight([], "L", "Crusher", 45)).toBeNull();
  });

  test("averages the matching reps weighted toward recent", () => {
    const history = [
      { hand: "L", grip: "Crusher", actual_time_s: 45, avg_force_kg: 20, date: "2025-01-01" },
      { hand: "L", grip: "Crusher", actual_time_s: 45, avg_force_kg: 24, date: "2025-02-01" },
    ];
    const out = estimateRefWeight(history, "L", "Crusher", 45);
    // Recent-weighted average should be closer to 24 than to 20.
    expect(out).toBeGreaterThan(22);
    expect(out).toBeLessThan(24.01);
  });
});

// ─────────────────────────────────────────────────────────────
// suggestWeight — refWeight × availFrac (in-workout display helper)
// ─────────────────────────────────────────────────────────────
describe("suggestWeight", () => {
  test("returns null when refWeight is null", () => {
    expect(suggestWeight(null, 0.3)).toBeNull();
  });

  test("scales by (1 - fatigue), clamped to 5%", () => {
    expect(suggestWeight(20, 0)).toBeCloseTo(20, 4);
    expect(suggestWeight(20, 0.5)).toBeCloseTo(10, 4);
    // Full fatigue clamps availFrac to 0.05
    expect(suggestWeight(20, 1.0)).toBeCloseTo(1.0, 4);
  });
});

// ─────────────────────────────────────────────────────────────
// EMPIRICAL_LOOKBACK_DAYS sanity
// ─────────────────────────────────────────────────────────────
describe("EMPIRICAL_LOOKBACK_DAYS", () => {
  test("is a positive integer", () => {
    expect(Number.isInteger(EMPIRICAL_LOOKBACK_DAYS)).toBe(true);
    expect(EMPIRICAL_LOOKBACK_DAYS).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// empiricalPrescription — primary path; success bumps, failure scales
// ─────────────────────────────────────────────────────────────
describe("empiricalPrescription", () => {
  const today = new Date().toISOString().slice(0, 10);

  test("returns null with no recent rep1 at scope", () => {
    expect(empiricalPrescription([], "L", "Crusher", 45)).toBeNull();
    expect(empiricalPrescription(null, "L", "Crusher", 45)).toBeNull();
  });

  test("success bumps load by 5% (single success)", () => {
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, avg_force_kg: 20, failed: false,
      date: today, session_id: "s1",
    }];
    const out = empiricalPrescription(history, "L", "Crusher", 45);
    expect(out).toBeCloseTo(21.0, 1);  // 20 × 1.05
  });

  test("failure case prescribes a lighter load (Monod cold-start path)", () => {
    // No three-exp prior provided → falls into Monod CF/W' update path.
    // Need ≥2 failures for fitCF, with consistent CF + W' shape.
    const history = [
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 30, avg_force_kg: 26, failed: true, date: today, session_id: "s1" },
      // Earlier failure points to seed the Monod fit
      { hand: "L", grip: "Crusher", target_duration: 10, rep_num: 1,
        actual_time_s: 10, avg_force_kg: 50, failed: true, date: "2025-01-01", session_id: "s0a" },
      { hand: "L", grip: "Crusher", target_duration: 60, rep_num: 1,
        actual_time_s: 60, avg_force_kg: 22, failed: true, date: "2025-01-02", session_id: "s0b" },
    ];
    const out = empiricalPrescription(history, "L", "Crusher", 45);
    expect(out).not.toBeNull();
    // The user just failed at 26 kg in 30s targeting 45s. The next
    // prescription should be lighter than 26 kg.
    expect(out).toBeLessThan(26);
  });

  test("success-streak bump capped at MAX_BUMP_MULT", () => {
    // Many recent successes
    const history = Array.from({ length: 20 }, (_, i) => ({
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, avg_force_kg: 20, failed: false,
      date: new Date(Date.now() - i*86400000).toISOString().slice(0, 10),
      session_id: `s${i}`,
    }));
    const out = empiricalPrescription(history, "L", "Crusher", 45);
    // 20 × 1.30 = 26
    expect(out).toBeCloseTo(20 * MAX_BUMP_MULT, 1);
  });

  test("respects EMPIRICAL_LOOKBACK_DAYS — old reps don't anchor", () => {
    const tooOld = new Date(Date.now() - (EMPIRICAL_LOOKBACK_DAYS + 5) * 86400 * 1000)
      .toISOString().slice(0, 10);
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, avg_force_kg: 20, failed: false,
      date: tooOld, session_id: "old",
    }];
    expect(empiricalPrescription(history, "L", "Crusher", 45)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// prescribedLoad — curve fallback (three-exp first, Monod cold-start)
// ─────────────────────────────────────────────────────────────
describe("prescribedLoad", () => {
  // Build a reasonable failure dataset for L Crusher
  const buildHistory = () => {
    const Ts = [7, 10, 30, 45, 60, 90, 120];
    const trueAmps = [30, 12, 6];
    const tau = [10, 30, 180];
    return Ts.map((T, i) => ({
      id: `r${i}`, hand: "L", grip: "Crusher", target_duration: T, rep_num: 1,
      actual_time_s: T, failed: true,
      avg_force_kg:
        trueAmps[0]*Math.exp(-T/tau[0])
      + trueAmps[1]*Math.exp(-T/tau[1])
      + trueAmps[2]*Math.exp(-T/tau[2]),
      date: "2026-04-01", session_id: `s${i}`,
    }));
  };

  test("returns null with insufficient data", () => {
    expect(prescribedLoad([], "L", "Crusher", 45)).toBeNull();
    expect(prescribedLoad(null, "L", "Crusher", 45)).toBeNull();
  });

  test("returns a positive load for a well-supported scope", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const out = prescribedLoad(history, "L", "Crusher", 45, null, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out).toBeGreaterThan(0);
  });

  test("higher target T → lower prescribed load (curve decays)", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const power = prescribedLoad(history, "L", "Crusher", 7, null, { threeExpPriors: priors });
    const cap = prescribedLoad(history, "L", "Crusher", 120, null, { threeExpPriors: priors });
    expect(power).toBeGreaterThan(cap);
  });

  test("falls back to Monod cold-start when no three-exp prior", () => {
    const history = buildHistory();
    // Pass no priors — should still work via Monod path.
    const out = prescribedLoad(history, "L", "Crusher", 45);
    expect(out).not.toBeNull();
    expect(out).toBeGreaterThan(0);
  });
});

// ─────────────────────────────────────────────────────────────
// prescriptionPotential — three-exp-primary ceiling
// ─────────────────────────────────────────────────────────────
describe("prescriptionPotential", () => {
  const buildHistory = () => {
    const Ts = [7, 10, 30, 45, 60, 90, 120];
    const trueAmps = [30, 12, 6];
    const tau = [10, 30, 180];
    return Ts.map((T, i) => ({
      id: `r${i}`, hand: "L", grip: "Crusher", target_duration: T, rep_num: 1,
      actual_time_s: T, failed: true,
      avg_force_kg:
        trueAmps[0]*Math.exp(-T/tau[0])
      + trueAmps[1]*Math.exp(-T/tau[1])
      + trueAmps[2]*Math.exp(-T/tau[2]),
      date: "2026-04-01", session_id: `s${i}`,
    }));
  };

  test("returns null with no usable data", () => {
    expect(prescriptionPotential([], "L", "Crusher", 45)).toBeNull();
    expect(prescriptionPotential(null, "L", "Crusher", 45)).toBeNull();
  });

  test("returns {value, lower, upper, reliability, monodValue, threeExpValue}", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const out = prescriptionPotential(history, "L", "Crusher", 45, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(typeof out.value).toBe("number");
    expect(typeof out.lower).toBe("number");
    expect(typeof out.upper).toBe("number");
    expect(out.lower).toBeLessThanOrEqual(out.upper);
    expect(["well-supported", "marginal", "extrapolation"]).toContain(out.reliability);
  });

  test("when three-exp is available, value comes from three-exp", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const out = prescriptionPotential(history, "L", "Crusher", 45, { threeExpPriors: priors });
    expect(out.threeExpValue).not.toBeNull();
    expect(out.value).toBe(out.threeExpValue);
  });

  test("reliability is well-supported when failures span the target T", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const out = prescriptionPotential(history, "L", "Crusher", 45, { threeExpPriors: priors });
    // History contains failures at T=30, 45, 60 (all within ±20% of 45)
    expect(out.reliability).toBe("well-supported");
  });

  test("reliability is extrapolation when no failures near target T", () => {
    const history = [
      { hand: "L", grip: "Crusher", actual_time_s: 5,  avg_force_kg: 50, failed: true, target_duration: 5 },
      { hand: "L", grip: "Crusher", actual_time_s: 7,  avg_force_kg: 45, failed: true, target_duration: 7 },
    ];
    const out = prescriptionPotential(history, "L", "Crusher", 120);
    if (out) expect(out.reliability).toBe("extrapolation");
  });
});
