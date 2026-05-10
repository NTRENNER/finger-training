// ─────────────────────────────────────────────────────────────
// THREE-EXPONENTIAL FORCE-DURATION MODEL
// ─────────────────────────────────────────────────────────────
// F(T) = a·exp(-T/τ₁) + b·exp(-T/τ₂) + c·exp(-T/τ₃)
//
// IMPORTANT: this model is PHENOMENOLOGICAL, not mechanistic.
// It's a sum of three exponentials with fixed time constants fit to
// force-duration data. The math doesn't require the three terms to
// map to literal PCr / glycolytic / oxidative tissue pools. The
// amplitudes (a, b, c) are regression coefficients that *behave* like
// compartment amplitudes given the chosen time constants — not strict
// tissue probes. We name the components fast / medium / slow for the
// energy systems they approximately align with in the climbing-
// physiology literature; downstream UI uses the "-aligned" suffix to
// keep that distinction visible to users.
//
// τ₁, τ₂, τ₃ are the DEPLETION time constants (PHYS_MODEL_DEFAULT.tauD)
// of the three model components — fast (≈10s, PCr-aligned), medium
// (≈30s, glycolytic-aligned), slow (≈180s, oxidative-aligned). The
// model describes how max sustainable force decays during a sustained
// hold, which is depletion physics, so the basis is the depletion
// taus, not the recovery taus.
//
// Amplitude parameterization (a, b, c ≥ 0 in kg) — Smax = a+b+c falls
// out as the model's prediction at T=0 (i.e. MVC / fresh max).
//
// THIS IS THE ONLY F-D MODEL IN THE APP. The legacy Monod-Scherrer
// (CF + W'/T) model was retired entirely in May 2026 — see the
// validate_taur_vs_taud.js script for the leak-free LOO-CV that
// established three-exp as the empirical winner across every λ tested
// at the time. Three-exp is now used for:
//     - F-D chart primary curve (bold purple solid line)
//     - prescriptionPotential.value (the gap-diagnostic ceiling)
//     - prescribedLoad (curve-derived prescription)
//     - empiricalPrescription (scale-by-residual against the per-grip
//       three-exp curve)
//     - coaching.js residual signal (zoneResidualFactor)
//     - limiter.js cross-zone leave-one-out residual

import { PHYS_MODEL_DEFAULT } from "./fatigue.js";

export const THREE_EXP_LAMBDA_DEFAULT = 100;

// Solve a 3x3 linear system A x = b via Cramer's rule. Internal helper.
function _solve3(A, b) {
  const det = (
    A[0][0]*(A[1][1]*A[2][2] - A[1][2]*A[2][1])
  - A[0][1]*(A[1][0]*A[2][2] - A[1][2]*A[2][0])
  + A[0][2]*(A[1][0]*A[2][1] - A[1][1]*A[2][0])
  );
  if (Math.abs(det) < 1e-12) return null;
  const replaceCol = (col) => A.map((row, ri) => row.map((v, ci) => ci === col ? b[ri] : v));
  const det3 = (m) => (
      m[0][0]*(m[1][1]*m[2][2] - m[1][2]*m[2][1])
    - m[0][1]*(m[1][0]*m[2][2] - m[1][2]*m[2][0])
    + m[0][2]*(m[1][0]*m[2][1] - m[1][1]*m[2][0])
  );
  return [det3(replaceCol(0))/det, det3(replaceCol(1))/det, det3(replaceCol(2))/det];
}

function _solve2(A, b) {
  const det = A[0][0]*A[1][1] - A[0][1]*A[1][0];
  if (Math.abs(det) < 1e-12) return null;
  return [(b[0]*A[1][1] - b[1]*A[0][1]) / det,
          (A[0][0]*b[1] - A[1][0]*b[0]) / det];
}

