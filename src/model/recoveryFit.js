// ─────────────────────────────────────────────────────────────
// PERSONAL RECOVERY TAU FIT
// ─────────────────────────────────────────────────────────────
// Fits personal recovery time constants (tauR) for the fast and
// medium energy compartments per grip, by minimizing the squared
// error between predicted and actual within-set rep-time decay.
// Slow tauR is INTENTIONALLY not fit — the user's typical sets are
// too short (5–60s holds) to deplete the slow compartment, so there's
// no signal to constrain it. We hold it at the population value.
//
// LOO-CV against ~5 weeks of real data showed:
//   pooled improvement: +20% RMSE drop vs population taus
//   Crusher:            +12% (signal real but borderline)
//   Micro:              +44% (Micro's recovery is dramatically slower
//                              than the population prior — tauR_med
//                              jumps from 90s → ~400s in the fit)
// Validation harness: /tmp/loo_cv.py at the time of shipping.
//
// Bayesian shrinkage with PRIOR_WEIGHT (5 effective sets) keeps a
// new user / sparse-data grip anchored to the population curve until
// enough sets accumulate. With 0 qualifying sets the function
// returns null and getPhysModel falls back to PHYS_MODEL_DEFAULT.
//
// Identifiability note: the fit needs at least some variation in
// rest periods within the training data to deconvolve recovery from
// depletion. With all-20s rests it CAN still fit, but the result is
// effectively "what tau makes 20s look like X% recovery" — which is
// still useful for the freshMap / predictRepTimes consumers since
// they're typically scoring 20s-rest sessions anyway.

import { PHYS_MODEL_DEFAULT } from "./fatigue.js";

const POP_TAU_R = PHYS_MODEL_DEFAULT.tauR;       // { fast, medium, slow }
const POP_TAU_D = PHYS_MODEL_DEFAULT.tauD;       // depletion (held fixed)
const POP_WEIGHTS = PHYS_MODEL_DEFAULT.weights;

// Bayesian shrinkage strength, in units of "qualifying sets". With
// PRIOR_WEIGHT=5 and n=5, the fitted value is weighted equally with
// the population prior; with n=20, the fit is ~80% personal.
const PRIOR_WEIGHT = 5;

// Minimum reps in a set to count as a "qualifying set". Need rep 1
// to anchor the prediction + at least 2 more to score against.
const MIN_REPS_PER_SET = 3;

// Search ranges (clamps) for the fit. Keep slow at population — see
// header comment about identifiability for short sets.
const RANGE = {
  fast:   [4, 60],
  medium: [20, 400],
};

// Predict rep-time sequence under a given recovery-tau triple.
// MUST stay numerically identical to fatigue.js predictRepTimes —
// any divergence here would invalidate the LOO-CV and the shrunk
// values plumbed into the freshMap pipeline.
function predictDecay(firstT, nReps, restS, tauR) {
  const comps = [
    { w: POP_WEIGHTS.fast,   tD: POP_TAU_D.fast,   tR: tauR.fast,   avail: 1.0 },
    { w: POP_WEIGHTS.medium, tD: POP_TAU_D.medium, tR: tauR.medium, avail: 1.0 },
    { w: POP_WEIGHTS.slow,   tD: POP_TAU_D.slow,   tR: tauR.slow,   avail: 1.0 },
  ];
  const out = [];
  for (let i = 0; i < nReps; i++) {
    const cap = comps.reduce((s, c) => s + c.w * c.avail, 0);
    const t = Math.max(0, firstT * cap);
    out.push(t);
    for (const c of comps) {
      c.avail = Math.max(0, c.avail * Math.exp(-t / c.tD));
    }
    if (i < nReps - 1) {
      for (const c of comps) {
        const rec = 1 - Math.exp(-restS / c.tR);
        c.avail = Math.min(1, c.avail + (1 - c.avail) * rec);
      }
    }
  }
  return out;
}

// Sum of squared errors between predicted and actual rep-2..N times
// across all sets, given a tauR triple.
function totalSSE(sets, tauR) {
  let sse = 0;
  for (const s of sets) {
    if (s.times.length < 2) continue;
    const pred = predictDecay(s.times[0], s.times.length, s.rest, tauR);
    for (let i = 1; i < s.times.length; i++) {
      const d = pred[i] - s.times[i];
      sse += d * d;
    }
  }
  return sse;
}

