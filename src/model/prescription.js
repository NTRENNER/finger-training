// ─────────────────────────────────────────────────────────────
// PRESCRIPTION LAYER
// ─────────────────────────────────────────────────────────────
// All the load-prescription logic — what weight to train at next
// session, what your potential ceiling is, what the gap diagnostic
// says. This module sits on top of the model layer (threeExp as the
// governing model, monod as the cold-start fallback, fatigue for the
// freshMap adjustment) and is what the React views call.
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
// Consequence: the success-floor fit variants
// (fitCFWithSuccessFloor / fitThreeExpAmpsWithSuccessFloor) are no
// longer called from production paths. They remain exported from
// monod.js / threeExp.js for backward compatibility with any external
// callers but are deprecated; new code uses the plain fits.
//
// HIERARCHY (post May 2026 migration; three-exp is governing):
//   - empiricalPrescription = anchor to most recent rep 1; PRIMARY
//     prescription path (what to train at today). Uses three-exp
//     scale-by-residual (curve shape from per-grip fit, amplitude
//     anchored to most recent rep). Falls back to Monod CF/W' update
//     if no per-grip three-exp prior exists yet.
//   - prescribedLoad = curve-derived FALLBACK when no recent rep 1
//     exists. Uses fitThreeExpAmps on freshMap-adjusted loads. Cold-
//     start path falls back to fitCF (Monod) when no per-grip
//     three-exp prior is available.
//   - prescriptionPotential = three-exp ceiling for the gap diagnostic.
//     Monod is computed alongside but only as the lower-bracket of the
//     reliability range; the .value field is three-exp-primary.
//   - estimateRefWeight = historical weighted-average emergency fallback
//     (no model fit at all; last-resort cold start).
//
// The gap between empirical (what you do) and potential (what you
// could) is the training opportunity. See model/coaching.js for
// the engine that scores zones using gap × intensity × recency ×
// external × residual (residual is computed against the three-exp
// curve, not Monod).

import { clamp, ymdLocal } from "../util.js";
import {
  PHYS_MODEL_DEFAULT, DEF_FAT,
  fatigueDose, fatigueAfterRest, availFrac,
} from "./fatigue.js";
import {
  fitCF,
} from "./monod.js";
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
// muscle fatigues. Plain Monod fits will then misread later reps
// as "you were weaker than this" and pull CF/W' down. The fix:
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
  const { fatParams = DEF_FAT, doseK = PHYS_MODEL_DEFAULT.doseK, sMaxIndex = null } = opts;
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
        F = fatigueAfterRest(F, prevRest, fatParams);
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

// ─────────────────────────────────────────────────────────────
// SESSION COMPARTMENT AUC  (depends on effectiveLoad)
// ─────────────────────────────────────────────────────────────
// Textbook PK-style integral: dose_i = load × A_i × τ_Di × (1 − e^(−t/τ_Di))
// Returns { fast, medium, slow, total } in kg·s units.
export function sessionCompartmentAUC(reps, physModel = PHYS_MODEL_DEFAULT) {
  const comps = [
    { key: "fast",   A: physModel.weights.fast,   tauD: physModel.tauD.fast   },
    { key: "medium", A: physModel.weights.medium, tauD: physModel.tauD.medium },
    { key: "slow",   A: physModel.weights.slow,   tauD: physModel.tauD.slow   },
  ];
  const out = { fast: 0, medium: 0, slow: 0 };
  for (const r of reps || []) {
    const t = r.actual_time_s;
    const L = effectiveLoad(r);
    if (!t || !L || t <= 0 || L <= 0) continue;
    for (const c of comps) {
      out[c.key] += L * c.A * c.tauD * (1 - Math.exp(-t / c.tauD));
    }
  }
  out.total = out.fast + out.medium + out.slow;
  return out;
}

