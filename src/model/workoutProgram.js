import {
  exercises as SUPPORT_EXERCISES,
  workouts as SUPPORT_WORKOUTS,
  STRENGTH_ROTATIONS,
} from "./supportTraining.js";
import { parseRepsCount, parseSeconds } from "./workout-volume.js";
import {
  createModifierDefinition,
  sanitizeModifierDefinition,
} from "./workoutModifiers.js";

export { createModifierDefinition };

export const WORKOUT_MODES = {
  maintain: {
    id: "maintain",
    label: "Maintain",
    days: 1,
    description: "One focused strength day for climbing season or busy weeks.",
  },
  build: {
    id: "build",
    label: "Build",
    days: 2,
    description: "Two complementary strength days for normal training.",
  },
  block: {
    id: "block",
    label: "Strength block",
    days: 3,
    description: "Three days when strength is the main training priority.",
  },
};

export const MOVEMENT_CATEGORIES = [
  { id: "push", label: "Push" },
  { id: "pull", label: "Pull" },
  { id: "lock_off", label: "Lock-off" },
  { id: "core", label: "Core" },
  { id: "legs", label: "Legs" },
  { id: "shoulder", label: "Shoulder" },
];

export const STIMULUS_OPTIONS = [
  { id: "strength", label: "Strength" },
  { id: "power", label: "Power" },
  { id: "capacity", label: "Capacity" },
];

const TEMPLATE_IDS = ["A", "C", "S3", "B"];

function defaultTemplateIds() {
  return Object.fromEntries(
    TEMPLATE_IDS.map(id => [id, (SUPPORT_WORKOUTS[id]?.exercises || []).map(ex => ex.id)])
  );
}

export function defaultWorkoutProgram() {
  return {
    version: 2,
    mode: "build",
    templates: defaultTemplateIds(),
    customExercises: [],
    modifierDefinitions: [],
    exerciseModifierIds: {},
  };
}

function cleanString(value, fallback = "") {
  return typeof value === "string" ? value.trim() : fallback;
}

