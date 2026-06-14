// ─────────────────────────────────────────────────────────────
// CLIMBING TRAINING LIBRARY — SEED DATA (proposal)
// ─────────────────────────────────────────────────────────────
// Machine-readable companion to docs/research/climbing-training-library.md.
// Shaped to drop toward the app's existing `exercises` map in
// src/model/supportTraining.js, EXTENDED with two fields from the
// design doc (docs/design/exercise-library-and-balance-engine.md):
//
//   climbingQualities: [{ category, axis }]   // the balance-engine taxonomy
//   equipment:         [string]               // gym-agnostic kit tags
//
// This is a SEED, not wired-in app data: it intentionally omits the
// logging fields (loggable/type/sets/reps/logWeight/...) since those
// are a per-deployment decision. Add them when promoting an entry
// into supportTraining.js. Skills live in a parallel `climbingSkills`
// map, the basis for a future src/model/climbingSkills.js.
//
// Sources & coaching notes: see docs/research/climbing-training-library.md.

// ── Taxonomy ────────────────────────────────────────────────
export const STRENGTH_AXES = {
  pull:           ["vertical", "horizontal", "lockOff", "oneArm", "scapular"],
  press:          ["horizontal", "vertical", "dips"],
  shoulderPrehab: ["externalRotation", "internalRotation", "scapular", "scaption"],
  elbowForearm:   ["extensor", "flexor", "pronator", "fingerExtensor", "tendonHealth"],
  core:           ["antiExtension", "antiRotation", "flexion", "compression", "rotation", "fullBodyTension"],
  lower:          ["hinge", "bilateral", "unilateral", "lateral"],
  hamstring:      ["eccentric", "kneeFlexion"],
  hipMobility:    ["flexion", "rotation", "adduction", "endRangeStrength"],
  power:          ["verticalProjection", "horizontalProjection", "lateralPlane", "rotational", "contactStrength", "fingerRFD"],
};

export const SKILL_DIMENSIONS = [
  "footwork", "bodyPositioning", "movement", "technique",
  "grip", "crack", "angle", "drill", "energySystem", "tactics", "mental",
];

export const EQUIPMENT = [
  "bodyweight", "pullUpBar", "barbell", "dumbbell", "kettlebell", "band",
  "trx", "rings", "cable", "medBall", "box", "bench", "abWheel",
  "parallettes", "hangboard", "campusBoard", "wall",
];

// helper
const q = (category, axis) => ({ category, axis });

