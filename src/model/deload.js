// ─────────────────────────────────────────────────────────────
// DELOAD DETECTOR
// ─────────────────────────────────────────────────────────────
// Flags accumulating systemic fatigue and proposes a deload. NOT an
// injury system (the Micro/Crusher tools carry no finger-injury risk)
// — it's about catching non-functional overreaching, where fatigue is
// suppressing adaptation and backing off lets supercompensation happen.
//
// DESIGN (validated against real history, May 2026):
//
//  • The finger-training data is the SENSOR. It's densely instrumented
//    (per-rep failure curves), so total systemic fatigue — climbing +
//    lifting + life — shows up in it. Lifting/climbing are coarsely
//    logged by comparison, so they're CONTEXT, not the trigger.
//
//  • Trigger = cross-grip recovery-gap down. The per-grip rep2/rep1
//    recovery gap (observed − model-predicted, see recoveryDynamics)
//    must be below the noise band for EVERY trained grip over the last
//    N sessions. Cross-grip agreement is the key false-positive guard:
//    a single grip dipping is almost always a zone/training-phase
//    artifact (we saw Crusher dip in May purely from a shift to long
//    holds while Micro stayed flat — NOT fatigue). Real systemic
//    fatigue pulls every grip down together.
//
//  • Personal recovery taus (recoveryFit), not population, so "worse
//    than the model expects" means worse than YOUR normal — this
//    strips the long-hold tau-mismatch that otherwise masquerades as
//    fatigue.
//
//  • Lifting volume is the DISAMBIGUATOR / severity booster, not the
//    trigger. A completed-set acute-vs-chronic spike turns an ambiguous
//    cross-grip dip into a confident "strong" deload (both grips down
//    AND your heaviest lifting week = real overreaching). Set count, not
//    tonnage — the workout logs are too messy (string reps, empty =
//    bodyweight, unilateral L/R, duplicate rows) for reliable tonnage.
//
//  • Detraining guard: if there's no recent finger session, you're
//    rested, not fatigued — never deload.
//
// The detector only PROPOSES (returns a why-string for a banner); the
// UI surfaces it and the user accepts before any load is regulated.
// Pure functions; no React, no Supabase. Tested in isolation.

import { buildRecoveryTrend, GAP_NOISE_BAND } from "./recoveryDynamics.js";
import { computePersonalRecoveryTaus } from "./recoveryFit.js";
import { PHYS_MODEL_DEFAULT } from "./fatigue.js";

// Sustained: cross-grip recovery must be down over at least this many
// of each grip's most-recent finger sessions. 2 keeps a single rough
// day from firing while still catching a real run.
export const DELOAD_MIN_SESSIONS = 2;

// Detraining guard: if the most recent finger session on/before the
// evaluation date is older than this, return no-deload (rested).
export const DELOAD_STALE_DAYS = 14;

// Lifting acute-vs-chronic windows (days) + the completed-set rate
// ratio that counts as a volume spike, with a floor so a sparse
// history can't trivially "spike" off one session.
export const DELOAD_ACUTE_DAYS = 9;
export const DELOAD_CHRONIC_DAYS = 28;
export const DELOAD_LIFT_SPIKE_RATIO = 1.5;
export const DELOAD_LIFT_MIN_ACUTE_SETS = 12;

const daysBetween = (a, b) => Math.round((new Date(b) - new Date(a)) / 86400000);

// physModel for a grip from personally-fit recovery taus, falling back
// to population taus when the grip has no fit yet.
function physModelForGrip(personalTaus, grip) {
  const tauR = (personalTaus && personalTaus.get && personalTaus.get(grip)) || PHYS_MODEL_DEFAULT.tauR;
  return { weights: PHYS_MODEL_DEFAULT.weights, tauD: PHYS_MODEL_DEFAULT.tauD, tauR };
}

// Completed working-set count per date from workout_sessions. Robust
// lifting-volume proxy: skips marker rows (__rotation_pin, STRETCH),
// non-set entries (stretch/jumps flags), and sets not marked done.
export function liftingVolumeByDate(workoutSessions) {
  const byDate = {};
  for (const w of workoutSessions || []) {
    if (!w || !w.date) continue;
    if (w.workout === "__rotation_pin" || w.workout === "STRETCH") continue;
    const ex = w.exercises;
    if (!ex || typeof ex !== "object") continue;
    let sets = 0;
    for (const k of Object.keys(ex)) {
      const val = ex[k];
      if (!val || !Array.isArray(val.sets)) continue;
      for (const s of val.sets) {
        if (s && (s.done === true || s.done === "true")) sets++;
      }
    }
    if (sets > 0) byDate[w.date] = (byDate[w.date] || 0) + sets;
  }
  return byDate;
}

