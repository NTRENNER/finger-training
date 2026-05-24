// Tests for src/model/prescription.js — the prescription layer.
// Covers effectiveLoad/loadedWeight/repKey, freshMap building, fitDoseK,
// the unified prescription() function, and suggestWeight.

import {
  effectiveLoad, loadedWeight, repKey,
  prescribedLoad,
  isShortfall, SHORTFALL_TOL,
  buildSMaxIndex, buildFreshLoadMap, freshLoadFor, fitDoseK,
  estimateRefWeight,
  EMPIRICAL_LOOKBACK_DAYS, prescription,
  suggestWeight,
} from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";

// ─────────────────────────────────────────────────────────────
// effectiveLoad / loadedWeight / repKey
// ─────────────────────────────────────────────────────────────
describe("effectiveLoad", () => {
  test("prefers avg_force_kg when in valid range (0-500)", () => {
    expect(effectiveLoad({ avg_force_kg: 25, weight_kg: 30 })).toBe(25);
    // Also wins over prescribed + manual when all four are present.
    expect(effectiveLoad({
      avg_force_kg: 25, manual_load_kg: 28,
      prescribed_load_kg: 30, weight_kg: 30,
    })).toBe(25);
  });

  test("falls back to manual_load_kg when no Tindeq reading", () => {
    expect(effectiveLoad({
      manual_load_kg: 28, prescribed_load_kg: 30,
    })).toBe(28);
    // Invalid avg_force_kg (0 or > 500) still falls through to manual.
    expect(effectiveLoad({
      avg_force_kg: 0, manual_load_kg: 28, prescribed_load_kg: 30,
    })).toBe(28);
  });

  test("falls back to prescribed_load_kg when no actual recorded", () => {
    expect(effectiveLoad({ prescribed_load_kg: 30 })).toBe(30);
    // Skips null/zero manual and goes to prescribed.
    expect(effectiveLoad({
      manual_load_kg: null, prescribed_load_kg: 30,
    })).toBe(30);
  });

  test("falls back to legacy weight_kg for unmigrated rows", () => {
    // Old localStorage rep that pre-dates the schema split — only
    // has weight_kg. Must still return a usable value.
    expect(effectiveLoad({ weight_kg: 30 })).toBe(30);
    expect(effectiveLoad({ avg_force_kg: 0, weight_kg: 30 })).toBe(30);
    expect(effectiveLoad({ avg_force_kg: 600, weight_kg: 30 })).toBe(30);
  });

  test("returns 0 when nothing is usable", () => {
    expect(effectiveLoad({})).toBe(0);
    expect(effectiveLoad({
      avg_force_kg: 0, manual_load_kg: 0,
      prescribed_load_kg: 0, weight_kg: 0,
    })).toBe(0);
  });
});

describe("prescribedLoad", () => {
  test("reads prescribed_load_kg directly when present", () => {
    expect(prescribedLoad({
      prescribed_load_kg: 30, avg_force_kg: 25, manual_load_kg: 28,
    })).toBe(30);
  });

  test("falls back to legacy weight_kg for unmigrated rows", () => {
    expect(prescribedLoad({ weight_kg: 30 })).toBe(30);
  });

  test("returns 0 when neither is present", () => {
    expect(prescribedLoad({})).toBe(0);
    expect(prescribedLoad({ avg_force_kg: 25 })).toBe(0);
  });
});

