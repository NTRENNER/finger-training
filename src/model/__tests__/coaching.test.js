// Tests for src/model/coaching.js — coaching recommendation engine v2.
// Covers recencyPenalty, externalLoadModifier, zoneResidualFactor,
// coachingRecommendation, coachingRationale.
//
// The earlier intensityMatch / readiness pathway has been removed
// (the readiness score was no longer displayed or settable, so the
// factor silently collapsed into a hidden per-zone bias). Tests for
// it were dropped along with the function.

import {
  COACH_RECOVERY_TAU_DAYS,
  recencyPenalty, externalLoadModifier,
  zoneResidualFactor, coachingRecommendation, coachingRationale,
  coachingRecommendationContinuous,
} from "../coaching.js";
import { buildThreeExpPriors } from "../threeExp.js";

// ─────────────────────────────────────────────────────────────
// COACH_RECOVERY_TAU_DAYS — sanity
// ─────────────────────────────────────────────────────────────
describe("coaching constants", () => {
  test("recovery taus ordered: power < strength < endurance", () => {
    expect(COACH_RECOVERY_TAU_DAYS.power).toBeLessThan(COACH_RECOVERY_TAU_DAYS.strength);
    expect(COACH_RECOVERY_TAU_DAYS.strength).toBeLessThan(COACH_RECOVERY_TAU_DAYS.endurance);
  });
});

