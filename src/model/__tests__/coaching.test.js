// Tests for src/model/coaching.js — continuous coaching engine.
// Covers recencyPenalty, externalLoadModifier, and the
// coachingRecommendationContinuous AUC-gain picker.
//
// The earlier discrete (zone × hand) engine and its rationale formatter
// were retired May 2026 along with the SessionPlannerCard surface they
// backed; the tests for coachingRecommendation, coachingRationale, and
// zoneResidualFactor were dropped at the same time.

import {
  COACH_RECOVERY_TAU_DAYS,
  recencyPenalty, externalLoadModifier,
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

  test("prefers actual_time_s over target_duration when present", () => {
    const today = new Date().toISOString().slice(0, 10);
    // User targeted strength_endurance (140s) but only held 60s. The
    // body trained power_strength, not strength_endurance — so:
    //   recencyPenalty(power_strength) should be ~0 (fresh)
    //   recencyPenalty(strength_endurance) should be 1.0 (untouched)
    // This matches getZoneStaleness's bucketing so both functions
    // agree on what counts as "trained in zone."
    const history = [{
      grip: "Crusher", target_duration: 140, actual_time_s: 60, date: today,
    }];
    expect(recencyPenalty("power_strength",     history, "Crusher")).toBeLessThan(0.1);
    expect(recencyPenalty("strength_endurance", history, "Crusher")).toBe(1.0);
  });

  test("falls back to target_duration when actual_time_s is missing", () => {
    const today = new Date().toISOString().slice(0, 10);
    // Legacy / manual rep with no actual_time_s — bucket by target.
    const history = [{ grip: "Crusher", target_duration: 30, date: today }];
    expect(recencyPenalty("power", history, "Crusher")).toBeLessThan(0.1);
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

  test("perceivedFatigue does NOT bias the recommendation (pure-math pick)", () => {
    // The RPE slider is a display/runner overlay, not an engine input.
    // What the curve wants next is a pure-math question over staleness,
    // recency, the F-D residual, and recent climbing — how tired the
    // user feels today shouldn't change which ZONE gets recommended,
    // only how much LOAD they're prescribed. Pin that contract here.
    const history = [
      buildRep("L", 30, F_curve(30)),
      buildRep("L", 60, F_curve(60)),
      buildRep("L", 120, F_curve(120)),
    ];
    const priors = buildThreeExpPriors(history);
    const fresh  = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today, perceivedFatigue: 0 });
    const cooked = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today, perceivedFatigue: 10 });
    expect(fresh).not.toBeNull();
    expect(cooked).not.toBeNull();
    expect(cooked.zone).toBe(fresh.zone);
    expect(cooked.T).toBe(fresh.T);
    expect(cooked.score).toBe(fresh.score);
    expect(cooked.ext).toBe(fresh.ext);
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
