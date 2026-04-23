// ─────────────────────────────────────────────────────────────
// CANONICAL THREE-COMPARTMENT PHYSIOLOGICAL MODEL  +  FATIGUE
// ─────────────────────────────────────────────────────────────
// PHYS_MODEL_DEFAULT is the single source of truth for the three-
// compartment model used by every downstream calculation: fatigue
// accumulation, rep-time prediction, AUC dose attribution, capacity-
// zone labels, and the three-exp force-duration curve target.
//
// Compartments map to bioenergetic systems:
//   fast   → phosphocreatine (PCr)
//   medium → glycolytic
//   slow   → oxidative
//
// Two distinct tau triples per compartment:
//   tauD — depletion time constant during a hang (faster systems
//          deplete faster as load draws down their substrate)
//   tauR — recovery time constant during rest between hangs
//          (slower systems recover slower)
//
// Weights sum to 1.0 and represent each compartment's contribution
// to fresh maximal force. They are population priors; per-user
// personalization happens in fitThreeExpAmps via shrinkage.
//
// sMax is per-(hand, grip) and gets filled in by getPhysModel() from
// the user's actual history; it isn't a population constant.
import { clamp } from "../util.js";

export const PHYS_MODEL_DEFAULT = {
  tauD:    { fast: 10,   medium: 30,   slow: 180 },
  tauR:    { fast: 15,   medium: 90,   slow: 600 },
  weights: { fast: 0.50, medium: 0.30, slow: 0.20 },
  doseK:   0.010,  // population-prior fatigue dose constant; back-fit per user via fitDoseK
  sMax:    null,   // per-(hand,grip), filled in from history
};

// Three-compartment fatigue decay parameters (defaults; derived from
// PHYS_MODEL_DEFAULT for backwards compat with fatigueAfterRest's
// {A1,tau1,...} call shape). Migrate fresh code to read PHYS_MODEL_DEFAULT
// directly instead of DEF_FAT.
export const DEF_FAT = {
  A1: PHYS_MODEL_DEFAULT.weights.fast,   tau1: PHYS_MODEL_DEFAULT.tauR.fast,
  A2: PHYS_MODEL_DEFAULT.weights.medium, tau2: PHYS_MODEL_DEFAULT.tauR.medium,
  A3: PHYS_MODEL_DEFAULT.weights.slow,   tau3: PHYS_MODEL_DEFAULT.tauR.slow,
};

// Fatigue accumulated per rep, scaled by load (relative to sMax) × duration.
// k is the dose-strength constant — population default = PHYS_MODEL_DEFAULT.doseK,
// back-fit per user via fitDoseK in prescription.js.
export function fatigueDose(weightKg, durationS, sMaxKg, k = PHYS_MODEL_DEFAULT.doseK) {
  if (!sMaxKg || sMaxKg <= 0) return 0;
  return clamp((weightKg / sMaxKg) * durationS * k, 0, 0.90);
}

// Fatigue remaining after a rest of restSeconds, given a current fatigue
// state F. Each compartment recovers at its own tauR; total remaining is
// the weighted sum of compartment fractions still in the fatigued pool.
export function fatigueAfterRest(F, restSeconds, p = DEF_FAT) {
  const { A1, tau1, A2, tau2, A3, tau3 } = p;
  return F * (
    A1 * Math.exp(-restSeconds / tau1) +
    A2 * Math.exp(-restSeconds / tau2) +
    A3 * Math.exp(-restSeconds / tau3)
  );
}

// Available fraction of max capacity given current fatigue F (0..1).
// Bounded at 5% so we never prescribe zero — even fully fatigued you
// can hold something briefly.
export const availFrac = (F) => clamp(1 - F, 0.05, 1.0);

// Returns the canonical three-compartment physModel for a (hand, grip)
// pair, with sMax filled in from the user's history. Taus and weights
// are still population priors at this stage; per-user personalization
// happens via fitThreeExpAmps in threeExp.js.
//
// Pass an optional opts.sMaxIndex to share a precomputed index across
// multiple lookups in the same render pass. Pass opts.doseK to override
// the dose constant (e.g., from fitDoseK).
// eslint-disable-next-line no-unused-vars
export function getPhysModel(history, hand, grip, opts = {}) {
  const { sMaxIndex = null, doseK = null } = opts;
  // Lazy-import to avoid circular dep — buildSMaxIndex lives in
  // prescription.js which imports from this module.
  const idx = sMaxIndex; // caller is expected to pass it in; null = no sMax
  const sMax = (hand && grip && idx) ? (idx.get(`${hand}|${grip}`) ?? null) : null;
  return {
    ...PHYS_MODEL_DEFAULT,
    sMax,
    doseK: doseK ?? PHYS_MODEL_DEFAULT.doseK,
  };
}

// ─────────────────────────────────────────────────────────────
// SESSION PLANNER — per-rep fatigue curve prediction
// ─────────────────────────────────────────────────────────────
// Uses the canonical three-compartment depletion/recovery model
// (PHYS_MODEL_DEFAULT). Each compartment depletes during a hang and
// recovers during rest. Returns an array of predicted hold times
// (seconds) for each rep. Pass an explicit physModel to use a fitted
// (hand, grip)-specific model; otherwise falls back to defaults.
export function predictRepTimes({ numReps, firstRepTime, restSeconds, physModel = PHYS_MODEL_DEFAULT }) {
  const comps = [
    { A: physModel.weights.fast,   tauD: physModel.tauD.fast,   tauR: physModel.tauR.fast   },
    { A: physModel.weights.medium, tauD: physModel.tauD.medium, tauR: physModel.tauR.medium },
    { A: physModel.weights.slow,   tauD: physModel.tauD.slow,   tauR: physModel.tauR.slow   },
  ];
  const state = comps.map(c => ({ ...c, avail: 1.0 }));
  const times = [];
  for (let i = 0; i < numReps; i++) {
    const capacity = state.reduce((s, c) => s + c.A * c.avail, 0);
    const t = Math.max(0, Math.round(firstRepTime * capacity * 10) / 10);
    times.push(t);
    for (const c of state) {
      const dep = 1 - Math.exp(-t / c.tauD);
      c.avail = Math.max(0, c.avail * (1 - dep));
    }
    if (i < numReps - 1) {
      for (const c of state) {
        const rec = 1 - Math.exp(-restSeconds / c.tauR);
        c.avail = Math.min(1, c.avail + (1 - c.avail) * rec);
      }
    }
  }
  return times;
}

// ─────────────────────────────────────────────────────────────
// PER-COMPARTMENT AUC (training dose delivered to each energy system)
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
    // Use raw weight_kg or avg_force_kg as load; effectiveLoad lives in prescription.js
    const L = (r.avg_force_kg > 0 && r.avg_force_kg < 500) ? r.avg_force_kg : (r.weight_kg || 0);
    if (!t || !L || t <= 0 || L <= 0) continue;
    for (const c of comps) {
      out[c.key] += L * c.A * c.tauD * (1 - Math.exp(-t / c.tauD));
    }
  }
  out.total = out.fast + out.medium + out.slow;
  return out;
}