function positiveInt(value, fallback) {
  const n = Math.round(Number(value));
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

export function sanitizeCustomExercise(raw) {
  if (!raw || typeof raw !== "object") return null;
  const id = cleanString(raw.id);
  const name = cleanString(raw.name);
  if (!id.startsWith("custom_") || !name) return null;

  const categoryIds = new Set(MOVEMENT_CATEGORIES.map(item => item.id));
  const movementCategories = Array.isArray(raw.movementCategories)
    ? [...new Set(raw.movementCategories.filter(id => categoryIds.has(id)))]
    : [];
  const stimulus = STIMULUS_OPTIONS.some(item => item.id === raw.stimulus)
    ? raw.stimulus
    : "strength";
  // "time" = reps × seconds per set, for holds (see timedHold).
  const tracking = ["weight", "reps", "time", "completion"].includes(raw.tracking)
    ? raw.tracking
    : "reps";
  // Sets and reps are optional: a new custom exercise starts blank and its
  // first logged session becomes the template (see learnedCustomExercise).
  const sets = positiveInt(raw.sets, null);
  const reps = tracking === "completion" ? "" : cleanString(raw.reps);
  const seconds = tracking === "time" ? cleanString(raw.seconds) : "";
  const prescription = cleanString(raw.prescription) || formatPrescription(sets, reps, seconds);
  const intent = cleanString(raw.intent) || `${name} for ${stimulus}.`;
  const type = stimulus === "power" ? "P" : "S";
  const setupModifiers = (Array.isArray(raw.setupModifiers) ? raw.setupModifiers : [])
    .map(sanitizeModifierDefinition)
    .filter(Boolean);

  return {
    id,
    name,
    movementCategories,
    stimulus,
    tracking,
    tags: [...new Set([stimulus, ...movementCategories.map(id => id === "lock_off" ? "climbing" : id)])],
    prescription,
    intent,
    progression: Array.isArray(raw.progression) ? raw.progression.filter(Boolean) : [],
    cautions: Array.isArray(raw.cautions) ? raw.cautions.filter(Boolean) : [],
    loggable: true,
    type,
    ...(sets ? { sets } : {}),
    reps,
    ...(tracking === "time" ? { seconds, logTime: true } : {}),
    ...(tracking === "weight" ? { logWeight: true } : { circlesOnly: true }),
    // Same convention as the built-in power and maintenance work: a fixed
    // dose. Only strength exercises add sets and then load.
    ...(stimulus !== "strength" ? { progressionPolicy: "maintain" } : {}),
    ...(setupModifiers.length ? { setupModifiers } : {}),
    custom: true,
  };
}

function formatPrescription(sets, reps, seconds = "") {
  if (sets && reps && seconds) return `${sets} × ${reps} × ${seconds} s`;
  if (sets && reps) return `${sets} × ${reps}`;
  return sets ? `${sets} sets` : "";
}

function firstUsableLoggedSets(sessions, exercise, requiresReps) {
  let first = null;
  for (const session of sessions || []) {
    const sets = session?.exercises?.[exercise.id]?.sets;
    if (!session?.date || !Array.isArray(sets)) continue;
    const done = sets.filter(set => set?.done);
    const usable = requiresReps
      ? done.filter(set => parseRepsCount(set.reps) > 0)
      : done;
    const repCounts = usable.map(set => parseRepsCount(set.reps)).filter(count => count > 0);
    const secondCounts = usable.map(set => parseSeconds(set.seconds)).filter(count => count > 0);
    if (!usable.length) continue;
    const order = `${session.date}\u0000${session.completedAt || ""}\u0000${session.id || ""}`;
    if (!first || order < first.order) first = { date: session.date, completed: usable.length, repCounts, secondCounts, order };
  }
  return first;
}

// A custom exercise created without sets or reps learns them from its first
// usable logged session. Rep-tracked rows must contain a positive rep count;
// a stale or historical blank completion cannot inflate the learned set
// target. Completion-only exercises still learn from every completed row.
// From the next session on, the ordinary progression rules (add sets after
// clean sessions, then load) run against that target exactly as they do for
// built-in templates. Anything the user did set is kept. Timed holds learn
// their seconds the same way, from the shortest logged hold.
export function learnedCustomExercise(exercise, sessions) {
  if (!exercise?.custom) return exercise;
  const requiresReps = exercise.tracking !== "completion";
  const needsReps = requiresReps && !exercise.reps;
  const needsSeconds = exercise.tracking === "time" && !exercise.seconds;
  if (exercise.sets && !needsReps && !needsSeconds) return exercise;
  const first = firstUsableLoggedSets(sessions, exercise, requiresReps);
  if (!first) return exercise;
  const sets = exercise.sets || first.completed;
  const reps = needsReps ? String(Math.min(...first.repCounts)) : exercise.reps;
  const seconds = needsSeconds && first.secondCounts.length
    ? String(Math.min(...first.secondCounts)) : exercise.seconds;
  return {
    ...exercise,
    sets,
    reps,
    ...(exercise.tracking === "time" ? { seconds } : {}),
    prescription: exercise.prescription || formatPrescription(sets, reps, seconds),
    learnedFrom: first.date,
  };
}

export function withLearnedCustomExercises(workouts, sessions) {
  return Object.fromEntries(Object.entries(workouts || {}).map(([id, workout]) => [id,
    workout?.exercises ? { ...workout, exercises: workout.exercises.map(ex => learnedCustomExercise(ex, sessions)) } : workout,
  ]));
}

export function createCustomExercise(values) {
  const slug = cleanString(values?.name, "exercise")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 28) || "exercise";
  const suffix = Math.random().toString(36).slice(2, 7);
  return sanitizeCustomExercise({ ...values, id: `custom_${slug}_${suffix}` });
}

