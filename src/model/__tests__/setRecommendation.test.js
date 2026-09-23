import {
  ADD_SET_CONFORMANCE_MIN,
  ADD_SET_LATER_OPENER_RETENTION_MIN,
  assessAdditionalSetNeed,
  recommendAnotherSet,
} from "../setRecommendation.js";

const config = { grip: "Micro", hand: "L", targetTime: 40, restTime: 20 };
const reps = (times, extras = {}) => times.map((t, i) => ({
  id: `r${i + 1}`, session_id: "current", set_num: 1, rep_num: i + 1,
  hand: "L", grip: "Micro", target_duration: 40, actual_time_s: t,
  avg_force_kg: 20, failure_valid: true, rest_s: 20, ...extras,
}));

// This used to pass with an empty history, because rare exposure was
// itself a reason to suggest volume. It no longer is (September 2026), so
// the happy path now needs a plateau as well as good within-set decay. The
// conformance gate is what this test is really protecting; the plateau
// history is scaffolding to get past `need`.
const plateauHistory = [12, 16].flatMap((day, i) => reps([40], {
  session_id: `plateau-${i}`, date: `2026-09-${day}`, avg_force_kg: 20,
}));

test("gently recommends another set when actual decay tracks the model", () => {
  const out = recommendAnotherSet({
    history: plateauHistory,
    sessionReps: reps([40, 40, 40, 40], { date: "2026-09-20" }),
    config, setNum: 1,
  });
  expect(out?.recommend).toBe(true);
  expect(out.conformance).toBeGreaterThanOrEqual(ADD_SET_CONFORMANCE_MIN);
});

test("good within-set decay alone is not enough without a reason to add volume", () => {
  // Same conforming set, no plateau behind it.
  expect(recommendAnotherSet({
    history: [], sessionReps: reps([40, 40, 40, 40], { date: "2026-09-20" }),
    config, setNum: 1,
  })).toBeNull();
});

test("does not recommend more volume after a collapsed set", () => {
  expect(recommendAnotherSet({
    history: [], sessionReps: reps([40, 2, 2, 2]), config, setNum: 1,
  })).toBeNull();
});

test("does not recommend another set when the opener missed its target", () => {
  expect(recommendAnotherSet({
    history: [], sessionReps: reps([30, 30, 30]), config, setNum: 1,
  })).toBeNull();
});

test("requires both hands to support more work in Both mode", () => {
  const left = reps([40, 40, 40], { hand: "L" });
  const right = reps([40, 2, 2], { hand: "R" }).map((r, i) => ({ ...r, id: `rr${i}` }));
  expect(recommendAnotherSet({
    history: [], sessionReps: [...left, ...right],
    config: { ...config, hand: "Both" }, setNum: 1,
  })).toBeNull();
});

test("does not suggest volume when recent exposure is already high and loads are not plateaued", () => {
  const history = [1, 2, 3].flatMap((n) => reps([40], {
    session_id: `old-${n}`, date: `2026-09-${10 + n}`,
    avg_force_kg: 16 + n * 2,
  }));
  const current = reps([40, 40, 40], { date: "2026-09-20" });
  expect(assessAdditionalSetNeed({ history, sessionReps: current, config })).toBeNull();
  expect(recommendAnotherSet({ history, sessionReps: current, config, setNum: 1 })).toBeNull();
});

test("a stable successful load plateau can justify another set", () => {
  const history = [12, 16].flatMap((day, i) => reps([40], {
    session_id: `old-${i}`, date: `2026-09-${day}`, avg_force_kg: 20,
  }));
  const current = reps([40, 40, 40], { date: "2026-09-20", avg_force_kg: 20 });
  const out = recommendAnotherSet({ history, sessionReps: current, config, setNum: 1 });
  expect(out?.basis).toBe("plateau");
});

test("later sets are judged against the fresh opener rather than the original target", () => {
  const first = reps([40, 40, 40]);
  const second = reps([30, 30, 30], { set_num: 2 }).map((r, i) => ({ ...r, id: `s2-${i}` }));
  const out = recommendAnotherSet({
    history: [], sessionReps: [...first, ...second], config, setNum: 2,
  });
  expect(out?.basis).toBe("set_tolerance");
  expect(out.openerRetention).toBeGreaterThanOrEqual(ADD_SET_LATER_OPENER_RETENTION_MIN);
});

test("a deeply degraded later set stops automatic set suggestions", () => {
  const first = reps([40, 40, 40]);
  const second = reps([20, 20, 20], { set_num: 2 }).map((r, i) => ({ ...r, id: `s2-${i}` }));
  expect(recommendAnotherSet({
    history: [], sessionReps: [...first, ...second], config, setNum: 2,
  })).toBeNull();
});

// September 2026, per Nathan: rare exposure used to justify a suggestion on
// its own. It no longer does. Training a domain seldom is the state in which
// the app knows least about what the athlete tolerates there, and a longer
// session is the wrong answer to needing more sessions.
test("a rarely-trained domain is not offered extra volume on that basis alone", () => {
  const current = reps([40, 40, 40], { date: "2026-09-20", avg_force_kg: 20 });
  // No prior work in this grip + zone at all — maximum "need" under the old
  // low-exposure rule, and a strong, conforming first set.
  expect(assessAdditionalSetNeed({ history: [], sessionReps: current, config })).toBeNull();
  expect(recommendAnotherSet({ history: [], sessionReps: current, config, setNum: 1 })).toBeNull();

  // One session in the window is still not a reason.
  const onePrior = reps([40], { session_id: "old-1", date: "2026-09-18", avg_force_kg: 20 });
  expect(assessAdditionalSetNeed({ history: onePrior, sessionReps: current, config })).toBeNull();
});

test("a plateau still justifies one, so the suggestion is not simply dead", () => {
  const history = [12, 16].flatMap((day, i) => reps([40], {
    session_id: `old-${i}`, date: `2026-09-${day}`, avg_force_kg: 20,
  }));
  const current = reps([40, 40, 40], { date: "2026-09-20", avg_force_kg: 20 });
  const need = assessAdditionalSetNeed({ history, sessionReps: current, config });
  expect(need).toMatchObject({ needed: true, basis: "plateau" });
});
