// ─────────────────────────────────────────────────────────────
// PRESCRIPTION LAYER
// ─────────────────────────────────────────────────────────────
// All the load-prescription logic — what weight to train at next
// session, what your potential ceiling is, what the gap diagnostic
// says. This module sits on top of the model layer (three-exp as the
// governing model, fatigue for the freshMap adjustment) and is what
// the React views call.
//
// DATA MODEL (May 2026 — train-to-failure migration):
// Every rep with a valid actual_time_s is a clean failure data point
// at (T = actual_time_s, F = loadedWeight). The user trains every rep
// to physical failure, so actual_time_s IS the time-to-failure
// regardless of how it compares to the prescribed target_duration.
// The legacy `failed` flag is retained on records for backward compat
// (and may still be true/false in old data) but is NO LONGER USED to
// gate fit logic — every rep contributes a data point. Old reps where
// actual_time_s == target_duration are read pragmatically as failure
// points at that duration (the user might have held longer if pushed,
// but we accept the approximation rather than re-collecting history).
//
// UNIFIED PRESCRIPTION (May 2026 — collapse of empirical/prescribed/
// potential trichotomy):
// One function, prescription(history, hand, grip, T, opts), answers
// "what load at this T?" by combining curve_shape × amplitude_anchor:
//   - curve_shape comes from the three-exp fit on this (hand, grip)
//     with prior shrinkage. It's stable across sessions — the *shape*
//     of the F-D curve doesn't move much with one new rep.
//   - amplitude_anchor = F_actual / curve(T_actual) for the most
//     recent rep 1 at any T. A great session at T=160s lifts the
//     amplitude scalar; the curve shape projects that lift across
//     every T proportionally. Cross-zone learning is intrinsic.
// Returns { value, potential, scale, anchor, reliability, source }
// so callers get both the anchored prescription (value) and the
// unscaled curve ceiling (potential) from a single fit. The gap
// diagnostic is just (potential - value) / value, equivalent to
// 1/scale - 1.
// Legacy estimateRefWeight remains as the last-resort fallback when
// no per-grip prior exists yet AND no anchor is available.

import { clamp, ymdLocal } from "../util.js";
import {
  PHYS_MODEL_DEFAULT, DEF_FAT,
  fatigueDose, fatigueAfterRest, availFrac,
} from "./fatigue.js";
import {
  THREE_EXP_LAMBDA_DEFAULT,
  fitThreeExpAmps, predForceThreeExp,
} from "./threeExp.js";

// ─────────────────────────────────────────────────────────────
// LOAD EXTRACTION HELPERS
// ─────────────────────────────────────────────────────────────

// Effective load for a rep — prefer Tindeq avg_force_kg, fall back
// to weight_kg. Used for CURVE FITTING (the actual force delivered
// during the hang is what shapes the F-D curve, regardless of
// whether there was load on a pin or not).
export function effectiveLoad(r) {
  const f = Number(r.avg_force_kg);
  const w = Number(r.weight_kg);
  if (f > 0 && f < 500) return f;
  if (w > 0) return w;
  return 0;
}

// Prescribable load for a rep — what the user should aim to produce
// next session. For Tindeq-isometric setups (spring/anchor, no pin),
// avg_force_kg IS the actual load delivered, AND it's what the
// prescription should be in. Kept distinct from effectiveLoad so the
// semantic is named — when we add weighted-rep support (hangboard
// with pulley + weight pin + inline Tindeq), this is what flips to
// prefer weight_kg.
export function loadedWeight(r) {
  const f = Number(r.avg_force_kg);
  if (f > 0 && f < 500) return f;
  const w = Number(r.weight_kg);
  if (w > 0) return w;
  return 0;
}

// Stable identity for a rep. Used as the key in freshMap.
export function repKey(r) {
  if (r.id) return `id:${r.id}`;
  return `${r.session_id || r.date}|${r.set_num || 1}|${r.rep_num || 1}|${r.hand}`;
}