// ── Strength & physique ─────────────────────────────────────
export const strengthLibrary = {
  // Pull — vertical
  pullUp: { id: "pullUp", name: "Pull-Up (full range)", equipment: ["pullUpBar"], tags: ["strength", "neural"], climbingQualities: [q("pull", "vertical")], cue: "Shoulders engaged; don't fully dead-hang between reps.", progression: "Build ~15 clean reps before loading." },
  weightedPullUp: { id: "weightedPullUp", name: "Weighted / Hypergravity Pull-Up", equipment: ["pullUpBar"], tags: ["strength", "neural"], climbingQualities: [q("pull", "vertical")], cue: "Start +10–20 lb; drop weight at any shoulder/elbow tweak.", progression: "5×5; add load when all sets clean.", caution: "Build base pull-up volume first." },
  latPulldown: { id: "latPulldown", name: "Lat Pulldown", equipment: ["cable"], tags: ["strength"], climbingQualities: [q("pull", "vertical")], cue: "Drive elbows toward the hips, chest tall.", progression: "Sub-bodyweight entry; graduate to weighted pull-ups." },
  explosivePullUp: { id: "explosivePullUp", name: "Chest-Bump / Explosive Pull-Up", equipment: ["pullUpBar"], tags: ["power", "neural"], climbingQualities: [q("pull", "vertical"), q("power", "contactStrength")], cue: "Pull fast to chest; absorb the descent.", progression: "Only after base strength." },

  // Pull — horizontal
  bentOverRow: { id: "bentOverRow", name: "Bent-Over Row", equipment: ["barbell", "dumbbell"], tags: ["strength", "shoulder"], climbingQualities: [q("pull", "horizontal")], cue: "Flat back, elbow to hip, squeeze blades.", progression: "Load progressively; balances bench volume." },
  invertedRow: { id: "invertedRow", name: "Inverted Row", equipment: ["pullUpBar"], tags: ["strength", "shoulder"], climbingQualities: [q("pull", "horizontal"), q("pull", "scapular")], cue: "Straight body line; shoulders back-and-down.", progression: "Lower bar / elevate feet." },
  trxRow: { id: "trxRow", name: "TRX / Ring Row", equipment: ["trx", "rings"], tags: ["strength", "shoulder"], climbingQualities: [q("pull", "horizontal"), q("pull", "scapular")], cue: "Palms in, elbows straight back, body rigid.", progression: "Walk feet toward anchor; rings add instability." },
  bandedRow: { id: "bandedRow", name: "Banded Row", equipment: ["band"], tags: ["strength", "shoulder"], climbingQualities: [q("pull", "horizontal")], cue: "Elbows back, squeeze blades, no shrug.", progression: "Stiffer band or single-arm (anti-rotation)." },

  // Pull — lock-off
  lockOffHold: { id: "lockOffHold", name: "90°/120° Lock-Off Hold", equipment: ["pullUpBar"], tags: ["strength", "neural"], climbingQualities: [q("pull", "lockOff")], cue: "Hold dead-still, no sag.", progression: "Add time, then weight; train your weak angle." },
  frenchies: { id: "frenchies", name: "Frenchies", equipment: ["pullUpBar"], tags: ["strength"], climbingQualities: [q("pull", "lockOff")], cue: "Per cycle: lock 4s top, 4s 90°, 4s 120°, no dead-hang.", progression: "Chain cycles/sets." },
  typewriters: { id: "typewriters", name: "Typewriters", equipment: ["pullUpBar"], tags: ["strength"], climbingQualities: [q("pull", "lockOff")], cue: "Shift weight under one arm, hold 3–5s, traverse.", progression: "Lower angle, more reps." },

  // Pull — one-arm progression
  offsetPullUp: { id: "offsetPullUp", name: "Uneven / Offset-Grip Pull-Up", equipment: ["pullUpBar", "band"], tags: ["strength", "neural"], climbingQualities: [q("pull", "oneArm")], cue: "High hand loads; low hand only assists past its height.", progression: "Increase offset once 5–6 clean/side." },
  archerPullUp: { id: "archerPullUp", name: "Archer Pull-Up", equipment: ["pullUpBar"], tags: ["strength", "neural"], climbingQualities: [q("pull", "oneArm")], cue: "Pull to one hand, other arm straight as a kickstand.", progression: "Move to offset-grip on the bar." },
  bandAssistedOneArm: { id: "bandAssistedOneArm", name: "Band-Assisted One-Arm Pull-Up", equipment: ["pullUpBar", "band"], tags: ["strength", "neural"], climbingQualities: [q("pull", "oneArm")], cue: "Thickest band that makes ~5 hard.", progression: "Thinner bands → 4×3 near max." },
  oneArmNegative: { id: "oneArmNegative", name: "One-Arm Negative", equipment: ["pullUpBar"], tags: ["strength", "neural"], climbingQualities: [q("pull", "oneArm")], cue: "Start at top lock-off, lower as slowly as possible.", progression: "Lengthen lower, reduce assist." },

  // Pull — scapular
  scapularPullUp: { id: "scapularPullUp", name: "Scapular Pull-Up / Shrug Hang", equipment: ["pullUpBar"], tags: ["shoulder", "connective"], climbingQualities: [q("pull", "scapular"), q("shoulderPrehab", "scapular")], cue: "Depress + retract blades, no elbow bend.", progression: "Two-arm → one-arm scapular shrugs." },

  // Press / antagonist
  pushUp: { id: "pushUp", name: "Push-Up (+ variations)", equipment: ["bodyweight"], tags: ["strength", "shoulder"], climbingQualities: [q("press", "horizontal")], cue: "Elbows tucked, shoulders from ears, rigid core.", progression: "Weighted / decline / ring." },
  benchPress: { id: "benchPress", name: "Bench Press", equipment: ["barbell", "dumbbell", "bench"], tags: ["strength", "shoulder"], climbingQualities: [q("press", "horizontal")], cue: "Blades retracted and set, controlled bar path.", progression: "Load toward ~bodyweight (Bechtel benchmark)." },
  overheadPress: { id: "overheadPress", name: "Overhead / Shoulder Press", equipment: ["barbell", "dumbbell"], tags: ["strength", "shoulder"], climbingQualities: [q("press", "vertical")], cue: "Brace, ribs down, straight bar path.", progression: "DB → barbell." },
  kbPress: { id: "kbPress", name: "Kettlebell Press / Overhead Carry", equipment: ["kettlebell"], tags: ["strength", "shoulder"], climbingQualities: [q("press", "vertical")], cue: "Wrist stacked, core engaged.", progression: "Single-arm → bottoms-up." },
  dips: { id: "dips", name: "Dips", equipment: ["parallettes"], tags: ["strength", "shoulder", "connective"], climbingQualities: [q("press", "dips")], cue: "Shoulders down, don't sink too deep.", progression: "After bench/OHP; add weight." },
  bandedPress: { id: "bandedPress", name: "Banded Press / Push-Up", equipment: ["band"], tags: ["strength", "shoulder"], climbingQualities: [q("press", "horizontal")], cue: "Brace, full lockout, ribs down.", progression: "More tension." },

  // Shoulder prehab
  externalRotation: { id: "externalRotation", name: "Band/Cable External Rotation", equipment: ["band", "cable"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "externalRotation")], cue: "Elbow pinned (towel); rotate from the elbow.", progression: "15–20 light → add resistance." },
  sideLyingExternalRotation: { id: "sideLyingExternalRotation", name: "Side-Lying External Rotation", equipment: ["dumbbell"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "externalRotation")], cue: "Elbow tucked; rotate only at the shoulder.", progression: "Stay light; cuff fatigues fast." },
  internalRotation: { id: "internalRotation", name: "Lying Internal Rotation", equipment: ["dumbbell", "band"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "internalRotation")], cue: "Slow, short range — for balance not bulk.", progression: "~20 light." },
  proneT: { id: "proneT", name: "Reverse Fly / Prone T", equipment: ["dumbbell"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "scapular")], cue: "Thumbs up, squeeze blades, no shrug.", progression: "Bent-over → prone → light DB." },
  proneY: { id: "proneY", name: "Prone Y Raise", equipment: ["dumbbell"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "scapular")], cue: "Form a Y, thumbs up, lift from blades.", progression: "Bodyweight → light plates." },
  proneW: { id: "proneW", name: "Prone W Raise", equipment: ["dumbbell"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "scapular"), q("shoulderPrehab", "externalRotation")], cue: "Elbows down-and-back into a W.", progression: "Hold end range, add load." },
  scaption: { id: "scaption", name: "Scaption", equipment: ["dumbbell"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "scaption")], cue: "~30° forward of side, thumbs up, stop at shoulder height.", progression: "15–20 light." },
  facePull: { id: "facePull", name: "Face Pull", equipment: ["cable", "band"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "externalRotation"), q("shoulderPrehab", "scapular")], cue: "Pull to forehead, elbows high, finish externally rotated.", progression: "Raise anchor to bias cuff." },
  bandPullApart: { id: "bandPullApart", name: "Band Pull-Apart", equipment: ["band"], tags: ["shoulder"], climbingQualities: [q("shoulderPrehab", "scapular")], cue: "Straight arms, lead with thumbs, no shrug.", progression: "Stiffer band / pause holds." },

  // Elbow & forearm
  reverseWristCurl: { id: "reverseWristCurl", name: "Reverse Wrist Curl (Extension)", equipment: ["dumbbell"], tags: ["connective"], climbingQualities: [q("elbowForearm", "extensor")], cue: "Palm-down, slow eccentric.", progression: "Light, 15–20, slow lower." },
  reverseArmCurl: { id: "reverseArmCurl", name: "Reverse (Pronated) Arm Curl", equipment: ["barbell", "dumbbell"], tags: ["connective"], climbingQualities: [q("elbowForearm", "extensor")], cue: "Palms-down, control both phases.", progression: "Build load; pairs with reverse wrist curl." },
  pronatorTwist: { id: "pronatorTwist", name: "Pronator (Offset Hammer) Twist", equipment: ["dumbbell"], tags: ["connective"], climbingQualities: [q("elbowForearm", "pronator")], cue: "Forearm on thigh, rotate hammer up, lower over 5-count.", progression: "Eccentric-only → add concentric → longer lever.", caution: "Primary climber's-elbow (medial) exercise — rehab eccentric-first." },
  wristFlexorCurl: { id: "wristFlexorCurl", name: "Wrist Flexor Curl", equipment: ["dumbbell"], tags: ["connective"], climbingQualities: [q("elbowForearm", "flexor")], cue: "Palm-up, controlled.", progression: "Keep lighter — don't outpace extensor work." },
  fingerExtensor: { id: "fingerExtensor", name: "Finger-Extensor Band / Rice Bucket", equipment: ["band"], tags: ["connective"], climbingQualities: [q("elbowForearm", "fingerExtensor")], cue: "Open fingers against band, or open/close in rice.", progression: "Thicker band / longer sets." },
  densityLockOffHang: { id: "densityLockOffHang", name: "Neutral-Grip Density Lock-Off Hang", equipment: ["pullUpBar"], tags: ["connective"], climbingQualities: [q("elbowForearm", "tendonHealth")], cue: "Mid-range neutral hold 15–20s; dull, not sharp.", progression: "Add reps → light load.", caution: "Tendon-loading; back off on sharp pain." },

  // Core — anti-extension
  abWheel: { id: "abWheel", name: "Ab-Wheel Rollout", equipment: ["abWheel"], tags: ["core"], climbingQualities: [q("core", "antiExtension")], cue: "Brace, posterior tilt, no sag.", progression: "Knees → standing." },
  plank: { id: "plank", name: "Plank (Hard Brace)", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "antiExtension")], cue: "Short max-tension effort; glutes+abs, ribs down.", progression: "Banded → weighted." },
  trxFallout: { id: "trxFallout", name: "TRX / Ring Fallout", equipment: ["trx", "rings"], tags: ["core"], climbingQualities: [q("core", "antiExtension")], cue: "Arms overhead, torso rigid, stop before arch.", progression: "More horizontal." },
  deadBug: { id: "deadBug", name: "Dead Bug", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "antiExtension")], cue: "Low back flat; move opposite limbs slowly.", progression: "Add band / longer levers." },

  // Core — anti-rotation
  pallofPress: { id: "pallofPress", name: "Pallof Press", equipment: ["cable", "band"], tags: ["core"], climbingQualities: [q("core", "antiRotation")], cue: "Press straight out, resist the twist, brace first.", progression: "Further from anchor / kneeling / hold." },
  bandChop: { id: "bandChop", name: "Cable / Band Chop & Lift", equipment: ["cable", "band"], tags: ["core"], climbingQualities: [q("core", "antiRotation")], cue: "Move diagonally, hips square.", progression: "Load / speed control." },
  suitcaseCarry: { id: "suitcaseCarry", name: "Suitcase Carry", equipment: ["dumbbell", "kettlebell"], tags: ["core"], climbingQualities: [q("core", "antiRotation")], cue: "One heavy load, walk tall, no lean.", progression: "Heavier / longer / march." },
  birdDogRow: { id: "birdDogRow", name: "Bird-Dog Row", equipment: ["dumbbell"], tags: ["core"], climbingQualities: [q("core", "antiRotation")], cue: "Row without twisting the torso.", progression: "Slow eccentric, add load." },

  // Core — flexion
  hangingLegRaise: { id: "hangingLegRaise", name: "Hanging Leg Raise", equipment: ["pullUpBar"], tags: ["core"], climbingQualities: [q("core", "flexion")], cue: "Curl the pelvis; control the lower.", progression: "Knees → straight-leg → ankle weight." },
  hardStyleSitup: { id: "hardStyleSitup", name: "Hard-Style / RKC Sit-Up", equipment: ["band", "bodyweight"], tags: ["core"], climbingQualities: [q("core", "flexion"), q("core", "fullBodyTension")], cue: "Drive heels, total tension, low reps.", progression: "Weighted." },
  hollowRock: { id: "hollowRock", name: "Hollow-Body Rock", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "flexion"), q("core", "fullBodyTension")], cue: "Ribs down, low back glued.", progression: "Tuck → full → weighted." },

  // Core — compression
  vUp: { id: "vUp", name: "V-Up", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "compression")], cue: "Reach to toes, straight legs, fold at hips.", progression: "Tuck → full → decline." },
  toesToBar: { id: "toesToBar", name: "Toes-to-Bar", equipment: ["pullUpBar"], tags: ["core"], climbingQualities: [q("core", "compression")], cue: "Pull the bar toward the hips, no kip.", progression: "Knees-to-chest → toes-to-bar → strict." },
  seatedPikeCompression: { id: "seatedPikeCompression", name: "Seated Pike Compression Hold", equipment: ["bodyweight", "box"], tags: ["core"], climbingQualities: [q("core", "compression")], cue: "Legs straight, actively lift heels and hold.", progression: "Floor → deficit box → ankle weight." },
  candlestick: { id: "candlestick", name: "Candlestick → Pike", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "compression")], cue: "Roll up, fold to a tight pike, control phases.", progression: "Assisted → freestanding." },

  // Core — rotation
  russianTwist: { id: "russianTwist", name: "Russian Twist", equipment: ["medBall", "dumbbell"], tags: ["core"], climbingQualities: [q("core", "rotation")], cue: "Rotate from the trunk, chest tall, controlled.", progression: "Feet down → feet up → weighted." },
  windshieldWiper: { id: "windshieldWiper", name: "Windshield Wiper", equipment: ["pullUpBar", "bodyweight"], tags: ["core"], climbingQualities: [q("core", "rotation"), q("core", "compression")], cue: "Legs together, shoulders stable, sweep side to side.", progression: "Bent-knee lying → straight-leg → hanging.", caution: "Advanced; demands lumbar control." },
  landmineRotation: { id: "landmineRotation", name: "Landmine Rotation", equipment: ["barbell"], tags: ["core"], climbingQualities: [q("core", "rotation")], cue: "Drive from hips/core, arms fairly straight.", progression: "Half-kneeling → standing → add speed." },

  // Core — full-body tension
  frontLever: { id: "frontLever", name: "Front Lever", equipment: ["pullUpBar", "rings"], tags: ["core", "shoulder", "connective"], climbingQualities: [q("core", "fullBodyTension"), q("core", "antiExtension")], cue: "Straight arms 'push bar down', posterior tilt, squeeze legs.", progression: "Tuck → adv tuck → single-leg/straddle → full.", caution: "Can stress elbows/shoulders; progress slowly." },
  dragonFlag: { id: "dragonFlag", name: "Dragon Flag", equipment: ["bench"], tags: ["core"], climbingQualities: [q("core", "fullBodyTension"), q("core", "antiExtension")], cue: "Pivot from upper back, body rigid as a rod, lower slow.", progression: "Tuck → straddle → full." },
  hollowHold: { id: "hollowHold", name: "Hollow-Body Hold", equipment: ["bodyweight"], tags: ["core"], climbingQualities: [q("core", "fullBodyTension")], cue: "Ribs down, low back flat, limbs squeezing.", progression: "Tuck → full → add time/weight." },
  lSit: { id: "lSit", name: "L-Sit", equipment: ["parallettes", "bodyweight"], tags: ["core"], climbingQualities: [q("core", "fullBodyTension"), q("core", "compression")], cue: "Depress shoulders, lock knees, lift to horizontal.", progression: "Foot-supported → tuck → full → V-sit." },
  tensionBoardDrill: { id: "tensionBoardDrill", name: "Steep-Wall Body-Tension Drill", equipment: ["wall"], tags: ["core"], climbingQualities: [q("core", "fullBodyTension")], cue: "Drive toes in, brace trunk so hips don't sag.", progression: "Bigger → smaller feet, steeper angle." },

  // Lower — hinge
  deadlift: { id: "deadlift", name: "Conventional Deadlift", equipment: ["barbell"], tags: ["strength"], climbingQualities: [q("lower", "hinge"), q("core", "fullBodyTension")], cue: "Hips above knees, brace hard.", progression: "Light technique → heavy 3–5s." },
  rdl: { id: "rdl", name: "Romanian Deadlift", equipment: ["barbell", "dumbbell"], tags: ["strength", "hamstring"], climbingQualities: [q("lower", "hinge"), q("hamstring", "eccentric")], cue: "Hips back, soft knee, stop before back rounds.", progression: "Load → single-leg." },
  kbSwing: { id: "kbSwing", name: "Kettlebell Swing", equipment: ["kettlebell"], tags: ["power", "explosive"], climbingQualities: [q("lower", "hinge"), q("power", "verticalProjection")], cue: "Snap hips; bell floats; no squat/arm-lift.", progression: "Two-hand → one-hand → heavier." },
  hipThrust: { id: "hipThrust", name: "Hip Thrust / Glute Bridge", equipment: ["barbell", "bodyweight"], tags: ["strength"], climbingQualities: [q("lower", "hinge")], cue: "Drive heels, hard glute squeeze, ribs down.", progression: "Bodyweight → barbell → single-leg." },
  backExtension: { id: "backExtension", name: "Back Extension / Reverse Hyper", equipment: ["bench"], tags: ["strength"], climbingQualities: [q("lower", "hinge")], cue: "Lift to neutral; don't hyperextend.", progression: "Add load / pause." },

  // Lower — squat & unilateral
  squat: { id: "squat", name: "Goblet / Back Squat", equipment: ["kettlebell", "barbell"], tags: ["strength"], climbingQualities: [q("lower", "bilateral")], cue: "Knees over toes, brace, controlled depth.", progression: "Goblet → barbell." },
  splitSquat: { id: "splitSquat", name: "Rear-Foot-Elevated Split Squat", equipment: ["dumbbell", "barbell"], tags: ["strength", "hip"], climbingQualities: [q("lower", "unilateral")], cue: "Front shin loaded, torso tall.", progression: "Load → bottom pause." },
  stepUp: { id: "stepUp", name: "Step-Up (High Box)", equipment: ["box", "dumbbell"], tags: ["strength", "hip"], climbingQualities: [q("lower", "unilateral"), q("hipMobility", "flexion")], cue: "Drive only through the top leg.", progression: "Raise box, add load." },
  cossackSquat: { id: "cossackSquat", name: "Cossack Squat", equipment: ["bodyweight", "kettlebell"], tags: ["strength", "hip"], climbingQualities: [q("lower", "lateral"), q("hipMobility", "adduction")], cue: "Sit over bent leg, other straight, heels down.", progression: "Supported → unsupported → weighted." },
  highStepTrx: { id: "highStepTrx", name: "High-Step on Box with TRX", equipment: ["box", "trx"], tags: ["strength", "hip"], climbingQualities: [q("lower", "unilateral"), q("hipMobility", "endRangeStrength")], cue: "Step on toes while pulling arms; less pull = harder.", progression: "Raise box / reduce assist." },

  // Hamstring
  nordicCurl: { id: "nordicCurl", name: "Nordic Hamstring Curl", equipment: ["bodyweight"], tags: ["hamstring"], climbingQualities: [q("hamstring", "eccentric")], cue: "Lower as slowly as possible.", progression: "Assisted/short range → full over 6–10 wks." },
  trxLegCurl: { id: "trxLegCurl", name: "TRX / Swiss-Ball Leg Curl", equipment: ["trx"], tags: ["hamstring"], climbingQualities: [q("hamstring", "kneeFlexion")], cue: "Hips lifted in a bridge throughout.", progression: "Two-leg → single-leg." },
  singleLegRdl: { id: "singleLegRdl", name: "Single-Leg RDL", equipment: ["dumbbell", "kettlebell"], tags: ["hamstring", "hip"], climbingQualities: [q("hamstring", "eccentric"), q("lower", "unilateral")], cue: "Hinge over stance leg, hips square.", progression: "Add load/range." },

  // Hip mobility & end-range
  hipCars: { id: "hipCars", name: "Hip CARs", equipment: ["bodyweight"], tags: ["mobility", "hip"], climbingQualities: [q("hipMobility", "rotation")], cue: "March → open → drop-knee → extend; pelvis neutral.", progression: "Widen the circle." },
  frogStretch: { id: "frogStretch", name: "Frog Stretch", equipment: ["bodyweight"], tags: ["mobility", "hip"], climbingQualities: [q("hipMobility", "flexion"), q("hipMobility", "adduction")], cue: "Shins parallel, rock hips back.", progression: "Toward pelvis-to-floor." },
  pancake: { id: "pancake", name: "Pancake / Seated Straddle", equipment: ["bodyweight"], tags: ["mobility", "hip", "hamstring"], climbingQualities: [q("hipMobility", "adduction"), q("hipMobility", "endRangeStrength")], cue: "Hinge from hips, long spine.", progression: "Active reaches / loaded end-range." },
  ninetyNinety: { id: "ninetyNinety", name: "90/90 (+ Heel Lift)", equipment: ["bodyweight"], tags: ["mobility", "hip"], climbingQualities: [q("hipMobility", "rotation"), q("hipMobility", "endRangeStrength")], cue: "Off the tailbone; back knee down, lift heel.", progression: "Passive → active heel lifts → transitions." },
  deepSquatSit: { id: "deepSquatSit", name: "Deep Squat (Active Sit)", equipment: ["bodyweight", "kettlebell"], tags: ["mobility", "hip"], climbingQualities: [q("hipMobility", "flexion"), q("hipMobility", "endRangeStrength")], cue: "Heels down, chest up, pry knees out.", progression: "Add load/time." },
  eccentricAdductor: { id: "eccentricAdductor", name: "Cossack / Eccentric Adductor", equipment: ["bodyweight", "cable"], tags: ["mobility", "hip"], climbingQualities: [q("hipMobility", "adduction"), q("hipMobility", "endRangeStrength")], cue: "Shift in/out over a step; resist as adductor lengthens.", progression: "Add resistance/range." },

  // Power / explosive
  broadJump: { id: "broadJump", name: "Broad Jump", equipment: ["bodyweight"], tags: ["power", "explosive"], climbingQualities: [q("power", "horizontalProjection")], cue: "Arm swing, explode through hips, land soft.", progression: "Distance / consecutive." },
  verticalJump: { id: "verticalJump", name: "Vertical / Box Jump", equipment: ["bodyweight", "box"], tags: ["power", "explosive"], climbingQualities: [q("power", "verticalProjection")], cue: "Arm swing; light quiet two-foot landing; step down.", progression: "Raise target; 3×3–5." },
  jumpLunge: { id: "jumpLunge", name: "Jump Lunge", equipment: ["bodyweight"], tags: ["power", "explosive"], climbingQualities: [q("power", "verticalProjection")], cue: "Explode, switch mid-air, max air time.", progression: "3×5–10/leg." },
  skaterJump: { id: "skaterJump", name: "Skater Jump / Bound", equipment: ["bodyweight"], tags: ["power", "explosive"], climbingQualities: [q("power", "lateralPlane")], cue: "Push laterally for distance, land one foot, use arms.", progression: "3×5–10/side, more distance." },
  medBallSlam: { id: "medBallSlam", name: "Med-Ball Slam", equipment: ["medBall"], tags: ["power", "explosive", "core"], climbingQualities: [q("power", "verticalProjection"), q("core", "fullBodyTension")], cue: "Reach tall, drive down whole-body.", progression: "Heavier / add jump." },
  medBallRotThrow: { id: "medBallRotThrow", name: "Med-Ball Rotational / Overhead Throw", equipment: ["medBall"], tags: ["power", "explosive", "core"], climbingQualities: [q("power", "rotational"), q("power", "contactStrength")], cue: "Sequence hips → trunk → arms.", progression: "Heavier / longer throw." },
  kbSnatch: { id: "kbSnatch", name: "Kettlebell Snatch", equipment: ["kettlebell"], tags: ["power", "explosive"], climbingQualities: [q("power", "verticalProjection")], cue: "One smooth pull; punch hand through at top.", progression: "Load for output." },
  powerPullUp: { id: "powerPullUp", name: "Power Pull-Up", equipment: ["pullUpBar"], tags: ["power", "explosive", "neural"], climbingQualities: [q("power", "contactStrength")], cue: "Pause 1s at bottom so each rep is its own explosion.", progression: "3×3–5; chest-to-bar / light weight." },
  clapPushUp: { id: "clapPushUp", name: "Power / Clap Push-Up", equipment: ["bodyweight"], tags: ["power", "explosive"], climbingQualities: [q("power", "contactStrength"), q("press", "horizontal")], cue: "Push the ground away hard; air time.", progression: "3×3–5; elevate / weight." },
  plyoMountainClimber: { id: "plyoMountainClimber", name: "Plyo Mountain Climbers", equipment: ["bodyweight"], tags: ["power", "core"], climbingQualities: [q("power", "lateralPlane"), q("core", "compression")], cue: "Drive knee off the ball of the foot; hips level.", progression: "3×10–20/leg, faster." },
  campusBoard: { id: "campusBoard", name: "Campus Board", equipment: ["campusBoard"], tags: ["power", "explosive", "finger"], climbingQualities: [q("power", "fingerRFD"), q("power", "contactStrength")], cue: "Precise + explosive, well within finger tolerance; never fatigued.", progression: "Short blocks, full recovery.", caution: "ADVANCED. Injury-free advanced fingers only; pulley + youth growth-plate (PIP) risk." },
};

