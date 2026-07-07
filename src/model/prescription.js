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
import { capacityMultiplier } from "./fatigueBeta.js";
// Max/power-protocol gate shared with the Peak Force card — both
// surfaces must agree on what counts as a "max attempt" peak.
import { PEAK_MAX_PROTOCOL_T } from "./peakForce.js";
// Load-extraction helpers (sane / prescribedLoad / effectiveLoad /
// loadedWeight) moved to ./load.js (May 2026) so lower-level modules
// like threeExp.js can use effectiveLoad without a circular import
// (prescription.js imports threeExp.js). effectiveLoad + loadedWeight
// are used internally below; all four are re-exported just after so
// existing call sites that import them from prescription.js keep working.
import { sane, effectiveLoad, loadedWeight, SANE_MAX_KG, isSeedArtifactRep } from "./load.js";

// ─────────────────────────────────────────────────────────────
// LOAD EXTRACTION HELPERS
// ─────────────────────────────────────────────────────────────
export { sane, prescribedLoad, effectiveLoad, loadedWeight } from "./load.js";

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
// Cap on how much within-set fatigue + cookedness de-cook can inflate a
// single rep's fresh-equivalent load. Without it, a maximally-cooked
// session (cooked=10 -> capacityMultiplier ~= exp(-5)) compounded with a
// fatigued late-set rep (availFrac floors at 0.05) produced ~20,000 kg
// fresh-equivalents that blew the F-D curve fit / chart axis up to
// ~44,000 lb (July 2026). A rep is never worth more than
// MAX_FRESH_INFLATION x its measured load, nor above SANE_MAX_KG.
const MAX_FRESH_INFLATION = 3;

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
    // Per-date cookedness map for EXTERNAL fatigue compensation
    // (climbing volume / sleep deficit / general systemic load
    // logged via the daily cookedness slider, including retroactive
    // edits from the AnalysisView session-detail modal). Plain
    // object: { "YYYY-MM-DD": 0..10 }.
    // When combined with the per-grip β fatigueModel below,
    // capacityMultiplier(model, grip, cooked) = exp(-β·cooked)
    // returns the scale-down factor that was applied (or should
    // have been applied) on that date — buildFreshLoadMap divides
    // each rep's load by it to recover the "fresh-equivalent"
    // load the curve fit should see. Without this, a cooked
    // session looks like a real capacity drop and skews the next
    // prescription downward.
    cookedByDate = null,
    fatigueModel = null,
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
      // Within-set fatigue compensation (existing path): divide by
      // availFrac to recover the fresh-equivalent load given how
      // fatigued the user was at this point in the set.
      let fresh = af > 0 && load > 0 ? load / af : load;
      // External cookedness compensation: divide by the capacity
      // multiplier that was active for this rep. Resolution order:
      //   1. Per-session override (r.session_cooked) — set on every
      //      rep at session save time from the pre-session slider,
      //      or via the History "override for this session" action.
      //      Wins because the user explicitly tagged THIS session's
      //      systemic state (e.g. "I was cooked by the evening hang
      //      even though the morning was fine").
      //   2. Day-level (cookedByDate[r.date]) — the broad-strokes
      //      day default the slider sets.
      //   3. Null/zero — no compensation applied.
      // Both paths still need fatigueModel; without it, capacityMultiplier
      // returns 1.0 and the path is a no-op.
      if (fatigueModel) {
        let cooked = null;
        if (r?.session_cooked != null) cooked = Number(r.session_cooked);
        else if (cookedByDate && r?.date && cookedByDate[r.date] != null) {
          cooked = Number(cookedByDate[r.date]);
        }
        if (cooked != null && cooked > 0) {
          const mult = capacityMultiplier(fatigueModel, r.grip, cooked);
          if (mult > 0) fresh = fresh / mult;
        }
      }
      // Bound the fresh-equivalent load (see MAX_FRESH_INFLATION).
      const cappedFresh = load > 0
        ? Math.min(fresh, load * MAX_FRESH_INFLATION, SANE_MAX_KG)
        : fresh;
      out.set(repKey(r), { fresh: cappedFresh, availFrac: af, load });

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
//     peakCapKg:   <number> | null  ceiling (PEAK_CAP_FRACTION × recent
//                                   best peak_force_kg), null when no
//                                   Tindeq peak exists in the window
//     peakCapped:  <bool>           true when value was reduced to the
//                                   ceiling (curve/linear paths only)
//     capacityFloorKg: <number>|null best load sustained for a hold of
//                                   this length-or-longer (the floor)
//     capacityFloored: <bool>       true when the floor lifted value
//                                   above the curve x anchor product
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

