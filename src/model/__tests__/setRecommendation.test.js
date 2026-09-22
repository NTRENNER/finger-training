import { ADD_SET_CONFORMANCE_MIN, recommendAnotherSet } from "../setRecommendation.js";

const config = { grip: "Micro", hand: "L", targetTime: 40, restTime: 20 };
const reps = (times, extras = {}) => times.map((t, i) => ({
  id: `r${i + 1}`, session_id: "current", set_num: 1, rep_num: i + 1,
  hand: "L", grip: "Micro", target_duration: 40, actual_time_s: t,
  avg_force_kg: 20, failure_valid: true, rest_s: 20, ...extras,
}));

test("gently recommends another set when actual decay tracks the model", () => {
  const out = recommendAnotherSet({
    history: [], sessionReps: reps([40, 40, 40, 40]), config, setNum: 1,
  });
  expect(out?.recommend).toBe(true);
  expect(out.conformance).toBeGreaterThanOrEqual(ADD_SET_CONFORMANCE_MIN);
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