// ── Climbing skills, techniques & drills ────────────────────
const s = (id, name, dimension, develops, howTo, extra = {}) =>
  ({ id, name, dimension, develops, howTo, ...extra });

export const climbingSkills = {
  // Footwork
  silentPlacement: s("silentPlacement", "Precise / Silent Placement", "footwork", "Efficiency, trust in feet", "Place the toe deliberately and silently, then weight it — no readjust."),
  insideEdge: s("insideEdge", "Edging — Inside Edge", "footwork", "Standing on small face holds", "Stiff ankle; stand on the spot under the big toe."),
  outsideEdge: s("outsideEdge", "Edging — Outside Edge", "footwork", "Backsteps & twists", "Stand on the outside corner under the little toe, ankle rigid."),
  smearing: s("smearing", "Smearing", "footwork", "Friction with no defined hold (slab)", "Max rubber on the wall, drop the heel, weight over the foot."),
  footSwap: s("footSwap", "Foot Swap", "footwork", "Setting up the next move", "Hop-swap or roll the toe off while sliding the other on precisely."),
  footBackstep: s("footBackstep", "Backstepping (foot)", "footwork", "Bringing a hip to the wall, saving arms", "Stand on the outside edge of the trailing foot, drop that knee."),
  toeingIn: s("toeingIn", "Toeing-In", "footwork", "Precision on tiny edges/pockets", "Point the toe into the hold so the big toe loads it."),
  heelDownUp: s("heelDownUp", "Heel-Down vs Heel-Up", "footwork", "Friction vs reach/leverage", "Drop the heel for smear; raise it to extend/push."),

  // Body positioning
  insideFlag: s("insideFlag", "Inside Flag", "bodyPositioning", "Prevents barn-door when reaching", "Swing the free foot across in front of the stance."),
  outsideFlag: s("outsideFlag", "Outside Flag", "bodyPositioning", "Most common balance flag", "Press the flagging foot out to the side, low and weighted."),
  backFlag: s("backFlag", "Back Flag", "bodyPositioning", "Stabilize on steep ground", "Tuck the trailing foot behind and smear it."),
  dropKnee: s("dropKnee", "Drop-Knee (Egyptian)", "bodyPositioning", "Pulls hips in, adds reach on steep, cuts arm load", "Stand wide, point a toe and drop that knee inward, twist hip in."),
  twistLock: s("twistLock", "Twist-Lock / Hip Turn", "bodyPositioning", "Straight reaching arm gains length", "Pivot the reaching-side hip into the wall and lock."),
  skeletonHang: s("skeletonHang", "Straight-Arm 'Skeleton' Hang", "bodyPositioning", "Resting on bones, not biceps", "Keep arms extended whenever not actively moving."),
  hipsClose: s("hipsClose", "Hips Close to the Wall", "bodyPositioning", "Weight onto feet, light grip", "Push the pelvis toward the rock."),
  cogOverFeet: s("cogOverFeet", "Center of Gravity Over Feet", "bodyPositioning", "Max friction, less hand load", "Stack the torso so weight drives through the standing foot."),

  // Movement
  staticMovement: s("staticMovement", "Static Movement", "movement", "Precise, reversible control", "Move slowly with weight set over feet."),
  dynamicMovement: s("dynamicMovement", "Dynamic Movement", "movement", "Momentum instead of pure strength", "Drive from the legs, catch as motion peaks."),
  lockOff: s("lockOff", "Lock-Off", "movement", "Hold still to free a hand", "Pull the holding arm to ~90°, engage the back, reach."),
  deadpoint: s("deadpoint", "Deadpoint", "movement", "Catch at the weightless apex", "Latch exactly when upward velocity hits zero."),
  dyno: s("dyno", "Dyno (Single)", "movement", "All-out jump to a far hold", "Pump legs/hips, launch, latch at the top."),
  doubleDyno: s("doubleDyno", "Double Dyno", "movement", "Both hands leave and catch together", "Coil low, explode, stick both with body tension."),
  coordination: s("coordination", "Coordination / Parkour Moves", "movement", "Linked momentum on steep/comp terrain", "Chain swings/jumps/catches in rhythm."),
  pendulum: s("pendulum", "Momentum & Pendulum", "movement", "Swing to reposition/reach", "Initiate from feet/hips, time the catch."),
  mantling: s("mantling", "Mantling", "movement", "Press onto a ledge with nothing above", "Push down on the palm, foot up high, rock over and stand."),
  rockOver: s("rockOver", "Rock-Over / High Step", "movement", "Step high, shift weight, stand", "Foot high, hips forward over it, stand with the leg."),
  downclimbing: s("downclimbing", "Downclimbing", "movement", "Descend/retreat; sharpens footwork", "Look for feet, arms straight, lower onto chosen holds."),

  // Specific techniques
  heelHook: s("heelHook", "Heel Hook", "technique", "Third 'hand' on steep/overhang", "Set the heel, pull with the hamstring to draw in."),
  toeHook: s("toeHook", "Toe Hook", "technique", "Resist swing on roofs/underclings", "Hook the top of the toes, pull with shin/foot."),
  kneeBar: s("kneeBar", "Knee Bar", "technique", "Hands-free rest/lock", "Toe into one hold, jam knee/thigh against an opposing feature."),
  kneeScum: s("kneeScum", "Knee Scum", "technique", "Extra friction/stability", "Smear the inside knee/thigh on the wall."),
  stemming: s("stemming", "Stemming / Bridging", "technique", "Opposing pressure in corners; restful", "Press hands/feet outward on opposing walls."),
  gaston: s("gaston", "Gaston", "technique", "Outward push on an inward-facing hold", "Elbow out, push away ('pry the doors open')."),
  undercling: s("undercling", "Undercling", "technique", "Pull up on a downward-facing hold, hips in", "Palm-up, pull out-and-up, walk feet high."),
  sidePull: s("sidePull", "Side Pull", "technique", "Lateral pull on a sideways hold", "Grip the edge, lean away to oppose."),
  layback: s("layback", "Layback (Lieback)", "technique", "Opposing pull/push on an edge/arête", "Pull with hands, push feet on the opposite surface."),
  palming: s("palming", "Palming", "technique", "Hand smear for friction/balance", "Press a flat palm where there's no hold."),

  // Grip types
  fullCrimp: s("fullCrimp", "Full Crimp", "grip", "Max power on tiny edges (highest strain)", "Thumb over index nail; reserve for hardest moves.", { caution: "Highest pulley strain — use sparingly." }),
  halfCrimp: s("halfCrimp", "Half Crimp", "grip", "Strong, versatile everyday hard-pull grip", "First knuckles ~90°, thumb off."),
  openHand: s("openHand", "Open Hand / Drag", "grip", "Lowest strain; slopers/rounded/pockets", "Fingers relaxed and extended."),
  sloperGrip: s("sloperGrip", "Sloper Technique", "grip", "Friction holds; body position over grip", "Flat open hand, max skin, hips in/low."),
  pinch: s("pinch", "Pinch", "grip", "Squeeze between fingers and thumb", "Actively oppose thumb and fingers."),
  pocket: s("pocket", "Pocket", "grip", "1–3 finger holes", "Middle+ring for two-finger; open-hand to protect tendons."),

  // Crack
  fingerJam: s("fingerJam", "Finger Jam", "crack", "Narrow cracks", "Slot fingers thumb-down, rotate elbow down to cam."),
  handJam: s("handJam", "Hand Jam", "crack", "Most secure; hand-width", "Insert flat, cup/expand by clenching."),
  fistJam: s("fistJam", "Fist Jam", "crack", "Fist-width; less secure", "Insert fist, clench to expand."),
  offwidth: s("offwidth", "Offwidth Technique", "crack", "Too wide for fists", "Stack hands/fists, arm bars, chicken wings, leg/heel-toe cams."),
  cornerStem: s("cornerStem", "Stemming in Corners", "crack", "Bridge opposing dihedral walls", "Push outward with feet (and hands)."),

  // Angles & styles
  slab: s("slab", "Slab / Balance", "angle", "Balance & footwork over strength", "Heels low for smear, weight over feet, trust subtle placements."),
  vertical: s("vertical", "Vertical / Face", "angle", "Efficient positioning", "Manage CoG, straight arms, turn hips to reach."),
  overhang: s("overhang", "Overhang / Steep", "angle", "Core tension to keep the body close", "Engage core + toes/heels, climb with momentum, rest straight-armed."),
  roof: s("roof", "Roofs", "angle", "Most tension-dependent style", "Toe hooks, heel hooks, full-body tension to move through."),

  // Technique drills
  silentFeetDrill: s("silentFeetDrill", "Silent / Quiet Feet", "drill", "Foot precision & awareness", "Climb easy terrain placing each foot noiselessly; a 'click' = redo from the last hold."),
  coinHolds: s("coinHolds", "Coin Holds", "drill", "Exact placement", "Set coins on footholds; knocking one off = restart."),
  stickyFeet: s("stickyFeet", "Sticky / Glue Feet (One-Touch)", "drill", "First-try accuracy & economy", "Once a foot touches, no lift/shuffle (pivot OK); re-adjust sends it back."),
  hoverDrill: s("hoverDrill", "3-Second Hover", "drill", "Deliberate placement", "Hover the toe over the target ~3s, then place precisely."),
  footholdStare: s("footholdStare", "Foothold Stare", "drill", "Visual tracking of feet", "Watch the foothold as you place, keep watching 3s more."),
  deadStops: s("deadStops", "Hover Hands / Dead Stops", "drill", "Deceleration, body tension, static control", "Pause and hold a static position at the end of each move."),
  straightArmOnly: s("straightArmOnly", "Straight-Arm Only", "drill", "Efficient hanging", "Bend the arm only to actually pull a move."),
  tracking: s("tracking", "Tracking (Feet Follow Hands)", "drill", "Intentional foot sequencing", "Place each foot only where a hand just was."),
  downclimbDrill: s("downclimbDrill", "Downclimbing Drill", "drill", "Footwork + reverse route reading + economy", "Climb back down on the same holds."),
  eliminates: s("eliminates", "Eliminates (Bad/Restricted Holds)", "drill", "Creative movement & positioning", "Re-climb with key good holds off-limits."),
  slothMonkey: s("slothMonkey", "Sloth / Monkey", "drill", "Control vs rhythm", "Climb as slow-and-continuous as possible; then fast-and-fluid."),
  paceDrill: s("paceDrill", "Pace Drill", "drill", "Conscious speed control", "Assign sections target speeds and execute (fast cruxes, slow rests)."),
  tennisBallHands: s("tennisBallHands", "Tennis-Ball Hands / No-Hands Slab", "drill", "Balance, hips, footwork", "Only touch tennis balls to the wall; progress to hands-free slab."),
  refinedRepeat: s("refinedRepeat", "Perfect / Refined Repeat", "drill", "Ingrain efficient patterns", "Re-climb a known problem executing every move as cleanly/quietly as possible."),
  experimentVary: s("experimentVary", "Experiment & Vary (MacLeod)", "drill", "Adaptable body awareness", "Treat each climb as a chance to try new solutions over a huge variety of styles/angles/rock; breadth beats rote drilling."),

  // Volume & energy-system
  arc: s("arc", "ARC Training", "energySystem", "Aerobic capacity/capillarity + technique under mild fatigue", "30–60 min continuous, ~3–4 grades below limit, light never-occluding pump."),
  aerobicMileage: s("aerobicMileage", "Aerobic Mileage / Volume", "energySystem", "Endurance base, efficiency, recovery", "Accumulate easy-to-moderate climbing (bigger base → better rests)."),
  fourByFour: s("fourByFour", "4x4s", "energySystem", "Anaerobic / power-endurance", "4 problems back-to-back, rest 3–4 min, ×4 rounds; deliberate pump."),
  circuits: s("circuits", "Circuits / Linked Problems", "energySystem", "Power-endurance & pacing", "Link many moves into continuous laps."),
  limitBouldering: s("limitBouldering", "Limit Bouldering", "energySystem", "Max recruitment/power & hard movement", "1–3 hardest moves, full rest; focus on the limit move, not topping."),
  repeaters: s("repeaters", "Repeaters (Climbing-Style)", "energySystem", "Power-endurance via work:rest intervals", "Short on-wall bouts with brief rests."),
  densityTraining: s("densityTraining", "Density Training", "energySystem", "Work capacity", "More climbing in a fixed block; increase density over time."),
  projectVsMileage: s("projectVsMileage", "Projecting vs Mileage (Choice)", "energySystem", "Peak performance/skill vs base/technique/recovery", "Choose deliberately; they train different things."),

  // Tactics
  routeReading: s("routeReading", "Route Reading / Sequencing", "tactics", "Decode moves before leaving the ground", "Map hands/feet/positions/clips/rests from the floor."),
  previsualization: s("previsualization", "Previsualization / Mental Rehearsal", "tactics", "Stored motor plan, less hesitation", "'Run the movie' of smooth execution incl. breathing/clips."),
  redpointTactics: s("redpointTactics", "Redpoint Tactics", "tactics", "Dial & link a hard route", "Work sections, memorize beta/rests, link growing pieces to a clean send."),
  onsightTactics: s("onsightTactics", "Onsight Tactics", "tactics", "First-go on unknown terrain", "Read thoroughly, climb decisively, find rests, clip from stable stances."),
  restingShaking: s("restingShaking", "Resting & Shaking Out", "tactics", "Mid-route recovery & pump management", "Use rest positions; alternate shaking each forearm low; breathe."),
  clippingPractice: s("clippingPractice", "Clipping Practice", "tactics", "Fast, secure clips from stable stances", "Practice from good rests; plan clip positions while reading."),
  pacing: s("pacing", "Pacing", "tactics", "Energy distribution across a route", "Rehearse where to accelerate vs recover."),

  // Mental
  fallPractice: s("fallPractice", "Fall Practice (Incremental)", "mental", "Desensitize fear of falling", "Stage it: short TR → long TR → lead from top bolt → advanced; increment only while relaxed.", { caution: "Only with a trusted belayer and safe fall zone." }),
  softCatch: s("softCatch", "Falling Technique / Soft Catch", "mental", "Safe, relaxed impact", "Stay loose, breathe, meet the wall soft; belayer gives a dynamic catch."),
  fearManagement: s("fearManagement", "Fear-of-Falling Management", "mental", "Reframe fear as a distractor", "Treat falls as learning; staged exposure frees attention."),
  commitment: s("commitment", "Commitment", "mental", "Decisive execution past retreat", "Practice committing in safe settings; train out hesitation via graded consequence."),
  visualization: s("visualization", "Visualization / Imagery", "mental", "Motor learning, focus, readiness", "Use first- and third-person imagery to pre-program sends."),
  arousalRegulation: s("arousalRegulation", "Arousal Regulation", "mental", "Control activation (calm down / psych up)", "Breathwork, mindfulness, routines to hit the optimal zone."),
  focusRoutine: s("focusRoutine", "Focus / Pre-Climb Routine", "mental", "Consistent concentration", "A repeatable sequence (breath, cue word, quick visualization, tie-in ritual) before every burn."),
};

export default { STRENGTH_AXES, SKILL_DIMENSIONS, EQUIPMENT, strengthLibrary, climbingSkills };