// Shortfall threshold: a rep that finishes meaningfully before its
// target duration is treated as a failure for fitting purposes, even
// if the user didn't tap "fail". 95% gives a small buffer for clock
// drift / late taps.
export const SHORTFALL_TOL = 0.95;
export function isShortfall(actualTime, targetDuration) {
  if (!(actualTime > 0) || !(targetDuration > 0)) return false;
  return actualTime < targetDuration * SHORTFALL_TOL;
}

// ─────────────────────────────────────────────────────────────
// FATIGUE-ADJUSTED LOAD INDEX  (freshMap)
// ─────────────────────────────────────────────────────────────
// Within a set, the same posted load gets HARDER each rep as the
// muscle fatigues. Plain F-D fits will then misread later reps as
// "you were weaker than this" and pull the curve down. The fix:
// walk each session/hand/set chronologically, accumulating fatigue
// via the same model the live workout uses (fatigueDose + fatigueAfterRest),
// and divide each rep's load by availFrac to get its FRESH-EQUIVALENT
// load — what you'd be holding if you started the set fresh.
//
// Returns Map<repKey, { fresh, availFrac, load }>. Use freshLoadFor(rep, map)
// to look up. Falls back to actual load if a rep isn't in the map.

// sMax per (hand, grip) = max observed effective load × 1.2 (matches
// the sMaxL / sMaxR computation used at runtime).
export function buildSMaxIndex(history) {
  const out = new Map();
  for (const r of history || []) {
    if (!r.hand || !r.grip) continue;
    const load = effectiveLoad(r);
    if (!(load > 0)) continue;
    const k = `${r.hand}|${r.grip}`;
    const cur = out.get(k) || 0;
    if (load > cur) out.set(k, load);
  }
  for (const k of out.keys()) out.set(k, out.get(k) * 1.2);
  return out;
}

