// ───────────────────────────────────────────────────────
// SUPPORT TRAINING — workout templates + recommender
// ───────────────────────────────────────────────────────
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
//   - The post-outdoor-Monday "I'm wiped" case is handled by the
//     user closing the app, not by a UI toggle. If you're wiped
//     enough to want a different workout, you're wiped enough to
//     skip — and on the rare day you want a lighter session, the
//     A/B/C picker override is one tap. A previous `energyLow`
//     toggle was removed (May 2026) because it only created a
//     theoretical behavior change: the user already self-gates.
//   - Cookedness is finger-specific and is NOT consumed here.
//
// Workouts:
//   A       — Strength Support      (BIG, ~45 min, one per week)
//   B       — Athletic Power        (FREQUENT, ~30 min, recovers fast)
//   C       — Neural Strength Touch (FREQUENT, ~15 min, the easy yes)
//   STRETCH — Daily Stretching      (DAILY HABIT, ~5–10 min, hip + forearm)
//   CLIMB   — primary climbing session (loggable marker only — the
//             recommender never pushes you to climb, and climbing no
//             longer feeds the recommendation; it's logged for its own
//             history via the climbing-activities flow.)
//   REST    — explicit rest day (a loggable marker; never a recommender
//             output — the user signals their own rest needs.)
//
// Rename history (May 2026): Old C (Positional Capacity, the dedicated
// mobility session) was moved out of the picker rotation entirely —
// the literature is clear that mobility adapts to frequency, not dose,
// so it lives as a daily-habit pill below the A/B/C picker rather than
// competing weekly with strength/power for a slot. Old D (Neural
// Strength Touch) was promoted into the now-empty C slot so the picker
// reads A/B/C cleanly. A one-shot migration in WorkoutTab rewrites
// historical sessions with workoutId "D" → "C" on first load; no
// migration is needed for old-C sessions because none exist (the user
// never used the dedicated mobility session, which is part of why we
// know the daily-habit framing is the right shape for the adaptation).

// `today` was imported here when the recommender's refDate option
// defaulted to it (frequency-based engine, May 2026 and earlier).
// The round-robin rewrite doesn't compute against a clock — the
// rotation pointer is purely a function of the most-recent A/B/C
// in history — so the import is dropped. The refDate option signature
// is still accepted for back-compat with existing test fixtures, just
// ignored.

// Valid stimulus tags (string union):
//   climbing, strength, power, neural, connective, explosive,
//   mobility, restoration, positionalCapacity, core, shoulder,
//   hamstring, hip, finger, biceps

