// ─────────────────────────────────────────────────────────────
// THREE-EXPONENTIAL FORCE-DURATION MODEL
// ─────────────────────────────────────────────────────────────
// F(T) = a·exp(-T/τ₁) + b·exp(-T/τ₂) + c·exp(-T/τ₃)
//
// τ₁, τ₂, τ₃ are the DEPLETION time constants (PHYS_MODEL_DEFAULT.tauD)
// of the three energy compartments — fast (PCr ≈10s), medium (glycolytic
// ≈30s), slow (oxidative ≈180s). The model describes how max sustainable
// force decays during a sustained hold, which is depletion physics, so
// the basis is the depletion taus, not the recovery taus.
//
// (Earlier versions of this model used tauR as the basis by accident —
// inherited from the rest-period fatigue decay model where tauR is the
// correct choice. Switching to tauD is both conceptually correct and
// empirically better: leak-free LOO-CV on pooled history shows tauD
// reduces RMSE by an additional ~3-4% over tauR at λ=100, doubling the
// improvement over Monod from ~4% to ~7%. See validate_taur_vs_taud.js.)
//
// Amplitude parameterization (a, b, c ≥ 0 in kg) — equivalent to the
// Smax × {weights} form but easier to fit because the constraint is
// just non-negativity instead of "weights sum to 1." Smax = a+b+c
// falls out as the model's prediction at T=0 (i.e. MVC / fresh max).
//
// Role in the app's hierarchy:
//   - PRIMARY potential model — drives prescriptionPotential.value
//     when well-supported, surfaces as the "target" curve on the
//     F-D chart.
//   - Validated offline (leak-free LOO-CV on pooled history) to beat
//     Monod by ~7% RMSE at λ=100 with per-grip prior + shrinkage.
//   - Especially valuable at the extremes (Power, Capacity) where
//     Monod's hyperbolic shape is provably too rigid to fit both
//     short-T successes and middle-T failures simultaneously.

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
//     Σᵢ (a·exp(-Tᵢ/τ₁) + b·exp(-Tᵢ/τ₂) + c·exp(-Tᵢ/τ₃) − Fᵢ)²
//     + λ · ((a − a₀)² + (b − b₀)² + (c − c₀)²)
//
// pts:    [{T: duration_s, F: avg_force_kg}]
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
  const XtX = [[0,0,0],[0,0,0],[0,0,0]];
  const Xty = [0, 0, 0];
  for (let i = 0; i < pts.length; i++) {
    for (let j = 0; j < 3; j++) {
      Xty[j] += X[i][j] * y[i];
      for (let k = 0; k < 3; k++) XtX[j][k] += X[i][j] * X[i][k];
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
      const pred = X[i][0]*beta[0] + X[i][1]*beta[1] + X[i][2]*beta[2];
      r += (pred - y[i]) ** 2;
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

// Predict force at duration T given fitted amplitudes [a, b, c].
// Uses PHYS_MODEL_DEFAULT.tauD by default — see header for why this is
// the depletion basis, not the recovery basis.
export function predForceThreeExp(amps, T, taus = null) {
  const tau = taus || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  return amps[0]*Math.exp(-T/tau[0]) + amps[1]*Math.exp(-T/tau[1]) + amps[2]*Math.exp(-T/tau[2]);
}

// Build per-grip three-exp prior by pooling all that grip's failures
// across hands. Used as the shrinkage target for per-(hand, grip) fits.
// Returns Map<grip, [a, b, c]>. Pooling within-grip avoids the cross-
// muscle (FDP vs FDS) amplitude contamination that broke the global
// pooled prior in offline validation.
export function buildThreeExpPriors(history) {
  const byGrip = {};
  for (const r of history || []) {
    if (!r.failed || !r.grip) continue;
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
