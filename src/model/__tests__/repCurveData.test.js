import { measuredRecoveryFields } from "../../testHelpers/recovery.js";
// Tests for src/model/repCurveData.js — assembly helpers for the
// shared RepCurveChart component.

import {
  buildPhysModel,
  buildForecastSeries,
  buildActualSeries,
  findPrevSessionReps,
  computeAsymptoticHold,
  buildRepCurveBundle,
  isComparableHold,
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
      rep({ set_num: 1, rep_num: 3, actual_time_s: 22, avg_force_kg: 12 }),
      rep({ set_num: 1, rep_num: 1, actual_time_s: 30, avg_force_kg: 14 }),
      rep({ set_num: 1, rep_num: 2, actual_time_s: 26, avg_force_kg: 13 }),
    ];
    const out = buildActualSeries(reps);
    expect(out).toEqual([
      { rep: 1, t: 30, weightKg: 14, date: "2026-05-15" },
      { rep: 2, t: 26, weightKg: 13, date: "2026-05-15" },
      { rep: 3, t: 22, weightKg: 12, date: "2026-05-15" },
    ]);
  });

  test("keeps missing hold slots as gaps without renumbering later reps", () => {
    const reps = [
      rep({ rep_num: 1, actual_time_s: 30 }),
      rep({ rep_num: 2, actual_time_s: 0 }),
      rep({ rep_num: 3, actual_time_s: null }),
      rep({ rep_num: 4, actual_time_s: 18 }),
    ];
    const out = buildActualSeries(reps);
    expect(out.map(p => p.t)).toEqual([30, null, null, 18]);
    expect(out.map(p => p.rep)).toEqual([1, 2, 3, 4]);
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

  test('matches the same set without flattening prior optional sets', () => {
    const sets = [1, 2].flatMap(set_num => [1, 2, 3, 4].map(rep_num => rep({
      date: '2026-05-12', session_id: 'two-set', set_num, rep_num,
      actual_time_s: 40 / (set_num * rep_num),
    })));
    const args = { grip: 'Crusher', hand: 'L', targetDuration: 45 };
    expect(findPrevSessionReps(sets, args)).toEqual(sets.slice(0, 4));
    expect(findPrevSessionReps(sets, { ...args, setNum: 2 })).toEqual(sets.slice(4));
    expect(findPrevSessionReps(sets.slice(0, 4), { ...args, setNum: 2 })).toBeNull();
  });

  test('a live session cannot become its own previous comparison after saving a rep', () => {
    const current = rep({ date: '2026-05-20', session_id: 'live' });
    const previous = findPrevSessionReps([...history, current], {
      grip: 'Crusher', hand: 'L', targetDuration: 45, excludeSessionId: 'live',
    });
    expect(previous).toHaveLength(2);
    expect(previous.every(r => r.session_id === 's_recent')).toBe(true);
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
  test.each([
    {failure_valid:false},
    {end_reason:'interrupted'},
    {end_reason:'equipment_interruption'},
    {force_recording:{capacity_eligible:false}},
    {force_recording:{redo_pending:true}},
    {force_recording:{redo_attempts:[{actualTime:1.3}]}},
    {force_recording:{recording_stop_reason:'release_not_observed'}},
  ])('disputed opener stays descriptive and cannot seed estimates or previous comparison: %j',flags=>{
    const invalid=rep({...flags,date:'2026-05-19',session_id:'disputed',actual_time_s:1.3});
    const prior=rep({date:'2026-05-18',session_id:'valid'});
    const out=buildRepCurveBundle({history:[prior,invalid],grip:'Crusher',hand:'L',numReps:4,firstRepTime:1.3,
      restSeconds:20,actualReps:[invalid],targetDuration:45,excludeSessionId:'disputed'});
    expect(out.actual).toEqual([expect.objectContaining({rep:1,t:1.3,activityOnly:true})]);
    expect(out.forecasted).toEqual([]);
    expect(out.asymptoticHold).toBeNull();
    expect(out.prevSession[0].t).toBe(30);
    expect(findPrevSessionReps([invalid],{grip:'Crusher',hand:'L',targetDuration:45})).toBeNull();
  });

  test('later valid holds never become the missing/invalid opener',()=>{
    const out=buildRepCurveBundle({history:[],grip:'Crusher',hand:'L',numReps:4,firstRepTime:22,restSeconds:20,
      actualReps:[rep({rep_num:3,actual_time_s:22})],targetDuration:45});
    expect(out.forecasted).toEqual([]);
    expect(out.actual[0]).toMatchObject({rep:3,t:22});
  });

  test('timestamp order chooses the latest same-day session regardless of input order',()=>{
    const early=rep({session_id:'early',session_started_at:'2026-05-15T08:00:00Z',actual_time_s:20});
    const late=rep({session_id:'late',session_started_at:'2026-05-15T18:00:00Z',actual_time_s:35});
    const args={grip:'Crusher',hand:'L',targetDuration:45};
    expect(findPrevSessionReps([early,late],args)).toEqual([late]);
    expect(findPrevSessionReps([late,early],args)).toEqual([late]);
    expect(findPrevSessionReps([{...early,session_started_at:null},{...late,session_started_at:null}],args)).toBeNull();
  });

  test('previous comparison preserves rep gaps when disputed middle holds are excluded',()=>{
    const rows=[rep({rep_num:1}),rep({rep_num:2,failure_valid:false}),rep({rep_num:3,actual_time_s:19})];
    const out=buildRepCurveBundle({history:rows,grip:'Crusher',hand:'L',numReps:4,firstRepTime:45,restSeconds:20,targetDuration:45});
    expect(out.prevSession.map(point=>point.rep)).toEqual([1,3]);
  });
  test('second-set bundle compares four prior second-set reps, never eight combined reps', () => {
    const previous = [1, 2].flatMap(set_num => [1, 2, 3, 4].map(rep_num => rep({
      set_num, rep_num, actual_time_s: 40 / (set_num * rep_num),
    })));
    const current = rep({ date: '2026-05-20', session_id: 'live', set_num: 2, actual_time_s: 18 });
    const bundle = buildRepCurveBundle({ history: [...previous, current], grip: 'Crusher', hand: 'L',
      numReps: 4, firstRepTime: 18, restSeconds: 20, actualReps: [current], targetDuration: 45,
      setNum: 2, excludeSessionId: 'live', physModel: PHYS_MODEL_DEFAULT });
    expect(bundle.actual).toHaveLength(1);
    expect(bundle.forecasted).toHaveLength(4);
    expect(bundle.prevSession.map(p => p.t)).toEqual([20, 10, 40 / 6, 5]);
  });
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
      session_id: sid, rep_num: i + 1, actual_time_s: t, rest_s: 20, ...measuredRecoveryFields(),
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

// Manual-load holds (no Tindeq) are timed holds like any other: they seed the
// estimate and the previous-session comparison. Disputed holds never do.
describe("manual-load holds stay comparable", () => {
  const manual = (date, rep_num, t, extra = {}) => ({ id: `${date}-${rep_num}`, session_id: date, date, grip: "Micro",
    hand: "L", set_num: 1, rep_num, target_duration: 40, actual_time_s: t, failure_valid: true,
    load_provenance: "nominal_setting", manual_load_kg: 20, ...extra });
  test("a manual hold is comparable; a disputed one is not", () => {
    expect(isComparableHold(manual("2026-11-01", 1, 35))).toBe(true);
    expect(isComparableHold(manual("2026-11-01", 1, 35, { force_recording: { redo_pending: true } }))).toBe(false);
    expect(isComparableHold(manual("2026-11-01", 1, 35, { failure_valid: false }))).toBe(false);
  });
  test("manual sessions keep the estimate, the previous session and plain points", () => {
    const history = [manual("2026-11-01", 1, 35), manual("2026-11-01", 2, 25)];
    const current = [manual("2026-11-05", 1, 33)];
    const bundle = buildRepCurveBundle({ history, grip: "Micro", hand: "L", numReps: 4, firstRepTime: 33,
      restSeconds: 20, actualReps: current, targetDuration: 40, beforeDate: "2026-11-05" });
    expect(bundle.forecasted.length).toBeGreaterThan(0);
    expect(bundle.asymptoticHold).not.toBeNull();
    expect(bundle.prevSession.map(p => p.t)).toEqual([35, 25]);
    expect(bundle.actual[0].activityOnly).toBeUndefined();
  });
});

// Same-day sessions are ordered by their timestamps only; the answer never
// depends on the order rows happen to arrive in.
test("same-day previous sessions pick the same answer in any input order", () => {
  const rep = (session_id, start) => ({ session_id, date: "2026-11-04", grip: "Micro", hand: "L", set_num: 1,
    rep_num: 1, target_duration: 40, actual_time_s: 30, failure_valid: true,
    ...(start != null ? { session_started_at: new Date(start).toISOString() } : {}) });
  const opts = { grip: "Micro", hand: "L", beforeDate: "2026-11-05", targetDuration: 40 };
  const A = rep("A", 100000), B = rep("B", null), C = rep("C", 200000);
  const orders = [[A, B, C], [B, A, C], [C, B, A], [A, C, B]];
  const picks = orders.map(order => findPrevSessionReps(order, opts)?.[0]?.session_id ?? null);
  expect(new Set(picks).size).toBe(1);
  expect(picks[0]).toBeNull();                                // B cannot be ordered
  expect(findPrevSessionReps([C, A], opts)[0].session_id).toBe("C");
  expect(findPrevSessionReps([A, C], opts)[0].session_id).toBe("C");
});
