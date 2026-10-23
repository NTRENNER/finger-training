import {
  createCustomExercise,
  defaultWorkoutProgram,
  sanitizeWorkoutProgram,
  sessionExerciseDefinitions,
  strengthWorkoutIds,
  workoutProgramCatalog,
  workoutProgramWorkouts,
} from "../workoutProgram.js";
import { workouts as SUPPORT_WORKOUTS } from "../supportTraining.js";

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
    expect(exercise.prescription).toBe("3 sets");
    expect(exercise.reps).toBe("");
    const definitions = sessionExerciseDefinitions([{
      exercises: { [exercise.id]: { done: true, _definition: exercise } },
    }]);
    expect(definitions[exercise.id].name).toBe("Wall Press");
  });
});
