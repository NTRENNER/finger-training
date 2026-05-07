// ─────────────────────────────────────────────────────────────
// ADAPTIVE WARM-UP PROTOCOL GENERATOR
// ─────────────────────────────────────────────────────────────
//
// Builds a personalized 5-step warm-up protocol on demand from the user's
// per-grip three-exp force curves + bodyweight + recent pullup max.
//
// Inspired by the Grip Gains Adaptive Warm-up: every load is
// force-curve-normalized so the warm-up feels the same for everyone.
// Goal: get to performance plateau quickly without flash pump or
// excessive energy depletion before the real work begins.
//
// IMPORTANT: warm-up reps DO NOT get logged or counted as training data.
// This module is a pure prescription generator — no Tindeq required, no
// reps written back, no curve updates. The user sees a target time/rep
// count and runs through it with the timer UI; we just generate the
// numbers and step through them.
//
// Protocol structure:
//   1. Two-Handed Crusher @ 25% T_max — wakes up the big finger flexors
//   2. Two-Handed Crusher @ 50% T_max — moderate-intensity hang
//   3. Right Micro · Left Crusher (cross-loaded @ ~30% T_max)
//   4. Left Micro · Right Crusher (mirror of #3)
//   5. Cross-loaded pullup finisher — reps derived from your recent
//      bodyweight pullup max in the Lifts tab (40% of max, ≥7 days fresh)
//
// Math:
//   - Two-handed Crusher: each hand carries bodyweight ÷ 2. Look up the
//     time T such that F_crusher(T) = bodyweight / 2 on the Crusher
//     three-exp curve. Target = X% × T.
//   - Cross-loaded: when hanging from one Crusher and one Micro, the
//     load distributes proportionally to each grip's force capacity
//     (the stronger grip naturally takes more weight). The Micro is
//     the limiter, so target time is derived from F_micro(T) = micro's
//     load share of bodyweight, then × 30%.
//   - Pullups: 40% of recent max. Floor of 2 reps. Default to 5 if no
//     recent Lifts data.

import {
  fitThreeExpAmps,
  predForceThreeExp,
  buildThreeExpPriors,
  THREE_EXP_LAMBDA_DEFAULT,
} from "./threeExp.js";

// Solve F(T) = targetForce for T via bisection. Three-exp F is
// monotonically decreasing in T (for non-negative amps), so a clean
// bisection is sufficient. Returns null if the load is above the
// fresh-max amplitude (a+b+c).
function solveTimeAtForce(amps, targetForce, tLo = 1, tHi = 1800) {
  if (!amps || amps.length !== 3) return null;
  const ampSum = amps[0] + amps[1] + amps[2];
  if (ampSum <= 0) return null;
  // Above-MVC load → can't hold at all.
  if (targetForce >= ampSum) return null;
  // Below-asymptote load → bisection would push to tHi; just return tHi.
  if (predForceThreeExp(amps, tHi) >= targetForce) return tHi;
  // F(tLo) should be > targetForce (load is below MVC). If not, the
  // user is at near-MVC and can barely hold — return tLo.
  if (predForceThreeExp(amps, tLo) <= targetForce) return tLo;
  let lo = tLo, hi = tHi;
  for (let i = 0; i < 50; i++) {
    const mid = (lo + hi) / 2;
    const f = predForceThreeExp(amps, mid);
    if (f > targetForce) lo = mid;
    else hi = mid;
  }
  return (lo + hi) / 2;
}

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

// Compute a target hold duration: T_max at the given load, scaled by
// pct, clamped to a sensible range. Returns minSec on degenerate fits
// rather than null so the warm-up always has a number to show.
function targetTimeFromLoad(amps, loadKg, pct, minSec = 10, maxSec = 240) {
  const tMax = solveTimeAtForce(amps, loadKg);
  if (!tMax || !isFinite(tMax)) return minSec;
  return Math.max(minSec, Math.min(maxSec, Math.round(tMax * pct)));
}

