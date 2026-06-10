// ─────────────────────────────────────────────────────────────
// THREE-EXPONENTIAL FORCE-DURATION MODEL
// ─────────────────────────────────────────────────────────────
// F(T) = a·exp(-T/τ₁) + b·exp(-T/τ₂) + c·exp(-T/τ₃)
//
// IMPORTANT: this is a three-timescale regression model, not a tissue
// measurement. F(T) is a sum of three decaying exponentials with fixed
// time constants chosen so the components separate cleanly across the
// 5–240s prescription range. The amplitudes (a, b, c) are regression
// coefficients fit per (hand, grip). The literature draws metaphors to
// PCr / glycolytic / oxidative tissue pools at these timescales, but
// we don't validate compartment identification — calling the components
// fast / medium / slow is honest about what the math is doing
// (timescale ordering); calling them by tissue names would be an
// overclaim the fit doesn't support.
//
// τ₁, τ₂, τ₃ are the DEPLETION time constants (PHYS_MODEL_DEFAULT.tauD)
// of the three model components — fast (≈10s), medium (≈30s), slow
// (≈180s). The model describes how max sustainable force decays during
// a sustained hold, which is depletion physics, so the basis is the
// depletion taus, not the recovery taus.
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
//     - prescription() value AND potential (anchored + unanchored
//       evaluations of the same per-grip three-exp fit)
//     - coaching.js continuous engine: per-T LOO residual ratios drive
//       the log-T-smoothed adaptBoost in coachingRecommendationContinuous
//       (fitThreeExpAmpsLOO, below)
 
import { PHYS_MODEL_DEFAULT } from "./fatigue.js";
import { ZONE_REF_T } from "./zones.js";
import { effectiveLoad, freshFitReps } from "./load.js";
 
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
 
// Fit three-component amplitudes (a, b, c) to failure observations
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
 
// (fitThreeExpAmpsWithSuccessFloor retired May 2026. Successes were
// lower-bound constraints when the data model distinguished success
// vs. failure; under train-to-failure every rep is a (T, F) point so
// the success-floor iteration was a no-op. The plain fitThreeExpAmps
// is the only fit path now — see prescription.js + AnalysisView.)
 
