// ─────────────────────────────────────────────────────────────
// ADAPTIVE WARM-UP PROTOCOL GENERATOR
// ─────────────────────────────────────────────────────────────
//
// Builds a personalized warm-up protocol on demand from the user's
// per-grip three-exp force curves + bodyweight + recent pullup max.
//
// Tindeq-driven design: each hang step prescribes a target LOAD (in kg)
// derived from the curve at a fixed reference time, and a target HOLD
// duration. The user pulls into the Tindeq until they reach the target
// load, holds for the prescribed time, releases. No bodyweight hanging,
// no extrapolation — loads always come from the curve at durations the
// curve has actually seen.
//
// IMPORTANT: warm-up reps DO NOT get logged or counted as training data.
// Pure prescription — nothing flows back into the F-D fit.
//
// Protocol structure (4 steps):
//   1. Two-Handed Crusher · 25%  — 25% × F_crusher(30s) per hand, 30s hold
//   2. Two-Handed Crusher · 50%  — 50% × F_crusher(60s) per hand, 60s hold
//   3. Two-Handed Micro   · 30%  — 30% × F_micro(30s)   per hand, 30s hold
//   4. Pullup finisher           — bodyweight, 40% of recent max × 2 sets
//
// Each hang step alternates L → R using one Tindeq. Between step 2 and
// step 3 the Tindeq swaps from the Crusher to the Micro gripper (the
// view prompts for this).
//
// Math:
//   F_grip(T) = three-exp prediction at duration T on that grip's curve.
//   Step load = intensity_pct × F_grip(reference_time).
//   These are loads the curve has covered, so no extrapolation issues
//   regardless of how strong the user is relative to bodyweight.

import {
  fitThreeExpAmps,
  predForceThreeExp,
  buildThreeExpPriors,
  THREE_EXP_LAMBDA_DEFAULT,
} from "./threeExp.js";

// Fit per-grip three-exp amps from the user's failure history. Mirrors
// the AnalysisView grip3xEstimates pattern: per-grip prior + adaptive
// shrinkage.
function fitGripAmps(history, grip) {
  const pts = (history || [])
    .filter(r =>
      r.failed && r.grip === grip &&
      r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
      r.actual_time_s > 0
    )
    .map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
  if (pts.length < 2) return null;
  const priors = buildThreeExpPriors(history);
  const prior  = priors?.get?.(grip) ?? [0, 0, 0];
  const hasPrior = (prior[0] + prior[1] + prior[2]) > 0;
  const lambda = hasPrior ? THREE_EXP_LAMBDA_DEFAULT / Math.max(pts.length, 1) : 0;
  const amps = fitThreeExpAmps(pts, { prior, lambda });
  if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) return null;
  return amps;
}

// Read recent max pullup reps from the Lifts/Workout log. Looks at the
// pull_ups exercise across all workout sessions within `daysOld` days
// and returns the highest rep count of any completed set. Returns null
// if no recent data.
export function getRecentMaxPullups(wLog, daysOld = 7) {
  if (!Array.isArray(wLog)) return null;
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - daysOld);
  let maxReps = 0;
  for (const session of wLog) {
    if (!session?.date) continue;
    const sessDate = new Date(session.date);
    if (isNaN(sessDate.getTime()) || sessDate < cutoff) continue;
    const sets = session.exercises?.["pull_ups"]?.sets;
    if (!Array.isArray(sets)) continue;
    for (const set of sets) {
      if (!set?.done) continue;
      const reps = Number(set.reps);
      if (Number.isFinite(reps) && reps > maxReps) maxReps = reps;
    }
  }
  return maxReps > 0 ? maxReps : null;
}

// Compute target load: intensity_pct × F_grip(reference_time).
// Floors at 1 kg so we never prescribe near-zero loads that the Tindeq
// auto-detect threshold (4 kg) wouldn't trigger on.
function targetLoadFromCurve(amps, refSec, intensityPct) {
  if (!amps) return null;
  const f = predForceThreeExp(amps, refSec);
  if (!isFinite(f) || f <= 0) return null;
  return Math.max(1, f * intensityPct);
}