// Fit three-compartment amplitudes (a, b, c) to failure observations
// with non-negativity constraints and a Gaussian shrinkage prior.
//
//   minimize over (a,b,c) ≥ 0 of:
//     Σᵢ wᵢ · (a·exp(-Tᵢ/τ₁) + b·exp(-Tᵢ/τ₂) + c·exp(-Tᵢ/τ₃) − Fᵢ)²
//     + λ · ((a − a₀)² + (b − b₀)² + (c − c₀)²)
//
// pts:    [{T: duration_s, F: avg_force_kg, w?: weight}]   w defaults to 1
// taus:   [τ₁, τ₂, τ₃] in seconds (defaults to PHYS_MODEL_DEFAULT.tauD —
//         the DEPLETION time constants, since this is a hold-duration
//         decay model, not a rest-period recovery model).
// prior:  [a₀, b₀, c₀] target amplitudes for shrinkage
// lambda: shrinkage strength (0 = no shrinkage; large = ignore data)
//
// Returns [a, b, c] all ≥ 0. Falls back to prior if no points.
export function fitThreeExpAmps(pts, opts = {}) {
  const taus  = opts.taus  || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  const prior = opts.prior || [0, 0, 0];
  const lambda = opts.lambda == null ? 0 : opts.lambda;
  if (!pts || pts.length === 0) return prior.slice();
  const X = pts.map(p => taus.map(t => Math.exp(-p.T / t)));
  const y = pts.map(p => p.F);
  const w = pts.map(p => p.w == null ? 1 : p.w);
  const XtX = [[0,0,0],[0,0,0],[0,0,0]];
  const Xty = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    if (!(w[i] > 0)) continue;
    for (let j = 0; j < 3; j++) {
      Xty[j] += w[i] * X[i][j] * y[i];
      for (let k = 0; k < 3; k++) XtX[j][k] += w[i] * X[i][j] * X[i][k];
    }
  }
  const A = XtX.map((row, j) => row.map((v, k) => v + (j === k ? lambda : 0)));
  const rhs = Xty.map((v, j) => v + lambda * prior[j]);
  const candidates = [];
  const sol3 = _solve3(A, rhs);
  if (sol3 && sol3.every(v => v >= -1e-9)) candidates.push(sol3.map(v => Math.max(0, v)));
  for (let zero = 0; zero < 3; zero++) {
    const free = [0,1,2].filter(i => i !== zero);
    const A2 = [[A[free[0]][free[0]], A[free[0]][free[1]]],
                [A[free[1]][free[0]], A[free[1]][free[1]]]];
    const sol2 = _solve2(A2, [rhs[free[0]], rhs[free[1]]]);
    if (sol2 && sol2.every(v => v >= -1e-9)) {
      const sol = [0, 0, 0];
      sol[free[0]] = Math.max(0, sol2[0]);
      sol[free[1]] = Math.max(0, sol2[1]);
      candidates.push(sol);
    }
  }
  for (let nz = 0; nz < 3; nz++) {
    if (A[nz][nz] < 1e-12) continue;
    const v = rhs[nz] / A[nz][nz];
    if (v >= -1e-9) {
      const sol = [0, 0, 0];
      sol[nz] = Math.max(0, v);
      candidates.push(sol);
    }
  }
  candidates.push([0, 0, 0]);
  const objective = (beta) => {
    let r = 0;
    for (let i = 0; i < pts.length; i++) {
      if (!(w[i] > 0)) continue;
      const pred = X[i][0]*beta[0] + X[i][1]*beta[1] + X[i][2]*beta[2];
      r += w[i] * (pred - y[i]) ** 2;
    }
    for (let j = 0; j < 3; j++) r += lambda * (beta[j] - prior[j]) ** 2;
    return r;
  };
  let best = candidates[0];
  let bestObj = objective(best);
  for (let c = 1; c < candidates.length; c++) {
    const o = objective(candidates[c]);
    if (o < bestObj) { best = candidates[c]; bestObj = o; }
  }
  return best;
}

