// ─────────────────────────────────────────────────────────────
// SUPPORT TRAINING — workout templates + recommender
// ─────────────────────────────────────────────────────────────
// Strength / power / mobility training that supports climbing,
// not the climbing itself. The finger-training side of the app
// (β learner, three-exp curve, cookedness slider) is finger-
// specific; this module handles everything else.
//
// Design constraints (user-specified, May 2026):
//   - One BIG strength session per week, max. A is the
//     reservation slot; everything else is frequent / low-friction.
//   - Climbing fatigue is local to the forearms — most days a
//     strength session is fine alongside climbing.
//   - The post-outdoor-Monday "I'm wiped" case (6–12×/year) is
//     covered by a manual `energyLow` toggle, not dedicated logic.
//   - Cookedness is finger-specific and is NOT consumed here.
//
// Workouts:
//   A     — Strength Support     (BIG, ~45 min, one per week)
//   B     — Athletic Power       (FREQUENT, ~30 min, recovers fast)
//   C     — Positional Capacity  (FREQUENT, ~20 min, hip access)
//   D     — Neural Strength Touch (FREQUENT, ~15 min, the easy yes)
//   CLIMB — primary climbing session (INPUT ONLY — the recommender
//           never pushes you to climb; climbing happens for its own
//           reasons. Climbing history is consumed for tag staleness
//           on neural/connective/finger patterns.)
//   REST  — explicit rest day (the recommender CAN push toward this
//           when climbing density is high; rest is real training.)

import { today } from "../util.js";

// Valid stimulus tags (string union):
//   climbing, strength, power, neural, connective, explosive,
//   mobility, restoration, positionalCapacity, core, shoulder,
//   hamstring, hip, finger, biceps

// ─────────────────────────────────────────────────────────────
// Exercises
// ─────────────────────────────────────────────────────────────
// Each exercise carries:
//
//   Coaching fields (always present): id, name, tags, prescription
//     (display string), intent, progression notes, optional cautions.
//
//   Logging fields (for the WorkoutTab UI):
//     loggable: true  — render with the full per-set weight/rep UI
//                       (SessionExRow). Provides numeric load
//                       progression for the lift-style exercises.
//     loggable: false — render as a compact "name + prescription +
//                       done?" tile with an optional notes field.
//                       For bodyweight / mobility / explosive items
//                       where numeric load tracking is the wrong
//                       shape (med-ball slam, KB snatch, skater
//                       bound, ab wheel — band color or distance is
//                       the variable, not "weight").
//
//   When loggable=true, the following mirror the legacy
//   DEFAULT_WORKOUTS schema so recommendSet() and SessionExRow keep
//   working unchanged:
//     type                — S/H/P/X badge color
//     sets                — number of sets to log
//     reps                — display-only string ("2–4", "5", etc.)
//     logWeight           — true → numeric weight per set
//     bodyweightAdditive  — true → "+X kg added to BW" instead of
//                           absolute load (pullups, dips)
//     unilateral          — true → L/R logged per set (curls, KB
//                           snatch, split squat)
//     availableLoads      — optional array of fixed DBs / KBs
//                           (some exercises only have certain
//                           weights available)
//
//   The `tags` field feeds the recommender's tag-staleness engine
//   downstream — independent of the logging fields.