/**
 * Generate the adaptive warm-up protocol.
 *
 * @param {Object} args
 * @param {Array}  args.history       - finger-training rep history (App-level)
 * @param {Array}  args.wLog          - workout log array (Lifts data)
 * @param {number} args.bodyWeightKg  - user's bodyweight in kg
 * @returns {Object} { ok, reason?, bodyWeightKg, bodyWeightLbs, pullupSource, steps[] }
 *
 * Each hang step has:
 *   { id, title, intensityLabel, type: 'hang',
 *     grip,                  - "Crusher" or "Micro" (single grip per step)
 *     targetLoadKg,          - per-hand target force in kg
 *     targetSec,             - target hold duration
 *     restAfterSec,
 *     description }
 *
 * The pullup finisher step:
 *   { id, title, type: 'pullup', targetReps, sets, restAfterSec, description }
 */
export function generateWarmupProtocol({ history, wLog, bodyWeightKg }) {
  if (!bodyWeightKg || bodyWeightKg <= 0) {
    return {
      ok: false,
      reason: "Bodyweight not set. Go to Settings, enter your bodyweight, and come back.",
    };
  }
  const crusherAmps = fitGripAmps(history, "Crusher");
  if (!crusherAmps) {
    return {
      ok: false,
      reason: "Need Crusher curve data first. Run a few Crusher hangs to failure (across multiple durations) to seed the force curve.",
    };
  }
  const microAmps = fitGripAmps(history, "Micro");

  const steps = [];

  // ── Step 1: Crusher · 25% × F_crusher(30s) for 30s ──
  const load1 = targetLoadFromCurve(crusherAmps, 30, 0.25);
  steps.push({
    id: "crusher-25",
    title: "Two-Handed Crusher",
    intensityLabel: "25%",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: load1,
    targetSec: 30,
    restAfterSec: 60,
    description:
      "Light squeeze on the Crusher to wake up the big finger flexors. Pull to the target load, hold for 30s, release. Alternates Left → Right.",
  });

  // ── Step 2: Crusher · 50% × F_crusher(60s) for 60s ──
  const load2 = targetLoadFromCurve(crusherAmps, 60, 0.50);
  steps.push({
    id: "crusher-50",
    title: "Two-Handed Crusher",
    intensityLabel: "50%",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: load2,
    targetSec: 60,
    restAfterSec: 180,
    description:
      "Same Crusher gripper, longer + heavier hold. Forearms get a working pump — well below failure thanks to the curve-derived load.",
  });

  // ── Step 3: Micro · 30% × F_micro(30s) for 30s ──
  // Skipped if Micro curve data is missing.
  if (microAmps) {
    const load3 = targetLoadFromCurve(microAmps, 30, 0.30);
    steps.push({
      id: "micro-30",
      title: "Two-Handed Micro",
      intensityLabel: "30%",
      type: "hang",
      grip: "Micro",
      targetLoadKg: load3,
      targetSec: 30,
      restAfterSec: 60,
      description:
        "Swap the Tindeq to the Micro gripper. Light pull on the smaller hold introduces the skin and finger position without going near failure.",
    });
  }

  // ── Step 4: Pullup finisher ──
  // Reps = 40% of recent max bodyweight pullups (≤7 days fresh) with a
  // floor of 2. Default to 5 if no recent data.
  const recentMaxPullups = getRecentMaxPullups(wLog, 7);
  const targetReps = recentMaxPullups
    ? Math.max(2, Math.round(recentMaxPullups * 0.4))
    : 5;
  steps.push({
    id: "pullup-finisher",
    title: "Pullup Finisher",
    intensityLabel: recentMaxPullups
      ? `${targetReps} reps × 2 sets · 40% of recent max ${recentMaxPullups}`
      : `${targetReps} reps × 2 sets · default (no recent pullup data)`,
    type: "pullup",
    targetReps,
    sets: 2,
    restAfterSec: 60,
    description:
      "Heart rate up, lats engaged, full prep. No Tindeq needed — just count reps. Two sets at 40% of your recent max.",
  });

  return {
    ok: true,
    bodyWeightKg,
    bodyWeightLbs: Math.round(bodyWeightKg * 2.20462 * 10) / 10,
    pullupSource: recentMaxPullups
      ? { count: recentMaxPullups, sourceText: "recent max within 7 days" }
      : { count: null, sourceText: "no recent data — using default 5" },
    steps,
  };
}