// ─────────────────────────────────────────────────────────────
// recencyPenalty — exponential recovery curve since last session
// ─────────────────────────────────────────────────────────────
describe("recencyPenalty", () => {
  test("returns 1.0 when never trained", () => {
    expect(recencyPenalty("power", [], "Crusher")).toBe(1.0);
    expect(recencyPenalty("power", null, "Crusher")).toBe(1.0);
  });

  test("returns 1.0 with no grip", () => {
    expect(recencyPenalty("power", [], null)).toBe(1.0);
  });

  test("returns near-zero immediately after training (today)", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Power refTime is 30s after the 6-zone migration.
    const history = [{ grip: "Crusher", target_duration: 30, date: today }];
    const out = recencyPenalty("power", history, "Crusher");
    expect(out).toBeLessThan(0.1);
  });

  test("approaches 1.0 as days_ago grows", () => {
    const longAgo = "2020-01-01";
    const history = [{ grip: "Crusher", target_duration: 30, date: longAgo }];
    expect(recencyPenalty("power", history, "Crusher")).toBeGreaterThan(0.9);
  });

  test("matches by grip + target_duration (not other zones)", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Strength refTime is 115s after the 6-zone migration.
    const history = [{ grip: "Crusher", target_duration: 115, date: today }];
    // Trained Strength today, so Strength recency is low
    expect(recencyPenalty("strength", history, "Crusher")).toBeLessThan(0.1);
    // But Power (refTime 30s) was not trained
    expect(recencyPenalty("power", history, "Crusher")).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────
// externalLoadModifier — climbing in last 48h depresses zones
// ─────────────────────────────────────────────────────────────
describe("externalLoadModifier", () => {
  test("returns 1.0 with no activities", () => {
    expect(externalLoadModifier("power", [])).toBe(1.0);
    expect(externalLoadModifier("power", null)).toBe(1.0);
  });

  test("returns 1.0 when no recent climbing", () => {
    const longAgo = "2020-01-01";
    expect(externalLoadModifier("power", [{ type: "climbing", date: longAgo }])).toBe(1.0);
  });

  test("recent climbing depresses power more than endurance", () => {
    // Yesterday avoids TZ edge cases. RPE drives session fatigue under
    // the new logic, so we put a moderate session in to get a signal.
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const acts = [
      { type: "climbing", date: yday, rpe: 8 },
      { type: "climbing", date: yday, rpe: 7 },
      { type: "climbing", date: yday, rpe: 7 },
      { type: "climbing", date: yday, rpe: 8 },
    ];
    const power = externalLoadModifier("power", acts);
    const end   = externalLoadModifier("endurance", acts);
    expect(power).toBeLessThan(end);
    // Both should be < 1 — climbing happened recently with real load.
    expect(power).toBeLessThan(1.0);
    expect(end).toBeLessThan(1.0);
  });

  test("low-RPE warmup day barely impacts the engine", () => {
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const warmupActs = [
      { type: "climbing", date: yday, rpe: 3 },
      { type: "climbing", date: yday, rpe: 3 },
    ];
    const power = externalLoadModifier("power", warmupActs);
    // Fatigue floor = 1-2 (two RPE-3 climbs derive a low score),
    // decayed by ~50% over the ~24h-since-midnight window. Expect
    // a small scale-down — definitely far from the moderate-load
    // suppression a real session would produce. Threshold is loose
    // because "yesterday" parses as midnight, so hours-ago depends
    // on the time of day the test runs (anywhere ~24-48h ahead).
    expect(power).toBeGreaterThan(0.9);
  });

  test("high-volume RPE-7 session crushes more than single RPE-9 attempt", () => {
    // The whole point of the RPE-aware refactor. 1 climb at RPE 9 vs
    // 8 climbs at RPE 7. The 8x7 session should leave you more cooked
    // → smaller modifier (more suppression).
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const oneMaxEffort = [{ type: "climbing", date: yday, rpe: 9 }];
    const volumeSlogfest = Array.from({ length: 8 }, () => ({
      type: "climbing", date: yday, rpe: 7,
    }));
    const oneAttemptMod = externalLoadModifier("power", oneMaxEffort);
    const volumeMod = externalLoadModifier("power", volumeSlogfest);
    expect(volumeMod).toBeLessThan(oneAttemptMod);
  });

  test("ignores non-climbing activities", () => {
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const acts = [{ type: "rest", date: yday, rpe: 9 }];
    expect(externalLoadModifier("power", acts)).toBe(1.0);
  });
});

// ─────────────────────────────────────────────────────────────
// zoneResidualFactor — three-exp dots-vs-curve signal (post Phase C)
// ─────────────────────────────────────────────────────────────
describe("zoneResidualFactor", () => {
  test("returns 1.0 (neutral) when amps is null", () => {
    expect(zoneResidualFactor([], "L", "Crusher", 45, null)).toBe(1.0);
  });

  test("returns 1.0 when amps are all zero", () => {
    expect(zoneResidualFactor([], "L", "Crusher", 45, [0, 0, 0])).toBe(1.0);
  });

  test("returns 1.0 when no failures in target zone", () => {
    const amps = [25, 12, 5];
    expect(zoneResidualFactor([], "L", "Crusher", 45, amps)).toBe(1.0);
  });

  test("dots below the curve → factor > 1 (limiter signal)", () => {
    // amps = [80, 40, 20] gives F(45) ≈ 80*exp(-4.5) + 40*exp(-1.5) + 20*exp(-0.25)
    //                              ≈ 0.89 + 8.93 + 15.58 ≈ 25.4
    // User fails at 18 / 16 (well below the curve) → positive residual,
    // factor > 1 (limiter signal).
    const amps = [80, 40, 20];
    const history = [
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 18 },
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 16 },
    ];
    const f = zoneResidualFactor(history, "L", "Crusher", 45, amps);
    expect(f).toBeGreaterThan(1);
  });

  test("dots above the curve → factor < 1 (strong-zone signal)", () => {
    // amps = [10, 5, 2] gives F(45) ≈ 10*exp(-4.5) + 5*exp(-1.5) + 2*exp(-0.25)
    //                            ≈ 0.11 + 1.12 + 1.56 ≈ 2.79
    // User overperforms at 30/28 → negative residual, factor < 1.
    const amps = [10, 5, 2];
    const history = [
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 30 },
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 28 },
    ];
    const f = zoneResidualFactor(history, "L", "Crusher", 45, amps);
    expect(f).toBeLessThan(1);
  });

  test("clamped to [0.5, 3.0]", () => {
    const amps = [50, 25, 10];
    const wayBelow = [
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 1 },
    ];
    expect(zoneResidualFactor(wayBelow, "L", "Crusher", 45, amps)).toBeLessThanOrEqual(3.0);

    const wayAbove = [
      { failed: true, hand: "L", grip: "Crusher", target_duration: 45,
        actual_time_s: 45, avg_force_kg: 999 },
    ];
    expect(zoneResidualFactor(wayAbove, "L", "Crusher", 45, amps)).toBeGreaterThanOrEqual(0.5);
  });

  test("uses freshLoadFor when freshMap is passed", () => {
    // Build a within-set sequence: posted load 20 throughout, but the
    // freshMap will say later reps are equivalent to higher fresh loads.
    // Without the fmap, the function compares curve to raw 20.
    // With the fmap, the function compares curve to fresh-equivalent
    // (which is > 20 for later reps). Same amps and same actual reps.
    const baseRep = (id, repNum) => ({
      id, hand: "L", grip: "Crusher", failed: true,
      session_id: "s1", set_num: 1, rep_num: repNum,
      target_duration: 45, actual_time_s: 45,
      avg_force_kg: 20, rest_s: 30,
      date: "2026-04-01",
    });
    const history = [baseRep("r1", 1), baseRep("r2", 2), baseRep("r3", 3)];
    // amps with predicted F(45) ≈ 25.4 (above raw 20, above fresh ~22)
    const amps = [80, 40, 20];
    const noFmap = zoneResidualFactor(history, "L", "Crusher", 45, amps);
    // Build the freshMap: late-set reps will have fresh > 20.
    // (We import buildFreshLoadMap from prescription.js for the test.)
    // eslint-disable-next-line global-require
    const { buildFreshLoadMap } = require("../prescription.js");
    const fmap = buildFreshLoadMap(history);
    const withFmap = zoneResidualFactor(history, "L", "Crusher", 45, amps, fmap);
    // With the fmap, actual loads are higher, so residual (pred - actual)
    // is smaller, so factor is closer to 1.0 (or smaller). It must
    // differ from the no-fmap value.
    expect(withFmap).not.toBe(noFmap);
  });
});

