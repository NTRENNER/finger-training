import { assessAdditionalSetNeed, recommendAnotherSet, isSetComplete } from "../setRecommendation.js";
import { computeDensityLadder } from "../densityLadder.js";
import { zoneOf } from "../zones.js";

const config = { grip: "Micro", hand: "L", targetTime: 40, restTime: 20, repsPerSet: 4 };
const times = [40, 35, 30, 9]; // Last rep misses the ladder gate, while overall decay remains strong.
const reps = (values = times, extras = {}) => values.map((t, i) => ({
  id: `r${i + 1}`, session_id: "current", date: "2026-09-20", set_num: 1, rep_num: i + 1,
  hand: "L", grip: "Micro", target_duration: 40, actual_time_s: t,
  avg_force_kg: 20, peak_force_kg: 22, failure_valid: true, rest_s: 20, ...extras,
}));
const plateauHistory = [12, 16].flatMap(day => reps(times, {
  session_id: `plateau-${day}`, date: `2026-09-${day}`,
}));
const recommend = (sessionReps = reps(), history = plateauHistory, options = {}) =>
  recommendAnotherSet({ history, sessionReps, config, setNum: 1, ...options });

test("a recent, valid plateau on a repeating rung can justify optional volume", () => {
  expect(recommend()).toMatchObject({ recommend: true, basis: "plateau", recentSessions: 2 });
});

test.each([4, 5, 6])("the %s-rep rung keeps its earned next step without an extra-set suggestion", count => {
  const current = reps(Array(count).fill(40));
  const history = [12, 16].flatMap(day => reps(Array(count).fill(40), {
    session_id: `prior-${day}`, date: `2026-09-${day}`,
  }));
  const ladder = computeDensityLadder([...history, ...current], "Micro", zoneOf(40), { expectedHands: ["L"] });
  expect(ladder.decision).toBe(count === 6 ? "step_load" : "advance");
  expect(ladder.reps).toBe(count === 6 ? 4 : count + 1);
  expect(ladder.loadByHand.L).toBe(count === 6 ? 21 : 20);
  expect(recommend(current, history, { config: { ...config, repsPerSet: count } })).toBeNull();
});

test("increasing from four to five to six reps is progress even at the same load", () => {
  const history = [4, 5].flatMap((count, i) => reps([...Array(count - 1).fill(40), 9], {
    session_id: `prior-${i}`, date: `2026-09-${12 + i * 4}`,
  }));
  expect(recommend(reps([40, 40, 40, 40, 40, 9]), history,
    { config: { ...config, repsPerSet: 6 } })).toBeNull();
});

test.each([0, 1, 3])("longer holds on rep index %s are progress at a fixed load", index => {
  const currentTimes = [...times]; currentTimes[index] *= 1.1;
  expect(recommend(reps(currentTimes))).toBeNull();
});

test.each([
  { failure_valid: false },
  { force_recording: { capacity_eligible: false } },
  { load_provenance: "nominal_setting", avg_force_kg: null, manual_load_kg: 20 },
  { end_reason: "equipment_interruption", failure_valid: false },
])("invalid history cannot establish a plateau: %j", changes => {
  expect(recommend(reps(), plateauHistory.map(r => ({ ...r, ...changes })))).toBeNull();
});

test("old history does not establish a current plateau", () => {
  const old = plateauHistory.map(r => ({ ...r, date: r.date.replace("09", "01") }));
  expect(recommend(reps(), old)).toBeNull();
});

test.each([{ actual_time_s: 20 }, { failure_valid: false }])("an intervening unsuccessful opener is not skipped: %j", change => {
  const interrupted = reps(times, { date: "2026-09-18", session_id: "intervening" });
  Object.assign(interrupted[0], change);
  expect(recommend(reps(), [...plateauHistory, ...interrupted])).toBeNull();
});

test("a new setup or changed rest cannot establish a plateau", () => {
  expect(recommend(reps(times, { setup_id: "new" }))).toBeNull();
  expect(recommend(reps(times, { rest_s: 60 }))).toBeNull();
});

test("rare exposure, increasing load, opener failure and collapse do not suggest volume", () => {
  expect(recommend(reps(), [])).toBeNull();
  expect(recommend(reps(times, { avg_force_kg: 22 }))).toBeNull();
  expect(recommend(reps([30, 30, 20, 9]))).toBeNull();
  expect(recommend(reps([40, 2, 2, 2]))).toBeNull();
});

test("three reps from a prescribed six is incomplete and cannot suggest another set", () => {
  const partial = reps([40, 40, 40]);
  const six = { ...config, repsPerSet: 6 };
  expect(isSetComplete({ sessionReps: partial, config: six })).toBe(false);
  expect(recommend(partial, plateauHistory, { config: six })).toBeNull();
});

test("completion requires each prescribed rep for each expected hand", () => {
  const both = { ...config, hand: "Both" };
  const left = reps(); const right = reps(times, { hand: "R" });
  expect(isSetComplete({ sessionReps: [...left, ...right], config: both })).toBe(true);
  expect(isSetComplete({ sessionReps: [...left, ...right.slice(0, 3)], config: both })).toBe(false);
  expect(isSetComplete({ sessionReps: [...left.slice(0, 3), left[2]], config })).toBe(false);
  expect(recommend([...left, ...right.slice(0, 3)], plateauHistory, { config: both })).toBeNull();
});

test("both hands must support the plateau", () => {
  const rightHistory = plateauHistory.map(r => ({ ...r, hand: "R" }));
  const both = { ...config, hand: "Both" };
  expect(recommend([...reps(), ...reps(times, { hand: "R" })], [...plateauHistory, ...rightHistory],
    { config: both })?.recommend).toBe(true);
  expect(recommend([...reps(), ...reps([44, 35, 30, 9], { hand: "R" })], [...plateauHistory, ...rightHistory],
    { config: both })).toBeNull();
});

test("later complete sets retain their tolerance check without changing the first-set ladder", () => {
  const fresh = reps([40, 40, 40, 40]);
  const optional = reps([30, 30, 30, 30], { set_num: 2 });
  expect(recommend([...fresh, ...optional], [], { setNum: 2 })?.basis).toBe("set_tolerance");
  expect(recommend([...fresh, ...optional.slice(0, 3)], [], { setNum: 2 })).toBeNull();
  expect(recommend([...fresh, ...reps([20, 20, 20, 20], { set_num: 2 })], [], { setNum: 2 })).toBeNull();
  const firstLadder = computeDensityLadder(fresh, "Micro", zoneOf(40));
  expect(computeDensityLadder([...fresh, ...optional], "Micro", zoneOf(40))).toEqual(firstLadder);
});

test("the plateau assessment is stable under history ordering", () => {
  const args = { history: plateauHistory, sessionReps: reps(), config };
  expect(assessAdditionalSetNeed(args)).toEqual(assessAdditionalSetNeed({ ...args, history: [...plateauHistory].reverse() }));
});
