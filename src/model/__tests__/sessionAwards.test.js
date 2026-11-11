import { sessionAwards, sessionAwardMetrics, AWARD_THRESHOLDS } from "../sessionAwards.js";

const rep = (over = {}) => ({
  id: `${over.hand ?? "L"}-${over.rep_num ?? 1}`, date: "2026-11-10", session_id: "s", grip: "Crusher", hand: "L",
  set_num: 1, rep_num: 1, target_duration: 220, prescribed_load_kg: 12.9, avg_force_kg: 13.7, peak_force_kg: 14.7,
  actual_time_s: 288.6, failure_valid: true, end_reason: "target_force_failure", load_provenance: "measured_force",
  force_recording: { capacity_eligible: true, signal_quality: "complete", decision: { overridden: false } },
  ...over,
});
const types = awards => awards.map(a => `${a.type}:${a.hand}`);
const run = (reps, before = []) => sessionAwards({ before, reps, grip: reps[0].grip,
  targetTime: reps[0].target_duration, hands: [...new Set(reps.map(r => r.hand))], restSeconds: 20 });

// Replays the 2026-11-10 Crusher session: lighter than the old best in the
// zone, so no level-up, but well past the recommended weight and time.
test("a hold past the recommended weight and time earns the recommendation award without a level-up", () => {
  const before = [
    rep({ id: "old1", date: "2026-05-11", session_id: "may", avg_force_kg: 16.3, actual_time_s: 221.8, load_provenance: null, force_recording: null }),
    rep({ id: "old2", date: "2026-07-24", session_id: "jul", avg_force_kg: 16.4, actual_time_s: 241.2, load_provenance: null, force_recording: null }),
  ];
  const awards = run([rep(), rep({ hand: "R", prescribed_load_kg: 13.4, avg_force_kg: 14.1, actual_time_s: 302.6 })], before);
  expect(types(awards)).toEqual(["recommendation:L", "recommendation:R"]);
  expect(awards[0].timeRatio).toBeCloseTo(288.6 / 220);
});

test("the recommendation award needs the plan followed, the weight met and the time clearly beaten", () => {
  expect(run([rep({ actual_time_s: 240 })])).toEqual([]);
  expect(run([rep({ avg_force_kg: 12.0 })])).toEqual([]);
  expect(run([rep({ manual_load_kg: 14 })])).toEqual([]);
  expect(run([rep({ force_recording: { capacity_eligible: true, decision: { overridden: true } } })])).toEqual([]);
  expect(run([rep({ session_adjustment: { load_choice: "lighter" } })])).toEqual([]);
  expect(run([rep({ failure_valid: false })])).toEqual([]);
});

test("only the opening hold of set one can earn the recommendation award", () => {
  const opener = rep({ actual_time_s: 200 });
  expect(run([opener, rep({ rep_num: 2 })])).toEqual([]);
  expect(run([opener, rep({ set_num: 2 })])).toEqual([]);
});

test("the curve award reads the prediction frozen before the session", () => {
  const withCheck = (actual, current, extra = {}) => rep({ actual_time_s: 100, force_recording: { capacity_eligible: true,
    prediction_check: { kind: "capacity", comparison: { status: "recorded", actual, current }, ...extra } } });
  expect(types(run([withCheck(13.7, 11)]))).toEqual(["curve:L"]);
  expect(run([withCheck(13.7, 11 * 1.2)])).toEqual([]);
  expect(run([withCheck(13.7, 13.7 / (AWARD_THRESHOLDS.curveRatio - 0.01))])).toEqual([]);
  expect(run([rep({ actual_time_s: 100, force_recording: { capacity_eligible: true,
    prediction_check: { kind: "capacity", comparison: { status: "unavailable" } } } })])).toEqual([]);
});

test("the recovery award needs a first hold that reached its target and a measured rest", () => {
  const set = (t1, t2, rest = { rest_before_s: 20 }) => [
    rep({ target_duration: 20, prescribed_load_kg: 20, avg_force_kg: 20, actual_time_s: t1 }),
    rep({ rep_num: 2, target_duration: 20, prescribed_load_kg: 20, avg_force_kg: 20, actual_time_s: t2, rep_timing: rest }),
  ];
  const strong = sessionAwardMetrics({ reps: set(21, 21), grip: "Crusher", targetTime: 20, hands: ["L"] })[0];
  expect(strong.recoveryGap).toBeGreaterThan(AWARD_THRESHOLDS.recoveryGap);
  expect(types(run(set(21, 21)))).toEqual(["recovery:L"]);
  expect(run(set(21, 8))).toEqual([]);
  expect(run(set(15, 15))).toEqual([]);
  expect(run(set(21, 21, null))).toEqual([]);
});

test("a level-up is reported as the heaviest award, ahead of the others", () => {
  const before = [
    rep({ id: "a", date: "2026-10-01", session_id: "a", avg_force_kg: 10, actual_time_s: 200 }),
    rep({ id: "b", date: "2026-10-08", session_id: "b", avg_force_kg: 10.2, actual_time_s: 200 }),
  ];
  const awards = run([rep()], before);
  expect(types(awards)).toEqual(["heaviest:L", "recommendation:L"]);
  expect(awards[0].level).toBeGreaterThan(1);
});