// ─────────────────────────────────────────────────────────────
// RPE 10 PROGRESSION BUMP — DEPRECATED (May 2026)
// ─────────────────────────────────────────────────────────────
// Under the train-to-failure data model, every rep ends in physical
// failure regardless of how it compares to the prescribed target_
// duration. A "success" — actual_time_s ≥ target — is no longer a
// real category, so the success-streak bump no longer applies.
// The curve scale-by-residual path in empiricalPrescription handles
// the same job intrinsically: if you've been failing later than the
// curve predicts, the curve gets pulled up automatically and the
// next prescription bumps without an explicit streak multiplier.
//
// rpeProgressionMultiplier is kept as a no-op (returns 1.0 always)
// so any external caller that imported it doesn't break, but it's
// deprecated and will be removed in a future cleanup.
export const BUMP_PER_SUCCESS = 0.05;  // deprecated — kept for compat
export const MAX_BUMP_MULT = 1.30;     // deprecated — kept for compat

// eslint-disable-next-line no-unused-vars
export function rpeProgressionMultiplier(history, hand, grip, targetDuration) {
  // No-op under train-to-failure model. The curve handles progression
  // via the residual scale in empiricalPrescription's three-exp path.
  return 1;
}

// ─────────────────────────────────────────────────────────────
// HISTORICAL ESTIMATION  (fallback path, no curve)
// ─────────────────────────────────────────────────────────────
// Returns the weighted-recent-average weight at which the user
// achieved close to targetDuration seconds to failure. Used as the
// last-resort emergency fallback when no Monod fit is available.
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
// LOAD AUTO-PRESCRIPTION from fitted three-exp curve
// ─────────────────────────────────────────────────────────────
// FALLBACK path: when no recent rep 1 exists at this exact scope (so
// empiricalPrescription returns null), this gives a curve-derived
// prescription using fitThreeExpAmps on freshMap-adjusted loads.
//
// Train-to-failure data model (May 2026): every rep with valid
// actual_time_s is a (T, F) data point at (actual_time_s, freshLoad).
// The legacy `failed` filter is gone — successes and failures both
// count as failure data points, since under train-to-failure every
// rep ends in physical failure (the prescribed target is just our
// prediction of when that failure will occur). The success-floor
// iteration is therefore unnecessary.
//
// Three-exp is the governing model (post tauD-fix LOO-CV: ~7% RMSE
// improvement over Monod). Per-grip prior is required for the three-
// exp shrinkage to mean anything; without it the fit is unstable at
// small N. When no per-grip prior exists yet (cold start), falls back
// to plain Monod fitCF on the same fresh-adjusted loads.
export function prescribedLoad(history, hand, grip, targetDuration, freshMap = null, opts = {}) {
  if (!history || !targetDuration) return null;
  const { threeExpPriors = null } = opts;
  const handMatch = r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    effectiveLoad(r) > 0;

  // Every valid rep is a failure data point under the train-to-failure
  // model. Drop the success/failure dichotomy at the fit level.
  const points = history.filter(handMatch);
  if (points.length < 2) return null;

  const fmap = freshMap || buildFreshLoadMap(history);

  // Try three-exp first (the governing model). Requires a per-grip prior
  // for the shrinkage to be meaningful; without one the fit is unstable
  // at small N.
  const prior = (grip && threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  if (prior && (prior[0] + prior[1] + prior[2]) > 0) {
    const tePts = points.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(points.length, 1);
    const amps = fitThreeExpAmps(tePts, { prior, lambda });
    if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
      const baseLoad = predForceThreeExp(amps, targetDuration);
      if (baseLoad > 0) return Math.round(baseLoad * 10) / 10;
    }
  }

  // Cold-start fallback: plain Monod fit on freshMap-adjusted loads.
  // Used when no per-grip three-exp prior exists yet (early data) or
  // when the three-exp fit collapsed to all-zero amps.
  const monodPts = points.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const fit = fitCF(monodPts);
  if (!fit) return null;
  const baseLoad = fit.CF + fit.W / targetDuration;
  return Math.round(baseLoad * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// EMPIRICAL PRESCRIPTION  (PRIMARY coaching path)
// ─────────────────────────────────────────────────────────────
// Returns the load to ACTUALLY TRAIN at next session, anchored to
// the user's most recent rep 1 outcome at this exact scope rather
// than a global curve extrapolation.
//
// Why empirical-first: the curve fit is a global model. At extreme
// zones (Power, Endurance) it can extrapolate aggressively, prescribing
// 2x what the user has actually proven they can do. The empirical
// anchor keeps prescriptions grounded in real recent performance.
//
// Returns null if no recent rep 1 exists; caller falls back to
// prescribedLoad() in that case (cold start).
export const EMPIRICAL_LOOKBACK_DAYS = 30;

export function empiricalPrescription(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { threeExpPriors = null } = opts;
  const cutoffMs = Date.now() - EMPIRICAL_LOOKBACK_DAYS * 86400 * 1000;
  const cutoff = ymdLocal(new Date(cutoffMs));

  const sessionRep1 = new Map();
  for (const r of history) {
    if (r.hand !== hand || r.grip !== grip) continue;
    if (r.target_duration !== targetDuration) continue;
    if ((r.rep_num || 1) !== 1) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!(loadedWeight(r) > 0)) continue;
    if ((r.date || "") < cutoff) continue;
    const sid = r.session_id || r.date || "unknown";
    sessionRep1.set(sid, r);
  }
  if (sessionRep1.size === 0) return null;

  const rep1s = [...sessionRep1.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const last = rep1s[0];
  const F_actual = loadedWeight(last);
  const T_actual = last.actual_time_s;
  const T_target = targetDuration;

  // Train-to-failure model (May 2026): every rep ends in physical
  // failure, so T_actual IS the time-to-failure regardless of how it
  // compares to target. The single path below handles both directions:
  //
  //   T_actual > T_target → curve will scale UP (you held longer than
  //                          predicted; your physiology exceeds the
  //                          previous fit; bump load at T_target)
  //   T_actual < T_target → curve will scale DOWN (you failed earlier
  //                          than predicted; reduce load at T_target)
  //   T_actual ≈ T_target → curve is well-calibrated; scale ≈ 1.0
  //
  // Three-exp scale-by-residual is the principled way to do this:
  // fit per-grip curve shape, anchor amplitude to the most recent
  // (T_actual, F_actual), evaluate at T_target.
  //
  // The success/failure dichotomy that previously gated this branch
  // is gone — every rep is a data point regardless of its `failed`
  // flag.
  const points = history.filter(r =>
    r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );

  // Path 1: three-exp scale-by-residual
  const prior = (threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  if (prior && (prior[0] + prior[1] + prior[2]) > 0 && points.length >= 1) {
    const tePts = points.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
    const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(points.length, 1);
    const amps = fitThreeExpAmps(tePts, { prior, lambda });
    if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
      const F_pred_actual = predForceThreeExp(amps, T_actual);
      if (F_pred_actual > 0) {
        const scale = F_actual / F_pred_actual;
        // Sanity bound: if the recent rep is more than 50% off the
        // curve in either direction, the curve is likely a poor
        // anchor — fall through to the linear scale instead.
        if (scale >= 0.5 && scale <= 2.0) {
          const F_pred_target = predForceThreeExp(amps, T_target);
          const next = F_pred_target * scale;
          if (next > 0) return Math.round(next * 10) / 10;
        }
      }
    }
  }

  // Path 2 (cold start): Monod CF/W' update — kept as the fallback
  // when no three-exp prior exists yet for this grip. Same math as
  // before the migration: assume CF stable, solve for new W' from
  // the recent rep, prescribe at T_target.
  const monodPts = points.map(r => ({ x: 1 / r.actual_time_s, y: effectiveLoad(r) }));
  if (monodPts.length >= 2) {
    const fit = fitCF(monodPts);
    if (fit && F_actual > fit.CF) {
      const newWprime = (F_actual - fit.CF) * T_actual;
      const next = fit.CF + newWprime / T_target;
      return Math.round(Math.max(next, fit.CF) * 10) / 10;
    }
  }

  // Path 3 (no fit at all): linear scale by duration ratio.
  const scale = Math.max(0.7, T_actual / T_target);
  return Math.round(F_actual * scale * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// PRESCRIPTION POTENTIAL  (the "what's possible" diagnostic)
// ─────────────────────────────────────────────────────────────
// Returns the curve-derived ceiling at a given (hand, grip, T):
// what the model thinks the user's physiology could support if
// balanced. Used as the diagnostic ceiling for the gap calculation.
//
// Returns { value, lower, upper, reliability, monodValue, threeExpValue }
// or null. `value` is three-exp-primary (with Monod fallback), and the
// function returns a result if EITHER model produced a value — Monod
// is no longer required.
//
// Both fits use freshLoadFor() so loads are fatigue-adjusted to their
// fresh-equivalents (within-set fatigue removed). Under the train-to-
// failure data model (May 2026), every rep with valid actual_time_s
// is a data point — the success-floor enforcement is no longer needed
// because there are no "successes" in the lower-bound sense.
export function prescriptionPotential(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { freshMap = null, threeExpPriors = null } = opts;

  // Every valid rep is a failure data point under the train-to-failure
  // model. Drop the success/failure dichotomy at the fit level.
  const points = history.filter(r =>
    r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );

  const within20 = points.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.20
  ).length;
  const within50 = points.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.50
  ).length;

  const fmap = freshMap || buildFreshLoadMap(history);

  // Monod path — fresh-adjusted loads, plain fit.
  const monodPts = points.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const monodFit = monodPts.length >= 2 ? fitCF(monodPts) : null;
  const monodValue = monodFit ? monodFit.CF + monodFit.W / targetDuration : null;

  // Three-exp path — also uses fresh-adjusted loads. Per-grip prior +
  // shrinkage; falls through gracefully when the prior is absent.
  let threeExpValue = null;
  if (threeExpPriors && threeExpPriors.get && points.length >= 1) {
    const prior = threeExpPriors.get(grip);
    if (prior && (prior[0] + prior[1] + prior[2]) > 0) {
      const tePts = points.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(points.length, 1);
      const amps = fitThreeExpAmps(tePts, { prior, lambda });
      if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
        const v = predForceThreeExp(amps, targetDuration);
        if (v > 0) threeExpValue = v;
      }
    }
  }

  // Three-exp can stand on its own — return a result if EITHER model
  // produced a value. Only bail when both failed.
  if (monodValue == null && threeExpValue == null) return null;

  const values = [monodValue, threeExpValue].filter(v => v != null);
  const lower = Math.min(...values);
  const upper = Math.max(...values);

  let reliability;
  if (within20 >= 1 && monodValue != null && threeExpValue != null
      && Math.abs(monodValue - threeExpValue) / monodValue < 0.15) {
    // Both models agree within 15% AND there's a near-target failure.
    reliability = "well-supported";
  } else if (within50 >= 1) {
    reliability = "marginal";
  } else {
    reliability = "extrapolation";
  }

  // Three-exp is the primary value when available; Monod when not.
  const primary = threeExpValue != null ? threeExpValue : monodValue;
  return {
    value: Math.round(primary * 10) / 10,
    lower: Math.round(lower * 10) / 10,
    upper: Math.round(upper * 10) / 10,
    reliability,
    monodValue:    monodValue    != null ? Math.round(monodValue * 10) / 10    : null,
    threeExpValue: threeExpValue != null ? Math.round(threeExpValue * 10) / 10 : null,
  };
}

// suggestWeight is a simple display helper used by the in-workout view —
// kept here because it depends on availFrac.
export function suggestWeight(refWeight, fatigue) {
  if (refWeight == null) return null;
  return Math.round(refWeight * availFrac(fatigue) * 10) / 10;
}

// Re-export clamp for callers that imported it via this module historically.
export { clamp };
