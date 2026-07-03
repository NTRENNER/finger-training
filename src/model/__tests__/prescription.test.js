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
  PEAK_CAP_FRACTION, PEAK_CAP_LOOKBACK_DAYS, recentBestPeakKg,
  suggestWeight,
  demonstratedCapacityKg,
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

  test("cookedness no longer scales the fresh load (disabled July 2026)", () => {
    // Same rep on two different dates — one tagged cooked, one fresh.
    // Cookedness is disabled as a load rescaler, so both report their
    // logged load unchanged (no de-cook).
    const history = [
      { id: "fresh", hand: "L", grip: "Crusher",
        session_id: "s_fresh", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-01" },
      { id: "cooked", hand: "L", grip: "Crusher",
        session_id: "s_cooked", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-02" },
    ];
    const fatigueModel = { Crusher: { beta: 0.5 } }; // even a big beta must not move loads
    const cookedByDate = { "2026-05-02": 10 };
    const map = buildFreshLoadMap(history, { cookedByDate, fatigueModel });
    expect(map.get("id:fresh").fresh).toBeCloseTo(25, 4);
    expect(map.get("id:cooked").fresh).toBeCloseTo(25, 4); // no de-cook
  });

  test("neither session_cooked nor cookedByDate moves the fresh load anymore (July 2026)", () => {
    const history = [
      { id: "morning", hand: "L", grip: "Crusher",
        session_id: "s_morning", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-02", session_cooked: 2 },
      { id: "evening", hand: "L", grip: "Crusher",
        session_id: "s_evening", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-02", session_cooked: null },
    ];
    const fatigueModel = { Crusher: { beta: 0.5 } };
    const cookedByDate = { "2026-05-02": 8 };
    const map = buildFreshLoadMap(history, { cookedByDate, fatigueModel });
    expect(map.get("id:morning").fresh).toBeCloseTo(25, 4);
    expect(map.get("id:evening").fresh).toBeCloseTo(25, 4);
  });

  test("session_cooked: 0 explicitly suppresses day-level compensation", () => {
    // Override of 0 isn't null — it's an explicit "this session was
    // fresh." The day default should NOT leak through. Important so
    // a user who toggles to per-session and sets 0 actually gets
    // "fresh" behavior, not the day default.
    const history = [
      { id: "fresh", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-02",
        session_cooked: 0 },
    ];
    const fatigueModel = { Crusher: { beta: 0.03 } };
    const cookedByDate = { "2026-05-02": 8 };
    const map = buildFreshLoadMap(history, { cookedByDate, fatigueModel });
    // cooked=0 → multiplier=1.0 → fresh = load unchanged
    expect(map.get("id:fresh").fresh).toBeCloseTo(25, 4);
  });

  test("cookedByDate without fatigueModel is a no-op", () => {
    // Both opts are required for compensation to fire — passing one
    // without the other should leave fresh = load (within-set
    // fatigue still applies as normal).
    const history = [
      { id: "r1", hand: "L", grip: "Crusher",
        session_id: "s1", set_num: 1, rep_num: 1,
        avg_force_kg: 25, actual_time_s: 30, rest_s: 0,
        date: "2026-05-02" },
    ];
    const cookedByDate = { "2026-05-02": 7 };
    // No fatigueModel arg → compensation skipped.
    const map = buildFreshLoadMap(history, { cookedByDate });
    expect(map.get("id:r1").fresh).toBeCloseTo(25, 4);
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
    // anchor's force, so scale < 1 and prescription < potential. (No
    // demonstrated hold reaches the 45s target here — 30s + 10s + a
    // 60s @ 22 kg — wait, the 60s @ 22 hold DOES reach 45s, so it
    // floors value at >= 22. Assert on scale, which the floor doesn't
    // touch.)
    expect(out.scale).toBeLessThan(1);
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
    // The cross-T anchor lifted the amplitude scalar above 1. (Target
    // 220s exceeds every demonstrated hold, so the floor is inactive
    // and value === potential × scale.)
    expect(out.scale).toBeGreaterThan(1);
    expect(out.value).toBeGreaterThan(out.potential);
  });

  test("unanchored-curve: no recent rep 1 falls back to pure curve", () => {
    // Curve-supporting reps, but all dated far in the past — so the prior
    // still builds from these (fresh) rep-1 points, yet no RECENT anchor
    // can be found within the lookback window. (Reps stay rep_num 1: the
    // curve fits / prior now use fresh reps only, so rep_num 2 would also
    // remove the prior, which isn't what this case is testing.) Dates are
    // >90d old so the demonstrated-capacity floor is inactive too, and
    // value === potential.
    const history = buildCurveHistory().map(r => ({ ...r, date: "2020-01-01" }));
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
    // 30s anchor → 45s target: ratio 30/45 ≈ 0.667, inside the clamp.
    expect(out.scale).toBeCloseTo(30 / 45, 5);
  });

  // Regression: the linear ratio used to be unclamped upward (an
  // endurance anchor at T=160s feeding a 5s max-hang target gave
  // scale = 32 → 32× the endurance load) and floored at 0.7 downward
  // (a 5s max anchor for a 220s hold prescribed 70% of max — real
  // endurance loads run ~25-35%). Both directions now clamp to
  // [0.4, 2.5].
  test("anchored-linear clamps extreme T ratios in both directions", () => {
    const mkHistory = (T, F) => [{
      hand: "L", grip: "Crusher", target_duration: T, rep_num: 1,
      actual_time_s: T, avg_force_kg: F, failed: true,
      date: today, session_id: "s1",
    }];

    // Endurance anchor (160s @ 12kg) → 5s max-hang target.
    // Unclamped would be 12 × 32 = 384kg; clamped: 12 × 2.5 = 30kg.
    // (5s target < the 160s hold, so the floor also guarantees >= 12;
    // 30 > 12 so the clamp is what binds here.)
    const up = prescription(mkHistory(160, 12), "L", "Crusher", 5);
    expect(up.source).toBe("anchored-linear");
    expect(up.scale).toBe(2.5);
    expect(up.value).toBeCloseTo(30, 1);

    // Max-hang anchor (5s @ 40kg) → 220s endurance target.
    // Old floor 0.7 gave 28kg; clamped floor 0.4 gives 16kg. (220s
    // target exceeds the 5s hold, so the demonstrated-capacity floor
    // is inactive and the linear clamp is what sets the value.)
    const down = prescription(mkHistory(5, 40), "L", "Crusher", 220);
    expect(down.source).toBe("anchored-linear");
    expect(down.scale).toBe(0.4);
    expect(down.value).toBeCloseTo(16, 1);
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

  test("referenceDate shifts the anchor lookback window", () => {
    // Reproduces the retrospective-modal bug: a session 60 days old
    // with an anchor rep 50 days old. Without referenceDate, the
    // anchor is too old (outside today-30d) and the modal collapses
    // to the unanchored-curve prediction. With referenceDate set to
    // the session date, the anchor falls inside session-30d and the
    // anchored-curve path fires — matching what the user saw live.
    // (July 2026: the anchor was originally dated -50d — ten days
    // AFTER sessDate, contradicting this test's own "history strictly
    // before sessDate" premise. It only anchored because
    // prescription() didn't yet enforce the retrospective upper bound
    // internally. Moved to -70d so the fixture matches the premise.)
    const sessDate = new Date(Date.now() - 60 * 86400 * 1000)
      .toISOString().slice(0, 10);
    const anchorDate = new Date(Date.now() - 70 * 86400 * 1000)
      .toISOString().slice(0, 10);
    const olderDate = new Date(Date.now() - 80 * 86400 * 1000)
      .toISOString().slice(0, 10);

    // priorHistory mimics what AnalysisView passes the modal —
    // history strictly before sessDate. The anchor rep at -70d is a
    // strong rep 1 (high force × long T); the older reps build a fit.
    const history = [
      // Older fit-supporting reps (well outside the today-30d window).
      ...Array.from({ length: 5 }, (_, i) => ({
        hand: "L", grip: "Crusher",
        target_duration: 30, rep_num: 1, set_num: 1,
        actual_time_s: 30 + i * 5, avg_force_kg: 24,
        failed: false, date: olderDate, session_id: `older${i}`,
      })),
      // The anchor rep itself — 10 days before sessDate (inside
      // sessDate-30d) but well outside today-30d.
      {
        hand: "L", grip: "Crusher",
        target_duration: 30, rep_num: 1, set_num: 1,
        actual_time_s: 30, avg_force_kg: 30,
        failed: false, date: anchorDate, session_id: "anchor",
      },
    ];
    const priors = buildThreeExpPriors(history);

    // Without referenceDate → today-30d cutoff → anchor at -70d is
    // outside → unanchored-curve.
    const withoutRef = prescription(history, "L", "Crusher", 30,
      { threeExpPriors: priors });
    expect(withoutRef).not.toBeNull();
    expect(withoutRef.source).toBe("unanchored-curve");

    // With referenceDate = sessDate (-60d) → cutoff is -90d → anchor
    // at -70d is inside and strictly before sessDate → anchored-curve. The value reflects the
    // amplitude shift from the strong anchor rep.
    const withRef = prescription(history, "L", "Crusher", 30,
      { threeExpPriors: priors, referenceDate: sessDate });
    expect(withRef).not.toBeNull();
    expect(withRef.source).toBe("anchored-curve");
    expect(withRef.anchor).not.toBeNull();
    expect(withRef.anchor.date).toBe(anchorDate);
    // referenceDate let the strong 30 kg anchor lift the amplitude: its
    // scale is > 1 (the anchor sits above the ~24 kg curve) while the
    // unanchored path stays at scale 1. (July 2026: both raw values are
    // now also subject to the demonstrated-capacity floor — the anchor is
    // a 30 kg / 30 s hold, so at this 30 s target the floor pins BOTH to
    // >= 30 kg, which is why we assert on scale rather than the floored
    // value.)
    expect(withRef.scale).toBeGreaterThan(1);
    expect(withoutRef.scale).toBe(1);
    expect(withRef.value).toBeGreaterThanOrEqual(withoutRef.value);
  });

  test("retrospective prescription() ignores reps on/after referenceDate even without caller pre-truncation", () => {
    // July 2026: the retrospective semantics were enforced only in
    // recentBestPeakKg — the anchor loop and the curve-fit points read
    // the ENTIRE passed history, safe solely because both callers
    // happened to pre-truncate. This pins the invariant inside the
    // function: full history + referenceDate must reconstruct exactly
    // what a pre-truncated history does, and a monster rep logged
    // AFTER the reference date must not become the anchor.
    const day = (n) => new Date(Date.now() - n * 86400 * 1000)
      .toISOString().slice(0, 10);
    const refDate = day(20);
    const past = [
      ...Array.from({ length: 5 }, (_, i) => ({
        hand: "L", grip: "Crusher",
        target_duration: 30, rep_num: 1, set_num: 1,
        actual_time_s: 30 + i * 5, avg_force_kg: 24,
        failed: false, date: day(40), session_id: `old${i}`,
      })),
      { hand: "L", grip: "Crusher",
        target_duration: 30, rep_num: 1, set_num: 1,
        actual_time_s: 30, avg_force_kg: 25,
        failed: false, date: day(25), session_id: "past-anchor" },
    ];
    // A freakishly strong rep AFTER the reference date — on the old
    // code this becomes the anchor (date ≥ cutoff sails through) and
    // also joins the fit points, dragging the reconstruction upward.
    const future = [{
      hand: "L", grip: "Crusher",
      target_duration: 30, rep_num: 1, set_num: 1,
      actual_time_s: 30, avg_force_kg: 60,
      failed: false, date: day(5), session_id: "future",
    }];
    const full = [...past, ...future];
    // Priors from the truncated view for BOTH calls — priors are a
    // caller-supplied input, and the point here is prescription()'s
    // own internal filtering, not buildThreeExpPriors's.
    const priors = buildThreeExpPriors(past);

    const truncated = prescription(past, "L", "Crusher", 30,
      { threeExpPriors: priors, referenceDate: refDate });
    const untruncated = prescription(full, "L", "Crusher", 30,
      { threeExpPriors: priors, referenceDate: refDate });

    expect(untruncated).not.toBeNull();
    expect(untruncated.anchor?.date).toBe(day(25));   // not the future rep
    expect(untruncated.value).toBe(truncated.value);  // full ≡ pre-truncated
    expect(untruncated.scale).toBe(truncated.scale);
    expect(untruncated.potential).toBe(truncated.potential);
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

// ─────────────────────────────────────────────────────────────
// Peak-force ceiling (recentBestPeakKg + the cap in prescription)
// ─────────────────────────────────────────────────────────────
// Regression for the 2026-06-08 Crusher/L session: the three-exp
// curve, with no data below 7s, extrapolated F(5s) ABOVE the user's
// best-ever measured instantaneous peak (94.1 kg prescribed vs
// 76.9 kg peak). The cap bounds short-T prescriptions at
// PEAK_CAP_FRACTION × recent best peak_force_kg.
describe("peak-force ceiling", () => {
  const today = new Date().toISOString().slice(0, 10);

  const buildPeakHistory = () => {
    const Ts = [7, 10, 30, 45, 60, 90, 120];
    const trueAmps = [30, 12, 6];
    const tau = [10, 30, 180];
    return Ts.map((T, i) => {
      const F = trueAmps[0] * Math.exp(-T / tau[0])
              + trueAmps[1] * Math.exp(-T / tau[1])
              + trueAmps[2] * Math.exp(-T / tau[2]);
      return {
        id: `r${i}`, hand: "L", grip: "Crusher", target_duration: T,
        rep_num: 1, actual_time_s: T, failed: true,
        avg_force_kg: F, peak_force_kg: F * 1.05,
        date: "2026-04-20", session_id: `s${i}`,
      };
    });
  };

  test("recentBestPeakKg: max sane peak within window, per (hand, grip)", () => {
    const history = [
      { hand: "L", grip: "Crusher", peak_force_kg: 70, date: today },
      { hand: "L", grip: "Crusher", peak_force_kg: 76.9, date: today },
      { hand: "R", grip: "Crusher", peak_force_kg: 90, date: today },   // other hand
      { hand: "L", grip: "Micro",   peak_force_kg: 95, date: today },   // other grip
      { hand: "L", grip: "Crusher", peak_force_kg: 0,  date: today },   // insane → ignored
    ];
    expect(recentBestPeakKg(history, "L", "Crusher")).toBe(76.9);
    expect(recentBestPeakKg(history, "R", "Crusher")).toBe(90);
    expect(recentBestPeakKg(history, "L", "Prime")).toBeNull();
    expect(recentBestPeakKg([], "L", "Crusher")).toBeNull();
  });

  test("recentBestPeakKg: respects lookback window and referenceDate", () => {
    const oldDate = new Date(Date.now() - (PEAK_CAP_LOOKBACK_DAYS + 10) * 86400 * 1000)
      .toISOString().slice(0, 10);
    const history = [
      { hand: "L", grip: "Crusher", peak_force_kg: 100, date: oldDate },
      { hand: "L", grip: "Crusher", peak_force_kg: 70,  date: today },
    ];
    // Stale 100 kg peak is outside the window — only the recent 70 counts.
    expect(recentBestPeakKg(history, "L", "Crusher")).toBe(70);
    // Retrospective: reps on/after referenceDate are excluded (no
    // leaking the session's own measurement into its reconstruction).
    expect(recentBestPeakKg(history, "L", "Crusher", today)).toBeNull();
  });

  test("caps short-duration curve extrapolation at PEAK_CAP_FRACTION × best peak", () => {
    const seed = buildPeakHistory();
    const priors = buildThreeExpPriors(seed);
    const history = [
      ...seed,
      { id: "rA", hand: "L", grip: "Crusher", target_duration: 30,
        rep_num: 1, actual_time_s: 28, failed: true,
        avg_force_kg: 21, peak_force_kg: 23,
        date: today, session_id: "sA" },
    ];
    const bestPeak = Math.max(...history.map(r => r.peak_force_kg));
    const out = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.peakCapKg).toBeCloseTo(Math.round(bestPeak * PEAK_CAP_FRACTION * 10) / 10, 1);
    expect(out.value).toBeLessThanOrEqual(out.peakCapKg);
    if (out.peakCapped) {
      expect(out.potential * out.scale).toBeGreaterThan(out.value);
    }
  });

  test("cap does not bind at long durations (curve sits far below peak)", () => {
    const seed = buildPeakHistory();
    const priors = buildThreeExpPriors(seed);
    const history = [
      ...seed,
      { id: "rA", hand: "L", grip: "Crusher", target_duration: 60,
        rep_num: 1, actual_time_s: 60, failed: true,
        avg_force_kg: 13, peak_force_kg: 15,
        date: today, session_id: "sA" },
    ];
    const out = prescription(history, "L", "Crusher", 60, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.peakCapped).toBe(false);
  });

  test("no Tindeq peaks → no cap (manual-load histories unchanged)", () => {
    const seed = buildPeakHistory().map(({ peak_force_kg, ...r }) => r);
    const priors = buildThreeExpPriors(seed);
    const history = [
      ...seed,
      { id: "rA", hand: "L", grip: "Crusher", target_duration: 30,
        rep_num: 1, actual_time_s: 28, failed: true,
        avg_force_kg: 21, date: today, session_id: "sA" },
    ];
    const out = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors });
    expect(out).not.toBeNull();
    expect(out.peakCapKg).toBeNull();
    expect(out.peakCapped).toBe(false);
  });

  test("anchored-linear cold-start path is capped too", () => {
    const history = [
      { id: "rA", hand: "L", grip: "Crusher", target_duration: 10,
        rep_num: 1, actual_time_s: 9.5, failed: true,
        avg_force_kg: 21, peak_force_kg: 30,
        date: today, session_id: "sA" },
    ];
    const out = prescription(history, "L", "Crusher", 5);
    expect(out).not.toBeNull();
    expect(out.source).toBe("anchored-linear");
    expect(out.peakCapped).toBe(true);
    expect(out.value).toBeCloseTo(Math.round(30 * PEAK_CAP_FRACTION * 10) / 10, 1);
  });

  test("sub-max-protocol peaks do NOT create a cap (new-grip case)", () => {
    const history = [
      { id: "rA", hand: "L", grip: "Prime", target_duration: 35,
        rep_num: 1, actual_time_s: 12, failed: true,
        avg_force_kg: 5.8, peak_force_kg: 7.6,
        date: today, session_id: "sA" },
    ];
    expect(recentBestPeakKg(history, "L", "Prime")).toBeNull();
    const out = prescription(history, "L", "Prime", 5);
    expect(out).not.toBeNull();
    expect(out.peakCapKg).toBeNull();
    expect(out.peakCapped).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────────
// Demonstrated-capacity FLOOR — never prescribe below a sustained load
// ─────────────────────────────────────────────────────────────
// Holding F kg for d seconds proves capacity >= F for any target <= d, so
// prescription() floors its value at the best fresh sustained load over
// holds of duration >= targetDuration (within 90d). Fixes the case where
// the short-rep-dominated F-D fit sits below a real endurance hold and the
// unfloored curve x anchor recommends LESS than the user just sustained.
describe("demonstrated-capacity floor", () => {
  const day = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10);
  const rep = (over) => ({
    hand: "L", grip: "Micro", rep_num: 1, set_num: 1,
    target_duration: 160, actual_time_s: 188, avg_force_kg: 5.5,
    date: day(5), session_id: "s", ...over,
  });

  test("demonstratedCapacityKg: best fresh load over holds of duration >= T (within 90d)", () => {
    const h = [
      rep({ actual_time_s: 188, avg_force_kg: 5.5, session_id: "a" }), // 188s @ 5.5
      rep({ actual_time_s: 130, avg_force_kg: 6.0, session_id: "b" }), // 130s @ 6.0
      rep({ actual_time_s: 40,  avg_force_kg: 9.0, session_id: "c" }), // 40s  @ 9.0
    ];
    expect(demonstratedCapacityKg(h, "L", "Micro", 160)).toBeCloseTo(5.5, 5); // only the 188s hold reaches 160
    expect(demonstratedCapacityKg(h, "L", "Micro", 120)).toBeCloseTo(6.0, 5); // 188 + 130 qualify -> max 6.0
    expect(demonstratedCapacityKg(h, "L", "Micro", 220)).toBeNull();          // no hold >= 220
    expect(demonstratedCapacityKg(h, "R", "Micro", 160)).toBeNull();          // other hand
  });

  test("ignores fatigued within-set reps (rep_num > 1) and stale (> 90d) holds", () => {
    const h = [
      rep({ actual_time_s: 200, avg_force_kg: 9.0, rep_num: 3, session_id: "x" }),    // fatigued -> ignored
      rep({ actual_time_s: 200, avg_force_kg: 8.0, date: day(120), session_id: "y" }), // stale -> ignored
      rep({ actual_time_s: 200, avg_force_kg: 5.5, session_id: "z" }),                 // fresh, recent
    ];
    expect(demonstratedCapacityKg(h, "L", "Micro", 160)).toBeCloseTo(5.5, 5);
  });

  test("prescription never falls below what was sustained for that hold length", () => {
    // Short high-force reps dominate the unweighted-in-kg fit, so a genuine
    // low-force long hold sits ABOVE the curve and the unfloored value lands
    // under it. The floor lifts it back to the demonstrated load.
    const history = [
      ...Array.from({ length: 12 }, (_, i) =>
        rep({ target_duration: 7, actual_time_s: 7, avg_force_kg: 18, date: day(6), session_id: `sh${i}` })),
      rep({ target_duration: 160, actual_time_s: 188, avg_force_kg: 5.5, date: day(6), session_id: "long" }),
    ];
    const priors = buildThreeExpPriors(history);
    const p = prescription(history, "L", "Micro", 160, { threeExpPriors: priors });
    expect(p).not.toBeNull();
    expect(p.value).toBeGreaterThanOrEqual(5.5);          // never below the 188s @ 5.5 hold
    expect(p.capacityFloorKg).toBeCloseTo(5.5, 5);
  });

  test("floor does not apply for a target longer than any demonstrated hold", () => {
    const history = [
      ...Array.from({ length: 12 }, (_, i) =>
        rep({ target_duration: 7, actual_time_s: 7, avg_force_kg: 18, date: day(6), session_id: `sh${i}` })),
      rep({ target_duration: 160, actual_time_s: 188, avg_force_kg: 5.5, date: day(6), session_id: "long" }),
    ];
    const priors = buildThreeExpPriors(history);
    const p = prescription(history, "L", "Micro", 220, { threeExpPriors: priors });
    expect(p.capacityFloorKg).toBeNull();
    expect(p.capacityFloored).toBe(false);
  });
});
