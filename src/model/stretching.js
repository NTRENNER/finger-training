// ─────────────────────────────────────────────────────────────
// CLIMBING MOBILITY MENU + SESSION PLANNER
// ─────────────────────────────────────────────────────────────
// Stretching is prescribed as a time budget with movement coverage,
// not as one fixed workout. Each category has at least one
// equipment-free option; selected equipment unlocks a preferred
// variation without making the session impossible away from home.

export const STRETCH_CATEGORIES = {
  hipRotation: {
    key: "hipRotation",
    label: "Hip rotation",
    shortLabel: "Rotation",
  },
  hamstrings: {
    key: "hamstrings",
    label: "Hamstrings",
    shortLabel: "Hamstrings",
  },
  highStep: {
    key: "highStep",
    label: "High steps",
    shortLabel: "High steps",
  },
  hipExtension: {
    key: "hipExtension",
    label: "Hip extension",
    shortLabel: "Extension",
  },
  hipOpening: {
    key: "hipOpening",
    label: "Hip opening",
    shortLabel: "Hip opening",
  },
  forearms: {
    key: "forearms",
    label: "Forearms",
    shortLabel: "Forearms",
  },
  overhead: {
    key: "overhead",
    label: "Overhead reach",
    shortLabel: "Overhead",
  },
  chest: {
    key: "chest",
    label: "Chest opening",
    shortLabel: "Chest",
  },
};

export const STRETCH_EQUIPMENT = {
  band: { key: "band", label: "Band" },
  weight: { key: "weight", label: "Weight" },
  box: { key: "box", label: "Box / bench" },
};

const mobilityExercise = ({
  id,
  name,
  category,
  mode,
  equipment = [],
  prescription,
  intent,
  progression = [],
  cue,
  videoUrl,
  logging = null,
}) => ({
  id,
  name,
  mobilityCategory: category,
  mobilityMode: mode,
  equipment,
  tags: [
    "mobility",
    "positionalCapacity",
    ...(category === "forearms" ? ["finger", "forearm"] : []),
    ...(["overhead", "chest"].includes(category) ? ["shoulder"] : []),
    ...(!["forearms", "overhead", "chest"].includes(category) ? ["hip"] : []),
    ...(category === "hamstrings" ? ["hamstring"] : []),
  ],
  prescription,
  intent,
  progression,
  cue,
  videoUrl,
  loggable: logging?.loggable ?? false,
  type: "H",
  ...(logging || {}),
});

