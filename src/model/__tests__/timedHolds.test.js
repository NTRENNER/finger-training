import { exercises } from "../supportTraining.js";
import { buildRepsVariantSeries, holdTimeSeed, isMeasuredSeconds, sessionHoldSeconds, timedHold } from "../workout-volume.js";
import { createCustomExercise, learnedCustomExercise } from "../workoutProgram.js";
import { setSummary } from "../../views/workout/workoutHelpers.js";
import { toWorkoutCSV } from "../../lib/csv.js";

const { frontLever, heelHookPull, copenhagenPlank } = exercises;
const redBand = { modifier_band: { modifierId: "modifier_band", name: "Band", kind: "assistance", value: "red", valueLabel: "Red" } };

test("the three built-in holds log reps × seconds; two of them once kept seconds in the reps box", () => {
  for (const ex of [frontLever, heelHookPull, copenhagenPlank]) expect(ex).toMatchObject({ logTime: true, reps: "1" });
  expect(frontLever.legacyRepsAreSeconds).toBeUndefined();
  expect(heelHookPull.legacyRepsAreSeconds).toBe(true);
  expect(copenhagenPlank.legacyRepsAreSeconds).toBe(true);
});

test("a timed set reads as reps × seconds; older sets are read by what the box used to mean", () => {
  expect(timedHold({ reps: "3", seconds: "10" }, frontLever)).toEqual({ reps: 3, seconds: 10 });
  // Front lever's box held reps (3 sets of 3 on 2026-10-23): time unknown.
  expect(timedHold({ reps: "3" }, frontLever)).toEqual({ reps: 3, seconds: null });
  // Heel-hook pull and Copenhagen plank held the seconds: one hold.
  expect(timedHold({ leftReps: "8", rightReps: "8" }, heelHookPull, "left")).toEqual({ reps: 1, seconds: 8 });
  expect(timedHold({ reps: "8–12 sec" }, copenhagenPlank)).toEqual({ reps: 1, seconds: 8 });
  expect(timedHold({ reps: "3", seconds: "10" }, { name: "Row" })).toBeNull();
});

test("only a plain number is a measured hold time; history still reads leniently", () => {
  for (const v of ["10", "7.5", " 12 "]) expect(isMeasuredSeconds(v)).toBe(true);
  for (const v of ["5–10", "8-12", "8–12 sec", "0", "", null, "abc"]) expect(isMeasuredSeconds(v)).toBe(false);
  expect(timedHold({ reps: "3", seconds: "5–10" }, frontLever)).toEqual({ reps: 3, seconds: 5 });
});

test("hold time totals reps × seconds over done sets, both sides for one-sided holds", () => {
  const set = { reps: "3", seconds: "10", done: true, modifiers: redBand };
  expect(sessionHoldSeconds([set, set, set, { ...set, done: false }], frontLever)).toBe(90);
  expect(sessionHoldSeconds([{ leftReps: "8", rightReps: "8", done: true }], heelHookPull)).toBe(16);
  expect(sessionHoldSeconds([{ reps: "3", done: true }], frontLever)).toBeNull();
});

test("a new session starts from the last set's reps and seconds; a prescribed range stays blank", () => {
  expect(holdTimeSeed(frontLever, { reps: "3", seconds: "10" })).toEqual({ reps: "3", seconds: "10" });
  expect(holdTimeSeed(frontLever, { reps: "3" })).toEqual({ reps: "3", seconds: "" });
  expect(holdTimeSeed(frontLever, undefined)).toEqual({ reps: "1", seconds: "" });
  expect(holdTimeSeed({ ...frontLever, seconds: "20" }, undefined)).toEqual({ reps: "1", seconds: "20" });
  expect(holdTimeSeed(heelHookPull, { leftReps: "8", rightReps: "10" }))
    .toEqual({ leftReps: "1", leftSeconds: "8", rightReps: "1", rightSeconds: "10" });
  expect(holdTimeSeed({ name: "Row" }, { reps: "5" })).toEqual({});
});

test("the progress series carries total hold time for each setup", () => {
  const sessions = [
    { date: "2026-10-23", exercises: { frontLever: { sets: [
      { reps: "3", seconds: "10", variant: "Full", done: true, modifiers: redBand },
      { reps: "3", seconds: "10", variant: "Full", done: true, modifiers: redBand },
    ] } } },
    { date: "2026-10-21", exercises: { frontLever: { sets: [{ reps: "5", variant: "Straddle", done: true }] } } },
  ];
  const series = buildRepsVariantSeries(sessions, "frontLever", frontLever);
  expect(series.map(p => [p.date, p.reps, p.holdSeconds, p.setupLabel]))
    .toEqual([["2026-10-21", 5, null, ""], ["2026-10-23", 6, 60, "Band: Red"]]);
});

test("the previous-set pill shows reps × seconds", () => {
  expect(setSummary({ reps: "3", seconds: "10", done: true }, frontLever)).toBe("3×10s");
  expect(setSummary({ reps: "3", seconds: "10", weight: "5" }, frontLever)).toBe("3×10s@5");
  expect(setSummary({ reps: "3" }, frontLever)).toBe("3");
  expect(setSummary({ leftReps: "8", rightReps: "8" }, heelHookPull)).toEqual({ L: "1×8s", R: "1×8s" });
  expect(setSummary({ reps: "5", weight: "20" })).toBe("5@20");
});

test("a custom Reps × seconds exercise logs like a timed hold and learns its seconds", () => {
  const ex = createCustomExercise({ name: "Plank", tracking: "time" });
  expect(ex).toMatchObject({ tracking: "time", logTime: true, circlesOnly: true, reps: "", seconds: "" });
  const learned = learnedCustomExercise(ex, [{ date: "2026-10-23", exercises: { [ex.id]: { sets: [
    { reps: "2", seconds: "30", done: true }, { reps: "2", seconds: "25", done: true },
  ] } } }]);
  expect(learned).toMatchObject({ sets: 2, reps: "2", seconds: "25", prescription: "2 × 2 × 25 s" });
  const set = createCustomExercise({ name: "Hang", tracking: "time", sets: 3, reps: "1", seconds: "20" });
  expect(set.prescription).toBe("3 × 1 × 20 s");
});

test("the workout CSV ends with a seconds column", () => {
  const csv = toWorkoutCSV([{ date: "2026-10-23", workout: "C", exercises: {
    frontLever: { sets: [{ reps: "3", seconds: "10", done: true }] },
  } }]);
  const [header, row] = csv.split("\n");
  expect(header.endsWith('"seconds"')).toBe(true);
  expect(row.endsWith('"10"')).toBe(true);
});