export const exercises = {
  weightedPullup: {
    id: "weightedPullup",
    name: "Weighted Pull-Up",
    tags: ["strength", "neural", "connective", "shoulder"],
    prescription: "3 × 2–4",
    intent: "Maintain high-force pulling without junk fatigue.",
    progression: [
      "Add load only when all reps are crisp.",
      "Prioritize speed and clean form.",
      "No grinders.",
    ],
    cautions: ["Reduce if elbows, shoulders, or fingers feel tweaky."],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "2–4",
    logWeight: true,
    bodyweightAdditive: true,
  },

  benchPress: {
    id: "benchPress",
    name: "Bench Press",
    tags: ["strength", "shoulder"],
    prescription: "2 × 5",
    intent: "Low-volume pressing strength for upper-body balance.",
    progression: ["Add small load when both sets feel clean."],
    loggable: true,
    type: "S",
    sets: 2,
    reps: "5",
    logWeight: true,
  },

  dips: {
    id: "dips",
    name: "Dips",
    tags: ["strength", "shoulder", "connective"],
    prescription: "2 × 3–5",
    intent:
      "Low-volume pressing on D as the dedicated pressing slot. Skipping bench in A keeps pressing volume from doubling up across the week.",
    progression: ["Add load slowly.", "Keep ROM pain-free."],
    cautions: ["Avoid deep ROM if anterior shoulder feels irritated."],
    loggable: true,
    type: "S",
    sets: 2,
    reps: "3–5",
    logWeight: true,
    bodyweightAdditive: true,
  },

  splitSquat: {
    id: "splitSquat",
    name: "Rear-Foot-Elevated Split Squat",
    tags: ["strength", "hip", "hamstring"],
    prescription: "2–3 × 5–8",
    intent: "Unilateral leg strength, hip control, athletic posture.",
    progression: [
      "Controlled eccentric.",
      "Explosive concentric.",
      "Add load gradually.",
    ],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "5–8",
    logWeight: true,
    unilateral: true,
  },

  bandedLatPull: {
    id: "bandedLatPull",
    name: "Heavy-Band Single-Arm Lat Pull",
    tags: ["strength", "shoulder"],
    prescription: "2–3 × 6–10",
    intent:
      "Climbing-specific lat integration with zero row setup. Use a heavy band so the top-range load is meaningful — light therapy bands won't cut it as a strength stimulus.",
    progression: [
      "Move to a heavier band before adding reps.",
      "Keep full reach and scapular motion.",
      "Pull elbow toward hip, not toward chest.",
    ],
    // Non-loggable: band color is the load axis, not numeric weight.
    // The user logs band variant + sets in the notes field.
    loggable: false,
    type: "S",
  },

  bicepCurls: {
    id: "bicepCurls",
    name: "Bicep Curls",
    tags: ["strength", "biceps", "connective"],
    prescription: "2–3 × 6–10",
    intent:
      "Support underclings, lockoffs, compression positions, and close-to-body pulling.",
    progression: [
      "Add load slowly.",
      "Keep reps clean.",
      "Use full ROM unless joints object.",
    ],
    cautions: ["Reduce if elbows feel irritated from climbing or pull-ups."],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "6–10",
    logWeight: true,
    unilateral: true,
    availableLoads: [20, 25, 40],
  },

  hardStyleSitup: {
    id: "hardStyleSitup",
    name: "Hard-Style Situp",
    tags: ["core", "hamstring"],
    prescription: "2–3 × 4–6",
    intent:
      "Trains trunk tension while hamstrings actively pull — mirrors the reciprocal-inhibition pattern in roof heel hooks. Hamstring engagement disables the hip flexor, forcing the rectus abdominis to do the situp on its own. That's the specific neural adaptation no other core exercise produces.",
    progression: [
      "Increase hamstring pull against the band.",
      "Reduce hand assistance.",
      "Control eccentric.",
    ],
    // Non-loggable: bodyweight + band tension. Notes field tracks
    // band tension cues if useful.
    loggable: false,
    type: "S",
    videoUrl: "https://www.youtube.com/watch?v=qFScyUpr0nQ",
  },

  abWheel: {
    id: "abWheel",
    name: "Ab Wheel",
    tags: ["core", "strength", "shoulder"],
    prescription: "1–2 light sets",
    intent: "Light anti-extension touch for steep-climbing force transfer.",
    progression: [
      "Increase ROM gradually.",
      "Slow eccentric.",
      "Progress toward standing rollouts (much later).",
    ],
    loggable: false,
    type: "S",
  },

  proneExternalRotation: {
    id: "proneExternalRotation",
    name: "Prone External Rotation",
    tags: ["shoulder", "strength"],
    prescription: "3 × 8–10",
    intent:
      "Top-range rotator cuff strength. Seated cable ER loads the bottom of the rotation; prone loads the top — and the top is the range that matters for small-hold shoulder control. Load is lighter than seated because the lever is harder, that's the point.",
    progression: [
      "Build range first, then add load.",
      "Later cycle: 4 × 3–5 heavier for maximal strength.",
    ],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "8–10",
    logWeight: true,
    // Lattice "Vacuum Style" video covers the prone variant in its
    // shoulder section, with Aidan Roberts demoing form.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw",
  },

  medBallThrows: {
    id: "medBallThrows",
    name: "Med Ball Slams / Throws",
    tags: ["power", "explosive", "core"],
    prescription: "4–5 × 3–5",
    intent: "Explosive whole-body power without taxing pulling muscles.",
    progression: [
      "Increase intent before load.",
      "Rotate variations.",
      "Stop before fatigue slows movement.",
    ],
    // Non-loggable: med ball weight rarely changes, intent is the
    // primary variable. Notes field is sufficient.
    loggable: false,
    type: "P",
  },

  kbSnatch: {
    id: "kbSnatch",
    name: "Kettlebell Snatch",
    tags: ["power", "explosive", "hamstring", "shoulder"],
    prescription: "4 × 4–6 / side",
    intent: "Hip drive, posterior chain, rhythm, athletic sequencing.",
    progression: ["Increase crispness first.", "Then load.", "Never grind reps."],
    loggable: true,
    type: "P",
    sets: 4,
    reps: "4–6",
    logWeight: true,
    unilateral: true,
  },

  jumps: {
    id: "jumps",
    name: "Broad Jump or Box Jump",
    tags: ["power", "explosive", "hamstring"],
    prescription: "3–4 × 2–5",
    intent: "Restore explosive confidence and rate of force development.",
    progression: [
      "Jump farther or higher only while landings stay clean.",
      "Low volume.",
      "Full recovery between sets.",
    ],
    // Non-loggable: distance/height is the variable, not weight.
    loggable: false,
    type: "P",
  },

  skaterBounds: {
    id: "skaterBounds",
    name: "Skater Bounds",
    tags: ["power", "explosive", "hip", "hamstring"],
    prescription: "3 × 5 / side",
    intent:
      "Lateral-plane power — flagging, sideways throws, cross-body moves. Most strength programs skip the lateral plane entirely; climbing is full of it.",
    progression: ["Increase distance.", "Stick landings.", "Do not rush reps."],
    loggable: false,
    type: "P",
  },

  bandedRotationalWork: {
    id: "bandedRotationalWork",
    name: "Banded Core Chop",
    tags: ["core", "power", "explosive"],
    prescription: "3 × 6 / side · alternate high-to-low and low-to-high week to week",
    intent:
      "Rotational power through the torso — the same force-transfer pattern that drives crossing throws, lateral dynos, and any move where the hips load and the upper body delivers. Anchor a heavy band at shoulder height (high-to-low) or at hip height (low-to-high) on a rack or post. Stand perpendicular, feet shoulder width, weight loaded into the inside leg. Grab the band with both hands and chop diagonally across the body — high anchor → opposite hip, or low anchor → opposite shoulder. The chop should feel like the hip initiates and the arms finish, not arms-only.",
    progression: [
      "Rotate AROUND your center of mass — don't lunge or lean forward over the lead leg. The torso turns; the feet stay rooted.",
      "Hip and shoulder should NOT move together. Coil first (hip rotates, shoulders stay back), then unleash. The stretch is what generates the power.",
      "Shoulders depressed, scapulae protracted, arms internally rotated through the chop.",
      "Increase speed before load. A faster chop with a lighter band beats a sluggish chop with a heavy one.",
      "Step further from the anchor for more torque before switching to a thicker band.",
    ],
    loggable: false,
    type: "P",
    videoUrl: "https://www.youtube.com/shorts/7FBTF01LBUI",
  },

  supineWeightedFrog: {
    id: "supineWeightedFrog",
    name: "Supine Weighted Frog",
    tags: ["mobility", "positionalCapacity", "hip", "restoration"],
    prescription: "2–3 × 90–120 sec",
    intent:
      "Hip opening for hips-close-to-wall climbing. Supine removes floor friction so the stretch actually loads end-range; weight goes on the knees.",
    progression: [
      "Add load gently (5–10 kg per knee is the working range).",
      "Improve relaxation quality.",
      "Extend duration gradually.",
    ],
    // Non-loggable: time-based hold with bilateral weight. Numeric
    // load tracking is overkill; notes field can capture weight if
    // it matters that session.
    loggable: false,
    type: "H",
    // Lattice "Vacuum Style" with Aidan Roberts covers the supine
    // frog in the hip section — same video covers the pancake +
    // pancake leg lifts below, scrub to the section you want.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw",
  },

  weightedPancake: {
    id: "weightedPancake",
    name: "Weighted Pancake",
    tags: ["mobility", "positionalCapacity", "hip", "hamstring"],
    prescription: "3 × 6 slow reps",
    intent:
      "Loaded hamstring / adductor mobility — opens wide stems, drop knees, far-away heel hooks. Slow tempo into end range, pause 1–2 sec, optional 10-sec final hold.",
    progression: [
      "Start regressed (standing, leaning back to wall) if seated pancake isn't accessible yet.",
      "Lower hip height as flexibility improves (yoga blocks → floor).",
      "Add load only once end-range control is solid.",
    ],
    loggable: true,
    type: "H",
    sets: 3,
    reps: "6",
    logWeight: true,
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw",
  },

  pancakeLegLifts: {
    id: "pancakeLegLifts",
    name: "Pancake Leg Lifts",
    tags: ["mobility", "strength", "positionalCapacity", "hip"],
    prescription: "3 × 6 / side",
    intent:
      "End-range hip-flexor strength for high feet and heel hooks. Flexibility without strength means you can passively sit in the position but can't generate from it — this exercise closes that gap.",
    progression: [
      "Increase object height as control improves.",
      "Keep reps strict — no hip rotation to cheat.",
    ],
    // Non-loggable: progression is "height of the object you're
    // lifting your heel over", not numeric load.
    loggable: false,
    type: "H",
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw",
  },
};

