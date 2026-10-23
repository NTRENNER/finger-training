import {
  createCustomExercise,
  defaultWorkoutProgram,
  learnedCustomExercise,
  sanitizeWorkoutProgram,
  sessionExerciseDefinitions,
  strengthWorkoutIds,
  workoutProgramCatalog,
  workoutProgramWorkouts,
} from "../workoutProgram.js";
import { workouts as SUPPORT_WORKOUTS } from "../supportTraining.js";
import { recommendSet, recommendSetCount } from "../workout-progression.js";

describe("workout program", () => {
  test("strength days carry unique display letters in rotation order, raw and resolved alike", () => {
    const block = { ...defaultWorkoutProgram(), mode: "block" };
    const ids = strengthWorkoutIds(block);
    expect(ids.map(id => SUPPORT_WORKOUTS[id].shortName)).toEqual(["A", "B", "C"]);
    const resolved = workoutProgramWorkouts(block);
    expect(ids.map(id => resolved[id].shortName)).toEqual(["A", "B", "C"]);
    expect(ids.map(id => resolved[id].name)).toEqual(ids.map(id => SUPPORT_WORKOUTS[id].name));
  });

  test("defaults to two strength days and keeps the power primer separate", () => {
    const program = defaultWorkoutProgram();
    expect(program.mode).toBe("build");
    expect(strengthWorkoutIds(program)).toEqual(["A", "C"]);
    expect(program.templates.B).toContain("medBallThrows");
    expect(strengthWorkoutIds(program)).not.toContain("B");
  });

  test("one and three day modes resolve the intended strength rotations", () => {
    expect(strengthWorkoutIds({ ...defaultWorkoutProgram(), mode: "maintain" })).toEqual(["A"]);
    expect(strengthWorkoutIds({ ...defaultWorkoutProgram(), mode: "block" })).toEqual(["A", "C", "S3"]);
  });

  test("custom exercises survive sanitizing and resolve into a template", () => {
    const exercise = createCustomExercise({
      name: "Towel Lock-Off",
      movementCategories: ["pull", "lock_off"],
      stimulus: "strength",
      tracking: "reps",
      sets: 3,
      reps: "4",
    });
    const base = defaultWorkoutProgram();
    const program = sanitizeWorkoutProgram({
      ...base,
      customExercises: [exercise],
      templates: { ...base.templates, S3: [...base.templates.S3, exercise.id] },
    });
    expect(workoutProgramCatalog(program)[exercise.id].name).toBe("Towel Lock-Off");
    expect(workoutProgramWorkouts(program).S3.exercises.at(-1).id).toBe(exercise.id);
  });

  test("saved session snapshots restore custom definitions", () => {
    const exercise = createCustomExercise({ name: "Wall Press", tracking: "completion" });
    expect(exercise.prescription).toBe("");
    expect(exercise.sets).toBeUndefined();
    expect(exercise.reps).toBe("");
    const definitions = sessionExerciseDefinitions([{
      exercises: { [exercise.id]: { done: true, _definition: exercise } },
    }]);
    expect(definitions[exercise.id].name).toBe("Wall Press");
  });

  describe("blank custom prescriptions", () => {
    const session = (date, id, sets) => ({ date, workout: "A", workoutId: "A", exercises: { [id]: { sets } } });

    test("a new custom exercise starts blank, with a non-empty intent and a fixed dose for power", () => {
      const strength = createCustomExercise({ name: "Ring Rows", tracking: "reps", intent: "" });
      expect(strength).toMatchObject({ prescription: "", reps: "", intent: "Ring Rows for strength." });
      expect(strength.sets).toBeUndefined();
      expect(strength.progressionPolicy).toBeUndefined();
      expect(createCustomExercise({ name: "Clap Push-Up", stimulus: "power" }).progressionPolicy).toBe("maintain");
    });

    test("the first logged session becomes the template; later sessions and skipped sets don't change it", () => {
      const ex = createCustomExercise({ name: "Ring Rows", tracking: "weight" });
      expect(learnedCustomExercise(ex, [])).toBe(ex);
      const sessions = [
        session("2026-10-25", ex.id, [{ reps: "12", weight: "30", done: true }]),
        session("2026-10-20", ex.id, [
          { reps: "8", weight: "20", done: true }, { reps: "8", weight: "20", done: true },
          { reps: "6", weight: "20", done: true }, { reps: "2", weight: "20", done: false },
        ]),
      ];
      expect(learnedCustomExercise(ex, sessions)).toMatchObject({
        sets: 3, reps: "6", prescription: "3 × 6", learnedFrom: "2026-10-20",
      });
    });

    test("blank completed rows still count as sets but don't set the reps", () => {
      const ex = createCustomExercise({ name: "Ring Rows", tracking: "reps" });
      const sessions = [
        session("2026-10-20", ex.id, [{ done: true }, { reps: "", done: true }]),
        session("2026-10-22", ex.id, [
          { reps: "10", done: true }, { done: true }, { reps: "8", done: true },
        ]),
      ];
      expect(learnedCustomExercise(ex, sessions)).toMatchObject({
        sets: 3, reps: "8", prescription: "3 × 8", learnedFrom: "2026-10-22",
      });
    });

    test("completion exercises learn only a set count; anything the user set is kept", () => {
      const done = createCustomExercise({ name: "Dead Hang", tracking: "completion" });
      expect(learnedCustomExercise(done, [session("2026-10-20", done.id, [{ done: true }, { done: true }])]))
        .toMatchObject({ sets: 2, reps: "", prescription: "2 sets" });
      const set = createCustomExercise({ name: "Dips", tracking: "reps", sets: 4, reps: "5" });
      expect(set.prescription).toBe("4 × 5");
      expect(learnedCustomExercise(set, [session("2026-10-20", set.id, [{ reps: "9", done: true }])])).toBe(set);
    });

    test("the next session is populated by the existing progression rules", () => {
      const ex = createCustomExercise({ name: "Ring Rows", tracking: "weight" });
      const log = [session("2026-10-20", ex.id, [
        { reps: "8", weight: "20", done: true }, { reps: "8", weight: "20", done: true },
      ])];
      const learned = learnedCustomExercise(ex, log);
      const plan = recommendSetCount(log, learned, learned.sets, { referenceDate: "2026-10-22" });
      expect(plan).toMatchObject({ sets: 3, mode: "accumulate" });
      expect(recommendSet(log, learned, "A", 0, null, plan)).toMatchObject({ weight: "20", reps: "8" });
    });
  });
});