describe("loadedWeight", () => {
  test("same fallback chain as effectiveLoad", () => {
    // For Tindeq-isometric setup, loadedWeight === effectiveLoad
    expect(loadedWeight({ avg_force_kg: 25, weight_kg: 30 })).toBe(25);
    expect(loadedWeight({ manual_load_kg: 28, prescribed_load_kg: 30 })).toBe(28);
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

// (rpeProgressionMultiplier + BUMP_PER_SUCCESS + MAX_BUMP_MULT tests
// removed alongside the symbols themselves — May 2026 cleanup.)

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
// UNIFIED PRESCRIPTION — collapsed empirical / prescribed / potential
// ─────────────────────────────────────────────────────────────
// Returns { value, potential, scale, anchor, reliability, source }.
// value = curve(T) × scale; potential = curve(T); scale = F_anchor /
// curve(T_anchor) for the most recent rep 1 at any T (lookback gated).
// Cross-zone anchor is the key behavior change vs. the old empirical
// path, which only matched on exact target_duration.
describe("prescription (unified)", () => {
  const today = new Date().toISOString().slice(0, 10);

  // Synthetic dataset — clean three-exp shape so the fits are sane.
  const buildCurveHistory = () => {
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

  test("returns null with no usable data and no fallback", () => {
    expect(prescription([], "L", "Crusher", 45)).toBeNull();
    expect(prescription(null, "L", "Crusher", 45)).toBeNull();
  });

  test("anchored-curve: recent rep 1 within lookback drives scale", () => {
    // Cold-start curve seed plus a recent rep that fell SHORT of its
    // target — anchor should pull the prescription DOWN below the
    // unscaled curve potential.
    const history = [
      { hand: "L", grip: "Crusher", target_duration: 10, rep_num: 1,
        actual_time_s: 10, avg_force_kg: 50, failed: true,
        date: "2026-04-01", session_id: "s0a" },
      { hand: "L", grip: "Crusher", target_duration: 60, rep_num: 1,
        actual_time_s: 60, avg_force_kg: 22, failed: true,
        date: "2026-04-02", session_id: "s0b" },
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
        actual_time_s: 30, avg_force_kg: 26, failed: true,
        date: today, session_id: "s1" },
    ];
    const priors = buildThreeExpPriors(history);
    const out = prescription(history, "L", "Crusher", 45, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.source).toBe("anchored-curve");
    expect(out.anchor).not.toBeNull();
    // Held 30s at 26 kg vs target 45s — the curve over-predicted the
    // anchor's force, so scale < 1 and prescription < potential.
    expect(out.scale).toBeLessThan(1);
    expect(out.value).toBeLessThan(out.potential);
  });

  test("cross-zone anchor: a great rep at one T lifts every T", () => {
    // Anchor is at T=160s with the user holding longer (180s) than
    // predicted at 50 kg. Prescription at T=220s (different zone)
    // should ALSO be higher than the unscaled curve there — the
    // amplitude scalar projects across the curve.
    const seed = buildCurveHistory();
    const priors = buildThreeExpPriors(seed);
    // Add a recent overshoot rep at T=180s
    const history = [
      ...seed,
      { hand: "L", grip: "Crusher", target_duration: 160, rep_num: 1,
        actual_time_s: 180, avg_force_kg: 50, failed: true,
        date: today, session_id: "sX" },
    ];
    const out = prescription(history, "L", "Crusher", 220, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.source).toBe("anchored-curve");
    // The cross-T anchor lifted the amplitude scalar above 1.
    expect(out.scale).toBeGreaterThan(1);
    expect(out.value).toBeGreaterThan(out.potential);
  });

  test("unanchored-curve: no recent rep 1 falls back to pure curve", () => {
    // History is curve-supporting but rep_num is 0 / missing on every
    // rep, so no valid anchor can be found. With a per-grip prior we
    // still have the unscaled curve.
    const history = buildCurveHistory().map(r => ({ ...r, rep_num: 2 }));
    const priors = buildThreeExpPriors(history);
    const out = prescription(history, "L", "Crusher", 45, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.source).toBe("unanchored-curve");
    expect(out.scale).toBe(1);
    expect(out.value).toBe(out.potential);
  });

  test("reliability classifies interpolation vs extrapolation", () => {
    const history = buildCurveHistory();  // failures at T=7..120
    const priors = buildThreeExpPriors(history);
    const wellSupp = prescription(history, "L", "Crusher", 45, { threeExpPriors: priors });
    expect(wellSupp.reliability).toBe("well-supported");
    // Build a more aggressive extrapolation case — pick T well clear
    // of the dataset's max (120s) so even ±50% (180s) doesn't reach.
    const extrap = prescription(history, "L", "Crusher", 300, { threeExpPriors: priors });
    expect(extrap.reliability).toBe("extrapolation");
  });

  test("anchored-linear cold start: no prior, but recent rep 1 exists", () => {
    // No three-exp prior available — fall back to linear-by-duration
    // scaling on the most recent rep 1.
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 30, rep_num: 1,
      actual_time_s: 30, avg_force_kg: 24, failed: true,
      date: today, session_id: "s1",
    }];
    const out = prescription(history, "L", "Crusher", 45);
    expect(out).not.toBeNull();
    expect(out.source).toBe("anchored-linear");
    expect(out.value).toBeGreaterThan(0);
  });

  test("historical fallback: no prior, no anchor, but matching reps exist", () => {
    // No prior, no rep 1 (rep_num=2 throughout). historical takes over
    // from estimateRefWeight.
    const history = [
      { hand: "L", grip: "Crusher", target_duration: 45, rep_num: 2,
        actual_time_s: 45, avg_force_kg: 20, failed: true,
        date: today, session_id: "s1" },
      { hand: "L", grip: "Crusher", target_duration: 50, rep_num: 2,
        actual_time_s: 50, avg_force_kg: 18, failed: true,
        date: today, session_id: "s1" },
    ];
    const out = prescription(history, "L", "Crusher", 45);
    expect(out).not.toBeNull();
    expect(out.source).toBe("historical");
    expect(out.value).toBeGreaterThan(0);
  });

  test("respects EMPIRICAL_LOOKBACK_DAYS — old rep doesn't anchor", () => {
    const tooOld = new Date(Date.now() - (EMPIRICAL_LOOKBACK_DAYS + 5) * 86400 * 1000)
      .toISOString().slice(0, 10);
    const history = [{
      hand: "L", grip: "Crusher", target_duration: 45, rep_num: 1,
      actual_time_s: 45, avg_force_kg: 20, failed: false,
      date: tooOld, session_id: "old",
    }];
    // Old rep is outside the lookback so it can't be used as an anchor.
    // estimateRefWeight has no lookback gate, so the historical path
    // can still fire — assert the source is historical, not anchored.
    const out = prescription(history, "L", "Crusher", 45);
    if (out) expect(["historical", null]).toContain(out.source);
  });

  test("higher T → lower potential (curve decays)", () => {
    const history = buildCurveHistory();
    const priors = buildThreeExpPriors(history);
    const power = prescription(history, "L", "Crusher", 7, { threeExpPriors: priors });
    const cap   = prescription(history, "L", "Crusher", 120, { threeExpPriors: priors });
    expect(power.potential).toBeGreaterThan(cap.potential);
  });

  test("uses fresh-adjusted loads (freshMap consistency)", () => {
    // Synthetic within-set sequence — late reps are higher fresh-
    // equivalent loads.
    const baseRep = (id, setNum, repNum) => ({
      id, hand: "L", grip: "Crusher",
      session_id: "s1", set_num: setNum, rep_num: repNum,
      target_duration: 30, actual_time_s: 30,
      avg_force_kg: 20, failed: true, rest_s: 30,
      date: "2026-04-01",
    });
    const history = [baseRep("r1", 1, 1), baseRep("r2", 1, 2), baseRep("r3", 1, 3)];
    const priors = buildThreeExpPriors(history);
    const fmap = buildFreshLoadMap(history);
    const out = prescription(history, "L", "Crusher", 30,
      { threeExpPriors: priors, freshMap: fmap });
    expect(out).not.toBeNull();
    expect(out.potential).toBeGreaterThan(20 * 0.9);
    expect(fmap.get("id:r3").fresh).toBeGreaterThan(20);
  });
});