// ─────────────────────────────────────────────────────────────
// Workouts
// ─────────────────────────────────────────────────────────────
// fatigueClass is the recommender's actionable tag:
//   "big"      — one per week, max. Competes with climbing for
//                the user's best non-outdoor day.
//   "frequent" — low-friction, can stack alongside climbing days.
//   "primary"  — climbing itself (input, not output).
//   "rest"     — explicit rest.
//
// fatigueCost is decorative for the UI (a 0–5 ordinal); the
// recommender reads fatigueClass, not the numeric cost.

export const workouts = {
  A: {
    id: "A",
    shortName: "A",
    name: "Workout A — Strength Support",
    purpose: "Low-volume force production and structural strength.",
    fatigueClass: "big",
    fatigueCost: 3,
    // Workout-level tags describe the STIMULUS the workout provides,
    // not the body parts it touches. The split squat involves the hip,
    // but A doesn't train positional capacity / mobility — so "hip" and
    // "hamstring" belong at the EXERCISE level (where they describe the
    // exercise truthfully) but NOT at the workout level (where the
    // recommender reads them to detect stimulus staleness). Same logic
    // applies to B, C, D below.
    tags: ["strength", "neural", "connective"],
    exercises: [
      exercises.weightedPullup,
      exercises.benchPress,
      exercises.splitSquat,
      exercises.bandedLatPull,
      exercises.bicepCurls,
      exercises.hardStyleSitup,
      exercises.proneExternalRotation,
    ],
    coachingNotes: [
      "Crisp, controlled, low-volume strength.",
      "Enough stimulus to adapt; no junk fatigue.",
      "Leave strong, not crushed.",
    ],
  },

  B: {
    id: "B",
    shortName: "B",
    name: "Workout B — Athletic Power",
    purpose: "Explosiveness, elasticity, sequencing, lateral-plane power.",
    fatigueClass: "frequent",
    fatigueCost: 2,
    // Power/explosive is the stimulus. Hip drive and posterior chain
    // load are byproducts of the chosen exercises (KB snatch, bounds),
    // but at the workout level B is a power session — not a hip-
    // mobility session. See note on A above.
    tags: ["power", "explosive"],
    exercises: [
      exercises.medBallThrows,
      exercises.kbSnatch,
      exercises.jumps,
      exercises.skaterBounds,
      exercises.bandedRotationalWork,
    ],
    coachingNotes: [
      "Stop while fast and springy.",
      "This is not conditioning.",
      "Quality beats volume.",
    ],
  },

  C: {
    id: "C",
    shortName: "C",
    name: "Workout C — Positional Capacity",
    purpose: "Hip mobility and usable range for climbing-specific positions.",
    // Was "Positional Capacity + Restoration". Rope flow dropped
    // because it's already in the warm-up / cool-down habit (no
    // point double-counting); Zone 2 dropped because it didn't fit
    // the positional theme. C is now three exercises, tightly
    // focused on hip access — frog → pancake → pancake leg lifts
    // is the right progression for the climbing patterns it serves.
    fatigueClass: "frequent",
    fatigueCost: 1,
    // C is the only workout that produces a mobility / positional-
    // capacity stimulus. Rule 3 in the recommender keys on these
    // tags exclusively, so keeping them clean (not also tagging A
    // with "hip" because of split squat) is what makes Rule 3 work.
    tags: ["mobility", "positionalCapacity", "restoration"],
    exercises: [
      exercises.supineWeightedFrog,
      exercises.weightedPancake,
      exercises.pancakeLegLifts,
    ],
    coachingNotes: [
      "This is not generic stretching.",
      "Build climbing-specific hip access and usable range.",
      "Leave loose, athletic, and restored.",
    ],
  },

  D: {
    id: "D",
    shortName: "D",
    name: "Workout D — Neural Strength Touch",
    purpose: "Brief low-fatigue strength exposure to maintain frequency.",
    // The "I can do this when tired" workout — pull + press + arm
    // + core in ~15 min. Catches the post-outdoor-Monday case and
    // the broader "I'd skip A but this still happens" pattern.
    // Dips on D is locked (no bench/dips alternation any more);
    // bench lives on A.
    fatigueClass: "frequent",
    fatigueCost: 1,
    tags: ["strength", "neural"],
    exercises: [
      { ...exercises.weightedPullup, prescription: "2 × 2" },
      { ...exercises.dips,           prescription: "2 × 3–5" },
      { ...exercises.bicepCurls,     prescription: "1–2 × 5–8 optional" },
      { ...exercises.abWheel,        prescription: "1–2 light sets optional" },
    ],
    coachingNotes: [
      "This should feel like activation, not training.",
      "Leave fresher than you started.",
      "No fatigue chasing.",
    ],
  },

  CLIMB: {
    id: "CLIMB",
    shortName: "Climb",
    name: "Climb",
    purpose: "Primary climbing performance stimulus.",
    fatigueClass: "primary",
    fatigueCost: 4,
    tags: ["climbing", "finger", "neural", "connective"],
    exercises: [],
    coachingNotes: [
      "Cap around 1.5 hours.",
      "High intention.",
      "Avoid junk volume.",
    ],
  },

  REST: {
    id: "REST",
    shortName: "Rest",
    name: "Rest",
    purpose: "Absorb training and preserve long-term progression.",
    fatigueClass: "rest",
    fatigueCost: 0,
    tags: ["restoration"],
    exercises: [],
    coachingNotes: ["Full rest is productive training."],
  },
};

