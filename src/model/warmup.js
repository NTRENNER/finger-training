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

// Epley 1RM estimate: 1RM ≈ load × (1 + reps/30). Standard formula
// for converting submaximal sets to a one-rep-max equivalent. Reliable
// up to ~10 reps, increasingly approximate beyond that — we cap output
// reps at 30 for the bodyweight-pullup use case to keep the warm-up
// prescription sensible.
function epleyOneRM(loadLbs, reps) {
  if (!(loadLbs > 0) || !(reps > 0)) return null;
  return loadLbs * (1 + reps / 30);
}

// Reverse Epley: given a 1RM and a target load, how many reps could
// the user do at that load? reps ≈ 30 × (1RM/load − 1). Returns null
// if 1RM ≤ load (meaning load IS or exceeds the 1RM, can't do reps).
function epleyRepsAtLoad(oneRM, loadLbs) {
  if (!(oneRM > 0) || !(loadLbs > 0)) return null;
  if (oneRM <= loadLbs) return 1;
  return 30 * (oneRM / loadLbs - 1);
}

// Read recent max pullup CAPACITY from the Lifts/Workout log, expressed
// as estimated UNWEIGHTED bodyweight pullup reps. For weighted pullups,
// we use Epley to convert the logged (weight × reps) set into a 1RM
// estimate, then back to estimated reps at bodyweight. For sets logged
// without added weight (weight = 0 or null), we use the rep count as-is.
//
// Two-pass search:
//   1. Strict pass — sets explicitly marked done (s.done === true).
//   2. Loose pass — any set with reps > 0 (catches "Finish Session"
//      without per-set done taps).
//
// Returns { unweightedReps, ageDays, strict, sourceWeightLbs, sourceReps }
// or null if nothing found within `daysOld`.
export function getRecentMaxPullups(wLog, { daysOld = 30, bodyWeightLbs } = {}) {
  if (!Array.isArray(wLog) || !(bodyWeightLbs > 0)) return null;
  const now = Date.now();
  const cutoffMs = now - daysOld * 24 * 60 * 60 * 1000;

  const search = (strict) => {
    let bestUnweightedReps = 0;
    let bestSet = null; // { weight, reps, ts }
    for (const session of wLog) {
      if (!session?.date) continue;
      const sessTs = Date.parse(session.date);
      if (!isFinite(sessTs) || sessTs < cutoffMs) continue;
      const sets = session.exercises?.["pull_ups"]?.sets;
      if (!Array.isArray(sets)) continue;
      for (const set of sets) {
        if (strict && !set?.done) continue;
        const reps = Number(set?.reps);
        const addedWeightLbs = Number(set?.weight) || 0;
        if (!Number.isFinite(reps) || reps <= 0) continue;
        // Total load on the user during the pullup = bodyweight + added.
        const totalLoadLbs = bodyWeightLbs + Math.max(0, addedWeightLbs);
        const oneRM = epleyOneRM(totalLoadLbs, reps);
        if (!oneRM) continue;
        // Estimated unweighted (BW only) reps at this 1RM.
        const bwReps = epleyRepsAtLoad(oneRM, bodyWeightLbs);
        if (!(bwReps > 0)) continue;
        const cappedBwReps = Math.min(30, Math.round(bwReps));
        if (cappedBwReps > bestUnweightedReps) {
          bestUnweightedReps = cappedBwReps;
          bestSet = { weight: addedWeightLbs, reps, ts: sessTs };
        }
      }
    }
    if (bestUnweightedReps <= 0) return null;
    const ageDays = bestSet?.ts != null
      ? Math.max(0, Math.round((now - bestSet.ts) / (24 * 60 * 60 * 1000)))
      : null;
    return {
      unweightedReps: bestUnweightedReps,
      ageDays,
      strict,
      sourceWeightLbs: bestSet?.weight ?? 0,
      sourceReps: bestSet?.reps ?? null,
    };
  };

  return search(true) || search(false) || null;
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

// Find the highest peak_force_kg recorded for a given grip within the
// lookback window. Used as an MVC proxy for warm-up load prescription —
// peak captures near-MVC moments during reps that the sustained-force
// curve never sees, and isn't subject to the ramp-up bias that drags
// avg_force_kg low at short durations.
//
// Returns null if no peak data is available (legacy reps from before
// peak capture was implemented, or no reps for this grip).
function getRecentPeakMVC(history, grip, daysOld = 90) {
  if (!Array.isArray(history) || !grip) return null;
  const cutoffMs = Date.now() - daysOld * 24 * 60 * 60 * 1000;
  let maxPeak = 0;
  for (const r of history) {
    if (r?.grip !== grip) continue;
    const peak = Number(r?.peak_force_kg);
    if (!Number.isFinite(peak) || peak <= 0 || peak >= 500) continue;
    if (r.date) {
      const ts = Date.parse(r.date);
      if (isFinite(ts) && ts < cutoffMs) continue;
    }
    if (peak > maxPeak) maxPeak = peak;
  }
  return maxPeak > 0 ? maxPeak : null;
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

  // ── MVC reference per grip ──
  // Peak force across recent reps gives a near-MVC reference that's
  // calibrated to the user's actual high-effort moments (no ramp-up
  // bias, captures spikes the sustained-force curve never sees). Fall
  // back to F(30s) on the curve if no peak data is available (legacy
  // reps from before peak capture).
  const crusherPeak = getRecentPeakMVC(history, "Crusher");
  const microPeak   = getRecentPeakMVC(history, "Micro");
  const crusherMVC  = crusherPeak ?? targetLoadFromCurve(crusherAmps, 30, 1.0);
  const microMVC    = microPeak ?? (microAmps ? targetLoadFromCurve(microAmps, 30, 1.0) : null);
  const crusherSource = crusherPeak ? "peak" : "curve";
  const microSource   = microPeak ? "peak" : (microAmps ? "curve" : null);

  const steps = [];

  // ── Step 1: Crusher · 40% × MVC for 30s ──
  // Light activation set. 40% of MVC is a standard hangboard warm-up
  // intensity — engages the muscle without going near failure.
  steps.push({
    id: "crusher-40pct-30s",
    title: "Two-Handed Crusher",
    intensityLabel: "40% MVC",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: Math.max(1, crusherMVC * 0.40),
    targetSec: 30,
    restAfterSec: 60,
    description:
      "Moderate squeeze at 40% of your max effort. Pull to the target load, hold 30s, release. Alternates Left → Right.",
  });

  // ── Step 2: Crusher · 60% × MVC for 60s ──
  // Working set at 60% MVC — meaningfully harder than Step 1 in both
  // load and duration. Still below failure for a sustained 60s hold.
  steps.push({
    id: "crusher-60pct-60s",
    title: "Two-Handed Crusher",
    intensityLabel: "60% MVC",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: Math.max(1, crusherMVC * 0.60),
    targetSec: 60,
    restAfterSec: 180,
    description:
      "Same Crusher gripper, 60% of max effort for a longer hold. Forearms get a working pump, well below failure.",
  });

  // ── Step 3: Micro · 40% × MVC for 30s ──
  // Light Micro introduction. Skipped if no Micro data at all.
  if (microMVC) {
    steps.push({
      id: "micro-40pct-30s",
      title: "Two-Handed Micro",
      intensityLabel: "40% MVC",
      type: "hang",
      grip: "Micro",
      targetLoadKg: Math.max(1, microMVC * 0.40),
      targetSec: 30,
      restAfterSec: 60,
      description:
        "Swap the Tindeq to the Micro gripper. Light pull on the smaller hold introduces the skin and finger position.",
    });
  }

  // ── Step 4: Pullup finisher ──
  // Reps = 40% of estimated UNWEIGHTED max (Epley-converted from your
  // recent weighted-pullup session if applicable) with a floor of 2.
  // Default to 5 if no recent pullup data within 30 days.
  const bodyWeightLbs = Math.round(bodyWeightKg * 2.20462 * 10) / 10;
  const pullupMatch = getRecentMaxPullups(wLog, { daysOld: 30, bodyWeightLbs });
  const unweightedMax = pullupMatch?.unweightedReps ?? null;
  const pullupAge = pullupMatch?.ageDays ?? null;
  const pullupStrict = pullupMatch?.strict ?? false;
  const sourceWeight = pullupMatch?.sourceWeightLbs ?? 0;
  const sourceReps = pullupMatch?.sourceReps ?? null;

  const targetReps = unweightedMax
    ? Math.max(2, Math.round(unweightedMax * 0.4))
    : 5;

  // Compose the source text for the UI. Show the original weighted set
  // plus the Epley-derived unweighted estimate so the user can see how
  // we got the number.
  let pullupSourceText;
  if (unweightedMax) {
    const ageText = pullupAge === 0 ? "today"
                  : pullupAge === 1 ? "1 day ago"
                  : `${pullupAge} days ago`;
    const sourceText = sourceWeight > 0
      ? `${sourceReps} reps × +${sourceWeight} lbs ${ageText} → ~${unweightedMax} unweighted`
      : `${sourceReps} reps unweighted ${ageText}`;
    pullupSourceText = pullupStrict
      ? sourceText
      : `${sourceText} (sets not marked done)`;
  } else {
    pullupSourceText = "no recent data — using default 5";
  }

  steps.push({
    id: "pullup-finisher",
    title: "Pullup Finisher",
    intensityLabel: unweightedMax
      ? `${targetReps} reps × 2 sets · 40% of ~${unweightedMax} unweighted`
      : `${targetReps} reps × 2 sets · default (no recent pullup data)`,
    type: "pullup",
    targetReps,
    sets: 2,
    restAfterSec: 60,
    description:
      "Heart rate up, lats engaged, full prep. No Tindeq needed — just count reps. Two sets at 40% of your estimated unweighted max.",
  });

  return {
    ok: true,
    bodyWeightKg,
    bodyWeightLbs,
    mvcSource: {
      // "peak" = derived from peak_force_kg in recent reps (preferred).
      // "curve" = fell back to F(30s) on the three-exp curve (legacy
      //          reps without peak data, or peak_force_kg never captured).
      crusher: crusherSource,
      micro: microSource,
      crusherKg: crusherMVC,
      microKg: microMVC,
    },
    pullupSource: {
      count: unweightedMax,
      ageDays: pullupAge,
      strict: pullupStrict,
      sourceWeightLbs: sourceWeight,
      sourceReps,
      sourceText: pullupSourceText,
    },
    steps,
  };
}