// Equipment-specific options come first within a category. The planner
// filters unavailable choices, so selecting a band/weight/box naturally
// promotes the equipped variation while an equipment-free fallback is
// always left behind.
export const STRETCH_EXERCISES = [
  mobilityExercise({
    id: "shinBoxes",
    name: "Shin Boxes",
    category: "hipRotation",
    mode: "active",
    prescription: "Slow 90/90 transitions with controlled pauses",
    intent: "Build usable internal and external hip rotation for drop knees, flags, and close-foot positions.",
    progression: ["Pause longer at each side.", "Add a controlled lift-off before switching."],
    cue: "Keep both sit bones heavy and rotate without rushing.",
    videoUrl: "https://www.youtube.com/watch?v=Y-L0s5uSQ-E",
  }),
  mobilityExercise({
    id: "shinBoxLiftOffs",
    name: "Shin-Box Lift-Offs",
    category: "hipRotation",
    mode: "active",
    prescription: "Controlled lift-offs from each 90/90 position",
    intent: "Strengthen the end range opened by shin-box transitions.",
    progression: ["Use less hand support.", "Increase lift height without leaning."],
    cue: "Move from the hip; keep the trunk quiet.",
    videoUrl: "https://www.youtube.com/watch?v=qDk1DMfdxgU",
  }),

  mobilityExercise({
    id: "weightedPancake",
    name: "Weighted Pancake",
    category: "hamstrings",
    mode: "loaded",
    equipment: ["weight"],
    prescription: "Slow hinges with a short end-range pause",
    intent: "Load hamstring and adductor range used in wide stems, high feet, and distant heel hooks.",
    progression: ["Increase range before load.", "Add load only when the return stays controlled."],
    cue: "Hinge from the hips with a long spine.",
    videoUrl: "https://www.youtube.com/watch?v=p23axnaLFHk",
    logging: {
      loggable: true,
      sets: 3,
      reps: "6",
      logWeight: true,
    },
  }),
  mobilityExercise({
    id: "elephantWalks",
    name: "Elephant Walks",
    category: "hamstrings",
    mode: "active",
    prescription: "Alternate slow knee extensions from a folded position",
    intent: "Accumulate hamstring range without requiring weights or a long passive hold.",
    progression: ["Straighten each knee farther.", "Slow the alternating cadence."],
    cue: "Keep the hips high and stop before nerve-like tingling.",
    videoUrl: "https://www.youtube.com/watch?v=fnih_6w_JjA",
  }),
  mobilityExercise({
    id: "seatedPancakeHinge",
    name: "Seated Pancake Hinge",
    category: "hamstrings",
    mode: "active",
    prescription: "Controlled forward hinges with relaxed pauses",
    intent: "Open hamstrings and adductors for wide and high foot positions.",
    progression: ["Reach farther without rounding.", "Add active return reps."],
    cue: "Lead with the pelvis, not the head.",
    videoUrl: "https://www.youtube.com/watch?v=CHRUb43S6RM",
  }),

  mobilityExercise({
    id: "boxHighStepRocks",
    name: "High-Step Rocks",
    category: "highStep",
    mode: "active",
    equipment: ["box"],
    prescription: "Controlled rocks over a high foot on a box or bench",
    intent: "Practice deep bent-knee hip flexion in the position climbing actually demands.",
    progression: ["Raise the foot.", "Use less hand support.", "Pause over the high foot."],
    cue: "Keep the heel loaded and the pelvis level.",
    videoUrl: "https://www.youtube.com/shorts/7hGt7NnOJB8",
  }),
  mobilityExercise({
    id: "activeHighStepPullIn",
    name: "Standing High-Step Pull-In",
    category: "highStep",
    mode: "active",
    prescription: "Alternating knee-to-chest pulls followed by active holds",
    intent: "Pair passive hip access with the strength needed to place and retain a high foot.",
    progression: ["Use less arm assistance.", "Hold the final position longer."],
    cue: "Stay tall and pull the thigh in without hiking the standing hip.",
    videoUrl: "https://www.youtube.com/watch?v=f86QMiSMaZ4",
  }),
  mobilityExercise({
    id: "pancakeLegLifts",
    name: "Pancake Leg Lifts",
    category: "highStep",
    mode: "active",
    prescription: "Strict alternating leg lifts from a straddle",
    intent: "Build active compression and hip-flexor strength for high feet and heel hooks.",
    progression: ["Increase obstacle height.", "Reduce trunk lean without losing lift height."],
    cue: "Lift from the hip without rolling the leg open.",
    videoUrl: "https://www.youtube.com/watch?v=WHSy0wERiPQ",
  }),

  mobilityExercise({
    id: "supineWeightedFrog",
    name: "Supine Weighted Frog",
    category: "hipOpening",
    mode: "loaded",
    equipment: ["weight"],
    prescription: "Relaxed loaded holds with weight supported at the knees",
    intent: "Open the adductors for hips-close-to-wall climbing positions.",
    progression: ["Improve relaxation before load.", "Add load gently."],
    cue: "Use a tolerable stretch, never knee pressure.",
    videoUrl: "https://www.youtube.com/watch?v=TiOh0dggqHQ&t=318s",
  }),
  mobilityExercise({
    id: "frogRockbacks",
    name: "Frog Rock-Backs",
    category: "hipOpening",
    mode: "active",
    prescription: "Slow rock-backs with a pause at the deepest comfortable point",
    intent: "Open the adductors without external load.",
    progression: ["Widen the knees gradually.", "Pause longer without losing position."],
    cue: "Keep the shins comfortable and the low back quiet.",
    videoUrl: "https://www.youtube.com/watch?v=eD0SMkOrd6g",
  }),

  mobilityExercise({
    id: "couchStretch",
    name: "Couch Stretch",
    category: "hipExtension",
    mode: "static",
    prescription: "Alternating hip-flexor and quad holds",
    intent: "Restore hip extension so high steps and steep climbing do not borrow motion from the low back.",
    progression: ["Bring the torso more upright.", "Move the knee closer to the wall gradually."],
    cue: "Tuck the pelvis and squeeze the rear glute.",
    videoUrl: "https://www.youtube.com/watch?v=ulgAOykAgV4",
  }),
  mobilityExercise({
    id: "halfKneelingHipFlexor",
    name: "Half-Kneeling Hip-Flexor Stretch",
    category: "hipExtension",
    mode: "static",
    prescription: "Alternating holds with a posterior pelvic tilt",
    intent: "Open hip extension when a wall or couch is unavailable.",
    progression: ["Increase the glute squeeze.", "Add a same-side overhead reach."],
    cue: "Move the pelvis, not the low back.",
    videoUrl: "https://www.youtube.com/watch?v=vIDzsqJiAIo",
  }),

  mobilityExercise({
    id: "wristRockbacks",
    name: "Wrist and Finger Rock-Backs",
    category: "forearms",
    mode: "active",
    prescription: "Gentle palm-down and palm-up rocks",
    intent: "Restore wrist and finger-flexor range after gripping.",
    progression: ["Shift farther while keeping the palms relaxed.", "Change finger angle gradually."],
    cue: "Use light pressure and avoid finger-joint pain.",
    videoUrl: "https://www.youtube.com/watch?v=Nh7YsSFLBfk",
  }),
  mobilityExercise({
    id: "wallForearmStretch",
    name: "Wall Forearm Stretch",
    category: "forearms",
    mode: "static",
    prescription: "Alternating flexor and extensor holds",
    intent: "Open both sides of the forearm with easily controlled pressure.",
    progression: ["Rotate the hand position.", "Step slightly farther from the wall."],
    cue: "Keep the elbow soft and stop before tingling.",
    videoUrl: "https://www.youtube.com/watch?v=Cj9b3nI1EHU",
  }),

  mobilityExercise({
    id: "bandedLatStretch",
    name: "Banded Lat Stretch",
    category: "overhead",
    mode: "static",
    equipment: ["band"],
    prescription: "Alternating overhead traction holds",
    intent: "Open overhead shoulder flexion and the lat line used in long reaches.",
    progression: ["Sit the hips farther back.", "Rotate gently away from the anchored side."],
    cue: "Keep the ribs down while the arm reaches long.",
    videoUrl: "https://www.youtube.com/watch?v=WUFuWuYf_u0",
  }),
  mobilityExercise({
    id: "childPoseLatReach",
    name: "Child's-Pose Lat Reach",
    category: "overhead",
    mode: "static",
    prescription: "Long overhead reaches, biased one side at a time",
    intent: "Open lats and overhead reach without equipment.",
    progression: ["Walk the hands farther to each side.", "Hold the ribs stacked."],
    cue: "Reach long through the hand without collapsing the shoulder.",
    videoUrl: "https://www.youtube.com/watch?v=XosIdsVPr0Y",
  }),
  mobilityExercise({
    id: "wallLatStretch",
    name: "Wall Lat Stretch",
    category: "overhead",
    mode: "static",
    prescription: "Supported overhead hinges at a wall",
    intent: "Restore overhead shoulder flexion with controllable loading.",
    progression: ["Hinge deeper while keeping the spine neutral.", "Bias one arm at a time."],
    cue: "Push the hips back and keep the ribs contained.",
    videoUrl: "https://www.youtube.com/watch?v=JW_B7HJFT2Q",
  }),

  mobilityExercise({
    id: "doorwayPecStretch",
    name: "Doorway Pec Stretch",
    category: "chest",
    mode: "static",
    prescription: "Alternating chest-opening holds",
    intent: "Open pecs and the front of the shoulder after pulling-dominant training.",
    progression: ["Vary arm height.", "Turn away slightly farther without shoulder pinch."],
    cue: "Keep the shoulder blade settled; do not force the joint forward.",
    videoUrl: "https://www.youtube.com/watch?v=M850sCj9LHQ",
  }),
  mobilityExercise({
    id: "pronePecStretch",
    name: "Prone Pec Stretch",
    category: "chest",
    mode: "static",
    prescription: "Gentle alternating floor-supported holds",
    intent: "Open the chest when a doorway is unavailable.",
    progression: ["Increase rotation gradually.", "Explore a slightly different arm angle."],
    cue: "Use the opposite hand to control the turn.",
    videoUrl: "https://www.youtube.com/watch?v=tatrv67rou8",
  }),
];