// ─────────────────────────────────────────────────────────────
// Recommender
// ─────────────────────────────────────────────────────────────
// Decision logic (first match wins):
//
//   1. A is overdue (≥7 days) AND energyLow is set
//      → D, with caution to reschedule A.
//   2. A is overdue AND energy is OK
//      → A. The week's strength reservation.
//   3. Hip / positional-capacity / mobility stale (≥7 days)
//      → C.
//   4. Power / explosive stale (≥10 days)
//      → B.
//   5. Strength touch stale (D ≥4 days)
//      → D.
//   6. Fallback
//      → C (safe useful default — compounds quietly).
//
// Neither CLIMB nor REST is ever recommended by this engine.
// CLIMB is logged via the climbing activities flow; REST is just
// "don't open the app today." The user knows when they need to
// rest without the engine prompting. A future deload-week
// recommender could re-introduce structured rest at a higher
// level (weeks, not days).
//
// Tunable thresholds live as constants below so tweaking doesn't
// require touching the decision tree.

const A_OVERDUE_DAYS     = 7;
const HIP_STALE_DAYS     = 7;
const POWER_STALE_DAYS   = 10;
const D_TOUCH_DAYS       = 4;

/**
 * Recommend the next support-training session.
 *
 * @param {Array<{id:string, workoutId:string, date:string}>} workoutHistory
 *   Completed support sessions. `workoutId` is one of A/B/C/D/CLIMB/REST.
 *   Order doesn't matter; the recommender scans for most-recent matches.
 * @param {Object} [opts]
 * @param {boolean} [opts.energyLow=false]  Manual "I'm wiped" toggle.
 *   When set, A is blocked even if overdue.
 * @param {Array<{type:string, date:string}>} [opts.climbingHistory=[]]
 *   Activities log (from the existing `activities` state). Entries
 *   with type === "climb" feed tag staleness for the climbing
 *   pattern bundle and the high-density REST trigger.
 * @param {string} [opts.refDate]  ISO date for testing. Defaults to today().
 *
 * @returns {{
 *   primary: object, reason: string,
 *   caution?: string, alternatives: object[]
 * }}
 */