// Three-exp fit with success-floor enforcement. Failures anchor the
// curve; successes act as LOWER BOUNDS (you held F for T without
// failing → the curve at T must be ≥ F). Without this, prescriptions
// lag actual capacity whenever the user clears a target instead of
// pushing to true failure.
//
// Algorithm: start with a failure-only fit, iteratively bump weights of
// any success points that violate the lower bound, refit until no more
// violations or maxIter reached.
//
// NOTE: Under the train-to-failure data model (May 2026), every rep is
// a failure data point, so this success-floor variant is no longer
// called from production paths. Kept exported for any external callers
// or future re-introduction; the production fit is fitThreeExpAmps.
//
// failurePts: [{T, F}]
// successPts: [{T, F}]
// opts: { taus?, prior?, lambda?, maxIter?, tol?, weightStep? }
//
// Returns [a, b, c] all ≥ 0, or null if not enough data.
export function fitThreeExpAmpsWithSuccessFloor(failurePts, successPts, opts = {}) {
  const { maxIter = 60, tol = 0.1, weightStep = 4.0, ...fitOpts } = opts;
  const failures = (failurePts || []).map(p => ({ T: p.T, F: p.F, w: 1 }));
  const successes = successPts || [];
  if (failures.length + successes.length < 2) return null;

  let amps = failures.length >= 1 ? fitThreeExpAmps(failures, fitOpts) : null;
  if (!amps || (amps[0] + amps[1] + amps[2]) <= 0) {
    // Seed with successes too if failures alone produced nothing
    const seed = [...failures, ...successes.map(p => ({ T: p.T, F: p.F, w: 1 }))];
    amps = fitThreeExpAmps(seed, fitOpts);
  }
  if (!amps) return null;
  if (successes.length === 0) return amps;

  const succWeights = successes.map(() => 0);
  for (let iter = 0; iter < maxIter; iter++) {
    let anyViolation = false;
    for (let i = 0; i < successes.length; i++) {
      const s = successes[i];
      const pred = predForceThreeExp(amps, s.T, fitOpts.taus);
      if (pred < s.F - tol) {
        succWeights[i] += weightStep;
        anyViolation = true;
      }
    }
    if (!anyViolation) break;
    const augmented = [...failures];
    for (let i = 0; i < successes.length; i++) {
      if (succWeights[i] > 0) {
        augmented.push({ T: successes[i].T, F: successes[i].F, w: succWeights[i] });
      }
    }
    const next = fitThreeExpAmps(augmented, fitOpts);
    if (!next) break;
    amps = next;
  }
  return amps;
}

// Predict force at duration T given fitted amplitudes [a, b, c].
// Uses PHYS_MODEL_DEFAULT.tauD by default — see header for why this is
// the depletion basis, not the recovery basis.
export function predForceThreeExp(amps, T, taus = null) {
  const tau = taus || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  return amps[0]*Math.exp(-T/tau[0]) + amps[1]*Math.exp(-T/tau[1]) + amps[2]*Math.exp(-T/tau[2]);
}

// Definite integral of the three-exp F-D curve over [tMin, tMax]:
//   ∫ a·e^(-t/τ) dt = a·τ·(e^(-tMin/τ) - e^(-tMax/τ))
// Sum over the three compartments. Units = force·seconds (force-area).
//
// Used as a single "total capacity" scalar for the Journey/AUC tracker
// — captures the area beneath the user's whole curve from the Power
// boundary out into deep Endurance, so growth in any compartment
// contributes proportionally to how much that compartment dominates
// in its zone. Default range [5, 180] covers the meaningful training
// span (post-fast-spike at 5s, well into oxidative steady-state at 3min).
export function computeAUCThreeExp(amps, tMin = 5, tMax = 180, taus = null) {
  if (!Array.isArray(amps) || amps.length !== 3) return 0;
  const tau = taus || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  let sum = 0;
  for (let i = 0; i < 3; i++) {
    const a = amps[i];
    const t = tau[i];
    if (!isFinite(a) || a <= 0 || !isFinite(t) || t <= 0) continue;
    sum += a * t * (Math.exp(-tMin / t) - Math.exp(-tMax / t));
  }
  return sum;
}

// Build per-grip three-exp prior by pooling all that grip's data
// across hands. Used as the shrinkage target for per-(hand, grip) fits.
// Returns Map<grip, [a, b, c]>. Pooling within-grip avoids the cross-
// muscle (FDP vs FDS) amplitude contamination that broke the global
// pooled prior in offline validation.
//
// Train-to-failure model (May 2026): every rep with valid
// actual_time_s is a (T, F) failure data point. The legacy r.failed
// filter is gone — every rep contributes uniformly.
export function buildThreeExpPriors(history) {
  const byGrip = {};
  for (const r of history || []) {
    if (!r.grip) continue;
    if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push({ T: r.actual_time_s, F: r.avg_force_kg });
  }
  const out = new Map();
  for (const [grip, pts] of Object.entries(byGrip)) {
    if (pts.length < 2) continue;
    out.set(grip, fitThreeExpAmps(pts, { lambda: 0 }));
  }
  return out;
}