export const STRETCH_EXERCISE_MAP = Object.fromEntries(
  STRETCH_EXERCISES.map(exercise => [exercise.id, exercise])
);

export const DEFAULT_STRETCH_PREFERENCES = {
  targetMinutes: 10,
  priorities: ["hamstrings", "highStep"],
  equipment: [],
};

const TARGET_OPTIONS = [5, 10, 15];
const CATEGORY_ORDER = Object.keys(STRETCH_CATEGORIES);
const EQUIPMENT_KEYS = Object.keys(STRETCH_EQUIPMENT);

export function sanitizeStretchPreferences(value) {
  const source = value && typeof value === "object" ? value : {};
  const target = TARGET_OPTIONS.includes(Number(source.targetMinutes))
    ? Number(source.targetMinutes)
    : DEFAULT_STRETCH_PREFERENCES.targetMinutes;
  const priorities = [...new Set(
    (Array.isArray(source.priorities) ? source.priorities : DEFAULT_STRETCH_PREFERENCES.priorities)
      .filter(key => STRETCH_CATEGORIES[key])
  )].slice(0, 2);
  const equipment = [...new Set(
    (Array.isArray(source.equipment) ? source.equipment : DEFAULT_STRETCH_PREFERENCES.equipment)
      .filter(key => STRETCH_EQUIPMENT[key])
  )];
  return { targetMinutes: target, priorities, equipment };
}