export function recommendNextWorkout(workoutHistory = [], opts = {}) {
  const {
    energyLow = false,
    climbingHistory = [],
    refDate = today(),
  } = opts;

  const daysSinceA = daysSinceLastOfType(workoutHistory, "A", refDate);
  const daysSinceD = daysSinceLastOfType(workoutHistory, "D", refDate);
  const tagDays    = computeTagDaysSince(workoutHistory, climbingHistory, refDate);

  // 1. A overdue + low energy → D, with caution.
  if (daysSinceA >= A_OVERDUE_DAYS && energyLow) {
    return {
      primary: workouts.D,
      reason:
        "A is due but you flagged low energy. D maintains the strength pattern without the volume — claim A on a fresher day.",
      caution: "Don't push for A tonight.",
      alternatives: [workouts.C, workouts.REST],
    };
  }

  // 2. A overdue + energy OK → A. The week's reservation slot.
  if (daysSinceA >= A_OVERDUE_DAYS) {
    return {
      primary: workouts.A,
      reason: daysSinceA === Infinity
        ? "No A on record yet. This is the week's one big strength day."
        : `Last A was ${daysSinceA} days ago — time to claim the week's strength slot.`,
      alternatives: [workouts.D, workouts.C],
    };
  }

  // 3. Positional-capacity / mobility stimulus stale → C.
  // Only C carries these workout-level tags, so this is functionally
  // "C is stale" with tag indirection in case a future workout adds
  // mobility content.
  const mobilityDays = Math.min(
    tagDays.positionalCapacity ?? Infinity,
    tagDays.mobility           ?? Infinity,
  );
  if (mobilityDays >= HIP_STALE_DAYS) {
    return {
      primary: workouts.C,
      reason: mobilityDays === Infinity
        ? "Positional capacity hasn't been touched yet — start here for hips-close-to-wall access."
        : `Positional capacity is ${mobilityDays} days stale. Supports steep-climbing positions.`,
      alternatives: [workouts.D, workouts.REST],
    };
  }

  // 4. Power / explosive stale → B.
  const powerDays = Math.min(
    tagDays.power     ?? Infinity,
    tagDays.explosive ?? Infinity,
  );
  if (powerDays >= POWER_STALE_DAYS) {
    return {
      primary: workouts.B,
      reason: powerDays === Infinity
        ? "No athletic power work on record yet. Stay fast and springy."
        : `Athletic power is due (~${powerDays} days). Keep it fast and low-fatigue.`,
      alternatives: [workouts.C, workouts.D],
    };
  }

  // 5. Strength touch stale → D.
  if (daysSinceD >= D_TOUCH_DAYS) {
    return {
      primary: workouts.D,
      reason:
        daysSinceD === Infinity
          ? "No D on record yet. Brief strength touch maintains the pull/press pattern between A sessions."
          : `Last D was ${daysSinceD} days ago. Brief strength touch.`,
      alternatives: [workouts.C, workouts.D],
    };
  }

  // 6. Fallback — nothing strictly overdue, default to C.
  // Note: the user signals their own rest needs and doesn't want
  // the engine prompting REST. A future deload-week recommender
  // could re-introduce structured rest at the weekly level.
  return {
    primary: workouts.C,
    reason:
      "Nothing's strictly overdue. Positional capacity is a safe useful default that compounds quietly.",
    alternatives: [workouts.D, workouts.B],
  };
}

