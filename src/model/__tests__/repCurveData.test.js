// Tests for src/model/repCurveData.js — assembly helpers for the
// shared RepCurveChart component.

import {
  buildPhysModel,
  buildForecastSeries,
  buildActualSeries,
  findPrevSessionReps,
  computeAsymptoticHold,
  buildRepCurveBundle,
} from "../repCurveData.js";
import { PHYS_MODEL_DEFAULT } from "../fatigue.js";
import { computePersonalRecoveryTausForGrip } from "../recoveryFit.js";

const rep = (over = {}) => ({
  date: "2026-05-15",
  grip: "Crusher", hand: "L",
  target_duration: 45,
  actual_time_s: 30,
  set_num: 1, rep_num: 1,
  session_id: "s1",
  ...over,
});

describe("buildForecastSeries", () => {
  test("returns numReps points indexed from rep 1", () => {
    const out = buildForecastSeries({
      numReps: 5, firstRepTime: 30, restSeconds: 20, physModel: PHYS_MODEL_DEFAULT,
    });
    expect(out).toHaveLength(5);
    expect(out[0]).toEqual({ rep: 1, t: expect.any(Number) });
    expect(out[4].rep).toBe(5);
  });

  test("first rep equals firstRepTime (no fatigue yet)", () => {
    const out = buildForecastSeries({
      numReps: 3, firstRepTime: 42, restSeconds: 30, physModel: PHYS_MODEL_DEFAULT,
    });
    expect(out[0].t).toBeCloseTo(42, 1);
  });

  test("decay is monotone with default short rest", () => {
    const out = buildForecastSeries({
      numReps: 5, firstRepTime: 30, restSeconds: 20, physModel: PHYS_MODEL_DEFAULT,
    });
    for (let i = 1; i < out.length; i++) {
      expect(out[i].t).toBeLessThanOrEqual(out[i - 1].t);
    }
  });

  test("returns [] for invalid input", () => {
    expect(buildForecastSeries({ numReps: 0, firstRepTime: 30, restSeconds: 20 })).toEqual([]);
    expect(buildForecastSeries({ numReps: 5, firstRepTime: 0,  restSeconds: 20 })).toEqual([]);
  });
});

describe("buildActualSeries", () => {
  test("returns sorted by (set_num, rep_num)", () => {
    const reps = [
      rep({ set_num: 1, rep_num: 3, actual_time_s: 22 }),
      rep({ set_num: 1, rep_num: 1, actual_time_s: 30 }),
      rep({ set_num: 1, rep_num: 2, actual_time_s: 26 }),
    ];
    const out = buildActualSeries(reps);
    expect(out).toEqual([
      { rep: 1, t: 30 },
      { rep: 2, t: 26 },
      { rep: 3, t: 22 },
    ]);
  });

  test("skips reps with no/zero actual_time_s", () => {
    const reps = [
      rep({ rep_num: 1, actual_time_s: 30 }),
      rep({ rep_num: 2, actual_time_s: 0 }),
      rep({ rep_num: 3, actual_time_s: null }),
      rep({ rep_num: 4, actual_time_s: 18 }),
    ];
    const out = buildActualSeries(reps);
    expect(out.map(p => p.t)).toEqual([30, 18]);
  });

  test("returns [] on empty/invalid input", () => {
    expect(buildActualSeries(null)).toEqual([]);
    expect(buildActualSeries([])).toEqual([]);
  });
});

describe("findPrevSessionReps", () => {
  // target_duration 45 falls in the "power" zone (12-50s); 40 is also
  // in power; 50 is power_strength; 160 is strength_endurance. The two
  // power sessions are the candidates; the others should be filtered.
  const history = [
    rep({ date: "2026-05-01", session_id: "s_old", target_duration: 45, actual_time_s: 28 }),
    rep({ date: "2026-05-01", session_id: "s_old", target_duration: 45, actual_time_s: 24, rep_num: 2 }),
    rep({ date: "2026-05-10", session_id: "s_recent", target_duration: 40, actual_time_s: 35 }),
    rep({ date: "2026-05-10", session_id: "s_recent", target_duration: 40, actual_time_s: 30, rep_num: 2 }),
    rep({ date: "2026-05-15", session_id: "s_diff_zone", target_duration: 160, actual_time_s: 100 }),
  ];

  test("returns most recent session in the same zone before the cutoff", () => {
    const out = findPrevSessionReps(history, {
      grip: "Crusher", hand: "L",
      beforeDate: "2026-05-20",
      targetDuration: 45, // power zone
    });
    expect(out).toBeTruthy();
    expect(out.every(r => r.session_id === "s_recent")).toBe(true);
  });

  test("returns null when no prior session in zone", () => {
    const out = findPrevSessionReps(history, {
      grip: "Micro", hand: "L",
      beforeDate: "2026-05-20",
      targetDuration: 45,
    });
    expect(out).toBeNull();
  });

  test("excludes sessions on or after the cutoff date", () => {
    const out = findPrevSessionReps(history, {
      grip: "Crusher", hand: "L",
      beforeDate: "2026-05-10", // s_recent is ON the cutoff, should exclude
      targetDuration: 45,
    });
    expect(out).toBeTruthy();
    expect(out.every(r => r.session_id === "s_old")).toBe(true);
  });
});