export function sanitizeWorkoutProgram(raw) {
  const base = defaultWorkoutProgram();
  if (!raw || typeof raw !== "object" || raw.version !== 2) return base;
  const mode = Object.hasOwn(WORKOUT_MODES, raw.mode) ? raw.mode : base.mode;
  const customExercises = (Array.isArray(raw.customExercises) ? raw.customExercises : [])
    .map(sanitizeCustomExercise)
    .filter(Boolean);
  const modifierDefinitions = (Array.isArray(raw.modifierDefinitions) ? raw.modifierDefinitions : [])
    .map(sanitizeModifierDefinition)
    .filter(Boolean);
  const modifierIds = new Set(modifierDefinitions.map(definition => definition.id));
  const knownIds = new Set([
    ...Object.keys(SUPPORT_EXERCISES),
    ...customExercises.map(ex => ex.id),
  ]);
  const templates = {};
  for (const templateId of TEMPLATE_IDS) {
    const candidate = raw.templates?.[templateId];
    const ids = Array.isArray(candidate)
      ? candidate.filter(id => typeof id === "string" && knownIds.has(id))
      : base.templates[templateId];
    templates[templateId] = [...new Set(ids)];
  }
  const exerciseModifierIds = {};
  for (const [exerciseId, ids] of Object.entries(raw.exerciseModifierIds || {})) {
    if (!knownIds.has(exerciseId) || !Array.isArray(ids)) continue;
    const valid = [...new Set(ids.filter(id => modifierIds.has(id)))];
    if (valid.length > 0) exerciseModifierIds[exerciseId] = valid;
  }
  return {
    version: 2,
    mode,
    templates,
    customExercises,
    modifierDefinitions,
    exerciseModifierIds,
  };
}

function withSetupModifiers(exercise, program) {
  if (!exercise) return exercise;
  const ids = program.exerciseModifierIds[exercise.id] || [];
  if (ids.length === 0) return exercise;
  const definitions = new Map(program.modifierDefinitions.map(item => [item.id, item]));
  const setupModifiers = ids.map(id => definitions.get(id)).filter(Boolean);
  return setupModifiers.length > 0 ? { ...exercise, setupModifiers } : exercise;
}

export function workoutProgramCatalog(programLike) {
  const program = sanitizeWorkoutProgram(programLike);
  const catalog = {
    ...SUPPORT_EXERCISES,
    ...Object.fromEntries(program.customExercises.map(ex => [ex.id, ex])),
  };
  return Object.fromEntries(Object.entries(catalog)
    .map(([id, exercise]) => [id, withSetupModifiers(exercise, program)]));
}

export function workoutProgramWorkouts(programLike) {
  const program = sanitizeWorkoutProgram(programLike);
  const catalog = workoutProgramCatalog(program);
  const resolved = { ...SUPPORT_WORKOUTS };

  for (const templateId of TEMPLATE_IDS) {
    const base = SUPPORT_WORKOUTS[templateId];
    if (!base) continue;
    const native = Object.fromEntries((base.exercises || []).map(ex => [ex.id, ex]));
    resolved[templateId] = {
      ...base,
      exercises: program.templates[templateId]
        .map(id => withSetupModifiers(native[id] || catalog[id], program))
        .filter(Boolean),
    };
  }
  return resolved;
}

export function strengthWorkoutIds(programLike) {
  const program = sanitizeWorkoutProgram(programLike);
  return [...STRENGTH_ROTATIONS[program.mode]];
}

export function exerciseMovementCategories(exercise) {
  if (Array.isArray(exercise?.movementCategories) && exercise.movementCategories.length > 0) {
    return exercise.movementCategories;
  }
  const id = exercise?.id || "";
  const tags = new Set(exercise?.tags || []);
  const categories = [];
  if (/press|dip/i.test(id)) categories.push("push");
  if (/pull|row|curl/i.test(id)) categories.push("pull");
  if (/lockoff|frontLever/i.test(id)) categories.push("lock_off");
  if (tags.has("core")) categories.push("core");
  if (tags.has("hip") || tags.has("hamstring")) categories.push("legs");
  if (tags.has("shoulder")) categories.push("shoulder");
  return [...new Set(categories)];
}

export function sessionExerciseDefinitions(sessions) {
  const definitions = {};
  for (const session of sessions || []) {
    for (const [id, data] of Object.entries(session?.exercises || {})) {
      const definition = data?._definition;
      if (!definition?.id || definition.id !== id) continue;
      const sanitized = definition.custom ? sanitizeCustomExercise(definition) : definition;
      if (sanitized) definitions[id] = sanitized;
    }
  }
  return definitions;
}