// Capacity-proportional load split for cross-loaded steps. When hanging
// with one Crusher hand + one Micro hand, weight naturally distributes
// to the stronger grip. Use F at a representative duration (60s) as
// the "capacity" weight per grip. The Micro's share of bodyweight is
// (F_micro / (F_crusher + F_micro)).
function microLoadShare(crusherAmps, microAmps, bodyWeightKg, refSec = 60) {
  const fCrusher = predForceThreeExp(crusherAmps, refSec);
  const fMicro   = predForceThreeExp(microAmps,   refSec);
  const total = fCrusher + fMicro;
  const share = total > 0 ? fMicro / total : 0.5;
  return bodyWeightKg * share;
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
 * Each step has:
 *   { id, title, intensityLabel, type: 'hang'|'pullup',
 *     leftGrip, rightGrip,
 *     targetSec?, targetReps?, sets?, swapAfterSet?,
 *     restAfterSec, description }
 */
export function generateWarmupProtocol({ history, wLog, bodyWeightKg }) {
  if (!bodyWeightKg || bodyWeightKg <= 0) {
    return {
      ok: false,
      reason: "Bodyweight not set. Go to Settings and enter your bodyweight, then come back to generate a personalized warm-up.",
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

  const halfBW = bodyWeightKg / 2;
  const steps = [];

  // ── Step 1: Two-Handed Crusher @ 25% T_max ──
  steps.push({
    id: "crusher-25",
    title: "Two-Handed Crusher",
    intensityLabel: "25%",
    type: "hang",
    leftGrip: "Crusher",
    rightGrip: "Crusher",
    targetSec: targetTimeFromLoad(crusherAmps, halfBW, 0.25),
    restAfterSec: 60,
    description:
      "Both hands on Crushers, hang at bodyweight. Big finger flexors get woken up at low intensity — easy on purpose.",
  });

  // ── Step 2: Two-Handed Crusher @ 50% T_max ──
  steps.push({
    id: "crusher-50",
    title: "Two-Handed Crusher",
    intensityLabel: "50%",
    type: "hang",
    leftGrip: "Crusher",
    rightGrip: "Crusher",
    targetSec: targetTimeFromLoad(crusherAmps, halfBW, 0.50),
    restAfterSec: 180,
    description:
      "Same setup, longer hold. Brings the forearms close to a working pump — well below failure thanks to the curve.",
  });

  // ── Cross-loaded steps require Micro curve data. Skip gracefully if
  //    Micro hasn't been baselined yet. ──
  if (microAmps) {
    const microLoad = microLoadShare(crusherAmps, microAmps, bodyWeightKg);

    // Step 3: Right Micro · Left Crusher
    steps.push({
      id: "cross-rmlc",
      title: "Right Micro · Left Crusher",
      intensityLabel: "30%",
      type: "hang",
      leftGrip: "Crusher",
      rightGrip: "Micro",
      targetSec: targetTimeFromLoad(microAmps, microLoad, 0.30),
      restAfterSec: 60,
      description:
        "Cross-loaded hang. Crusher hand naturally carries more, Micro hand less — your body finds the balance, the curve sets the time.",
    });

    // Step 4: Left Micro · Right Crusher (mirror)
    steps.push({
      id: "cross-lmrc",
      title: "Left Micro · Right Crusher",
      intensityLabel: "30%",
      type: "hang",
      leftGrip: "Micro",
      rightGrip: "Crusher",
      targetSec: targetTimeFromLoad(microAmps, microLoad, 0.30),
      restAfterSec: 60,
      description:
        "Same as above, swapped. Skin gets a small-hold introduction without going near failure.",
    });
  }

  // ── Step 5: Cross-loaded pullup finisher ──
  // Only render if Micro is baselined (the finisher is grip-mixed).
  // Reps = 40% of your recent max bodyweight pullups (≤7 days fresh)
  // with a floor of 2. Default to 5 if no recent data.
  const recentMaxPullups = getRecentMaxPullups(wLog, 7);
  if (microAmps) {
    const targetReps = recentMaxPullups
      ? Math.max(2, Math.round(recentMaxPullups * 0.4))
      : 5;
    steps.push({
      id: "pullup-finisher",
      title: "Cross-Loaded Pullups",
      intensityLabel: recentMaxPullups
        ? `${targetReps} reps × 2 sets · 40% of recent max ${recentMaxPullups}`
        : `${targetReps} reps × 2 sets · default (no recent pullup data)`,
      type: "pullup",
      // Set 1: L-Crusher / R-Micro. Set 2: L-Micro / R-Crusher.
      leftGrip: "Crusher",
      rightGrip: "Micro",
      swapAfterSet: true,
      targetReps,
      sets: 2,
      restAfterSec: 60,
      description:
        "Pullups with mixed grips. Each side gets a different load profile — Crusher bicep heavy + Micro fingers light, then swapped between sets.",
    });
  }

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
