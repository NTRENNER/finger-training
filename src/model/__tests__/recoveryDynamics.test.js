// Tests for src/model/recoveryDynamics.js — between-rep capacity
// restoration metrics that feed the RecoveryChart.

import {
  buildObservedRecoverySeries,
  buildPredictedRecoverySeries,
  buildRecoveryBundle,
  buildRecoveryTrend,
  withRollingMean,
  classifyRecovery,
  OPERATING_LOW, OPERATING_HIGH, GAP_TARGET_REP,
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
  test("inside [LOW, HIGH] → well_calibrated", () => {
    expect(classifyRecovery(0.8)).toBe("well_calibrated");
    expect(classifyRecovery(OPERATING_LOW)).toBe("well_calibrated");
    expect(classifyRecovery(OPERATING_HIGH)).toBe("well_calibrated");
  });

  test("below LOW → under_rested", () => {
    expect(classifyRecovery(0.5)).toBe("under_rested");
    expect(classifyRecovery(OPERATING_LOW - 0.01)).toBe("under_rested");
  });

  test("above HIGH → over_rested", () => {
    expect(classifyRecovery(0.95)).toBe("over_rested");
    expect(classifyRecovery(1.0)).toBe("over_rested");
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