// Coarse grid + local refinement, mirrors the Python LOO-CV harness.
// Returns the unshrunk best-fit { fast, medium }.
function fitCore(sets) {
  const gridFast = [5, 8, 12, 15, 20, 30, 45];
  const gridMed  = [30, 60, 90, 120, 180, 300];
  let best = { fast: POP_TAU_R.fast, medium: POP_TAU_R.medium };
  let bestSSE = Infinity;
  for (const f of gridFast) {
    for (const m of gridMed) {
      const tau = { fast: f, medium: m, slow: POP_TAU_R.slow };
      const sse = totalSSE(sets, tau);
      if (sse < bestSSE) { bestSSE = sse; best = { fast: f, medium: m }; }
    }
  }
  // Local refinement — multiplicative steps, two passes.
  for (let pass = 0; pass < 3; pass++) {
    let improved = false;
    for (const k of ["fast", "medium"]) {
      const [lo, hi] = RANGE[k];
      for (const delta of [0.7, 0.85, 1.15, 1.4]) {
        const cand = { ...best };
        cand[k] = Math.max(lo, Math.min(hi, best[k] * delta));
        const tau = { fast: cand.fast, medium: cand.medium, slow: POP_TAU_R.slow };
        const sse = totalSSE(sets, tau);
        if (sse < bestSSE) { bestSSE = sse; best = cand; improved = true; }
      }
    }
    if (!improved) break;
  }
  return best;
}

// Group history into per-(session, hand) within-set sequences for one
// grip. Skips reps with non-L/R hand (the legacy "B" corruption from
// the May 2026 Both-button bug — those reps don't carry a coherent
// per-hand decay sequence).
function setsForGrip(history, grip) {
  const groups = new Map();
  for (const r of history || []) {
    if (!r || r.grip !== grip) continue;
    if (r.hand !== "L" && r.hand !== "R") continue;
    if (!(r.actual_time_s > 0) || !r.session_id) continue;
    const key = `${r.session_id}|${r.hand}`;
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  const sets = [];
  for (const reps of groups.values()) {
    reps.sort((a, b) => (a.rep_num || 0) - (b.rep_num || 0));
    if (reps.length < MIN_REPS_PER_SET) continue;
    const times = reps.map(r => r.actual_time_s);
    const rest  = reps.reduce((s, r) => s + (r.rest_s || 20), 0) / reps.length;
    sets.push({ times, rest });
  }
  return sets;
}

// Fit personal recovery taus for one grip, with Bayesian shrinkage
// toward the population prior. Returns { fast, medium, slow } or null
// when there's not enough data to bother.
//
// Slow always equals the population value — see header for the
// identifiability rationale.
export function computePersonalRecoveryTausForGrip(history, grip) {
  const sets = setsForGrip(history, grip);
  if (sets.length === 0) return null;
  const fitted = fitCore(sets);
  const n = sets.length;
  const w = PRIOR_WEIGHT;
  return {
    fast:   (w * POP_TAU_R.fast   + n * fitted.fast)   / (w + n),
    medium: (w * POP_TAU_R.medium + n * fitted.medium) / (w + n),
    slow:   POP_TAU_R.slow,  // always population — not enough signal in short sets
    nSets:  n,                 // expose for "calibrated" indicators / debug
  };
}

// Fit per-grip recovery taus across the user's whole history.
// Returns Map<grip, { fast, medium, slow, nSets }>. App.js memoizes
// this on the history fingerprint and threads it through to the
// freshMap / predictRepTimes call sites via getPhysModel.
export function computePersonalRecoveryTaus(history) {
  const grips = new Set();
  for (const r of history || []) if (r?.grip) grips.add(r.grip);
  const out = new Map();
  for (const grip of grips) {
    const taus = computePersonalRecoveryTausForGrip(history, grip);
    if (taus) out.set(grip, taus);
  }
  return out;
}

// Build the {A1, tau1, A2, tau2, A3, tau3} fatParams that the
// freshMap pipeline (fatigueAfterRest) consumes, from a tauR triple.
// Pure utility; lives here so the fit module owns the conversion
// from "physiology language" (tauR) to "fatParams language" (numbered
// A/tau pairs).
export function fatParamsFromTauR(tauR, weights = POP_WEIGHTS) {
  return {
    A1: weights.fast,   tau1: tauR.fast,
    A2: weights.medium, tau2: tauR.medium,
    A3: weights.slow,   tau3: tauR.slow,
  };
}
