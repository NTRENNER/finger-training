// ─────────────────────────────────────────────────────────────
// ADAPTIVE WARM-UP PROTOCOL GENERATOR
// ─────────────────────────────────────────────────────────────
//
// Builds a personalized warm-up protocol on demand from the user's
// per-grip three-exp force curves + bodyweight + recent pullup max.
//
// Two modes:
//   - 'boulder' (default): perfusion + BORK potentiation primer
//   - 'route':             perfusion only, longer holds
//
// Sports-science skeleton:
//   - Perfusion phase: sustained sub-failure holds anchored to F(60s),
//     not peak. F(60s) is what the user can hold for ~60s before
//     failing — their "second rep" sustainable level. Intensities at
//     70-80% of F(60s) sit well below failure for the prescribed
//     hold (30-60s), so the climber finishes each rep with margin.
//     Raises tissue temp, increases blood flow, mobilizes glycogen
//     WITHOUT fatiguing the contractile machinery. The earlier
//     protocol (60% × peak) was actually a near-failure load for the
//     60s step — quietly defeating its own warmup goal.
//
//   - BORK potentiation (boulder mode only, last step before pullups):
//     5 reps of brief (~5s) MAX voluntary contractions on the Micro
//     gripper, 45s rest between. Classical Post-Activation
//     Potentiation: short heavy stimulus → enhanced motor unit
//     recruitment + CNS facilitation in a 4-10 minute window.
//     Micro (not Crusher) because the small-edge crimp pattern is
//     what climbing demands; PAP transfers best when the primer
//     matches the target movement. No target load — the user just
//     pulls hard for each rep. First rep typically hits below peak;
//     reps 3-5 ride the potentiation curve upward.
//
//   Route mode skips BORK (the potentiation window fades faster than
//   the perfusion benefit, and route climbing rewards endurance
//   prep more than CNS priming) and stretches the Micro perfusion
//   hold to 60s for a deeper endurance-system warmup.
//
// Tindeq-driven design: each hang step prescribes a target LOAD (in kg)
// derived from the curve at a fixed reference time, and a target HOLD
// duration. The user pulls into the Tindeq until they reach the target
// load, holds for the prescribed time, releases. No extrapolation —
// loads always come from the curve at durations the curve has seen.
//
// IMPORTANT: warm-up reps DO NOT get logged or counted as training data.
// Pure prescription — nothing flows back into the F-D fit.
//
// Math:
//   F_grip(T) = three-exp prediction at duration T on that grip's curve.
//   Step load = intensity_pct × F_grip(60s)  [perfusion]
//   BORK has no target — display "Pull MAX" and capture peak.

import {
  fitThreeExpAmps,
  predForceThreeExp,
  buildThreeExpPriors,
  THREE_EXP_LAMBDA_DEFAULT,
} from "./threeExp.js";
import { effectiveLoad } from "./load.js";