// ─────────────────────────────────────────────────────────────
// LEAVE-ONE-OUT RESIDUAL RATIOS  (closed form, June 2026)
// ─────────────────────────────────────────────────────────────
// The coaching engine reads "where do you fall below your curve" from
// per-rep residual ratios F_actual / F_curve. Computed in-sample, that
// signal is biased toward 1: the curve is fit to those same points, so
// it chases them and real limiters look milder than they are. The fix
// was previously a CONFIDENCE GATE that suppressed the signal in thin
// data — but suppression isn't de-biasing, it just mutes everything.
//
// Because the fit is RIDGE-LINEAR in the fixed-tau exponential basis,
// the honest leave-one-out residual is available in closed form, with
// no refitting. For a linear smoother ŷ = S·y (here the weighted ridge
// hat matrix S = Xₐ(XₐᵀWXₐ + λI)⁻¹XₐᵀW over the ACTIVE columns — the
// components that come back non-zero from the NNLS fit), the standard
// identity gives the leave-one-out prediction:
//     ŷ_loo,i = y_i − (y_i − ŷ_i) / (1 − h_ii),   h_ii = S_ii
// so the de-biased ratio is r_loo,i = y_i / ŷ_loo,i. This is the same
// algebra GCV uses; it's exact for the linear (active-set-fixed) fit
// and a tight approximation when leaving a point out doesn't flip the
// active set (the common case — a single short rep rarely zeros a
// component the rest of the data supports).
//
// We approximate true leave-one-OUT with leave-one-out only over the
// active linear system. The NNLS active set is held fixed at the full
// fit's; (1 − h_ii) is floored away from 0 so a high-leverage lone
// point can't produce an infinite ratio. Where the active set is empty
// (degenerate fit) every ratio is 1.0 (neutral).
//
// Returns { amps, ratios } where ratios[i] aligns with pts[i]:
//   ratios[i] = F_actual,i / F_curve_loo,i   ( <1 → below curve, room )
// taus default to PHYS_MODEL_DEFAULT.tauD (see header).
export function fitThreeExpAmpsLOO(pts, opts = {}) {
  const amps = fitThreeExpAmps(pts, opts);
  const n = pts ? pts.length : 0;
  if (n === 0) return { amps, ratios: [] };
 
  const taus = opts.taus || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  const lambda = opts.lambda == null ? 0 : opts.lambda;
 
  // Active columns = components the NNLS fit kept above ~0.
  const active = [0, 1, 2].filter(j => amps[j] > 1e-9);
  const X = pts.map(p => taus.map(t => Math.exp(-p.T / t)));
  const y = pts.map(p => p.F);
  const w = pts.map(p => (p.w == null ? 1 : p.w));
 
  // Degenerate fit → neutral ratios.
  if (active.length === 0) return { amps, ratios: pts.map(() => 1.0) };
 
  // Active-column design Xa and the ridge normal matrix M = XaᵀWXa + λI.
  const k = active.length;
  const M = Array.from({ length: k }, () => new Array(k).fill(0));
  for (let i = 0; i < n; i++) {
    if (!(w[i] > 0)) continue;
    for (let a = 0; a < k; a++) {
      const xa = X[i][active[a]];
      for (let b = 0; b < k; b++) M[a][b] += w[i] * xa * X[i][active[b]];
    }
  }
  for (let a = 0; a < k; a++) M[a][a] += lambda;
 
  const Minv = _invSym(M);
  if (!Minv) return { amps, ratios: pts.map(() => 1.0) };
 
  // h_ii = w_i · xaᵢᵀ M⁻¹ xaᵢ  (diagonal of the weighted ridge smoother).
  const ratios = pts.map((p, i) => {
    const xa = active.map(j => X[i][j]);
    let h = 0;
    for (let a = 0; a < k; a++) {
      let mv = 0;
      for (let b = 0; b < k; b++) mv += Minv[a][b] * xa[b];
      h += xa[a] * mv;
    }
    h *= w[i];
    const yhat = active.reduce((s, j) => s + amps[j] * X[i][j], 0);
    const denom = Math.max(1 - h, 0.1);   // floor leverage so no blow-ups
    const yhatLoo = y[i] - (y[i] - yhat) / denom;
    return yhatLoo > 0 ? y[i] / yhatLoo : 1.0;
  });
  return { amps, ratios };
}
 
// Invert a small symmetric positive-definite matrix (k ≤ 3) via
// Gauss-Jordan. Returns null if singular. Internal helper for the
// LOO hat-matrix diagonal.
function _invSym(M) {
  const k = M.length;
  const A = M.map((row, i) => [...row, ...Array.from({ length: k }, (_, j) => (i === j ? 1 : 0))]);
  for (let col = 0; col < k; col++) {
    let piv = col;
    for (let r = col + 1; r < k; r++) if (Math.abs(A[r][col]) > Math.abs(A[piv][col])) piv = r;
    if (Math.abs(A[piv][col]) < 1e-12) return null;
    [A[col], A[piv]] = [A[piv], A[col]];
    const d = A[col][col];
    for (let j = 0; j < 2 * k; j++) A[col][j] /= d;
    for (let r = 0; r < k; r++) {
      if (r === col) continue;
      const f = A[r][col];
      for (let j = 0; j < 2 * k; j++) A[r][j] -= f * A[col][j];
    }
  }
  return A.map(row => row.slice(k));
}
 
// Predict force at duration T given fitted amplitudes [a, b, c].
// Uses PHYS_MODEL_DEFAULT.tauD by default — see header for why this is
// the depletion basis, not the recovery basis.
export function predForceThreeExp(amps, T, taus = null) {
  const tau = taus || [PHYS_MODEL_DEFAULT.tauD.fast, PHYS_MODEL_DEFAULT.tauD.medium, PHYS_MODEL_DEFAULT.tauD.slow];
  return amps[0]*Math.exp(-T/tau[0]) + amps[1]*Math.exp(-T/tau[1]) + amps[2]*Math.exp(-T/tau[2]);
}
 