// ─────────────────────────────────────────────────────────────
// coachingRecommendation — full smoke test
// ─────────────────────────────────────────────────────────────
describe("coachingRecommendation", () => {
  // Build a synthetic history with failures across all three zones
  const buildHistory = () => {
    const Ts = [7, 10, 30, 45, 60, 90, 120];
    const trueAmps = [30, 12, 6];
    const tau = [10, 30, 180];
    const today = new Date().toISOString().slice(0, 10);
    return Ts.flatMap((T, i) =>
      ["L", "R"].map(h => ({
        id: `${h}-${i}`, hand: h, grip: "Crusher", target_duration: T, rep_num: 1,
        actual_time_s: T, failed: true,
        avg_force_kg:
          trueAmps[0]*Math.exp(-T/tau[0])
        + trueAmps[1]*Math.exp(-T/tau[1])
        + trueAmps[2]*Math.exp(-T/tau[2]),
        date: today, session_id: `s${i}`,
      }))
    );
  };

  test("returns null with no grip", () => {
    expect(coachingRecommendation([], null)).toBeNull();
    expect(coachingRecommendation([], "")).toBeNull();
  });

  test("returns a candidate with required fields when data is sufficient", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendation(history, "Crusher", { threeExpPriors: priors });
    expect(rec).not.toBeNull();
    expect([
      "max_strength", "power", "power_strength",
      "strength", "strength_endurance", "endurance",
    ]).toContain(rec.zone);
    expect(["L", "R"]).toContain(rec.hand);
    expect(typeof rec.gap).toBe("number");
    expect(typeof rec.score).toBe("number");
    expect(typeof rec.recency).toBe("number");
    expect(typeof rec.ext).toBe("number");
  });
});

// ─────────────────────────────────────────────────────────────
// coachingRationale — formats human text from a rec
// ─────────────────────────────────────────────────────────────
describe("coachingRationale", () => {
  test("returns empty string for null rec", () => {
    expect(coachingRationale(null)).toBe("");
  });

  test("includes zone-compartment language but not hand-side", () => {
    // hand-side intentionally omitted from rationale: most users train
    // both hands per session so "on Left" / "on Right" at the
    // recommendation level adds noise without changing what they'd do.
    const rec = { zone: "power", hand: "L", gap: 0.20, recency: 0.9, ext: 1, resFactor: 1 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/fast|PCr/i);
    expect(text).not.toMatch(/Left|Right/);
  });

  test("calls out the 3-exp curve in residual signal", () => {
    const rec = { zone: "strength", hand: "R", gap: 0.10, recency: 0.9, ext: 1, resFactor: 1.6 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/3-exp curve/);
  });

  test("formats positive gap with explicit percentage", () => {
    const rec = { zone: "power", hand: "L", gap: 0.25, recency: 0.9, ext: 1, resFactor: 1 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/\+25%/);
  });
});