// ── Peak-force ceiling (June 2026) ───────────────────────────
// The three-exp curve has essentially no data support below ~10s for
// most training histories (short-end reps are rare, and the recent
// ones usually aren't failures), so curve_shape(T) extrapolates
// steeply at short T. Unclamped, that produced prescriptions ABOVE
// the user's measured instantaneous max — the 2026-06-08 Crusher/L
// max-strength session prescribed 94.1 kg when the best peak_force_kg
// ever recorded on that (hand, grip) was 76.9 kg. No isometric hold
// of ANY duration can exceed instantaneous peak force, so a recent
// measured peak is a hard physical ceiling the curve must respect.
//
// PEAK_CAP_FRACTION sits slightly below 1.0 because a prescription is
// a load to SUSTAIN for targetDuration, and sustained force is always
// under instantaneous peak. The cap only binds at short durations —
// at 30s+ the curve sits far below peak and nothing changes. Manual
// (non-Tindeq) histories have no peak_force_kg, so the cap is simply
// absent there.
//
// This is deliberately NOT a re-clamp of the anchor scale (removed
// May 2026 per user direction — the engine should react to genuine
// recent performance). The scale stays unclamped; the cap bounds only
// the final value, and only against demonstrated physical capacity.
export const PEAK_CAP_LOOKBACK_DAYS = 90;
export const PEAK_CAP_FRACTION = 0.95;

// Clamp a prescribed load to a physical ceiling. With a recent measured
// peak, that peak IS the ceiling (peakCapKg). WITHOUT one — a new grip, a
// sub-max-only history, or a first max day — fall back to SANE_MAX_KG so a
// degenerate short-T curve extrapolation can't emit an impossible load.
// (The 2026-06-10 Micro session wrote 974 kg exactly this way, before the
// peak cap existed and on a path where no recent Micro max peak bound it.)
export function capLoad(v, peakCapKg, absMax = SANE_MAX_KG) {
  const ceil = peakCapKg != null ? peakCapKg : absMax;
  return v > ceil ? ceil : v;
}

// Best measured instantaneous peak (kg) for (hand, grip) within the
// lookback window — MAX/POWER-PROTOCOL reps only (target ≤
// PEAK_MAX_PROTOCOL_T, same intent filter as the Peak Force card).
// A sub-max session's peak tracks the prescribed load, not the
// user's max: capping on it would bound a new grip's first max-day
// prescription at ~its endurance load (June 2026 — Prime's only
// session was 35s holds at ~6 kg; an unfiltered cap would have
// frozen its 5s prescriptions at ~6.9 kg indefinitely). Within a
// qualifying session, any rep's peak counts (fatigue lowers peaks,
// never raises) and missing targets (legacy/manual rows) are kept.
// referenceDate mirrors prescription()'s retrospective semantics:
// null = today. Returns null when no qualifying peak exists in the
// window — callers then run uncapped, the pre-cap behavior.
export function recentBestPeakKg(history, hand, grip, referenceDate = null) {
  if (!history) return null;
  const refMs = referenceDate
    ? new Date(`${referenceDate}T00:00:00`).getTime()
    : Date.now();
  const cutoff = ymdLocal(new Date(refMs - PEAK_CAP_LOOKBACK_DAYS * 86400 * 1000));
  let best = null;
  for (const r of history) {
    if (!r || r.hand !== hand || r.grip !== grip) continue;
    if ((r.date || "") < cutoff) continue;
    if (referenceDate && (r.date || "") >= referenceDate) continue; // retrospective: strictly before
    if (isSeedArtifactRep(r)) continue; // seeded twin's mirrored peak can't set the ceiling
    const tgt = Number(r.target_duration);
    if (Number.isFinite(tgt) && tgt > PEAK_MAX_PROTOCOL_T) continue; // sub-max protocol
    const p = sane(r.peak_force_kg);
    if (p != null && (best == null || p > best)) best = p;
  }
  return best;
}

