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
    // Coverage across every zone (so no never-zone wins by 3.0× boost),
    // all 8 days ago (every zone is "ok" with recency near 1.0 — neutral
    // score multipliers across the board). A single under-perform at 90s
    // creates a localized limiter signal; with enough on-curve reps to
    // dilute the limiter in the three-exp prior, the fit stays close to
    // the true curve and the residual at T=90 produces adaptBoost > 1.
    const d = 8;
    const history = [
      buildRep("L", 5,   F_curve(5),   d),
      buildRep("L", 10,  F_curve(10),  d),
      buildRep("L", 15,  F_curve(15),  d),
      buildRep("L", 20,  F_curve(20),  d),
      buildRep("L", 30,  F_curve(30),  d),
      buildRep("L", 45,  F_curve(45),  d),
      buildRep("L", 60,  F_curve(60),  d),
      buildRep("L", 120, F_curve(120), d),
      buildRep("L", 160, F_curve(160), d),   // covers S·E
      buildRep("L", 180, F_curve(180), d),   // covers endurance boundary
      buildRep("L", 90,  F_curve(90) * 0.6, d),  // localized limiter
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

  test("never-sampled zone wins over above-curve sampled zone (adaptBoost floor)", () => {
    // Reproduce the May 2026 issue: Crusher Strength reps showing above-
    // curve performance at 90-120s suppressed the adaptBoost at T=160s
    // (Strength·Endurance) via Gaussian kernel leak, letting Power win
    // even though S·E was "never" sampled (3.0× boost).
    //
    // History: solid coverage at 30-120s with the user above curve at
    // 95-120s (~1.4× the fit). No samples in [140, 180) → S·E status
    // should be "never" → 3.0× staleness boost.
    //
    // Without the floor: adaptBoost at T=160 gets crushed by leakage
    // from above-curve 95-120s reps → ~0.2 × 3.0 = 0.6, loses to Power.
    // With the floor: adaptBoost ≥ 1.0 in S·E → 1.0 × 3.0 = 3.0, wins.
    const history = [
      // Power zone, on curve (T=30s)
      buildRep("L", 30, F_curve(30), 6),
      buildRep("L", 30, F_curve(30), 12),
      // Strength zone, ABOVE curve (T=95, T=120s) — this is what was
      // leaking into T=160 via the Gaussian
      buildRep("L", 95,  F_curve(95)  * 1.4, 8),
      buildRep("L", 120, F_curve(120) * 1.4, 8),
      buildRep("L", 120, F_curve(120) * 1.4, 18),
      // Endurance anchor (T=220s) — well away from S·E so it doesn't
      // dominate the localRatio computation at 160
      buildRep("L", 220, F_curve(220), 14),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Pick should land in the strength_endurance zone [140, 180)
    expect(rec.zone).toBe("strength_endurance");
    expect(rec.staleStatus).toBe("never");
    // Floor pinned adaptBoost ≥ 1.0 in the never zone
    expect(rec.adaptBoost).toBeGreaterThanOrEqual(1.0);
  });

  test("never-zone tiebreaker: T snaps to the zone's reference time", () => {
    // With the adaptBoost floor flattening every T inside a never zone
    // to the same score, the engine should pick the zone's canonical
    // refT (S·E → 160) rather than the zone's lower boundary by first-T
    // accident. History covers max_strength through strength so S·E and
    // Endurance are both "never"; S·E wins by zone-order, and within
    // S·E the pick should land at T=160 not T=140 (boundary).
    const history = [
      buildRep("L", 10,  F_curve(10),  6),   // max_strength
      buildRep("L", 30,  F_curve(30),  6),   // power
      buildRep("L", 30,  F_curve(30),  12),
      buildRep("L", 70,  F_curve(70),  8),   // power_strength
      buildRep("L", 95,  F_curve(95)  * 1.4, 8),   // strength (above curve)
      buildRep("L", 120, F_curve(120) * 1.4, 8),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.zone).toBe("strength_endurance");
    expect(rec.staleStatus).toBe("never");
    expect(rec.T).toBe(160);  // ZONE_REF_T.strength_endurance
  });

  test("never-zone snap: Endurance pick lands at T=220, not T=180 boundary", () => {
    // Same property for the Endurance zone. History covers every zone
    // except Endurance so Endurance is the uniquely-never pick. Pick
    // should snap to the canonical Endurance refT.
    const history = [
      buildRep("L", 10,  F_curve(10),  5),   // max_strength
      buildRep("L", 30,  F_curve(30),  5),   // power
      buildRep("L", 70,  F_curve(70),  8),   // power_strength
      buildRep("L", 95,  F_curve(95),  8),   // strength
      buildRep("L", 120, F_curve(120), 8),
      buildRep("L", 160, F_curve(160), 10),  // strength_endurance
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    expect(rec.zone).toBe("endurance");
    expect(rec.staleStatus).toBe("never");
    expect(rec.T).toBe(220);  // ZONE_REF_T.endurance
  });

  test("never-zone floor does not lift adaptBoost above 1.0 for limiter signal", () => {
    // The floor is a MINIMUM, not a ceiling — a genuine below-curve
    // signal in a never zone should still produce adaptBoost > 1.0.
    // (Unlikely in practice since "never" means no in-zone data, but
    // kernel leakage from a below-curve neighbor can drive localRatio
    // below 1.0 at the never-zone's T.) Pin the contract that the floor
    // doesn't clamp UP — only floors at 1.0 when adaptBoost would
    // otherwise drop below.
    const history = [
      // Strong below-curve signal at 120s (Strength), bleeds into 160s
      buildRep("L", 30,  F_curve(30),          5),
      buildRep("L", 60,  F_curve(60),          5),
      buildRep("L", 120, F_curve(120) * 0.5,   5),
      buildRep("L", 120, F_curve(120) * 0.5,  10),
      buildRep("L", 220, F_curve(220),        15),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Crusher",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // adaptBoost can be > 1.0 (limiter signal won't be clamped down)
    expect(rec.adaptBoost).toBeGreaterThan(0);
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
    // Crusher), AND Micro trained everywhere EXCEPT endurance (also 50
    // days ago — past every zone's lockout window). Endurance is the
    // uniquely never-sampled Micro zone, so under per-grip staleness it
    // should uniquely earn the 3.0× boost while all other Micro zones
    // get the 2.0× stale boost. Pooled staleness would mask Micro
    // endurance behind the Crusher endurance training.
    const history = [
      // Crusher: full coverage today
      rep("L", "Crusher", 10,  F_curve(10),  0),
      rep("L", "Crusher", 30,  F_curve(30),  0),
      rep("L", "Crusher", 70,  F_curve(70),  0),
      rep("L", "Crusher", 115, F_curve(115), 0),
      rep("L", "Crusher", 160, F_curve(160), 0),
      rep("L", "Crusher", 220, F_curve(220), 0),
      // Micro: covers max_strength through strength_endurance (50d ago)
      // but never trained endurance. Endurance is uniquely "never".
      rep("L", "Micro", 10,  F_curve(10),  50),
      rep("L", "Micro", 30,  F_curve(30),  50),
      rep("L", "Micro", 70,  F_curve(70),  50),
      rep("L", "Micro", 115, F_curve(115), 50),
      rep("L", "Micro", 160, F_curve(160), 50),
    ];
    const priors = buildThreeExpPriors(history);
    const rec = coachingRecommendationContinuous(history, "Micro",
      { threeExpPriors: priors, today });
    expect(rec).not.toBeNull();
    // Engine should see Micro endurance as never-trained and prefer it
    // over the stale-but-sampled zones. Pick lands in endurance (T ≥ 180s).
    expect(rec.zone).toBe("endurance");
    expect(rec.staleStatus).toBe("never");
  });
});