describe("computeAsymptoticHold", () => {
  test("returns a positive number less than firstRepTime", () => {
    const a = computeAsymptoticHold({
      firstRepTime: 30, restSeconds: 20, physModel: PHYS_MODEL_DEFAULT,
    });
    expect(a).toBeGreaterThan(0);
    expect(a).toBeLessThan(30);
  });

  test("longer rest yields higher asymptote", () => {
    const aShort = computeAsymptoticHold({
      firstRepTime: 30, restSeconds: 20, physModel: PHYS_MODEL_DEFAULT,
    });
    const aLong = computeAsymptoticHold({
      firstRepTime: 30, restSeconds: 600, physModel: PHYS_MODEL_DEFAULT,
    });
    expect(aLong).toBeGreaterThan(aShort);
  });

  test("returns null on invalid input", () => {
    expect(computeAsymptoticHold({ firstRepTime: 0, restSeconds: 20 })).toBeNull();
  });
});

describe("buildRepCurveBundle", () => {
  test("returns all four series with sensible shapes", () => {
    const history = [
      rep({ date: "2026-05-01", session_id: "s_old", target_duration: 45,
            actual_time_s: 28, rep_num: 1 }),
      rep({ date: "2026-05-01", session_id: "s_old", target_duration: 45,
            actual_time_s: 22, rep_num: 2 }),
    ];
    const actualReps = [
      rep({ date: "2026-05-15", session_id: "s_now", actual_time_s: 30, rep_num: 1 }),
      rep({ date: "2026-05-15", session_id: "s_now", actual_time_s: 25, rep_num: 2 }),
    ];
    const out = buildRepCurveBundle({
      history,
      grip: "Crusher", hand: "L",
      numReps: 5,
      firstRepTime: 30, restSeconds: 20,
      actualReps,
      targetDuration: 45,
      beforeDate: "2026-05-15",
    });
    expect(out.forecasted).toHaveLength(5);
    expect(out.actual.map(p => p.t)).toEqual([30, 25]);
    expect(out.prevSession.map(p => p.t)).toEqual([28, 22]);
    expect(out.asymptoticHold).toBeGreaterThan(0);
    expect(out.targetS).toBe(45);
  });
});

describe("buildPhysModel personalization", () => {
  // Regression: computePersonalRecoveryTausForGrip returns flat
  // {fast, medium, slow, nSets}, not a nested .tauR — the original
  // wrapper checked personal.tauR and therefore ALWAYS fell back to
  // the population model, silently disabling personalization for
  // every RepCurveChart forecast.
  const decaySession = (sid, times) =>
    times.map((t, i) => rep({
      session_id: sid, rep_num: i + 1, actual_time_s: t, rest_s: 20,
    }));

  // Steep within-set decay → fitted taus differ from population.
  const history = [
    ...decaySession("p1", [30, 18, 12, 9]),
    ...decaySession("p2", [32, 20, 13, 10]),
    ...decaySession("p3", [31, 19, 12, 9]),
  ];

  test("personal fit exists for this fixture (guards the fixture itself)", () => {
    const personal = computePersonalRecoveryTausForGrip(history, "Crusher");
    expect(personal).not.toBeNull();
    expect(personal.fast).toEqual(expect.any(Number));
    expect(personal.nSets).toBeGreaterThanOrEqual(3);
  });

  test("personal taus reach the returned tauR (not the population default)", () => {
    const personal = computePersonalRecoveryTausForGrip(history, "Crusher");
    const model = buildPhysModel(history, "L", "Crusher");
    expect(model.tauR.fast).toBeCloseTo(personal.fast, 6);
    expect(model.tauR.medium).toBeCloseTo(personal.medium, 6);
    // Slow is always population — recoveryFit holds it fixed.
    expect(model.tauR.slow).toBe(PHYS_MODEL_DEFAULT.tauR.slow);
    // And the fit must actually move at least one tau off population,
    // otherwise this test can't distinguish fixed from broken.
    const moved =
      model.tauR.fast !== PHYS_MODEL_DEFAULT.tauR.fast ||
      model.tauR.medium !== PHYS_MODEL_DEFAULT.tauR.medium;
    expect(moved).toBe(true);
  });

  test("falls back to population model when grip has no data", () => {
    const model = buildPhysModel(history, "L", "NoSuchGrip");
    expect(model.tauR).toEqual(PHYS_MODEL_DEFAULT.tauR);
  });
});
