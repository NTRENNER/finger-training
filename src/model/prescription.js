// ─────────────────────────────────────────────────────────────
// PRESCRIPTION LAYER
// ─────────────────────────────────────────────────────────────
// All the load-prescription logic — what weight to train at next
// session, what your potential ceiling is, what the gap diagnostic
// says. This module sits on top of the model layer (threeExp as the
// governing model, monod as the cold-start fallback, fatigue for the
// freshMap adjustment) and is what the React views call.
//
// HIERARCHY (post Phase A-C migration; three-exp is governing):
//   - empiricalPrescription = anchor to most recent rep 1; PRIMARY
//     prescription path (what to train at today). Failure case uses
//     three-exp scale-by-residual (curve shape from per-grip fit,
//     amplitude anchored to most recent failure). Falls back to Monod
//     CF/W' update if no per-grip three-exp prior exists yet.
//   - prescribedLoad = curve-derived FALLBACK when no recent rep 1
//     exists. Uses fitThreeExpAmpsWithSuccessFloor on freshMap-adjusted
//     loads. Cold-start path falls back to fitCFWithSuccessFloor (Monod)
//     when no per-grip three-exp prior is available.
//   - prescriptionPotential = three-exp ceiling for the gap diagnostic.
//     Monod is computed alongside but only as the lower-bracket of the
//     reliability range; the .value field is three-exp-primary.
//   - estimateRefWeight = historical weighted-average emergency fallback
//     (no model fit at all; last-resort cold start).
//
// The gap between empirical (what you do) and potential (what you
// could) is the training opportunity. See model/coaching.js for
// the engine that scores zones using gap × intensity × recency ×
// external × residual (residual is now also computed against the
// three-exp curve, not Monod).