// Acute-vs-chronic lifting-volume spike as of `today`.
function liftingSpike(volByDate, today) {
  let acute = 0, chronic = 0;
  for (const [d, sets] of Object.entries(volByDate)) {
    const ago = daysBetween(d, today);
    if (ago < 0) continue;                       // after the eval date — ignore
    if (ago < DELOAD_ACUTE_DAYS) acute += sets;
    if (ago < DELOAD_CHRONIC_DAYS) chronic += sets;
  }
  const acuteRate = acute / DELOAD_ACUTE_DAYS;
  const chronicRate = chronic / DELOAD_CHRONIC_DAYS;
  const ratio = chronicRate > 0 ? acuteRate / chronicRate : 0;
  const spike = acute >= DELOAD_LIFT_MIN_ACUTE_SETS && ratio >= DELOAD_LIFT_SPIKE_RATIO;
  return { acuteSets: acute, chronicSets: chronic, ratio, spike };
}

// Mean recovery gap for a grip over its last `n` finger sessions
// on/before `today`. Null when fewer than `n` sessions carry a gap.
function recentGap(history, grip, physModel, today, n) {
  const trend = buildRecoveryTrend(history, grip, { physModel })
    .filter(r => r.date && r.date <= today && Number.isFinite(r.gapAtTarget));
  if (trend.length < n) return null;
  const last = trend.slice(-n);
  const mean = last.reduce((s, r) => s + r.gapAtTarget, 0) / last.length;
  return { mean, n: last.length, lastDate: last[last.length - 1].date };
}

// Main entry. Returns:
//   { deload: bool, severity: "none"|"mild"|"strong", signals, why }
// `signals` exposes the raw inputs so the UI can show its work.
export function computeDeload(history, workoutSessions = [], opts = {}) {
  const { today = null, minSessions = DELOAD_MIN_SESSIONS } = opts;
  const none = (why, signals = {}) => ({ deload: false, severity: "none", signals, why });

  if (!Array.isArray(history) || history.length === 0) return none("No training history.");

  const datesAsc = history.filter(r => r.date).map(r => r.date).sort();
  const ref = today || datesAsc[datesAsc.length - 1];
  if (!ref) return none("No dated sessions.");

  // Detraining guard — most recent finger session on/before ref.
  const lastOnOrBefore = datesAsc.filter(d => d <= ref).pop();
  if (!lastOnOrBefore || daysBetween(lastOnOrBefore, ref) > DELOAD_STALE_DAYS) {
    return none("No recent finger sessions — rested, not fatigued.");
  }

  // Per-grip recent recovery gap with personal taus.
  const grips = [...new Set(history.filter(r => r.grip).map(r => r.grip))];
  const personalTaus = computePersonalRecoveryTaus(history);
  const gripGaps = {};
  for (const g of grips) {
    const rg = recentGap(history, g, physModelForGrip(personalTaus, g), ref, minSessions);
    if (rg) gripGaps[g] = rg;
  }
  const measured = Object.keys(gripGaps);
  const lifting = liftingSpike(liftingVolumeByDate(workoutSessions), ref);
  const signals = { today: ref, gripGaps, lifting };

  if (measured.length < 2) {
    return none("Not enough cross-grip recovery data yet.", signals);
  }

  // Cross-grip gate: EVERY measured grip's recent mean gap below the band.
  const downGrips = measured.filter(g => gripGaps[g].mean < -GAP_NOISE_BAND);
  signals.downGrips = downGrips;
  signals.crossGripDown = downGrips.length === measured.length;

  if (!signals.crossGripDown) {
    const why = downGrips.length > 0
      ? `Only ${downGrips.join(", ")} recovery is down — looks grip-specific (a zone/phase artifact), not systemic. No deload.`
      : "Recovery is within your normal range across grips. No deload.";
    return none(why, signals);
  }

  const severity = lifting.spike ? "strong" : "mild";
  const gapStr = measured
    .map(g => `${g} ${gripGaps[g].mean >= 0 ? "+" : ""}${gripGaps[g].mean.toFixed(2)}`)
    .join(", ");
  const why = lifting.spike
    ? `Both grips' between-rep recovery is below your model over the last ${minSessions} sessions (${gapStr}), and lifting volume is ${lifting.ratio.toFixed(1)}× your 4-week average. Signs of accumulating systemic fatigue — consider an easier finger session and trimming your next lifting workout.`
    : `Both grips' between-rep recovery is below your model over the last ${minSessions} sessions (${gapStr}). An early fatigue signal — consider a lighter finger session.`;

  return { deload: true, severity, signals, why };
}