export function buildFreshLoadMap(history, opts = {}) {
  const {
    fatParams = DEF_FAT,
    doseK = PHYS_MODEL_DEFAULT.doseK,
    sMaxIndex = null,
    // Per-grip personal recovery taus from recoveryFit.computePersonalRecoveryTaus.
    // Map<grip, { fast, medium, slow }> — when present, overrides fatParams
    // per-rep based on the rep's grip. Falls back to fatParams when a grip
    // isn't in the map (cold start, sparse data). Engine-only personalization.
    personalTausByGrip = null,
  } = opts;
  const out = new Map();
  if (!history || history.length === 0) return out;

  const sMaxByKey = sMaxIndex || buildSMaxIndex(history);

  // Group by session + hand (fatigue state is per-hand at runtime).
  const groups = new Map();
  for (const r of history) {
    const sid = r.session_id || `nosid|${r.date}`;
    const k = `${sid}|${r.hand}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }

  // Build a per-grip fatParams cache so we don't reconstruct the
  // {A1,tau1,...} object inside the hot per-rep loop.
  const gripFatParams = new Map();
  const gripFatParamsFor = (grip) => {
    if (!personalTausByGrip || !grip) return fatParams;
    if (gripFatParams.has(grip)) return gripFatParams.get(grip);
    const taus = personalTausByGrip.get?.(grip);
    if (!taus) { gripFatParams.set(grip, fatParams); return fatParams; }
    const w = PHYS_MODEL_DEFAULT.weights;
    const personal = {
      A1: w.fast,   tau1: taus.fast,
      A2: w.medium, tau2: taus.medium,
      A3: w.slow,   tau3: taus.slow,
    };
    gripFatParams.set(grip, personal);
    return personal;
  };

  for (const reps of groups.values()) {
    const sorted = [...reps].sort((a, b) => {
      const sn = (a.set_num || 1) - (b.set_num || 1);
      if (sn !== 0) return sn;
      return (a.rep_num || 1) - (b.rep_num || 1);
    });

    let F = 0;
    let prevSetNum = null;
    let prevRest = 0;

    for (const r of sorted) {
      const setNum = r.set_num || 1;
      if (prevSetNum !== null && setNum !== prevSetNum) {
        F = 0;
      } else if (prevSetNum !== null) {
        F = fatigueAfterRest(F, prevRest, gripFatParamsFor(r.grip));
      }

      const af = availFrac(F);
      const load = effectiveLoad(r);
      const fresh = af > 0 && load > 0 ? load / af : load;
      out.set(repKey(r), { fresh, availFrac: af, load });

      const sMax = sMaxByKey.get(`${r.hand}|${r.grip}`) || 20;
      const dose = fatigueDose(load, r.actual_time_s || 0, sMax, doseK);
      F = Math.min(F + dose, 0.95);

      prevSetNum = setNum;
      prevRest = r.rest_s || 0;
    }
  }

  return out;
}

export function freshLoadFor(rep, freshMap) {
  if (!freshMap) return effectiveLoad(rep);
  const entry = freshMap.get(repKey(rep));
  return entry ? entry.fresh : effectiveLoad(rep);
}

// Back-fit the dose-strength constant k from a user's history. The
// signal is within-set decay: at constant posted load, actual_time_s
// should drop rep after rep. Under correct k, dividing each rep's
// posted load by availFrac yields a roughly constant fresh-equivalent
// load within the set.
export function fitDoseK(history, opts = {}) {
  const { kMin = 0.0005, kMax = 0.030, steps = 60, fatParams = DEF_FAT } = opts;
  if (!history || history.length < 6) return null;

  const sets = new Map();
  for (const r of history) {
    if (!(r.actual_time_s > 0) || effectiveLoad(r) <= 0) continue;
    const sid = r.session_id || `nosid|${r.date}`;
    const k = `${sid}|${r.hand}|${r.set_num || 1}`;
    if (!sets.has(k)) sets.set(k, []);
    sets.get(k).push(r);
  }
  const validSets = [];
  for (const reps of sets.values()) {
    if (reps.length < 3) continue;
    const tdSet = new Set(reps.map(r => r.target_duration || 0));
    if (tdSet.size > 1) continue;
    validSets.push(reps);
  }
  if (validSets.length < 2) return null;

  const sMaxIndex = buildSMaxIndex(history);

  let bestK = null, bestScore = Infinity;
  for (let i = 0; i < steps; i++) {
    const k = kMin + (kMax - kMin) * (i / (steps - 1));
    const freshMap = buildFreshLoadMap(history, { fatParams, doseK: k, sMaxIndex });
    let weightedVar = 0, totalW = 0;
    for (const reps of validSets) {
      const sorted = [...reps].sort((a, b) => (a.rep_num || 1) - (b.rep_num || 1));
      const xs = sorted.map(r => freshLoadFor(r, freshMap)).filter(v => v > 0);
      if (xs.length < 3) continue;
      const mean = xs.reduce((a, b) => a + b, 0) / xs.length;
      if (!(mean > 0)) continue;
      const variance = xs.reduce((a, v) => a + (v - mean) ** 2, 0) / xs.length;
      const cv = Math.sqrt(variance) / mean;
      const w = xs.length;
      weightedVar += cv * cv * w;
      totalW += w;
    }
    if (totalW <= 0) continue;
    const score = weightedVar / totalW;
    if (score < bestScore) { bestScore = score; bestK = k; }
  }
  return bestK;
}

// (sessionCompartmentAUC moved to fatigue.js as sessionComponentAUC during
// the three-timescale rebrand. The prescription.js copy was a dead
// duplicate — no runtime caller, only the fatigue.test.js test exercised
// either definition. Deleted May 2026.)

// (RPE-10 progression bump retired in May 2026: rpeProgressionMultiplier,
// BUMP_PER_SUCCESS, MAX_BUMP_MULT all gone. The train-to-failure model
// + curve scale-by-residual in prescription() handle the same job
// intrinsically — overshoots pull the amplitude anchor up, undershoots
// down, no explicit streak multiplier needed.)

// ─────────────────────────────────────────────────────────────
// HISTORICAL ESTIMATION  (fallback path, no curve)
// ─────────────────────────────────────────────────────────────
// Returns the weighted-recent-average weight at which the user
// achieved close to targetDuration seconds to failure. Used as the
// last-resort emergency fallback when no curve fit is available.
export function estimateRefWeight(history, hand, grip, targetDuration) {
  if (!history || history.length === 0) return null;
  const tol = targetDuration * 0.40;
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    Math.abs(r.actual_time_s - targetDuration) <= tol &&
    effectiveLoad(r) > 0
  );
  if (matches.length === 0) return null;
  const sorted = [...matches].sort((a, b) => a.date < b.date ? -1 : 1).slice(-10);
  let wSum = 0, wKg = 0;
  sorted.forEach((r, i) => { const w = i + 1; wSum += w; wKg += effectiveLoad(r) * w; });
  return wKg / wSum;
}

// ─────────────────────────────────────────────────────────────
// UNIFIED PRESCRIPTION  (PRIMARY coaching path)
// ─────────────────────────────────────────────────────────────
// Returns the load to TRAIN AT for a given (hand, grip, T), plus the
// unscaled curve "potential" for the gap diagnostic, derived from a
// SINGLE three-exp fit. Replaces the prior empiricalPrescription /
// prescribedLoad / prescriptionPotential trichotomy with one function.
//
// Architecture (May 2026 — curve-trust collapse):
//
//   value      = curve_shape(T) × amplitude_anchor
//   potential  = curve_shape(T)                       (anchor = 1.0)
//   scale      = F_anchor / curve_shape(T_anchor)
//
// curve_shape comes from the three-exp fit on (hand, grip) with prior
// shrinkage — it gives the *relative* force across all T values and
// is stable across sessions.
//
// amplitude_anchor is the scalar shift derived from the user's MOST
// RECENT rep 1 at ANY T, this (hand, grip), within the lookback
// window. A great session at T=160s lifts the amplitude scalar; the
// curve shape then projects that lift to every T proportionally —
// cross-zone learning is intrinsic. No more "exact T match" gate.
//
// The gap diagnostic collapses to (potential − value) / value, which
// is exactly 1/scale − 1. Positive gap = user is currently below the
// curve's amplitude (limiter signal — adaptation room). Negative gap
// = user is exceeding the curve's amplitude (strength signal — already
// at or above modeled potential).
//
// Returns:
//   {
//     value:       <number>  anchored prescription, kg
//     potential:   <number>  unscaled curve, kg
//     scale:       <number>  amplitude anchor (1.0 if no anchor)
//     anchor:      { T, F, date } | null
//     reliability: "well-supported" | "marginal" | "extrapolation"
//     source:      "anchored-curve"  | "unanchored-curve"
//                | "anchored-linear" | "historical" | "none"
//   }
//   or null if there's not even a historical fallback.
//
// Sources, in priority order:
//   anchored-curve    — per-grip prior available, recent rep 1 anchor
//                       found. value = curve(T) × scale.
//   unanchored-curve  — per-grip prior available, no recent anchor.
//                       value = curve(T), scale = 1.0.
//   anchored-linear   — no per-grip prior (cold start), recent rep 1
//                       anchor found. value scales by duration ratio
//                       (Path 2 of the old empiricalPrescription).
//   historical        — no prior, no anchor. value = estimateRefWeight
//                       (weighted-recent average near target T).
//   none              — nothing usable; returns null.

export const EMPIRICAL_LOOKBACK_DAYS = 30;

export function prescription(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { freshMap = null, threeExpPriors = null } = opts;

  // Anchor: most recent rep 1 (any T) at this (hand, grip), within
  // EMPIRICAL_LOOKBACK_DAYS. Earlier code matched on EXACT
  // target_duration; the unified prescription deliberately drops that
  // — a recent overshoot at any T is a legitimate amplitude signal
  // for every T via the curve shape.
  const cutoffMs = Date.now() - EMPIRICAL_LOOKBACK_DAYS * 86400 * 1000;
  const cutoff = ymdLocal(new Date(cutoffMs));
  const sessionRep1 = new Map();
  for (const r of history) {
    if (r.hand !== hand || r.grip !== grip) continue;
    if ((r.rep_num || 1) !== 1) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!(loadedWeight(r) > 0)) continue;
    if ((r.date || "") < cutoff) continue;
    const sid = r.session_id || r.date || "unknown";
    sessionRep1.set(sid, r);
  }
  const rep1s = [...sessionRep1.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const anchorRep = rep1s[0] || null;
  const anchor = anchorRep ? {
    T: anchorRep.actual_time_s,
    F: loadedWeight(anchorRep),
    date: anchorRep.date,
  } : null;

  // Try the three-exp curve fit. Requires a per-grip prior to anchor
  // the shrinkage; without one, small-N fits collapse onto degenerate
  // mixes and we fall through to the cold-start paths.
  const points = history.filter(r =>
    r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );
  const prior = (threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  const hasPrior = prior && (prior[0] + prior[1] + prior[2]) > 0;

  if (hasPrior && points.length >= 1) {
    const fmap = freshMap || buildFreshLoadMap(history);
    const tePts = points.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(points.length, 1);
    const amps = fitThreeExpAmps(tePts, { prior, lambda });
    if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
      const potentialRaw = predForceThreeExp(amps, targetDuration);
      if (potentialRaw > 0) {
        // Compute amplitude anchor from the most recent rep 1, if any.
        // No clamp on scale — per user direction (May 2026), freak reps
        // are unlikely under the train-to-failure model and we want the
        // engine to react to genuine recent performance.
        let scale = 1.0;
        let source = "unanchored-curve";
        if (anchor) {
          const F_pred_anchor = predForceThreeExp(amps, anchor.T);
          if (F_pred_anchor > 0) {
            scale = anchor.F / F_pred_anchor;
            source = "anchored-curve";
          }
        }
        const valueRaw = potentialRaw * scale;

        // Reliability of the curve PREDICTION at targetDuration —
        // how interpolative vs extrapolative the (hand, grip) data
        // is at that T. Independent of whether the anchor is present.
        const within20 = points.filter(r =>
          Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.20
        ).length;
        const within50 = points.filter(r =>
          Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.50
        ).length;
        const reliability = within20 >= 1 ? "well-supported"
                          : within50 >= 1 ? "marginal"
                          :                 "extrapolation";

        return {
          value:       Math.round(valueRaw * 10) / 10,
          potential:   Math.round(potentialRaw * 10) / 10,
          scale,
          anchor,
          reliability,
          source,
        };
      }
    }
  }

  // Cold start: no per-grip prior or the curve fit failed. Fall back
  // to the linear-scale path if we have an anchor — it's the same Path 2
  // the old empiricalPrescription used: F_target = F_actual × T_actual/T_target,
  // floor at 0.7 to keep prescriptions from collapsing on a short rep.
  if (anchor) {
    const linScale = Math.max(0.7, anchor.T / targetDuration);
    const v = anchor.F * linScale;
    return {
      value:       Math.round(v * 10) / 10,
      potential:   Math.round(v * 10) / 10,  // no curve to give a separate ceiling
      scale:       linScale,
      anchor,
      reliability: "extrapolation",
      source:      "anchored-linear",
    };
  }

  // Last resort: historical weighted-recent average near targetDuration.
  // No anchor, no curve fit — just give the user something reasonable
  // based on what they've done historically near this T.
  const hist = estimateRefWeight(history, hand, grip, targetDuration);
  if (hist != null && hist > 0) {
    return {
      value:       Math.round(hist * 10) / 10,
      potential:   Math.round(hist * 10) / 10,
      scale:       1.0,
      anchor:      null,
      reliability: "extrapolation",
      source:      "historical",
    };
  }

  return null;
}

// suggestWeight is a simple display helper used by the in-workout view —
// kept here because it depends on availFrac.
export function suggestWeight(refWeight, fatigue) {
  if (refWeight == null) return null;
  return Math.round(refWeight * availFrac(fatigue) * 10) / 10;
}

// Re-export clamp for callers that imported it via this module historically.
export { clamp };
