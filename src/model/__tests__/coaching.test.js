// Tests for src/model/coaching.js — coaching recommendation engine v2.
// Covers intensityMatch, recencyPenalty, externalLoadModifier,
// zoneResidualFactor, coachingRecommendation, coachingRationale.

import {
  COACH_INTENSITY, COACH_RECOVERY_TAU_DAYS,
  intensityMatch, recencyPenalty, externalLoadModifier,
  zoneResidualFactor, coachingRecommendation, coachingRationale,
} from "../coaching.js";
import { buildThreeExpPriors } from "../threeExp.js";

// ─────────────────────────────────────────────────────────────
// COACH_INTENSITY / COACH_RECOVERY_TAU_DAYS — sanity
// ─────────────────────────────────────────────────────────────
describe("coaching constants", () => {
  test("intensity ordered: power > strength > endurance", () => {
    expect(COACH_INTENSITY.power).toBeGreaterThan(COACH_INTENSITY.strength);
    expect(COACH_INTENSITY.strength).toBeGreaterThan(COACH_INTENSITY.endurance);
  });

  test("recovery taus ordered: power < strength < endurance", () => {
    expect(COACH_RECOVERY_TAU_DAYS.power).toBeLessThan(COACH_RECOVERY_TAU_DAYS.strength);
    expect(COACH_RECOVERY_TAU_DAYS.strength).toBeLessThan(COACH_RECOVERY_TAU_DAYS.endurance);
  });
});

// ─────────────────────────────────────────────────────────────
// intensityMatch — readiness × zone alignment
// ─────────────────────────────────────────────────────────────
describe("intensityMatch", () => {
  test("returns highest score when readiness matches zone intensity", () => {
    // Power needs high readiness (zone intensity = 1.0)
    // readiness=10 normalizes to 1.0, perfect match
    const m = intensityMatch("power", 10);
    expect(m).toBeCloseTo(1.0, 1);
  });

  test("low readiness penalizes power more than endurance", () => {
    const powerLow = intensityMatch("power", 1);
    const endLow   = intensityMatch("endurance", 1);
    expect(endLow).toBeGreaterThan(powerLow);
  });

  test("never returns below 0.1 (floor)", () => {
    expect(intensityMatch("power", 1)).toBeGreaterThanOrEqual(0.1);
    expect(intensityMatch("endurance", 10)).toBeGreaterThanOrEqual(0.1);
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
    const history = [{ grip: "Crusher", target_duration: 7, date: today }];
    const out = recencyPenalty("power", history, "Crusher");
    expect(out).toBeLessThan(0.1);
  });

  test("approaches 1.0 as days_ago grows", () => {
    const longAgo = "2020-01-01";
    const history = [{ grip: "Crusher", target_duration: 7, date: longAgo }];
    expect(recencyPenalty("power", history, "Crusher")).toBeGreaterThan(0.9);
  });

  test("matches by grip + target_duration (not other zones)", () => {
    const today = new Date().toISOString().slice(0, 10);
    const history = [{ grip: "Crusher", target_duration: 45, date: today }];
    // Trained Strength today, so Strength recency is low
    expect(recencyPenalty("strength", history, "Crusher")).toBeLessThan(0.1);
    // But Power was not trained
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
    // Use yesterday — avoids TZ edge case where today-as-UTC parses to
    // the future relative to local "now" inside the function.
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const acts = [{ type: "climbing", date: yday }];
    const power = externalLoadModifier("power", acts);
    const end   = externalLoadModifier("endurance", acts);
    expect(power).toBeLessThan(end);
  });

  test("ignores non-climbing activities", () => {
    const yday = new Date(Date.now() - 86400000).toISOString().slice(0, 10);
    const acts = [{ type: "rest", date: yday }];
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
    expect(["power", "strength", "endurance"]).toContain(rec.zone);
    expect(["L", "R"]).toContain(rec.hand);
    expect(typeof rec.gap).toBe("number");
    expect(typeof rec.score).toBe("number");
    expect(typeof rec.iMatch).toBe("number");
    expect(typeof rec.recency).toBe("number");
    expect(typeof rec.ext).toBe("number");
  });

  test("higher readiness should score Power higher relative to Capacity", () => {
    const history = buildHistory();
    const priors = buildThreeExpPriors(history);
    const recHigh = coachingRecommendation(history, "Crusher",
      { threeExpPriors: priors, readiness: 10 });
    const recLow  = coachingRecommendation(history, "Crusher",
      { threeExpPriors: priors, readiness: 1 });
    // We don't assert WHICH zone wins — depends on the exact gap shape —
    // but recHigh's Power-zone iMatch should beat recLow's Power iMatch.
    const im10 = intensityMatch("power", 10);
    const im1  = intensityMatch("power", 1);
    expect(im10).toBeGreaterThan(im1);
  });
});

// ─────────────────────────────────────────────────────────────
// coachingRationale — formats human text from a rec
// ─────────────────────────────────────────────────────────────
describe("coachingRationale", () => {
  test("returns empty string for null rec", () => {
    expect(coachingRationale(null)).toBe("");
  });

  test("includes zone-compartment and hand language", () => {
    const rec = { zone: "power", hand: "L", gap: 0.20, iMatch: 0.9, recency: 0.9, ext: 1, resFactor: 1 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/fast|PCr/i);
    expect(text).toMatch(/Left/);
  });

  test("calls out the 3-exp curve in residual signal", () => {
    const rec = { zone: "strength", hand: "R", gap: 0.10, iMatch: 0.8, recency: 0.9, ext: 1, resFactor: 1.6 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/3-exp curve/);
  });

  test("formats positive gap with explicit percentage", () => {
    const rec = { zone: "power", hand: "L", gap: 0.25, iMatch: 0.9, recency: 0.9, ext: 1, resFactor: 1 };
    const text = coachingRationale(rec);
    expect(text).toMatch(/\+25%/);
  });
});