// ─────────────────────────────────────────────────────────────
// coachingRecommendationContinuous — curve-trust continuous engine
// ─────────────────────────────────────────────────────────────
// Sweeps T from 5 to 240 in 5s steps, scores via Gaussian-smoothed
// residuals + staleness, returns the best (T, hand) with the load
// at that point on the curve.
describe("coachingRecommendationContinuous", () => {
  const today = new Date();

  // Build a synthetic history that follows a known three-exp curve.
  // F(T) = 30·exp(-T/10) + 12·exp(-T/30) + 6·exp(-T/180)
  const trueAmps = [30, 12, 6];
  const tau = [10, 30, 180];
  const F_curve = (T) => trueAmps[0]*Math.exp(-T/tau[0])
                       + trueAmps[1]*Math.exp(-T/tau[1])
                       + trueAmps[2]*Math.exp(-T/tau[2]);

  const buildRep = (hand, T, F, daysAgo = 0) => ({
    id: `r-${hand}-${T}-${daysAgo}`,
    hand, grip: "Crusher",
    target_duration: T, actual_time_s: T,
    avg_force_kg: F,
    rep_num: 1,
    date: new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10),
    session_id: `s-${daysAgo}-${T}`,
  });

  test("returns null with no history", () => {
    expect(coachingRecommendationContinuous([], "Crusher", { today })).toBeNull();
    expect(coachingRecommendationContinuous(null, "Crusher", { today })).toBeNull();
  });

  test("returns null with no grip", () => {
    expect(coachingRecommendationContinuous([buildRep("L", 30, 22)], null, { today })).toBeNull();
  });

  test("returns a (T, hand, loadKg) pick with on-curve data", () => {
    // Two L data points exactly on the curve → no residual signal,
    // staleness drives the pick.
    const history = [buildRep("L", 30, F_curve(30)), buildRep("L", 60, F_curve(60))];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.T).toBeGreaterThanOrEqual(5);
    expect(rec.T).toBeLessThanOrEqual(240);
    expect(rec.hand).toBe("L");
    expect(rec.loadKg).toBeGreaterThan(0);
    expect(rec.loadByHand).toBeDefined();
  });

  test("recommends near a duration where actuals fall below the curve", () => {
    // Many on-curve data points anchor the fit, plus a single isolated
    // under-perform at 90s creates a localized limiter signal that the
    // smoothed residual picks up.
    const history = [
      buildRep("L", 5,  F_curve(5)),
      buildRep("L", 10, F_curve(10)),
      buildRep("L", 15, F_curve(15)),
      buildRep("L", 20, F_curve(20)),
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 45, F_curve(45)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 120, F_curve(120)),
      buildRep("L", 180, F_curve(180)),
      buildRep("L", 90, F_curve(90) * 0.6),  // localized under-perform
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Should land near the limiter signal at 90s. Gaussian bandwidth
    // is 30s so the smoothed peak should land somewhere in 50-140s.
    // Note: shrinkage pulls the fit toward the (data-derived) prior,
    // which dilutes the residual at any single outlier — so we don't
    // assert on residualBoost magnitude, only on T_star location.
    expect(rec.T).toBeGreaterThanOrEqual(50);
    expect(rec.T).toBeLessThanOrEqual(140);
  });

  test("prefers hand with stronger limiter signal", () => {
    // L is on-curve everywhere. R has a big under-perform at 60s.
    const history = [
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 120, F_curve(120)),
      buildRep("R", 30, F_curve(30)),
      buildRep("R", 60, F_curve(60) * 0.5),  // R limiter
      buildRep("R", 60, F_curve(60) * 0.55),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.hand).toBe("R");
  });

  test("respects T range limits", () => {
    // Even with strong signal at T=300, sweep stops at tMax=240.
    const history = [
      buildRep("L", 5,  F_curve(5)),
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec.T).toBeGreaterThanOrEqual(5);
    expect(rec.T).toBeLessThanOrEqual(240);
  });

  test("loadByHand contains predicted load for both hands at T_star", () => {
    const history = [
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
      buildRep("R", 30, F_curve(30) * 0.9),
      buildRep("R", 60, F_curve(60) * 0.9),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.loadByHand.L).toBeGreaterThan(0);
    expect(rec.loadByHand.R).toBeGreaterThan(0);
    // The picked hand's load should match loadKg
    expect(rec.loadByHand[rec.hand]).toBeCloseTo(rec.loadKg, 4);
  });

  test("returns zone-of-T_star for context", () => {
    const history = [
      buildRep("L", 5, F_curve(5)),
      buildRep("L", 30, F_curve(30)),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(["max_strength", "power", "power_strength", "strength", "strength_endurance", "endurance"]).toContain(rec.zone);
  });

  // ── AUC-gain pick (Reading B) — symmetric adaptBoost ───────────
  test("adaptBoost penalizes zones where actuals sit ABOVE the curve", () => {
    // Many on-curve points anchor the fit, plus a strong above-curve
    // signal at T=30s. The engine should NOT pick T near 30s — adaptBoost
    // there is < 1 because the user is at/above ceiling.
    const history = [
      buildRep("L", 5,  F_curve(5)),
      buildRep("L", 10, F_curve(10)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 90, F_curve(90)),
      buildRep("L", 120, F_curve(120)),
      buildRep("L", 180, F_curve(180)),
      // Outperform at 30s: actual is 1.4× the curve
      buildRep("L", 30, F_curve(30) * 1.4),
      buildRep("L", 30, F_curve(30) * 1.4),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Strength signal zone (around 30s) shouldn't be the pick. Allow
    // some kernel bleed — assert pick is NOT inside the obvious peak.
    expect(rec.T < 15 || rec.T > 60).toBe(true);
  });

  test("recency penalty steers away from a just-trained zone", () => {
    // Two zones with identical limiter strength: strength_endurance
    // (T=160, in zone bounds [140, 180)) trained TODAY, vs power
    // (T=30, in zone bounds [12, 50)) trained 21 days ago. With
    // zone-based recency the strength_endurance zone's penalty drops
    // to ~0 today, so the rested power limiter wins on score.
    const history = [
      // Today: strength_endurance limiter at T=160 (in-zone)
      buildRep("L", 160, F_curve(160) * 0.5, 0),
      buildRep("L", 160, F_curve(160) * 0.5, 0),
      // 21 days ago: power limiter at T=30 (in-zone)
      buildRep("L", 30, F_curve(30) * 0.5, 21),
      buildRep("L", 30, F_curve(30) * 0.5, 21),
      // 21 days ago: anchors so the curve has a sane shape
      buildRep("L", 60, F_curve(60), 21),
      buildRep("L", 90, F_curve(90), 21),
      buildRep("L", 120, F_curve(120), 21),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Just-trained strength_endurance is crushed by recency ≈ 0.
    // The pick should not land inside [140, 180).
    expect(rec.T < 140 || rec.T >= 180).toBe(true);
  });

  test("residualBoost field is preserved as alias for adaptBoost (back-compat)", () => {
    const history = [buildRep("L", 30, F_curve(30)), buildRep("L", 60, F_curve(60))];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.residualBoost).toBe(rec.adaptBoost);
  });

  test("activities (recent climbing) suppress the recommendation score", () => {
    // Same history both runs; the only difference is whether activities
    // include a recent hard climbing session. With it, the score should
    // be lower (activities multiply through ext < 1.0 within 48h).
    const history = [
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 120, F_curve(120)),
    ];
    const priors = buildThreeExpPriors(history);
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const hardClimb = Array.from({ length: 6 }, () => ({
      type: "climbing", date: yday, rpe: 8,
    }));
    const noClimbs   = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today });
    const withClimbs = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors: priors, today, activities: hardClimb });
    expect(noClimbs).not.toBeNull();
    expect(withClimbs).not.toBeNull();
    // ext is exposed on the result for transparency
    expect(withClimbs.ext).toBeLessThan(1.0);
    expect(noClimbs.ext).toBe(1.0);
    // Score should drop when climbing fatigue is in play
    expect(withClimbs.score).toBeLessThan(noClimbs.score);
  });

  test("staleness is per-grip — Crusher endurance training doesn't refresh Micro endurance", () => {
    // Helper: same as buildRep but lets us pick the grip
    const rep = (hand, grip, T, F, daysAgo = 0) => ({
      id: `r-${grip}-${hand}-${T}-${daysAgo}`,
      hand, grip,
      target_duration: T, actual_time_s: T,
      avg_force_kg: F,
      rep_num: 1,
      date: new Date(Date.now() - daysAgo * 86400000).toISOString().slice(0, 10),
      session_id: `s-${grip}-${daysAgo}-${T}`,
    });
    // History: Crusher trained across all zones recently (none stale on
    // Crusher), AND Micro trained at short Ts only (50 days ago) so Micro
    // endurance is genuinely stale. Under pooled staleness the Crusher
    // endurance training would mask Micro endurance's staleness; under
    // per-grip staleness Micro endurance still flags as stale and the
    // engine should pick endurance for Micro.
    const history = [
      // Crusher: full coverage today
      rep("L", "Crusher", 10,  F_curve(10),  0),
      rep("L", "Crusher", 30,  F_curve(30),  0),
      rep("L", "Crusher", 70,  F_curve(70),  0),
      rep("L", "Crusher", 115, F_curve(115), 0),
      rep("L", "Crusher", 160, F_curve(160), 0),
      rep("L", "Crusher", 220, F_curve(220), 0),
      // Micro: short-T only, 50 days ago — endurance window is 35d so
      // Micro endurance is well past stale.
      rep("L", "Micro", 10, F_curve(10), 50),
      rep("L", "Micro", 30, F_curve(30), 50),
      rep("L", "Micro", 70, F_curve(70), 50),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Micro",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Engine should see Micro endurance as stale and prefer it. Pick
    // should land in the endurance bucket (T ≥ 180s).
    expect(rec.zone).toBe("endurance");
    expect(rec.staleStatus).not.toBe("ok");
  });
});