// ───────────────────────────────────────────────────────
// Exercises
// ───────────────────────────────────────────────────────
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

  trxRow: {
    // Added June 2026 as Workout C's pulling slot, replacing the
    // weighted pull-up there (the pull-up def stays in this map for
    // Workout A and for historical sessions). Rationale: between
    // climbing, A's pull-ups, and C's old pull-ups, every pull in the
    // program was vertical. A horizontal row trains the scapular
    // retraction / mid-back strength that balances all that vertical
    // pulling — the classic climber's-shoulder prehab gap.
    id: "trxRow",
    name: "TRX Row",
    tags: ["strength", "shoulder"],
    prescription: "3 × 8–12",
    intent:
      "Horizontal pull for scapular and mid-back balance. Climbing and pull-ups are all vertical pulling; rows train the retraction strength that keeps shoulders healthy underneath it.",
    progression: [
      "Climb the leverage rungs: two-arm → feet-elevated → archer → one-arm.",
      "Only then add vest weight.",
      "Maintenance dose — quality reps, no auto-escalation.",
    ],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "8–12",
    // Variant ladder (June 2026): the progression variable here is
    // LEVERAGE, not load — each set logs which rung was used.
    // logVariant is an axis alongside logWeight (like `unilateral`),
    // NOT a fourth logging mode: the row still renders reps + weight
    // inputs, plus a per-set variant selector fed by `variants`.
    logVariant: true,
    variants: ["Two-arm", "Feet-elevated", "Archer", "One-arm"],
    // Optional vest weight — the input exists but may stay blank.
    // Blank weights are safe downstream: the volume/1RM helpers skip
    // zero/missing loads, and seeding for variant exercises copies the
    // prior session rather than running plate-progression math.
    logWeight: true,
    // Definition-level policy is fine HERE (unlike the shared lifts in
    // Workout C below) because only C uses this definition: fixed 3
    // sets, held load — no set ladder, no +5% bumps.
    progressionPolicy: "maintain",
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
      "Pressing strength. June 2026 dip⇄bench swap made dips Workout A's main press (weighted) — bench's barbell had been blocking the pull-up bar on the same day. Two press days a week without doubling the heavy stimulus.",
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
    // Loggable with band color instead of numeric weight (logBand).
    // Unilateral — each side gets its own reps + band, since you may
    // load one side heavier when the other's recovering.
    loggable: true,
    type: "S",
    sets: 3,
    reps: "6–10",
    logBand: true,
    unilateral: true,
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
    // Loggable with band tension (logBand) — the band is the
    // progression variable. Bilateral (the band loops around both
    // feet so it's one tension across the whole movement, not a
    // per-side selection like the lat pull).
    loggable: true,
    type: "S",
    sets: 3,
    reps: "4–6",
    logBand: true,
    videoUrl: "https://www.youtube.com/watch?v=qFScyUpr0nQ",
  },

  abWheel: {
    id: "abWheel",
    name: "Ab Wheel",
    tags: ["core", "strength", "shoulder"],
    prescription: "1–2 × 5–10",
    intent: "Light anti-extension touch for steep-climbing force transfer.",
    progression: [
      "Increase ROM gradually.",
      "Slow eccentric.",
      "Progress toward standing rollouts (much later).",
    ],
    // Loggable as set-circles with reps (circlesOnly + reps): one
    // tappable circle per set, with a reps input alongside. The
    // circle conveys "set N done"; the reps input tracks how many
    // rollouts you actually did. Weight is still excluded — load
    // progression is ROM quality, not numeric.
    loggable: true,
    type: "S",
    sets: 2,
    reps: "5–10",
    circlesOnly: true,
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
    // shoulder section, with Aidan Roberts demoing form. Jumps to
    // the Shoulder Exercises chapter (10:03 / 603s) where Aidan
    // contrasts seated vs prone ER and demos the pronated lever.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw&t=603s",
  },

  medBallThrows: {
    // Kept the id as medBallThrows so historical sessions still
    // resolve to this exercise. Display name dropped "Throws" — user
    // doesn't have a good wall to throw against, slams-only.
    id: "medBallThrows",
    name: "Med Ball Slams",
    tags: ["power", "explosive", "core"],
    prescription: "4–5 × 3–5",
    intent: "Explosive whole-body power without taxing pulling muscles.",
    progression: [
      "Increase intent before load.",
      "Step up to the next ball weight when 3–5 reps stay crisp.",
      "Stop before fatigue slows movement.",
    ],
    // Loggable now (May 2026) — ball weight is the actual progression
    // variable, not just session notes. Same shape as the other
    // strength rows so SessionExRow renders sets × (reps @ weight).
    loggable: true,
    type: "P",
    sets: 4,
    reps: "3–5",
    logWeight: true,
    // Set ladder opt-out (June 2026): power work must not accumulate
    // sets. "double" = fixed sets, rep-up at the current ball counting
    // only FAST reps, then step to the next ball and reset reps —
    // alactic repeat-power capacity, the thing the user reports
    // feeling great.
    progressionPolicy: "double",
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

  // Broad/box jumps split into two first-class exercises (June 2026),
  // replacing KB snatch in Workout B: the user's bell ladder makes the
  // snatch jump infeasible-and-unenjoyable (35→50), and jumps train
  // the same hip projection. Logged as COUNT OF FAST REPS only —
  // recording distance/height was judged a compliance cost. circlesOnly
  // + reps gives the reps-only logging path; no weight, no set ladder.
  broadJump: {
    id: "broadJump",
    name: "Broad Jump",
    tags: ["power", "explosive", "hamstring", "hip"],
    prescription: "3 × 3–5 fast reps",
    intent: "Horizontal hip projection — count only jumps that feel maximal.",
    progression: [
      "All reps maximal intent, full recovery between sets.",
      "Stop the set when a jump feels flat.",
    ],
    loggable: true,
    circlesOnly: true,
    type: "P",
    sets: 3,
    reps: "3–5",
    logWeight: false,
  },
  // boxJump replaced by verticalJump in Workout B (June 2026); def
  // retained so historical sessions still resolve. Rationale: the
  // trainable quality in a jump is the takeoff (triple extension), which
  // is identical with or without a box. Box HEIGHT is confounded by knee
  // tuck (hip flexion), so it measures compression as much as power. A
  // standing vertical jump trains/measures the hip drive that transfers
  // to dynos and driving off footholds more honestly. The box's one real
  // benefit — a de-loaded landing — is a low-volume non-issue here, and
  // recoverable via reach-a-target + step-down if knees object.
  boxJump: {
    id: "boxJump",
    name: "Box Jump",
    tags: ["power", "explosive", "hip"],
    prescription: "3 × 3–5 fast reps",
    intent: "Vertical hip drive with near-zero landing cost — step down, never jump down.",
    progression: [
      "Crisp takeoffs only; step down between reps.",
      "Raise the box only when every rep is easy-fast.",
    ],
    loggable: true,
    circlesOnly: true,
    type: "P",
    sets: 3,
    reps: "3–5",
    logWeight: false,
  },

  verticalJump: {
    id: "verticalJump",
    name: "Vertical Jump",
    tags: ["power", "explosive", "hip"],
    prescription: "3 × 3–5 fast reps",
    intent:
      "Vertical hip drive / triple extension — the takeoff that powers dynos and driving off footholds. Countermovement, then explode and reach for a fixed high target. The trainable quality is the explosive extension, not how high you tuck the knees, so chase reach, not air-time.",
    progression: [
      "Every rep maximal intent; full recovery between sets.",
      "Reach for a fixed target so you're chasing output, not knee tuck.",
      "Land soft; stop the set the moment a jump feels flat.",
    ],
    // Same logging shape as broad/box jump: reps-only fast-rep count
    // (circlesOnly + reps), no weight, no set ladder.
    loggable: true,
    circlesOnly: true,
    type: "P",
    sets: 3,
    reps: "3–5",
    logWeight: false,
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

  frontLever: {
    // Added June 2026 as Workout B's core slot, replacing the banded
    // core chop. Rationale: the chop's band/cable tension never matched
    // the demand of actually holding body position on the wall, so it
    // felt like it wasn't doing much. Front lever trains the straight-
    // arm, scapula-loaded body tension that transfers directly to
    // keeping feet on overhanging terrain — the single most climbing-
    // specific core quality, and one the program had no dedicated work
    // for (hard-style situp = flexion on A; ab wheel = anti-extension
    // on C; both bent-arm / floor-based).
    id: "frontLever",
    name: "Front Lever",
    tags: ["core", "strength", "shoulder", "connective"],
    prescription: "4 × 5–10 sec",
    intent:
      "Straight-arm body tension for steep terrain — the king of climbing core. Hang with straight arms, shoulders depressed and pushed down away from the ears, ribs down so the lower back doesn't arch. Hold the hardest leverage at which the LINE stays rigid hip-to-heel; the instant the hips sag or the elbows bend, you've dropped a rung.",
    progression: [
      "Climb the leverage ladder by HOLD QUALITY, not reps: tuck → advanced tuck → single-leg → straddle → full.",
      "Only add vest weight once a full lever is solid.",
      "Arms dead straight, shoulders depressed, ribs down — end the set the moment the line breaks.",
    ],
    cautions: [
      "Can light up elbows and shoulders if rushed — stay one rung easier than your ego wants for the first few weeks.",
      "Stop a set when form breaks rather than grinding to failure; this is a tension-quality exercise, not a burn.",
    ],
    // Loggable on the leverage-variant path (like trxRow): the
    // progression variable is LEVERAGE, logged per set via the variant
    // selector, with an optional vest-weight input for the post-full-
    // lever phase. Held position — maintain policy, no set ladder.
    loggable: true,
    type: "S",
    sets: 4,
    reps: "5–10 sec",
    logVariant: true,
    variants: ["Tuck", "Advanced tuck", "Single-leg", "Straddle", "Full"],
    logWeight: true,
    progressionPolicy: "maintain",
  },

  hangingLegRaise: {
    // Added June 2026 alongside the front lever as Workout B's second
    // core slot. Covers the compression / active-hip-flexion quality
    // the program had nothing for — bringing high feet up under roofs,
    // locking into steep kneebars and scums. The windshield-wiper rung
    // at the top of the ladder also restores the rotation-under-load
    // the banded chop was nominally there for, but with real bodyweight
    // tension instead of band slack.
    //
    // DROPPED from Workout B June 2026 (def retained for history):
    // grip-limited (taxed already-cooked forearms) and pure flexion,
    // the least climbing-valuable core quality. Its anti-lateral-flexion
    // replacement (Copenhagen plank) lives on the light C day; B kept
    // the front lever as its tension piece and added the TRX hamstring
    // curl.
    id: "hangingLegRaise",
    name: "Hanging Leg Raise",
    tags: ["core", "strength", "shoulder"],
    prescription: "3 × 6–10",
    intent:
      "Compression and active hip flexion from a dead hang. Straight legs if hamstring length allows, knees if not; keep it strict — no kipping or swing. Finish hard sessions with a few windshield wipers (legs up, rotate side to side under control) for rotation under real load.",
    progression: [
      "Climb the leverage ladder: knee raise → straight-leg raise → toes-to-bar → windshield wiper.",
      "Strict and controlled — kill the swing before adding range or reps.",
      "Optional ankle weight / dumbbell between the feet once toes-to-bar is easy.",
    ],
    loggable: true,
    type: "S",
    sets: 3,
    reps: "6–10",
    logVariant: true,
    variants: ["Knee raise", "Straight-leg raise", "Toes-to-bar", "Windshield wiper"],
    logWeight: true,
    progressionPolicy: "maintain",
  },

  heelHookPull: {
    // Added June 2026 as Workout A's leg slot, replacing the split
    // squat. The user hikes fine with a heavy pack, so general leg
    // strength wasn't the need — heel-hook pulling power is. Heel hooks
    // load the hamstring as a PRIME MOVER reeling the body into the wall
    // through the heel; squatting never trains that. Lie on your back,
    // hip and knee ~90°, heel/calf on a box, drive the heel down-and-in
    // and lift the hips — an isometric pull in the exact heel-hook joint
    // position.
    id: "heelHookPull",
    name: "Heel-Hook Iso Pull (90/90)",
    tags: ["hamstring", "hip", "strength"],
    prescription: "3 × 8–10 sec / side",
    intent:
      "Heel-hook–specific hamstring/glute strength in the 90/90 position — the hamstring as the prime mover that pulls your body into the wall through the heel.",
    progression: [
      "Single-leg before adding load.",
      "Pull hard — treat each rep as a max isometric, not a stretch.",
      "Add a dumbbell/vest on the hips, then lengthen the hold.",
    ],
    // logWeight + unilateral (optional hip load, logged per side since
    // heel hooks are single-leg and L/R often differ). Held position —
    // maintain policy, no set ladder.
    loggable: true,
    type: "S",
    sets: 3,
    reps: "8–10 sec",
    logWeight: true,
    unilateral: true,
    progressionPolicy: "maintain",
  },

  trxHamstringCurl: {
    // Added June 2026 to Workout B as the dynamic partner to A's
    // heel-hook iso pull — heel-hook/hamstring work twice a week. Heels
    // in the straps, hips bridged the whole set; curl the heels in
    // without letting the hips drop. Knee-flexion + hip-extension
    // through range, the moving complement to the 90/90 isometric.
    id: "trxHamstringCurl",
    name: "TRX Hamstring Curl",
    tags: ["hamstring", "hip"],
    prescription: "3 × 6–10",
    intent:
      "Dynamic knee-flexion + hip-extension for heel-hook pulling power. Hips stay lifted in a bridge throughout the set.",
    progression: [
      "Keep hips up the whole set — no sagging.",
      "Two-leg → single-leg for more load and anti-rotation.",
      "Slow the eccentric before adding reps.",
    ],
    // circlesOnly: progression is leverage / single-leg, not numeric
    // load — reps-only logging (same shape as Ab Wheel).
    loggable: true,
    type: "S",
    sets: 3,
    reps: "6–10",
    circlesOnly: true,
  },

  copenhagenPlank: {
    // Added June 2026 as Workout C's core slot. Fills the core axis the
    // whole program lacked: across A/B/C the core work was all anterior
    // (hard-style situp = flexion, front lever = tension, ab wheel =
    // anti-extension) with ZERO anti-lateral-flexion or adductor work —
    // exactly the high-value, under-trained quality coaches (Bechtel/
    // Climb Strong) flag. Also grip-free, which is why it landed on the
    // light C day rather than piling more onto B (B's hanging leg raise
    // was dropped outright for the same grip reason). Side plank, top
    // leg on a box, bottom leg hovering; the adductors hold the line.
    id: "copenhagenPlank",
    name: "Copenhagen Plank",
    tags: ["core", "hip", "strength"],
    prescription: "3 × 8–12 sec / side",
    intent:
      "Anti-lateral-flexion + adductor strength — grip-free, and the core axis the program was missing. Serves drop-knees, heel-hook tension, and keeping the hips pinned on steep walls.",
    progression: [
      "Box under the knee (short lever) → mid-shin → ankle.",
      "Bottom leg hovering, body in one line, no hip dip.",
      "Keep it low-rep / short-hold — never to failure.",
    ],
    // Variant ladder (lever position) like trxRow/frontLever, plus an
    // optional ankle/hip load. logVariant is an axis alongside the
    // single logging mode (logWeight). Held position — maintain.
    loggable: true,
    type: "S",
    sets: 3,
    reps: "8–12 sec",
    logVariant: true,
    variants: ["Knee-supported", "Mid-shin", "Ankle-supported"],
    logWeight: true,
    progressionPolicy: "maintain",
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
    // Loggable with band color instead of numeric weight (logBand).
    // Reps are per-side ("3 × 6 / side") — we treat each side as a
    // separate row by reusing the unilateral pattern.
    loggable: true,
    type: "P",
    sets: 3,
    reps: "6",
    logBand: true,
    unilateral: true,
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
    // Lattice "Vacuum Style" with Aidan Roberts — same video covers
    // pancake + pancake leg lifts (different timestamps). Jumps to
    // the Frog chapter (1:17 / 77s) where Aidan demos the supine
    // variation specifically.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw&t=77s",
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
    // Jumps to the Weighted Pancake chapter (3:06 / 186s) of the
    // Lattice video — Aidan walks through tempo, regressions, and
    // the standing-against-wall variation.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw&t=186s",
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
    // Jumps to the Leg Lift chapter (6:48 / 408s) of the Lattice
    // video — Aidan demos heel-over-block from pancake position,
    // and explains the flexibility-before-mobility-strength order.
    videoUrl: "https://www.youtube.com/watch?v=UYsvnlpSLdw&t=408s",
  },
};

// ───────────────────────────────────────────────────────
// Workouts
// ───────────────────────────────────────────────────────
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
    // Press slot is dips (weighted) after the June 2026 dip⇄bench swap —
    // bench's barbell was blocking the pull-up bar on this same day.
    // Leg slot is the heel-hook iso pull (replaced the split squat):
    // the user hikes fine with a pack, so the need is heel-hook
    // hamstring power, not general squatting.
    //
    // Prone external rotation moved to C June 2026: rotator-cuff health
    // rewards frequency, and C is the frequent low-fatigue day — a
    // better home than A's once-a-week slot.
    //
    // Bicep curls moved to B July 2026 (reverses the June "curls live on
    // A" call). A already stacks weighted pull-ups + dips + banded lat
    // pull, so the elbow flexors are pre-fatigued before the curl even
    // starts — the curl got the day's lowest-quality reps AND piled
    // isolation volume onto the heaviest session, making it the first
    // thing skipped ("leave strong, not crushed"). B trains it fresh, on
    // the most-reliably-completed day. See B below.
    exercises: [
      exercises.weightedPullup,
      exercises.dips,
      exercises.heelHookPull,
      exercises.bandedLatPull,
      exercises.hardStyleSitup,
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
    // KB snatch removed June 2026 (bell-jump infeasibility killed
    // adherence; def retained for history). The combined "jumps"
    // chooser became two first-class exercises so each gets logged.
    //
    // Banded core chop swapped out June 2026 (def retained for history).
    // Replaced by front lever + hanging leg raise: the chop's band
    // tension never matched on-wall demand, and the program lacked any
    // straight-arm body-tension or compression core work. Workout-level
    // tags stay ["power","explosive"] — per the convention above, "core"
    // is an EXERCISE-level tag, not a workout stimulus tag (cf. A, which
    // holds the hard-style situp without listing core at the workout
    // level).
    //
    // Box jump → vertical jump June 2026 (boxJump def retained for
    // history). The takeoff (triple extension) is the trainable quality
    // either way; box height is confounded by knee tuck, so a standing
    // vertical jump measures hip drive more honestly. broadJump keeps
    // the horizontal axis; verticalJump keeps the vertical axis.
    //
    // Hanging leg raise dropped June 2026 (def retained for history):
    // grip-limited (taxed already-cooked forearms) and pure flexion —
    // the least climbing-valuable core quality. Its anti-lateral-flexion
    // replacement (Copenhagen plank) went to the light C day instead.
    // B gains the TRX hamstring curl — the dynamic partner to A's
    // heel-hook iso pull, so heel-hook/hamstring work happens twice a
    // week. Front lever stays as B's tension piece.
    //
    // Bicep curls added July 2026 (moved off the over-stacked A day),
    // sequenced LAST so they can't blunt the explosive work. B stays a
    // power day at the workout-tag level — a lone isolation strength
    // piece no more changes B's stimulus than A's hard-style situp makes
    // A a core day, so tags stay ["power","explosive"]. The curl keeps
    // its default ladder (load-building) progression, so it is the one
    // progressing lift on B: the intended strength stimulus, parked on
    // the light, high-adherence day where the arms are fresh.
    exercises: [
      exercises.medBallThrows,
      exercises.broadJump,
      exercises.verticalJump,
      exercises.skaterBounds,
      exercises.frontLever,
      exercises.trxHamstringCurl,
      exercises.bicepCurls,
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
    name: "Workout C — Neural Strength Touch",
    purpose: "Brief low-fatigue strength exposure to maintain frequency.",
    // The "I can do this when tired" workout — pull + press + core
    // in ~15 min. Catches the post-outdoor-Monday case and the
    // broader "I'd skip A but this still happens" pattern.
    // Bench on C (light) and dips on A (heavy) — swapped June 2026:
    // bench's barbell blocked the pull-up bar when both lived on A,
    // slowing the session. C pulls horizontally (TRX row), so bench
    // here has no bar conflict.
    //
    // Was workouts.D before the May 2026 rename. Same content,
    // same fatigueClass, same tags — only the slot key changed
    // because the old C (Positional Capacity) graduated into the
    // STRETCH daily-habit pill below the picker.
    fatigueClass: "frequent",
    fatigueCost: 1,
    tags: ["strength", "neural"],
    // Per-workout policy overrides (June 2026): C shares these
    // definition OBJECTS with A, so a definition-level
    // progressionPolicy would wrongly freeze A's progression too.
    // The spread copies scope `maintain` to C's membership only —
    // exercise identity is by `id` everywhere downstream (history,
    // exDef indexes, the swap picker), so nothing relies on
    // referential identity between A's and C's copies. C is the
    // light-touch day: every weight-logged lift here holds sets and
    // load by design; progression lives on A.
    //
    // Pulling slot swapped June 2026: weighted pull-ups → TRX Row
    // (def carries its own maintain policy — only C uses it). All
    // the program's other pulling is vertical; the row adds the
    // horizontal scapular/mid-back balance.
    //
    // Copenhagen plank added June 2026 — the program's anti-lateral-
    // flexion + adductor gap, parked on the light day because it's
    // grip-free. C now covers two core axes (ab wheel = anti-extension,
    // Copenhagen = anti-lateral-flexion); it carries its own maintain
    // policy via the def. Drop the ab wheel if C runs long.
    //
    // Bicep curls dropped June 2026: the one-arm TRX row already loads
    // lats and biceps enough on the light day, so a dedicated curl was
    // redundant. Curls now live on B (moved off A July 2026).
    //
    // Prone external rotation moved here from A June 2026: low-load
    // rotator-cuff prehab belongs on the frequent day, not the weekly
    // one — cuff health is frequency-driven. C-only now, so a membership
    // maintain policy keeps it from set-laddering (load doesn't chase
    // on the light day).
    exercises: [
      exercises.trxRow,
      { ...exercises.benchPress, prescription: "2 × 5 · light",       progressionPolicy: "maintain" },
      // abWheel is circlesOnly (no load to ladder against), so it
      // needs no policy override.
      { ...exercises.abWheel,    prescription: "1–2 light sets optional" },
      exercises.copenhagenPlank,
      { ...exercises.proneExternalRotation, progressionPolicy: "maintain" },
    ],
    coachingNotes: [
      "This should feel like activation, not training.",
      "Leave fresher than you started.",
      "No fatigue chasing.",
    ],
  },

  STRETCH: {
    id: "STRETCH",
    shortName: "Stretch",
    name: "Daily Stretching",
    purpose: "Hip and forearm mobility — adaptation comes from frequency, not dose.",
    // Was Workout C (Positional Capacity) before the May 2026 rename.
    // Pulled out of the weekly picker because the literature on hip
    // and forearm mobility is clear: short, regular sessions drive
    // adaptation; dedicating one weekly slot is the wrong shape. The
    // exercises are unchanged — they now live behind a daily-habit
    // pill rendered below the A/B/C picker in WorkoutTab. The pill
    // toggles between done / not-done for today and logs a marker
    // session each time so history, streaks, and CSV export all keep
    // working through the existing workout_sessions schema.
    fatigueClass: "frequent",
    fatigueCost: 0,
    // Same tag set as old C. computeTagDaysSince still feeds these
    // into the recommender's tag-staleness map, but the recommender
    // no longer has a mobility-stale → recommend-this rule (the
    // staleness now drives the pill's color state instead). Keeping
    // the tags here lets future surfaces — analytics, end-of-week
    // briefings — read "days since mobility" without special-casing.
    tags: ["mobility", "positionalCapacity", "restoration"],
    exercises: [
      exercises.supineWeightedFrog,
      exercises.weightedPancake,
      exercises.pancakeLegLifts,
    ],
    coachingNotes: [
      "Short and regular beats long and rare.",
      "Hip access for steep climbing positions.",
      "Leave loose, not exhausted.",
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

// ───────────────────────────────────────────────────────
// Recommender
// ───────────────────────────────────────────────────────
// Decision logic (first match wins):
//
//   1. A is overdue (≥7 days)
//      → A. The week's strength reservation.
//   2. Power / explosive stale (≥10 days)
//      → B.
//   3. Strength touch stale (C ≥4 days)
//      → C.
//   4. Fallback
//      → C (the low-fatigue default — brief, doesn't bury you).
//
// Neither CLIMB nor REST is ever recommended by this engine.
// CLIMB is logged via the climbing activities flow; REST is just
// "don't open the app today." The user knows when they need to
// rest without the engine prompting. A future deload-week
// recommender could re-introduce structured rest at a higher
// level (weeks, not days).
//
// May 2026 rewrite — round-robin model:
//   The earlier engine was frequency-based: A treated as the week's
//   strength slot (≥7-day staleness), B as power refresh (≥10-day
//   staleness on power/explosive tags), C as the 4-day strength
//   touch-up. Each branch had its own clock. That sounded principled
//   but in practice the clocks didn't align with how the user
//   actually trained: after an A + B in a single week, the engine
//   would re-recommend A on day 8 because the A clock had elapsed,
//   even though the user clearly wanted C next.
//
//   The new model is dead-simple A → B → C → A rotation: whichever
//   letter was logged most recently, the next one in the cycle is
//   what gets recommended. No frequency clocks, no tag staleness,
//   no separate budget per letter. Users who skip a session in the
//   cycle just resume from where they left off — if they did A and
//   B this week but didn't make it to C, next session is C; if they
//   did A, B, C, A in a single week, next week starts with B.
//
//   STRETCH and REST never count toward rotation advancement —
//   STRETCH is a daily habit the user toggles directly, and REST
//   is an explicit "no workout" marker. The engine still won't ever
//   *recommend* STRETCH or REST.
//
// What happened to the old "energyLow" rule (A overdue + low
// energy → C with caution)? Retired May 2026. The toggle was
// theoretical: if the user is wiped enough to want a lighter
// workout, they're wiped enough to skip the app entirely; if
// they want C instead of A on any given day, the picker override
// is one tap. The toggle didn't capture history either — it
// auto-cleared at midnight — so it wasn't doing data work.
//
// What happened to the old hip/positional-capacity rule? Retired
// when the dedicated mobility session moved out of the picker
// rotation into the daily-stretching pill (May 2026). Mobility
// staleness still surfaces visually on the pill itself — gray
// default, yellow at 3–5 days, orange at 6+ — instead of elbowing
// a weekly workout slot.

// Rotation order. The recommender returns the letter that comes
// AFTER the most-recently-logged one in this list, wrapping back
// to the start at the end.
const ROTATION = ["A", "B", "C"];

/**
 * Recommend the next support-training session via A → B → C
 * round-robin advancement.
 *
 * Finds the most recent A/B/C session in `workoutHistory` (by date,
 * with completedAt + array-order tiebreaks for same-day workouts)
 * and returns the next letter in the cycle. Sessions that aren't
 * in the rotation (STRETCH, REST, climbing, anything unknown) are
 * ignored entirely — they don't advance the rotation pointer and
 * they don't reset it.
 *
 * @param {Array<{id:string, workoutId?:string, workout?:string, date:string, completedAt?:string}>} workoutHistory
 *   Completed support sessions. Accepts either `workoutId` (modern)
 *   or `workout` (legacy/cloud-mirror); see sessionWorkoutKey.
 * @param {Object} [opts]
 * @param {string} [opts.refDate]  ISO date for testing. Defaults to today().
 *
 * @returns {{
 *   primary: object, reason: string,
 *   alternatives: object[]
 * }}
 */
// eslint-disable-next-line no-unused-vars
export function recommendNextWorkout(workoutHistory = [], opts = {}) {
  // refDate is no longer used internally (no day-budget math), but
  // we keep the option signature so older callers and tests don't
  // need to change their call sites.

  // Walk the history once and pick the latest A/B/C session. Tiebreaks:
  //   1. Later `date` wins.
  //   2. Within a day, later `completedAt` wins (sessions logged in
  //      the same day still resolve to the one finished most recently).
  //   3. Same date + same/missing completedAt → later array index wins
  //      (the log grows append-only locally, so later index == later log).
  let latest = null;
  let latestIdx = -1;
  for (let i = 0; i < (workoutHistory || []).length; i++) {
    const s = workoutHistory[i];
    const key = sessionWorkoutKey(s);
    if (!ROTATION.includes(key) || !s.date) continue;
    const isLater =
      !latest
      || s.date > latest.date
      || (s.date === latest.date && (s.completedAt || "") > (latest.completedAt || ""))
      || (s.date === latest.date && (s.completedAt || "") === (latest.completedAt || "") && i > latestIdx);
    if (isLater) {
      latest = s;
      latestIdx = i;
    }
  }

  // No A/B/C on record yet → seed the rotation at A.
  if (!latest) {
    return {
      primary: workouts.A,
      reason: "No A/B/C on record yet. Start the rotation with A.",
      alternatives: [workouts.B, workouts.C],
    };
  }

  const lastKey = sessionWorkoutKey(latest);
  const nextKey = ROTATION[(ROTATION.indexOf(lastKey) + 1) % ROTATION.length];

  return {
    primary: workouts[nextKey],
    reason: `Last support workout was ${lastKey} — next in the rotation is ${nextKey}.`,
    alternatives: ROTATION
      .filter(k => k !== nextKey)
      .map(k => workouts[k]),
  };
}

// ───────────────────────────────────────────────────────
// Helpers (exported for unit testing)
// ───────────────────────────────────────────────────────

// Whole days between two ISO date strings. Positive when `bISO` is
// later. Floored — partial days don't count.
export function daysBetween(aISO, bISO) {
  if (!aISO || !bISO) return NaN;
  const a = new Date(aISO).getTime();
  const b = new Date(bISO).getTime();
  if (!Number.isFinite(a) || !Number.isFinite(b)) return NaN;
  return Math.floor((b - a) / (1000 * 60 * 60 * 24));
}

// Read the canonical workout key from a session. Modern sessions
// stamp `workoutId`; legacy and cloud-pulled-before-mirror sessions
// only have `workout`. Accept either so a missing field from any
// older client version doesn't render a real A/B/C session invisible
// to the recommender. Returns null when neither is set so the caller
// can skip the entry cleanly.
function sessionWorkoutKey(s) {
  if (!s) return null;
  return s.workoutId || s.workout || null;
}

// Days since the most recent session of a given workout type.
// Returns Infinity when no such session exists (so "never" reads
// as "infinitely stale" in numeric comparisons).
export function daysSinceLastOfType(history, workoutId, refDate) {
  const matches = (history || []).filter(s => sessionWorkoutKey(s) === workoutId);
  if (matches.length === 0) return Infinity;
  const latest = matches.reduce((mx, s) => (s.date > mx ? s.date : mx), "");
  if (!latest) return Infinity;
  const d = daysBetween(latest, refDate);
  return Number.isFinite(d) ? d : Infinity;
}

// Map { tag → minimum days since any session producing that tag }.
// Workout sessions contribute their template's `tags`. Future-dated
// rows are ignored. Tags that never appear are absent — callers use
// `tagDays[tag] ?? Infinity`.
export function computeTagDaysSince(workoutHistory, refDate) {
  const tagDays = {};
  const bump = (tag, d) => {
    if (d < 0) return;
    if (tagDays[tag] == null || d < tagDays[tag]) tagDays[tag] = d;
  };

  for (const s of (workoutHistory || [])) {
    const wo = workouts[sessionWorkoutKey(s)];
    if (!wo || !wo.tags) continue;
    const d = daysBetween(s.date, refDate);
    if (!Number.isFinite(d)) continue;
    for (const tag of wo.tags) bump(tag, d);
  }

  return tagDays;
}

// ───────────────────────────────────────────────────────
// Integration sketch
// ───────────────────────────────────────────────────────
//
//   import { recommendNextWorkout, workouts } from "../model/supportTraining.js";
//
//   // wLog: existing workout-session log. New entries should carry
//   //   `workoutId: "A" | "B" | "C" | "STRETCH"` so this recommender
//   //   can read them. Older entries with the legacy `workout` field
//   //   are invisible to the recommender — that's fine for a soft
//   //   migration, the system just starts learning from new sessions.
//
//   const rec = recommendNextWorkout(wLog, { refDate: today() });
//
//   // Render:
//   //   rec.primary       — the recommended workout template
//   //   rec.reason        — one-line explanation
//   //   rec.caution?      — optional yellow-flag note
//   //   rec.alternatives  — array of fallback templates the user can tap