// BALANCED CURVE SCORE — a single "whole-curve capacity" scalar.
//
// Replaces the old computeAUCThreeExp (force-time integral) as the
// headline capacity number for the Journey / Curve-Improvement tracker.
// Why the change (May 2026): the time-integral ∫a·τ·(…) scales with τ,
// so the slow component (τ=180) contributed ~95–97% of the total on
// real fits — the "total capacity" number was effectively a pure
// endurance metric, and a genuine max-strength gain barely moved it.
//
// The balanced score is the GEOMETRIC MEAN of predicted force at the
// six zone reference times (ZONE_REF_T: 5/30/70/115/160/220 s). The
// geometric mean is the right aggregator because the % change of a
// geometric mean equals the AVERAGE of the per-zone % changes:
//   d·log(GM) = (1/n)·Σ d·log(F_zone) = (1/n)·Σ (ΔF/F)_zone
// so an equal % improvement in ANY zone moves the score equally —
// "reward improvement across the whole curve, not just the slow tail."
// (An arithmetic mean of forces would instead be dominated by the
// high-force short-duration zones — the opposite bias.) Units = kg.
export function computeBalancedCurveScore(amps, taus = null) {
  if (!Array.isArray(amps) || amps.length !== 3) return 0;
  const refTs = Object.values(ZONE_REF_T);
  let logSum = 0;
  let n = 0;
  for (const t of refTs) {
    const f = predForceThreeExp(amps, t, taus);
    if (isFinite(f) && f > 0) { logSum += Math.log(f); n++; }
  }
  if (n === 0) return 0;
  return Math.exp(logSum / n);
}
 
// Build per-grip three-exp prior by pooling all that grip's data
// across hands. Used as the shrinkage target for per-(hand, grip) fits.
// Returns Map<grip, [a, b, c]>. Pooling within-grip avoids the cross-
// muscle (FDP vs FDS) amplitude contamination that broke the global
// pooled prior in offline validation.
//
// Train-to-failure model (May 2026): every rep with valid
// actual_time_s is a (T, F) failure data point. The legacy r.failed
// filter is gone — every rep contributes uniformly. Load comes from
// effectiveLoad (Tindeq ?? manual ?? prescribed ?? legacy) so manual /
// non-Tindeq reps aren't silently dropped from the prior.
// `opts.upTo` (an ISO date string) builds a LEAK-FREE prior: only reps
// on or before that date are pooled. This matters for BASELINE fits —
// the baseline curve must be anchored toward the data that existed when
// the baseline window closed, NOT the whole (future-inclusive) history.
// A whole-history prior pools your recent, stronger reps; the small,
// heavily-shrunk baseline window then gets dragged UP toward your
// current strength, erasing real improvement. Current/"now" fits pass
// no cutoff (they legitimately see everything).
export function buildThreeExpPriors(history, { upTo = null } = {}) {
  const byGrip = {};
  // Fresh + de-duped, so the prior matches the baseline/estimate/overlay
  // fits — otherwise a contaminated all-reps prior drags the small,
  // heavily-shrunk baseline window down and inflates improvement %.
  for (const r of freshFitReps(history)) {
    if (!r.grip) continue;
    if (upTo && r.date && r.date > upTo) continue;   // leak-free cutoff
    const F = effectiveLoad(r);
    if (!(F > 0)) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!byGrip[r.grip]) byGrip[r.grip] = [];
    byGrip[r.grip].push({ T: r.actual_time_s, F });
  }
  const out = new Map();
  for (const [grip, pts] of Object.entries(byGrip)) {
    if (pts.length < 2) continue;
    out.set(grip, fitThreeExpAmps(pts, { lambda: 0 }));
  }
  return out;
}