// ─────────────────────────────────────────────────────────────
// Helpers (exported for unit testing)
// ─────────────────────────────────────────────────────────────

// Whole days between two ISO date strings. Positive when `bISO` is
// later. Floored — partial days don't count.
export function daysBetween(aISO, bISO) {
  if (!aISO || !bISO) return NaN;
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

// Days since the most recent session of a given workout type.
// Returns Infinity when no such session exists (so "never" reads
// as "infinitely stale" in numeric comparisons).
export function daysSinceLastOfType(history, workoutId, refDate) {
  const matches = (history || []).filter(s => s && s.workoutId === workoutId);
  if (matches.length === 0) return Infinity;
  const latest = matches.reduce((mx, s) => (s.date > mx ? s.date : mx), "");
  if (!latest) return Infinity;
  const d = daysBetween(latest, refDate);
  return Number.isFinite(d) ? d : Infinity;
}

// Map { tag → minimum days since any session producing that tag }.
// Workout sessions contribute their template's `tags`; climbing
// activities contribute the CLIMB template's tag bundle (climbing,
// finger, neural, connective). Future-dated rows are ignored. Tags
// that never appear are absent — callers use `tagDays[tag] ?? Infinity`.
export function computeTagDaysSince(workoutHistory, climbingHistory, refDate) {
  const tagDays = {};
  const bump = (tag, d) => {
    if (d < 0) return;
    if (tagDays[tag] == null || d < tagDays[tag]) tagDays[tag] = d;
  };

  for (const s of (workoutHistory || [])) {
    const wo = s && workouts[s.workoutId];
    if (!wo || !wo.tags) continue;
    const d = daysBetween(s.date, refDate);
    if (!Number.isFinite(d)) continue;
    for (const tag of wo.tags) bump(tag, d);
  }

  for (const a of (climbingHistory || [])) {
    if (!a || a.type !== "climb") continue;
    const d = daysBetween(a.date, refDate);
    if (!Number.isFinite(d)) continue;
    for (const tag of workouts.CLIMB.tags) bump(tag, d);
  }

  return tagDays;
}

// How many DISTINCT dates in the last `withinDays` had at least one
// climbing activity. Distinct-by-date so two climbs on the same day
// count as one climb day (matches the user's intuition of "I climbed
// 4 days this week" rather than "I logged 8 sessions").
export function recentClimbDayCount(climbingHistory, refDate, withinDays) {
  const seen = new Set();
  for (const a of (climbingHistory || [])) {
    if (!a || a.type !== "climb") continue;
    const d = daysBetween(a.date, refDate);
    if (Number.isFinite(d) && d >= 0 && d < withinDays) seen.add(a.date);
  }
  return seen.size;
}

// ─────────────────────────────────────────────────────────────
// Integration sketch (for the eventual WorkoutTab wiring)
// ─────────────────────────────────────────────────────────────
//
//   import { recommendNextWorkout, workouts } from "../model/supportTraining.js";
//
//   // wLog: existing workout-session log. New entries should carry
//   //   `workoutId: "A" | "B" | "C" | "D"` so this recommender can
//   //   read them. Older entries with the legacy `workout` field
//   //   are invisible to the recommender — that's fine for a soft
//   //   migration, the system just starts learning from new sessions.
//   //
//   // activities: the existing climbing/oneRM/rpe log. The
//   //   recommender filters to type === "climb" internally; the
//   //   full array can be passed as `climbingHistory`.
//
//   const rec = recommendNextWorkout(wLog, {
//     energyLow,                  // boolean from a "I'm wiped" toggle in UI
//     climbingHistory: activities,
//   });
//
//   // Render:
//   //   rec.primary       — the recommended workout template
//   //   rec.reason        — one-line explanation
//   //   rec.caution?      — optional yellow-flag note
//   //   rec.alternatives  — array of fallback templates the user can tap