// Best load the user has DEMONSTRABLY sustained for a hold of
// targetDuration-or-longer, within the lookback window — a hard FLOOR
// for the prescription. Holding F kg for actual_time_s d seconds proves
// the user can sustain at least F for any target <= d (a shorter hold at
// the same load is strictly easier). So for a target T no prescription
// should fall below max{ effectiveLoad(r) : fresh rep, actual_time_s >= T }.
//
// Why this is needed: the F-D fit is unweighted least-squares in ABSOLUTE
// kg, so sparse low-force endurance points sit well below the curve (a real
// 189s @ 5.5 kg Micro hold reads ~37% above the fit). The prescription is
// curve x anchor with a peak-force CEILING but no floor, so it could
// recommend LESS load than the user just sustained for a longer hold. This
// floor makes that impossible; it's a minimum, so genuine progression (the
// curve/anchor going higher) is unaffected.
//
// Fresh efforts only (rep_num === 1 / null) so a fatigued within-set rep
// can't set the floor; sane loads only; referenceDate mirrors the
// retrospective semantics used throughout this file. Returns null when
// nothing qualifies — the prescription then runs unfloored, as before.
export const CAPACITY_FLOOR_LOOKBACK_DAYS = 90;

export function demonstratedCapacityKg(history, hand, grip, targetDuration, referenceDate = null) {
  if (!history || !(targetDuration > 0)) return null;
  const refMs = referenceDate
    ? new Date(`${referenceDate}T00:00:00`).getTime()
    : Date.now();
  const cutoff = ymdLocal(new Date(refMs - CAPACITY_FLOOR_LOOKBACK_DAYS * 86400 * 1000));
  let best = null;
  for (const r of history) {
    if (!r || r.hand !== hand || r.grip !== grip) continue;
    if (!(r.rep_num == null || r.rep_num === 1)) continue;        // fresh efforts only
    if (isSeedArtifactRep(r)) continue;                           // skip seeded/backfilled twins (avg==peak)
    if (!(Number(r.actual_time_s) >= targetDuration)) continue;   // proves capacity at this T-or-shorter
    if ((r.date || "") < cutoff) continue;
    if (referenceDate && (r.date || "") >= referenceDate) continue; // retrospective: strictly before
    const load = sane(effectiveLoad(r));
    if (load != null && (best == null || load > best)) best = load;
  }
  return best;
}