import { clamp, ymdLocal } from "../util.js";
import {
  PHYS_MODEL_DEFAULT, DEF_FAT,
  fatigueDose, fatigueAfterRest, availFrac,
} from "./fatigue.js";
import {
  fitCF, fitCFWithSuccessFloor,
} from "./monod.js";
import {
  THREE_EXP_LAMBDA_DEFAULT,
  fitThreeExpAmps, fitThreeExpAmpsWithSuccessFloor, predForceThreeExp,
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
// RPE 10 PROGRESSION BUMP
// ─────────────────────────────────────────────────────────────
// In RPE 10 (rep-to-failure) training, the goal is for rep 1 to fail
// at the prescribed target time. A SUCCESS at rep 1 is evidence the
// load was too light — explicit per-session bump closes the loop:
// count consecutive recent rep-1 successes at this scope and multiply
// by (1 + BUMP_PER_SUCCESS)^streak. As soon as a real failure happens,
// the streak resets and the curve takes over.
export const BUMP_PER_SUCCESS = 0.05;
export const MAX_BUMP_MULT = 1.30;

export function rpeProgressionMultiplier(history, hand, grip, targetDuration) {
  if (!hand || !grip || !targetDuration || !history || history.length === 0) return 1;
  const rep1ByScope = new Map();
  for (const r of history) {
    if (r.hand !== hand || r.grip !== grip) continue;
    if (r.target_duration !== targetDuration) continue;
    if ((r.rep_num || 1) !== 1) continue;
    const sid = r.session_id || r.date || "unknown";
    rep1ByScope.set(sid, r);
  }
  const rep1s = [...rep1ByScope.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  let streak = 0;
  for (const r of rep1s) {
    if (r.failed) break;
    if (!(r.actual_time_s >= targetDuration * 0.95)) break;
    streak += 1;
  }
  return Math.min(MAX_BUMP_MULT, Math.pow(1 + BUMP_PER_SUCCESS, streak));
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
// prescription using fitThreeExpAmpsWithSuccessFloor on freshMap-adjusted
// loads, then applies the RPE 10 bump.
//
// Three-exp is the governing model (post tauD-fix LOO-CV: ~7% RMSE
// improvement over Monod). Successes act as lower bounds via the
// success-floor iteration so the curve respects "you held F for T
// without failing" the same way the Monod success-floor does.
//
// Per-grip prior is required for the three-exp shrinkage to mean anything.
// If opts.threeExpPriors is not provided OR no prior exists for this grip,
// we fall back to the Monod success-floor fit (still fatigue-adjusted)
// — this preserves the cold-start / first-grip case where the prior
// hasn't been built yet.
export function prescribedLoad(history, hand, grip, targetDuration, freshMap = null, opts = {}) {
  if (!history || !targetDuration) return null;
  const { threeExpPriors = null } = opts;
  const handMatch = r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    effectiveLoad(r) > 0;

  const failures = history.filter(r => r.failed && handMatch(r));
  const successes = history.filter(r =>
    !r.failed && handMatch(r) &&
    r.target_duration > 0 &&
    r.actual_time_s >= r.target_duration
  );
  if (failures.length < 2 && successes.length < 2) return null;

  const fmap = freshMap || buildFreshLoadMap(history);
  const bump = rpeProgressionMultiplier(history, hand, grip, targetDuration);

  // Try three-exp first (the governing model). Requires a per-grip prior
  // for the shrinkage to be meaningful; without one the fit is unstable
  // at small N.
  const prior = (grip && threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
  if (prior && (prior[0] + prior[1] + prior[2]) > 0 && failures.length >= 1) {
    const tePts = failures.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    const teSucc = successes.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
    const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1);
    const amps = fitThreeExpAmpsWithSuccessFloor(tePts, teSucc, { prior, lambda });
    if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
      const baseLoad = predForceThreeExp(amps, targetDuration);
      if (baseLoad > 0) return Math.round(baseLoad * bump * 10) / 10;
    }
  }

  // Cold-start fallback: Monod success-floor on freshMap-adjusted loads.
  // Used when no per-grip three-exp prior exists yet (early data) or
  // when the three-exp fit collapsed to all-zero amps.
  const failurePts = failures.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const successPts = successes.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const fit = fitCFWithSuccessFloor(failurePts, successPts);
  if (!fit) return null;
  const baseLoad = fit.CF + fit.W / targetDuration;
  return Math.round(baseLoad * bump * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// EMPIRICAL PRESCRIPTION  (PRIMARY coaching path)
// ─────────────────────────────────────────────────────────────
// Returns the load to ACTUALLY TRAIN at next session, anchored to
// the user's most recent rep 1 outcome at this exact scope rather
// than a global curve extrapolation.
//
// Why empirical-first: the curve fit is a global model. At extreme
// zones (Power, Capacity) it can extrapolate aggressively, prescribing
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
  const wasSuccess = !last.failed && T_actual >= T_target * 0.95;

  if (wasSuccess) {
    let streak = 0;
    for (const r of rep1s) {
      if (r.failed) break;
      if (!(r.actual_time_s >= targetDuration * 0.95)) break;
      streak += 1;
    }
    const bump = Math.min(MAX_BUMP_MULT, Math.pow(1 + BUMP_PER_SUCCESS, streak));
    return Math.round(F_actual * bump * 10) / 10;
  } else {
    // Failure case: three-exp scale-by-residual.
    // Fit three-exp to all of this (hand, grip)'s failures with the
    // per-grip prior + shrinkage. The fit gives us the curve SHAPE the
    // user's physiology is likely to follow. We then anchor the
    // amplitude to the most recent failure: scale = F_actual / F_pred(T_actual).
    // Prescription = F_pred(T_target) × scale. If T_target < T_actual,
    // scale > 1 follows naturally; if T_target > T_actual, scale captures
    // how much the curve drops over that extra duration.
    //
    // Falls back to Monod CF/W' update if no three-exp prior exists for
    // this grip yet (cold start), then to a linear scale as last resort.
    const failurePts = history.filter(r =>
      r.failed && r.hand === hand && r.grip === grip
      && r.actual_time_s > 0 && effectiveLoad(r) > 0
    );

    // Path 1: three-exp scale-by-residual
    const prior = (threeExpPriors && threeExpPriors.get) ? threeExpPriors.get(grip) : null;
    if (prior && (prior[0] + prior[1] + prior[2]) > 0 && failurePts.length >= 1) {
      const tePts = failurePts.map(r => ({ T: r.actual_time_s, F: effectiveLoad(r) }));
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failurePts.length, 1);
      const amps = fitThreeExpAmps(tePts, { prior, lambda });
      if (amps && (amps[0] + amps[1] + amps[2]) > 0) {
        const F_pred_actual = predForceThreeExp(amps, T_actual);
        if (F_pred_actual > 0) {
          const scale = F_actual / F_pred_actual;
          // Sanity bound: if the recent failure is more than 50% off
          // the curve in either direction, the curve is likely a poor
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
    // before the three-exp migration: assume CF stable, solve for new
    // W' from the failure point, prescribe at T_target.
    const monodPts = failurePts.map(r => ({ x: 1 / r.actual_time_s, y: effectiveLoad(r) }));
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
// fresh-equivalents (within-set fatigue removed). Both also enforce
// success-as-lower-bound — failures anchor the curve, successes pin
// it from below at their (T, F) coordinates.
export function prescriptionPotential(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { freshMap = null, threeExpPriors = null } = opts;

  const failures = history.filter(r =>
    r.failed && r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );

  const within20 = failures.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.20
  ).length;
  const within50 = failures.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.50
  ).length;

  const fmap = freshMap || buildFreshLoadMap(history);
  const successes = history.filter(r =>
    !r.failed && r.hand === hand && r.grip === grip
    && r.target_duration > 0 && r.actual_time_s >= r.target_duration
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );

  // Monod path — fresh-adjusted loads, success-floor enforcement.
  const failurePtsM = failures.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const successPtsM = successes.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const monodFit = (failurePtsM.length + successPtsM.length >= 2)
    ? fitCFWithSuccessFloor(failurePtsM, successPtsM)
    : null;
  const monodValue = monodFit ? monodFit.CF + monodFit.W / targetDuration : null;

  // Three-exp path — also uses fresh-adjusted loads, also enforces
  // success-as-lower-bound when successes exist. Per-grip prior +
  // shrinkage; falls through gracefully when the prior is absent.
  //
  // Picks fit function by data shape:
  //   successes present       → success-floor variant (≥2 combined pts)
  //   failures only + prior   → plain fitThreeExpAmps (works with 1 pt
  //                             because the prior anchors the basis)
  let threeExpValue = null;
  if (threeExpPriors && threeExpPriors.get && failures.length >= 1) {
    const prior = threeExpPriors.get(grip);
    if (prior && (prior[0] + prior[1] + prior[2]) > 0) {
      const failurePtsTE = failures.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
      const successPtsTE = successes.map(r => ({ T: r.actual_time_s, F: freshLoadFor(r, fmap) }));
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1);
      const amps = successPtsTE.length > 0
        ? fitThreeExpAmpsWithSuccessFloor(failurePtsTE, successPtsTE, { prior, lambda })
        : fitThreeExpAmps(failurePtsTE, { prior, lambda });
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
