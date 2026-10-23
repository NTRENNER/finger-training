import {
  exercises as SUPPORT_EXERCISES,
  workouts as SUPPORT_WORKOUTS,
  STRENGTH_ROTATIONS,
} from "./supportTraining.js";

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
  const tracking = ["weight", "reps", "completion"].includes(raw.tracking)
    ? raw.tracking
    : "reps";
  const sets = positiveInt(raw.sets, 3);
  const reps = cleanString(raw.reps, "5–8");
  const prescription = cleanString(
    raw.prescription,
    tracking === "completion" ? `${sets} sets` : `${sets} × ${reps}`,
  );
  const intent = cleanString(raw.intent, `${name} for ${stimulus}.`);
  const type = stimulus === "power" ? "P" : "S";

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
    sets,
    reps: tracking === "completion" ? "" : reps,
    ...(tracking === "weight" ? { logWeight: true } : { circlesOnly: true }),
    ...(stimulus === "capacity" ? { progressionPolicy: "maintain" } : {}),
    custom: true,
  };
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
  return { version: 2, mode, templates, customExercises };
}

export function workoutProgramCatalog(programLike) {
  const program = sanitizeWorkoutProgram(programLike);
  return {
    ...SUPPORT_EXERCISES,
    ...Object.fromEntries(program.customExercises.map(ex => [ex.id, ex])),
  };
}

const DISPLAY_OVERRIDES = {
  A: { shortName: "A", name: "Strength A — Heavy" },
  C: { shortName: "B", name: "Strength B — Balanced" },
  S3: { shortName: "C", name: "Strength C — Lock-Off & Core" },
};

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
      ...(DISPLAY_OVERRIDES[templateId] || {}),
      exercises: program.templates[templateId]
        .map(id => native[id] || catalog[id])
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