function isoDay(date) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(date || "");
  if (!match) return null;
  return Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])) / 86400000;
}

export function weeklyStretchCoverage(workoutSessions, asOfDate) {
  const coverage = Object.fromEntries(CATEGORY_ORDER.map(key => [key, 0]));
  const asOf = isoDay(asOfDate);
  if (asOf == null) return coverage;
  for (const session of workoutSessions || []) {
    if ((session?.workoutId || session?.workout) !== "STRETCH") continue;
    const day = isoDay(session.date);
    if (day == null || day > asOf || day < asOf - 6) continue;
    for (const [id, data] of Object.entries(session.exercises || {})) {
      if (data?.done === false) continue;
      const category = data?.category || STRETCH_EXERCISE_MAP[id]?.mobilityCategory;
      if (!STRETCH_CATEGORIES[category]) continue;
      const minutes = Number(data?.minutes);
      coverage[category] += Number.isFinite(minutes) && minutes > 0 ? minutes : 0;
    }
  }
  return coverage;
}

function availableExercises(category, equipment) {
  const available = new Set(equipment || []);
  return STRETCH_EXERCISES.filter(exercise =>
    exercise.mobilityCategory === category
    && (exercise.equipment || []).every(key => available.has(key))
  );
}

export function buildStretchPlan({
  targetMinutes,
  priorities,
  equipment,
  coverage = {},
}) {
  const prefs = sanitizeStretchPreferences({ targetMinutes, priorities, equipment });
  const desiredCategories = prefs.targetMinutes <= 5 ? 3 : prefs.targetMinutes <= 10 ? 5 : 6;
  const selected = [];
  const add = key => {
    if (STRETCH_CATEGORIES[key] && !selected.includes(key)) selected.push(key);
  };

  prefs.priorities.forEach(add);

  // Hip rotation and forearms are the climbing-specific foundation.
  // On a five-minute day there is room for only one after two personal
  // priorities, so the less-covered one wins. Standard/extended days
  // include both.
  const core = ["hipRotation", "forearms"].sort((a, b) => {
    const diff = Number(coverage[a] || 0) - Number(coverage[b] || 0);
    return diff || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);
  });
  core.forEach(add);

  // Fill remaining slots by weekly deficit. This rotates hip opening,
  // extension, overhead reach, and chest work instead of letting the
  // same favorite movement crowd out everything else.
  CATEGORY_ORDER
    .slice()
    .sort((a, b) => {
      const diff = Number(coverage[a] || 0) - Number(coverage[b] || 0);
      return diff || CATEGORY_ORDER.indexOf(a) - CATEGORY_ORDER.indexOf(b);
    })
    .forEach(add);

  const categories = selected.slice(0, desiredCategories);
  const baseMinutes = Math.floor(prefs.targetMinutes / categories.length);
  let remainder = prefs.targetMinutes - baseMinutes * categories.length;
  const minutePriority = [
    ...prefs.priorities.filter(key => categories.includes(key)),
    ...categories.filter(key => !prefs.priorities.includes(key)),
  ];
  const minutesByCategory = Object.fromEntries(categories.map(key => [key, baseMinutes]));
  for (const key of minutePriority) {
    if (remainder <= 0) break;
    minutesByCategory[key] += 1;
    remainder -= 1;
  }

  const items = categories.map(category => {
    const options = availableExercises(category, prefs.equipment);
    const exercise = options[0];
    return {
      category,
      categoryLabel: STRETCH_CATEGORIES[category].label,
      minutes: minutesByCategory[category],
      exercise,
      options,
    };
  }).filter(item => item.exercise);

  return {
    targetMinutes: prefs.targetMinutes,
    priorities: prefs.priorities,
    equipment: prefs.equipment,
    items,
  };
}

export function toggleStretchPriority(priorities, key) {
  if (!STRETCH_CATEGORIES[key]) return priorities || [];
  const current = [...new Set((priorities || []).filter(k => STRETCH_CATEGORIES[k]))];
  if (current.includes(key)) return current.filter(item => item !== key);
  if (current.length < 2) return [...current, key];
  return [current[1], key];
}

export function toggleStretchEquipment(equipment, key) {
  if (!EQUIPMENT_KEYS.includes(key)) return equipment || [];
  const current = [...new Set((equipment || []).filter(k => STRETCH_EQUIPMENT[k]))];
  return current.includes(key)
    ? current.filter(item => item !== key)
    : [...current, key];
}
