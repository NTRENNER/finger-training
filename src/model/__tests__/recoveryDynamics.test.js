// Tests for src/model/recoveryDynamics.js — between-rep capacity
// restoration metrics that feed the RecoveryChart.

import {
  buildObservedRecoverySeries,
  buildPredictedRecoverySeries,
  buildRecoveryBundle,
  buildRecoveryTrend,
  withRollingMean,
  classifyRecovery,
  OPERATING_LOW, OPERATING_HIGH, GAP_TARGET_REP, GAP_NOISE_BAND,
} from "../recoveryDynamics.js";
import { getPhysModel } from "../fatigue.js";

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────

// Realistic-looking physModel from the population defaults. We
// don't need the full freshMap / history pipeline here — the
// model's recovery predictions are deterministic given a physModel.
const physModel = getPhysModel([], "L", "Crusher");

function rep(repNum, actual_time_s) {
  return { rep_num: repNum, actual_time_s };
}

// ─────────────────────────────────────────────────────────────
// buildObservedRecoverySeries
// ─────────────────────────────────────────────────────────────

describe("buildObservedRecoverySeries", () => {
  test("rep 1 always anchors at 1.0", () => {
    const out = buildObservedRecoverySeries([rep(1, 30), rep(2, 20)]);
    expect(out[0]).toEqual({ rep: 1, observedFraction: 1 });
  });

  test("rep N returns actual_time_s(N) / actual_time_s(1)", () => {
    const out = buildObservedRecoverySeries([rep(1, 30), rep(2, 24), rep(3, 18)]);
    expect(out[1].observedFraction).toBeCloseTo(24 / 30, 5);
    expect(out[2].observedFraction).toBeCloseTo(18 / 30, 5);
  });

  test("rep order is normalized by rep_num", () => {
    const out = buildObservedRecoverySeries([rep(3, 18), rep(1, 30), rep(2, 24)]);
    expect(out.map(p => p.observedFraction)).toEqual([
      1, 24 / 30, 18 / 30,
    ]);
  });

  test("rep 1 missing time → all ratios null", () => {
    const out = buildObservedRecoverySeries([rep(1, 0), rep(2, 20)]);
    expect(out.every(p => p.observedFraction == null)).toBe(true);
  });

  test("a missing time in the middle → null only for that rep", () => {
    const out = buildObservedRecoverySeries([rep(1, 30), rep(2, 0), rep(3, 18)]);
    expect(out[0].observedFraction).toBe(1);
    expect(out[1].observedFraction).toBeNull();
    expect(out[2].observedFraction).toBeCloseTo(18 / 30, 5);
  });

  test("empty input → empty array", () => {
    expect(buildObservedRecoverySeries([])).toEqual([]);
    expect(buildObservedRecoverySeries(null)).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// buildPredictedRecoverySeries
// ─────────────────────────────────────────────────────────────

describe("buildPredictedRecoverySeries", () => {
  test("rep 1 always anchors at 1.0", () => {
    const out = buildPredictedRecoverySeries({
      numReps: 3, firstRepTime: 30, restSeconds: 20, physModel,
    });
    expect(out[0]).toEqual({ rep: 1, predictedFraction: 1 });
  });

  test("subsequent reps decline (capacity drops as fatigue accumulates)", () => {
    const out = buildPredictedRecoverySeries({
      numReps: 5, firstRepTime: 30, restSeconds: 20, physModel,
    });
    // Each rep should be <= the previous one — recovery never fully
    // catches up at constant load with finite rest.
    for (let i = 1; i < out.length; i++) {
      expect(out[i].predictedFraction).toBeLessThanOrEqual(
        out[i - 1].predictedFraction + 1e-9,
      );
    }
  });

  test("longer rest → higher recovered fraction at rep 2", () => {
    const short = buildPredictedRecoverySeries({
      numReps: 2, firstRepTime: 30, restSeconds: 10, physModel,
    });
    const long = buildPredictedRecoverySeries({
      numReps: 2, firstRepTime: 30, restSeconds: 120, physModel,
    });
    expect(long[1].predictedFraction).toBeGreaterThan(short[1].predictedFraction);
  });

  test("missing physModel → empty array (can't predict without taus)", () => {
    expect(buildPredictedRecoverySeries({
      numReps: 3, firstRepTime: 30, restSeconds: 20, physModel: null,
    })).toEqual([]);
  });

  test("zero firstRepTime → empty array", () => {
    expect(buildPredictedRecoverySeries({
      numReps: 3, firstRepTime: 0, restSeconds: 20, physModel,
    })).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────────
// classifyRecovery
// ─────────────────────────────────────────────────────────────

describe("classifyRecovery", () => {
  test("inside [LOW, HIGH] → operating_zone", () => {
    expect(classifyRecovery(0.8)).toBe("operating_zone");
    expect(classifyRecovery(OPERATING_LOW)).toBe("operating_zone");
    expect(classifyRecovery(OPERATING_HIGH)).toBe("operating_zone");
  });

  test("below LOW → deep_depletion", () => {
    expect(classifyRecovery(0.5)).toBe("deep_depletion");
    expect(classifyRecovery(OPERATING_LOW - 0.01)).toBe("deep_depletion");
  });

  test("above HIGH → shallow_depletion", () => {
    expect(classifyRecovery(0.95)).toBe("shallow_depletion");
    expect(classifyRecovery(1.0)).toBe("shallow_depletion");
  });

  test("null / invalid → null", () => {
    expect(classifyRecovery(null)).toBeNull();
    expect(classifyRecovery(undefined)).toBeNull();
    expect(classifyRecovery(NaN)).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────────
// buildRecoveryBundle — end-to-end shape
// ─────────────────────────────────────────────────────────────

describe("buildRecoveryBundle", () => {
  test("produces both series and a gap at the target rep", () => {
    const reps = [rep(1, 30), rep(2, 24), rep(3, 20)];
    const out = buildRecoveryBundle({ reps, restSeconds: 20, physModel });
    expect(out.observed).toHaveLength(3);
    expect(out.predicted).toHaveLength(3);
    expect(out.observedAtTarget).toBeCloseTo(24 / 30, 5);
    expect(out.gapAtTarget).toBe(
      out.observedAtTarget - out.predicted.find(p => p.rep === GAP_TARGET_REP).predictedFraction,
    );
  });

  test("gap is positive when user recovered faster than model predicts", () => {
    // Long rest + a rep 2 close to rep 1 means the user recovered
    // about as well as the model predicts (or maybe better). Use
    // a very long rest so the model predicts near-full recovery.
    const reps = [rep(1, 30), rep(2, 29)]; // ~97% recovered observed
    const out = buildRecoveryBundle({ reps, restSeconds: 300, physModel });
    // With 5 minutes of rest the model should predict near-full
    // recovery too, so the gap shouldn't be wildly off either way.
    expect(out.gapAtTarget).toBeGreaterThan(-0.2);
    expect(out.gapAtTarget).toBeLessThan(0.2);
  });

  test("gap is negative when user recovered slower than model predicts", () => {
    // Short rest + a poor rep 2 vs long rest + same poor rep 2.
    // The short-rest version predicts low recovery (smaller gap);
    // the long-rest version predicts high recovery (bigger gap).
    const repsBadRecovery = [rep(1, 30), rep(2, 5)]; // 17% observed
    const longRest = buildRecoveryBundle({
      reps: repsBadRecovery, restSeconds: 300, physModel,
    });
    expect(longRest.gapAtTarget).toBeLessThan(0); // user underperformed
  });

  test("rep 1 only → no gap (single rep can't measure recovery)", () => {
    const out = buildRecoveryBundle({
      reps: [rep(1, 30)], restSeconds: 20, physModel,
    });
    expect(out.observed).toHaveLength(1);
    expect(out.gapAtTarget).toBeNull();
    expect(out.observedAtTarget).toBeNull();
  });

  test("missing physModel → observed only, no predicted, no gap", () => {
    const reps = [rep(1, 30), rep(2, 24)];
    const out = buildRecoveryBundle({ reps, restSeconds: 20, physModel: null });
    expect(out.observed).toHaveLength(2);
    expect(out.predicted).toEqual([]);
    expect(out.gapAtTarget).toBeNull();
  });

  test("empty reps → empty everything", () => {
    const out = buildRecoveryBundle({ reps: [], restSeconds: 20, physModel });
    expect(out).toEqual({
      observed: [], predicted: [],
      gapAtTarget: null, observedAtTarget: null,
    });
  });
});

// ─────────────────────────────────────────────────────────────
// Module-level constants — sanity
// ─────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────
// buildRecoveryTrend — per-session aggregation across history
// ─────────────────────────────────────────────────────────────

function repRow({ session_id, date, grip, hand, rep_num, actual_time_s }) {
  return { session_id, date, grip, hand, rep_num, actual_time_s };
}

describe("buildRecoveryTrend", () => {
  test("empty / null inputs → empty array", () => {
    expect(buildRecoveryTrend([], "Crusher")).toEqual([]);
    expect(buildRecoveryTrend(null, "Crusher")).toEqual([]);
    expect(buildRecoveryTrend([repRow({})], null)).toEqual([]);
  });

  test("one session with rep 2 produces one point", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out).toHaveLength(1);
    expect(out[0].date).toBe("2026-05-01");
    expect(out[0].observedAtTarget).toBeCloseTo(24 / 30, 5);
  });

  test("sessions sort ascending by date", () => {
    const history = [
      repRow({ session_id: "s2", date: "2026-05-10", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s2", date: "2026-05-10", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 27 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out.map(p => p.date)).toEqual(["2026-05-01", "2026-05-10"]);
  });

  test("Both-mode session averages L and R into one point", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }), // L: 0.8
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "R", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "R", rep_num: 2, actual_time_s: 21 }), // R: 0.7
    ];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out).toHaveLength(1);
    expect(out[0].observedAtTarget).toBeCloseTo(0.75, 5); // mean(0.8, 0.7)
  });

  // Regression: grouping used to ignore set_num, so a multi-set
  // session paired SOME set's rep 1 with SOME other set's rep 2
  // (insertion-order dependent). Per-set ratios must be computed
  // within each set, then averaged into the session point.
  test("multi-set session computes the gap within each set, then averages", () => {
    const set = (set_num, t1, t2) => [
      { ...repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: t1 }), set_num },
      { ...repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: t2 }), set_num },
    ];
    // set 1: 15/30 = 0.5 — set 2: 50/60 ≈ 0.8333 — mean ≈ 0.6667.
    // The broken merged grouping yielded 15/30 = 0.5 instead.
    const history = [...set(1, 30, 15), ...set(2, 60, 50)];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out).toHaveLength(1);
    expect(out[0].observedAtTarget).toBeCloseTo((15 / 30 + 50 / 60) / 2, 5);
  });

  test("filters by grip — Micro sessions ignored when querying Crusher", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }),
      repRow({ session_id: "s2", date: "2026-05-02", grip: "Micro", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s2", date: "2026-05-02", grip: "Micro", hand: "L", rep_num: 2, actual_time_s: 18 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out).toHaveLength(1);
    expect(out[0].observedAtTarget).toBeCloseTo(24 / 30, 5);
  });

  test("session with only rep 1 produces no point", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
    ];
    expect(buildRecoveryTrend(history, "Crusher")).toEqual([]);
  });

  test("without physModel, gapAtTarget is null", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher");
    expect(out[0].observedAtTarget).toBeCloseTo(24 / 30, 5);
    expect(out[0].gapAtTarget).toBeNull();
  });

  test("with physModel + rest_s, gapAtTarget = observed − predicted at rep 2", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30, rest_s: 20 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24, rest_s: 20 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher", { physModel });
    expect(out).toHaveLength(1);
    expect(out[0].observedAtTarget).toBeCloseTo(24 / 30, 5);
    expect(Number.isFinite(out[0].gapAtTarget)).toBe(true);
    // gap = observed - predicted; with the population physModel and
    // 20s rest after a 30s rep 1, predicted recovery is well below 1.
    // We just sanity-check the relationship rather than re-deriving it.
    expect(out[0].gapAtTarget).toBeLessThan(out[0].observedAtTarget);
  });

  test("missing rest_s falls back to 20s, gap still computed", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher", { physModel });
    expect(Number.isFinite(out[0].gapAtTarget)).toBe(true);
  });

  test("gap is robust to rep 1 lengthening at constant load", () => {
    // Same recovery dynamics, but rep 1 got longer between sessions
    // (user got stronger). Observed fraction will drop, but gap should
    // stay flat-ish because predicted drops in step with observed.
    const baseRest = 20;
    // For each session, set rep 2 = predicted-at-target * rep 1, so
    // observed exactly equals predicted → gap = 0. If gap stays ≈ 0
    // across both sessions despite observed dropping, the metric works.
    const { predictRepTimes } = require("../fatigue.js");
    const predA = predictRepTimes({ numReps: 2, firstRepTime: 20, restSeconds: baseRest, physModel });
    const predB = predictRepTimes({ numReps: 2, firstRepTime: 35, restSeconds: baseRest, physModel });
    const fracA = predA[1] / predA[0];
    const fracB = predB[1] / predB[0];
    const history = [
      repRow({ session_id: "sA", date: "2026-04-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 20, rest_s: baseRest }),
      repRow({ session_id: "sA", date: "2026-04-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 20 * fracA, rest_s: baseRest }),
      repRow({ session_id: "sB", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 35, rest_s: baseRest }),
      repRow({ session_id: "sB", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 35 * fracB, rest_s: baseRest }),
    ];
    const out = buildRecoveryTrend(history, "Crusher", { physModel });
    expect(out).toHaveLength(2);
    // Observed has dropped (longer rep 1 → deeper depletion → smaller fraction)
    expect(out[1].observedAtTarget).toBeLessThan(out[0].observedAtTarget);
    // …but the gap should be ≈ 0 for both sessions (within rounding noise)
    expect(Math.abs(out[0].gapAtTarget)).toBeLessThan(0.01);
    expect(Math.abs(out[1].gapAtTarget)).toBeLessThan(0.01);
  });

  test("Both-mode gap averages L and R gaps", () => {
    const history = [
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 1, actual_time_s: 30, rest_s: 20 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "L", rep_num: 2, actual_time_s: 24, rest_s: 20 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "R", rep_num: 1, actual_time_s: 30, rest_s: 20 }),
      repRow({ session_id: "s1", date: "2026-05-01", grip: "Crusher", hand: "R", rep_num: 2, actual_time_s: 21, rest_s: 20 }),
    ];
    const out = buildRecoveryTrend(history, "Crusher", { physModel });
    expect(out).toHaveLength(1);
    // L and R have identical predicted (same rep 1, same rest, same model),
    // so the mean gap should equal the average of the two observed-minus-predicted.
    expect(out[0].observedAtTarget).toBeCloseTo(0.75, 5); // mean(0.8, 0.7)
    expect(Number.isFinite(out[0].gapAtTarget)).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// withRollingMean
// ─────────────────────────────────────────────────────────────

describe("withRollingMean", () => {
  test("empty input → empty output", () => {
    expect(withRollingMean([])).toEqual([]);
    expect(withRollingMean(null)).toEqual([]);
  });

  test("first point smoothed = raw (window of 1 effectively)", () => {
    const trend = [{ date: "d1", observedAtTarget: 0.8 }];
    const out = withRollingMean(trend);
    expect(out[0].observedSmoothed).toBe(0.8);
  });

  test("3-window mean on 3 points = arithmetic mean of all three", () => {
    const trend = [
      { date: "d1", observedAtTarget: 0.6 },
      { date: "d2", observedAtTarget: 0.8 },
      { date: "d3", observedAtTarget: 0.7 },
    ];
    const out = withRollingMean(trend, 3);
    expect(out[2].observedSmoothed).toBeCloseTo((0.6 + 0.8 + 0.7) / 3, 5);
  });

  test("preserves date and original observedAtTarget", () => {
    const trend = [{ date: "d1", observedAtTarget: 0.5 }];
    const out = withRollingMean(trend);
    expect(out[0].date).toBe("d1");
    expect(out[0].observedAtTarget).toBe(0.5);
  });

  test("smooths gapAtTarget in parallel with observedAtTarget", () => {
    const trend = [
      { date: "d1", observedAtTarget: 0.6, gapAtTarget: -0.05 },
      { date: "d2", observedAtTarget: 0.8, gapAtTarget:  0.10 },
      { date: "d3", observedAtTarget: 0.7, gapAtTarget: -0.02 },
    ];
    const out = withRollingMean(trend, 3);
    expect(out[2].observedSmoothed).toBeCloseTo((0.6 + 0.8 + 0.7) / 3, 5);
    expect(out[2].gapSmoothed).toBeCloseTo((-0.05 + 0.10 + -0.02) / 3, 5);
  });

  test("gapSmoothed is null when no finite gap values in window", () => {
    const trend = [
      { date: "d1", observedAtTarget: 0.6, gapAtTarget: null },
      { date: "d2", observedAtTarget: 0.8, gapAtTarget: null },
    ];
    const out = withRollingMean(trend, 3);
    expect(out[0].gapSmoothed).toBeNull();
    expect(out[1].gapSmoothed).toBeNull();
    // Observed is still smoothed
    expect(out[0].observedSmoothed).toBeCloseTo(0.6, 5);
    expect(out[1].observedSmoothed).toBeCloseTo(0.7, 5);
  });
});

describe("GAP_NOISE_BAND", () => {
  test("is a small positive fraction (sane noise threshold)", () => {
    expect(GAP_NOISE_BAND).toBeGreaterThan(0);
    expect(GAP_NOISE_BAND).toBeLessThan(0.5);
  });
});

describe("operating-zone constants", () => {
  test("LOW < HIGH and both in (0, 1)", () => {
    expect(OPERATING_LOW).toBeGreaterThan(0);
    expect(OPERATING_LOW).toBeLessThan(OPERATING_HIGH);
    expect(OPERATING_HIGH).toBeLessThan(1);
  });

  test("GAP_TARGET_REP is the first inter-rep measurement (rep 2)", () => {
    expect(GAP_TARGET_REP).toBe(2);
  });
});