export function prescription(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { freshMap = null, threeExpPriors = null, referenceDate = null } = opts;

  // Anchor: most recent rep 1 (any T) at this (hand, grip), within
  // EMPIRICAL_LOOKBACK_DAYS. Earlier code matched on EXACT
  // target_duration; the unified prescription deliberately drops that
  // — a recent overshoot at any T is a legitimate amplitude signal
  // for every T via the curve shape.
  //
  // referenceDate controls which day "recent" is measured from:
  //   - null / unset → today (LIVE prescription path; what the user
  //     should aim at for their next session).
  //   - ymd string ("YYYY-MM-DD") → that date (RETROSPECTIVE path;
  //     used by the AnalysisView session-detail modal and HistoryView
  //     reconstruction to answer "what would the engine have shown
  //     at the time of THIS session?"). Without this, an old session
  //     reconstructs against today-30d, which usually has no anchor-
  //     eligible rep in priorHistory and falls through to the
  //     conservative unanchored-curve prediction. That made the modal
  //     show targets dramatically lower than what was displayed live.
  const refMs = referenceDate
    ? new Date(`${referenceDate}T00:00:00`).getTime()
    : Date.now();
  const cutoffMs = refMs - EMPIRICAL_LOOKBACK_DAYS * 86400 * 1000;
  const cutoff = ymdLocal(new Date(cutoffMs));
  //
  // July 2026: when referenceDate is set, reps ON or AFTER it are
  // excluded here AND from the curve-fit points below. Both callers
  // of the retrospective path happened to pre-truncate their history,
  // which is why this never misfired — but "retrospective" was an
  // invariant enforced nowhere inside the function that claims it.
  // recentBestPeakKg already guarded this; the anchor and fit did not,
  // so an untruncated caller would have anchored an old session's
  // reconstruction on reps from its own future.
  const sessionRep1 = new Map();
  for (const r of history) {
    if (r.hand !== hand || r.grip !== grip) continue;
    if ((r.rep_num || 1) !== 1) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!(loadedWeight(r) > 0)) continue;
    if (isSeedArtifactRep(r)) continue;                             // seeded/backfilled twin can't anchor
    if ((r.date || "") < cutoff) continue;
    if (referenceDate && (r.date || "") >= referenceDate) continue; // retrospective: strictly before
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

  // Peak-force ceiling — see PEAK_CAP_FRACTION above. Null when the
  // history has no Tindeq peaks in the window (manual users), in
  // which case capValue() falls back to the SANE_MAX_KG backstop.
  const bestPeakKg = recentBestPeakKg(history, hand, grip, referenceDate);
  const peakCapKg = bestPeakKg != null
    ? Math.round(bestPeakKg * PEAK_CAP_FRACTION * 10) / 10
    : null;
  // Demonstrated-capacity FLOOR (July 2026) — see demonstratedCapacityKg.
  // Applied inside capValue as floor-then-cap so every return path is
  // bounded to [floor, ceiling]. A sustained avg is under instantaneous
  // peak, so the floor can't legitimately exceed the peak ceiling; if a
  // stale/odd data point ever makes it, the ceiling still wins.
  const floorKg = demonstratedCapacityKg(history, hand, grip, targetDuration, referenceDate);
  const capValue = (v) => capLoad(floorKg != null ? Math.max(v, floorKg) : v, peakCapKg);

  // Try the three-exp curve fit. Requires a per-grip prior to anchor
  // the shrinkage; without one, small-N fits collapse onto degenerate
  // mixes and we fall through to the cold-start paths.
  const points = history.filter(r =>
    r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
    && !isSeedArtifactRep(r)      // seeded twins would distort the fit
    // Retrospective semantics (see anchor loop): the fit must not
    // learn from reps the engine couldn't have seen on referenceDate.
    && !(referenceDate && (r.date || "") >= referenceDate)
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

        // Apply the peak-force ceiling to the trainable value only.
        // `potential` stays the raw curve — it's a diagnostic of what
        // the model believes, and the gap consumers should keep seeing
        // the uncapped shape. peakCapped tells the UI the value was
        // physically bounded rather than curve-derived.
        const rawRounded = Math.round(valueRaw * 10) / 10;
        const value = capValue(rawRounded);
        return {
          value,
          potential:   Math.round(potentialRaw * 10) / 10,
          scale,
          anchor,
          reliability,
          source,
          peakCapKg,
          peakCapped:      value < rawRounded,   // ceiling bit
          capacityFloorKg: floorKg,
          capacityFloored: value > rawRounded,   // floor lifted it above the curve
        };
      }
    }
  }

  // Cold start: no per-grip prior or the curve fit failed. Fall back
  // to the linear-scale path if we have an anchor — it's the same Path 2
  // the old empiricalPrescription used: F_target = F_actual × T_actual/T_target.
  //
  // The ratio is CLAMPED to [0.4, 2.5]. Linear F∝T scaling is only a
  // sane approximation for anchors near the target duration; the
  // anchor here is "most recent rep 1 at ANY T" (the exact-T gate was
  // deliberately removed), so without a ceiling a 160s endurance
  // anchor feeding a 5s max-hang target prescribed 32× the endurance
  // load — and the old 0.7 floor pinned a 5s anchor at 70% of max for
  // a 220s hold (real endurance loads run ~25-35% of max). The true
  // force-duration ratio between the extremes of the trained range is
  // ~3-4×; 2.5 up / 0.4 down keeps cold-start numbers inside
  // physically plausible territory while staying responsive. This is
  // distinct from the unclamped anchored-CURVE path above, which has
  // a fitted curve shape to keep it honest ("no clamp per user
  // direction" applies there, not here).
  if (anchor) {
    const linScale = Math.min(2.5, Math.max(0.4, anchor.T / targetDuration));
    const v = Math.round(anchor.F * linScale * 10) / 10;
    // Same peak-force ceiling as the curve path — linear scaling from
    // a long-T anchor to a short target overshoots the same way.
    const value = capValue(v);
    return {
      value,
      potential:   v,  // no curve to give a separate ceiling
      scale:       linScale,
      anchor,
      reliability: "extrapolation",
      source:      "anchored-linear",
      peakCapKg,
      peakCapped:      value < v,
      capacityFloorKg: floorKg,
      capacityFloored: value > v,
    };
  }

  // Last resort: historical weighted-recent average near targetDuration.
  // No anchor, no curve fit — just give the user something reasonable
  // based on what they've done historically near this T.
  const hist = estimateRefWeight(history, hand, grip, targetDuration);
  if (hist != null && hist > 0) {
    const hv = Math.round(hist * 10) / 10;
    const value = capValue(hv);
    return {
      value,
      potential:   hv,
      scale:       1.0,
      anchor:      null,
      reliability: "extrapolation",
      source:      "historical",
      peakCapKg,
      peakCapped:      value < hv,
      capacityFloorKg: floorKg,
      capacityFloored: value > hv,
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
