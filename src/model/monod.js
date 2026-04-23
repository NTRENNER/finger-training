// ─────────────────────────────────────────────────────────────
// MONOD-SCHERRER FORCE-DURATION MODEL
// ─────────────────────────────────────────────────────────────
// F(T) = CF + W'/T   where CF is the sustainable aerobic asymptote
// and W' is the finite anaerobic capacity above CF.
//
// Role in the app's hierarchy:
//   - Failure-only Monod fit (fitCF) drives the F-D chart's primary
//     curve display — intentionally honest about your data shape.
//   - fitCFWithSuccessFloor (Monod with success constraints) drives
//     the prescription FALLBACK path (when no recent rep 1 exists for
//     the empirical-first prescription) and the "potential" calculation
//     where three-exp isn't yet well-supported.
//   - Three-exp has been promoted as the primary "potential" model
//     (see threeExp.js) — Monod is now a backup / second opinion.

// pts: array of { x: 1/duration_s, y: avg_force_kg }
// Returns { CF, W, n } or null if not enough data / degenerate.
export function fitCF(pts) {
  if (!pts || pts.length < 2) return null;
  const n   = pts.length;
  const sx  = pts.reduce((a, p) => a + p.x, 0);
  const sy  = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const W  = (n * sxy - sx * sy) / den;
  const CF = (sy - W * sx) / n;
  if (CF < 0 || W < 0) return null;
  return { CF, W, n };
}

// Weighted Monod-Scherrer fit. pts: array of { x, y, w? }, default w = 1.
// Same model as fitCF (F = CF + W'/T) but allows per-point weighting.
export function fitCFWeighted(pts) {
  if (!pts || pts.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0, n = 0;
  for (const p of pts) {
    const w = p.w == null ? 1 : p.w;
    if (!(w > 0)) continue;
    sw  += w;
    swx += w * p.x;
    swy += w * p.y;
    swxx += w * p.x * p.x;
    swxy += w * p.x * p.y;
    n++;
  }
  if (n < 2 || sw <= 0) return null;
  const den = sw * swxx - swx * swx;
  if (Math.abs(den) < 1e-12) return null;
  const W  = (sw * swxy - swx * swy) / den;
  const CF = (swy - W * swx) / sw;
  if (CF < 0 || W < 0) return null;
  return { CF, W, n };
}

// Like fitCFWeighted but doesn't reject negative CF or W. Exists for
// fitCFWithSuccessFloor's iteration where intermediate iterates may go
// negative on the way to a valid clamped fit.
export function fitCFWeightedRaw(pts) {
  if (!pts || pts.length < 2) return null;
  let sw = 0, swx = 0, swy = 0, swxx = 0, swxy = 0, n = 0;
  for (const p of pts) {
    const w = p.w == null ? 1 : p.w;
    if (!(w > 0)) continue;
    sw  += w;
    swx += w * p.x;
    swy += w * p.y;
    swxx += w * p.x * p.x;
    swxy += w * p.x * p.y;
    n++;
  }
  if (n < 2 || sw <= 0) return null;
  const den = sw * swxx - swx * swx;
  if (Math.abs(den) < 1e-12) return null;
  const W  = (sw * swxy - swx * swy) / den;
  const CF = (swy - W * swx) / sw;
  return { CF, W, n };
}

// Monod fit with success-floor constraint. Failures anchor the curve
// directly (you failed at L for T → curve passes through that point).
// Successes act as LOWER BOUNDS on the curve: held L for T without
// failing → curve at T must be ≥ L. Without this, prescriptions lag
// actual capacity whenever the user clears a target instead of pushing
// to true failure.
//
// Algorithm: start with the failure-only fit, iteratively bump weights
// of any success points that violate the lower bound, refit until
// converged or maxIter reached. Uses the raw weighted-LS solver
// (fitCFWeightedRaw) so intermediate iterates with negative CF or W
// don't abort the iteration; clamped to physical values at the end.
//
// failurePts/successPts: arrays of { x: 1/T, y: load }
export function fitCFWithSuccessFloor(failurePts, successPts, opts = {}) {
  const { maxIter = 60, tol = 0.1, weightStep = 4.0 } = opts;
  const failures = (failurePts || []).map(p => ({ x: p.x, y: p.y, w: 1 }));
  const successes = successPts || [];
  if (failures.length + successes.length < 2) return null;

  // Initial fit: failures alone if we have ≥ 2. If failures are sparse
  // or produce a degenerate fit, seed with successes too.
  let fit = failures.length >= 2 ? fitCFWeighted(failures) : null;
  if (!fit && successes.length >= 1) {
    const seed = [...failures, ...successes.map(p => ({ x: p.x, y: p.y, w: 1 }))];
    fit = fitCFWeighted(seed);
  }
  if (!fit) return null;
  if (successes.length === 0) return fit;

  const succWeights = successes.map(() => 0);
  for (let iter = 0; iter < maxIter; iter++) {
    let anyViolation = false;
    for (let i = 0; i < successes.length; i++) {
      const s = successes[i];
      const pred = fit.CF + fit.W * s.x;
      if (pred < s.y - tol) {
        succWeights[i] += weightStep;
        anyViolation = true;
      }
    }
    if (!anyViolation) break;

    const augmented = [...failures];
    for (let i = 0; i < successes.length; i++) {
      if (succWeights[i] > 0) {
        augmented.push({ x: successes[i].x, y: successes[i].y, w: succWeights[i] });
      }
    }
    const newFit = fitCFWeightedRaw(augmented);
    if (!newFit) break;
    fit = {
      CF: Math.max(0, newFit.CF),
      W:  Math.max(0, newFit.W),
      n:  newFit.n,
    };
  }
  return fit;
}

// Predicted force at a given duration (s) from a CF/W fit.
export function predForce(fit, t) { return fit.CF + fit.W / t; }

// Area under F = CF + W/t from tMin to tMax (analytical integral).
// = CF*(tMax-tMin) + W*ln(tMax/tMin)
// Units: kg·s — captures total capacity across the full duration range.
export function computeAUC(CF, W, tMin = 10, tMax = 120) {
  return CF * (tMax - tMin) + W * Math.log(tMax / tMin);
}

// Adaptive per-hand fit. If both hands' CFs agree within tolerance,
// pool them. If they diverge sharply, trust the ceiling hand (the
// weaker hand is typically noise — sparse data, fatigue, mis-logged
// failures). Returns { CF, W, n } or null.
export function fitAdaptiveHandCurve(rows) {
  const CF_ASYMMETRY_TOL = 0.20;
  if (!rows || rows.length < 2) return null;
  const fitFor = (subset) => {
    if (subset.length < 2) return null;
    const durs = new Set(subset.map(r => r.target_duration));
    if (durs.size < 2) return null;
    return fitCF(subset.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
  };
  const fitL = fitFor(rows.filter(r => r.hand === "L"));
  const fitR = fitFor(rows.filter(r => r.hand === "R"));
  const fitPooled = fitFor(rows);
  if (fitL && fitR) {
    const cfHi = Math.max(fitL.CF, fitR.CF);
    const cfLo = Math.min(fitL.CF, fitR.CF);
    const asym = cfHi > 0 ? (cfHi - cfLo) / cfHi : 0;
    if (asym <= CF_ASYMMETRY_TOL) return fitPooled ?? (fitL.CF >= fitR.CF ? fitL : fitR);
    return fitL.CF >= fitR.CF ? fitL : fitR;
  }
  if (fitL) return fitL;
  if (fitR) return fitR;
  return fitPooled;
}