// Fit per-grip three-exp amps from the user's failure history. Mirrors
// the AnalysisView grip3xEstimates pattern: per-grip prior + adaptive
// shrinkage.
function fitGripAmps(history, grip) {
  // Train-to-failure model: every rep with valid actual_time_s is a
  // (T, F) failure data point. Drop the legacy r.failed filter.
  const pts = (history || [])
    .filter(r =>
      r.grip === grip &&
      effectiveLoad(r) > 0 &&
      r.actual_time_s > 0
    )
    .map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
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
 * @param {'boulder'|'route'} [args.mode='boulder'] - what climbing you're warming up FOR
 * @returns {Object} { ok, reason?, mode, bodyWeightKg, bodyWeightLbs,
 *                     mvcSource, perfusionSource, pullupSource, steps[] }
 *
 * Hang step shape:
 *   { id, title, intensityLabel, type: 'hang',
 *     grip, targetLoadKg, targetSec, restAfterSec, description }
 *
 * BORK step shape (boulder mode only, last hang step before pullups):
 *   { id, title, intensityLabel, type: 'bork',
 *     grip,                  - "Micro"
 *     reps,                  - 5
 *     holdSec,               - 5 (each rep)
 *     restBetweenSec,        - 45 (between reps)
 *     restAfterSec,
 *     description }
 *
 * Pullup finisher step:
 *   { id, title, type: 'pullup', targetReps, sets, restAfterSec, description }
 */
export function generateWarmupProtocol({ history, wLog, bodyWeightKg, mode = "boulder" }) {
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

  // ── Per-grip MVC reference (used only for the BORK potentiation
  // step's display target, since BORK itself has no target load — the
  // user just pulls max). Peak across recent reps; fall back to curve.
  const crusherPeak = getRecentPeakMVC(history, "Crusher");
  const microPeak   = getRecentPeakMVC(history, "Micro");
  const crusherMVC  = crusherPeak ?? targetLoadFromCurve(crusherAmps, 30, 1.0);
  const microMVC    = microPeak ?? (microAmps ? targetLoadFromCurve(microAmps, 30, 1.0) : null);
  const crusherSource = crusherPeak ? "peak" : "curve";
  const microSource   = microPeak ? "peak" : (microAmps ? "curve" : null);

  // ── Per-grip F(60s) reference (sustainable "second-rep" capacity) ──
  // This is the perfusion anchor. Force the user can hold for ~60s
  // before failing — a robust population stat (not a noise-sensitive
  // peak sample) that matches the working force during real climbing.
  const crusherF60 = targetLoadFromCurve(crusherAmps, 60, 1.0);
  const microF60   = microAmps ? targetLoadFromCurve(microAmps, 60, 1.0) : null;

  const isRoute = mode === "route";
  const steps = [];

  // ── Perfusion 1: Crusher · 70% × F(60s) · 45s hold ──
  // Sub-failure long hold. Loaded enough to drive blood flow into
  // the working tissues; finishes with margin so the contractile
  // machinery stays fresh.
  steps.push({
    id: "perfusion-crusher-easy",
    title: "Two-Handed Crusher",
    intensityLabel: "70% × F(60s)",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: Math.max(1, crusherF60 * 0.70),
    targetSec: 45,
    restAfterSec: 60,
    description:
      "Sustained two-handed squeeze for tissue perfusion. Loaded enough to drive blood flow, easy enough to finish with margin.",
  });

  // ── Perfusion 2: Crusher · 80% × F(60s) ──
  // Bouldering: 30s hold (briefer ramp into working intensity).
  // Routes: 45s hold (longer sustained loading for endurance prep).
  steps.push({
    id: "perfusion-crusher-hard",
    title: "Two-Handed Crusher",
    intensityLabel: "80% × F(60s)",
    type: "hang",
    grip: "Crusher",
    targetLoadKg: Math.max(1, crusherF60 * 0.80),
    targetSec: isRoute ? 45 : 30,
    restAfterSec: 90,
    description:
      "Same Crusher gripper, a touch harder. Working pump territory — still well below failure for the prescribed hold.",
  });

  // ── Perfusion 3: Micro · 70% × F(60s) ──
  // Switch grippers (the view prompts for the Tindeq swap before
  // this step). Same intensity as Crusher perfusion 1, but on the
  // small edge so the climbing-specific finger position gets warmed.
  // Routes get a longer hold (60s) for endurance prep since they
  // skip the BORK that follows for boulderers.
  if (microF60) {
    steps.push({
      id: "perfusion-micro",
      title: "Two-Handed Micro",
      intensityLabel: "70% × F(60s)",
      type: "hang",
      grip: "Micro",
      targetLoadKg: Math.max(1, microF60 * 0.70),
      targetSec: isRoute ? 60 : 45,
      restAfterSec: 60,
      description: isRoute
        ? "Swap the Tindeq to the Micro gripper. Longer hold on the small edge to warm the climbing-specific finger position for sustained climbing."
        : "Swap the Tindeq to the Micro gripper. Warms the climbing-specific finger position before the BORK potentiation primer.",
    });
  }

  // ── BORK potentiation (boulder mode only) ──
  // 5 reps of brief max-effort pulls on the Micro. No target load —
  // pull as hard as possible for ~5 seconds, rest 45s, repeat. PAP
  // window opens 4-10 min after the last rep; that's the climb.
  if (!isRoute && microMVC) {
    steps.push({
      id: "bork-micro",
      title: "Micro BORK (potentiation primer)",
      intensityLabel: "5 × ~5s MVC",
      type: "bork",
      grip: "Micro",
      reps: 5,
      holdSec: 5,
      restBetweenSec: 45,
      restAfterSec: 60,
      // Reference MVC the user can expect to approach. Not a TARGET —
      // BORK reps have no target line. Just for display so the user
      // knows roughly what "max" looks like on the gauge.
      referenceMvcKg: microMVC,
      description:
        "Pull as hard as you can for ~5 seconds, rest 45s, repeat 5 times. No target — go full effort each rep. CNS primer for hard climbing.",
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
    mode,
    bodyWeightKg,
    bodyWeightLbs,
    mvcSource: {
      // "peak" = derived from peak_force_kg in recent reps (preferred).
      // "curve" = fell back to F(30s) on the three-exp curve.
      // Reference for the BORK step's display number — BORK has no
      // target, but the user sees the expected ballpark MVC.
      crusher: crusherSource,
      micro: microSource,
      crusherKg: crusherMVC,
      microKg: microMVC,
    },
    perfusionSource: {
      // F(60s) on the fitted curve — the "second-rep" sustainable
      // capacity that anchors the perfusion intensities.
      crusherF60Kg: crusherF60,
      microF60Kg: microF60,
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
