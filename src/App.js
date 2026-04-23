// src/App.js  — Finger Training v3
// Rep-based sessions · Three-Compartment Fatigue Model · Tindeq Progressor BLE · Gamification
import React, {
  useCallback, useEffect, useMemo, useRef, useState,
} from "react";
import { supabase } from "./lib/supabase";
import {
  ResponsiveContainer, LineChart, Line, ComposedChart, Scatter,
  BarChart, Bar,
  XAxis, YAxis, Tooltip, CartesianGrid, Legend,
  ReferenceLine, ReferenceArea,
} from "recharts";

// ─────────────────────────────────────────────────────────────
// CONSTANTS
// ─────────────────────────────────────────────────────────────
const LS_KEY       = "ft_v3";
const LS_QUEUE_KEY = "ft_push_queue"; // reps that failed to reach Supabase

// Tindeq Progressor BLE UUIDs & commands
// NOTE: If your Progressor firmware uses a different packet format,
//       adjust parseTindeqPacket() below.
const TINDEQ_SERVICE = "7e4e1701-1ea6-40c9-9dcc-13d34ffead57";
const TINDEQ_NOTIFY  = "7e4e1702-1ea6-40c9-9dcc-13d34ffead57";
const TINDEQ_WRITE   = "7e4e1703-1ea6-40c9-9dcc-13d34ffead57";
const CMD_TARE  = new Uint8Array([0x64]); // zero/tare the scale
const CMD_START = new Uint8Array([0x65]); // start weight measurement
const CMD_STOP  = new Uint8Array([0x66]); // stop weight measurement
const RESPONSE_WEIGHT = 0x01;

const TARGET_OPTIONS = [
  { label: "Power",     seconds: 10  },
  { label: "Strength",  seconds: 45  },
  { label: "Capacity",  seconds: 120 },
];

const GRIP_PRESETS = ["Crusher", "Micro", "Thunder"];

// ─────────────────────────────────────────────────────────────
// CANONICAL THREE-COMPARTMENT PHYSIOLOGICAL MODEL
// ─────────────────────────────────────────────────────────────
// A single source of truth for the three-compartment model used by
// every downstream calculation: fatigue accumulation, rep-time
// prediction, AUC dose attribution, capacity-zone labels, and (in
// the next migration step) the force-duration curve itself.
//
// Compartments map to the bioenergetic systems:
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
// to fresh maximal force. They are population priors for now; the
// follow-up commit (fitThreeExpModel) will personalize them per
// (hand, grip) from history with shrinkage to these defaults.
//
// sMax is per-(hand, grip) and gets filled in by getPhysModel() from
// the user's actual history; it isn't a population constant.
const PHYS_MODEL_DEFAULT = {
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
const DEF_FAT = {
  A1: PHYS_MODEL_DEFAULT.weights.fast,   tau1: PHYS_MODEL_DEFAULT.tauR.fast,
  A2: PHYS_MODEL_DEFAULT.weights.medium, tau2: PHYS_MODEL_DEFAULT.tauR.medium,
  A3: PHYS_MODEL_DEFAULT.weights.slow,   tau3: PHYS_MODEL_DEFAULT.tauR.slow,
};

const LS_NOTES_KEY     = "ft_notes";     // { [session_id]: string }
const LS_BW_KEY        = "ft_bw";        // body weight in kg (number)
const LS_BW_LOG_KEY    = "ft_bw_log";    // [{ date, kg }] body weight history
const LS_READINESS_KEY = "ft_readiness"; // { [date]: 1-5 } subjective daily rating
const LS_BASELINE_KEY  = "ft_baseline";  // { date, CF, W } — permanent first-calibration snapshot
const LS_ACTIVITY_KEY  = "ft_activity";  // [{ id, date, type: "climbing", discipline, grade, ascent }] — legacy entries may carry { duration_min, intensity } instead
const LS_GENESIS_KEY   = "ft_genesis";   // { date, CF, W, auc } — snapshot when first all-zone coverage earned

const LEVEL_STEP = 1.05; // 5% improvement per level

// Level display — numeric only, no old badge names
const LEVEL_EMOJIS = ["🌱","🏛️","📈","⚡","⚙️","🔥","🏔️","⭐","💎","🏆","🌟"];

// ─────────────────────────────────────────────────────────────
// UTILITIES
// ─────────────────────────────────────────────────────────────
const uid     = () => Math.random().toString(36).slice(2, 10);
// Local-date YYYY-MM-DD. toISOString() converts to UTC, which dated
// evening reps to "tomorrow" for users west of UTC (e.g. a 22:00
// Pacific rep would land on the next day's row, breaking the
// "this session was today" check in computeReadiness and friends).
const ymdLocal = (d = new Date()) => {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
};
const today   = () => ymdLocal();
const nowISO      = () => new Date().toISOString();
const fmtClock    = (iso) => { try { return new Date(iso).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }); } catch { return ""; } };
// Return the most recent BW log entry on or before `date` (YYYY-MM-DD), or null.
const bwOnDate = (bwLog, date) => {
  const candidates = (bwLog || []).filter(e => e.date <= date);
  return candidates.length ? candidates[candidates.length - 1] : null;
};
const clamp  = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const fmt1   = (n) => (typeof n === "number" && isFinite(n)) ? n.toFixed(1) : "—";
const fmt0   = (n) => (typeof n === "number" && isFinite(n)) ? String(Math.round(n)) : "—";

const KG_TO_LBS = 2.20462;
// Convert stored kg → display unit
const toDisp   = (kg, unit) => (unit === "lbs" && typeof kg === "number") ? kg * KG_TO_LBS : kg;
// Convert display unit → kg for storage
const fromDisp = (val, unit) => (unit === "lbs" && typeof val === "number") ? val / KG_TO_LBS : val;
// Format a kg value for display in the current unit
const fmtW = (kg, unit) => fmt1(toDisp(kg, unit));
const fmtTime = (s) => {
  if (!isFinite(s) || s < 0) return "—";
  const m = Math.floor(s / 60), sec = Math.floor(s % 60);
  return m > 0 ? `${m}:${String(sec).padStart(2, "0")}` : `${Math.floor(s)}s`;
};

const loadLS = (key) => {
  try { const r = localStorage.getItem(key); return r ? JSON.parse(r) : null; }
  catch { return null; }
};
const saveLS = (key, v) => {
  try { localStorage.setItem(key, JSON.stringify(v)); } catch {}
};

function toCSV(reps) {
  const cols = ["id","date","grip","hand","target_duration","weight_kg",
                "actual_time_s","peak_force_kg","set_num","rep_num","rest_s","session_id"];
  const esc  = (v) => { const s = String(v ?? ""); return /[",\n]/.test(s) ? `"${s.replace(/"/g,'""')}"` : s; };
  return [cols.join(","), ...reps.map(r => cols.map(c => esc(r[c])).join(","))].join("\n");
}
function downloadCSV(reps) {
  const blob = new Blob([toCSV(reps)], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "finger-training-history.csv",
  });
  a.click();
}

function downloadWorkoutCSV(log) {
  // Flatten sessions → one row per set
  const rows = [];
  for (const s of log) {
    for (const [exId, exData] of Object.entries(s.exercises || {})) {
      const exName = exId.replace(/_/g, " ");
      if (exData.sets && exData.sets.length > 0) {
        exData.sets.forEach((set, i) => {
          rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, i + 1, set.reps ?? "", set.weight ?? "", set.done ? "yes" : "no"]);
        });
      } else {
        rows.push([s.date, s.completedAt || "", s.workout || "", s.sessionNumber || "", exName, "", "", "", exData.done ? "yes" : "no"]);
      }
    }
  }
  const header = ["date", "completed_at", "workout", "session_number", "exercise", "set", "reps", "weight", "done"];
  const csv = [header, ...rows].map(r => r.map(v => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
  const blob = new Blob([csv], { type: "text/csv" });
  const a = Object.assign(document.createElement("a"), {
    href: URL.createObjectURL(blob), download: "workout-history.csv",
  });
  a.click();
}

// ─────────────────────────────────────────────────────────────
// MONOD-SCHERRER CURVE FIT  (standalone — used by AnalysisView & auto-baseline)
// ─────────────────────────────────────────────────────────────
// pts: array of { x: 1/duration_s, y: avg_force_kg }
// Returns { CF, W, n } or null if not enough data / degenerate.
function fitCF(pts) {
  if (!pts || pts.length < 2) return null;
  const n   = pts.length;
  const sx  = pts.reduce((a, p) => a + p.x, 0);
  const sy  = pts.reduce((a, p) => a + p.y, 0);
  const sxx = pts.reduce((a, p) => a + p.x * p.x, 0);
  const sxy = pts.reduce((a, p) => a + p.x * p.y, 0);
  const den = n * sxx - sx * sx;
  if (Math.abs(den) < 1e-12) return null;
  const W  = (n * sxy - sx * sy) / den;   // slope  = W′  (kg·s)
  const CF = (sy - W * sx) / n;           // intercept = CF (kg)
  if (CF < 0 || W < 0) return null;
  return { CF, W, n };
}

// Weighted Monod-Scherrer fit. pts: array of { x, y, w? }, default w = 1.
// Same model as fitCF (F = CF + W'/T) but allows per-point weighting.
function fitCFWeighted(pts) {
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

// Monod-Scherrer fit treating successful holds as lower-bound constraints
// on the F-D curve. The classic Monod fit (fitCF) only learns from FAILURE
// points: it knows "you failed at load L after T seconds" → F(T) = L. But
// successful reps also carry information: "you held L for T seconds without
// failing" → F(T) ≥ L. The plain fit ignores them entirely, which causes
// the prescription to lag actual capacity any time you hit a target without
// pushing to true failure.
//
// Algorithm: start with the failure-only fit, then iteratively augment with
// any success points that fall ABOVE the current curve (constraint
// violations). Each violator gets added as a synthetic failure point with
// growing weight until the curve clears it (or maxIter is reached). The
// result satisfies success constraints in a soft, least-squares sense
// without needing a full QP solver.
//
// failurePts/successPts: arrays of { x: 1/T, y: load }
function fitCFWithSuccessFloor(failurePts, successPts, opts = {}) {
  const { maxIter = 24, tol = 0.1, weightStep = 1.0 } = opts;
  const failures = (failurePts || []).map(p => ({ x: p.x, y: p.y, w: 1 }));
  const successes = successPts || [];
  if (failures.length + successes.length < 2) return null;

  // Initial fit: failures alone if we have ≥ 2 of them. If failures are
  // sparse OR produce a degenerate fit (W′ < 0, common when within-session
  // fatigue noise drags the slope the wrong way), seed with successes too
  // so we at least get a valid fit to iterate from.
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
    const newFit = fitCFWeighted(augmented);
    if (!newFit) break;
    fit = newFit;
  }
  return fit;
}

// ─────────────────────────────────────────────────────────────
// THREE-EXPONENTIAL FORCE-DURATION MODEL  (shadow / experimental)
// ─────────────────────────────────────────────────────────────
// F(T) = a·exp(-T/τ₁) + b·exp(-T/τ₂) + c·exp(-T/τ₃)
//
// Amplitude parameterization (a, b, c ≥ 0 in kg) — equivalent to the
// Smax × {weights} form but easier to fit because the constraint is
// just non-negativity instead of "weights sum to 1." Smax = a+b+c falls
// out as the model's prediction at T=0 (i.e. MVC / fresh max).
//
// Currently used as a SHADOW model only — its prediction is rendered
// alongside Monod in the F-D chart so the two can be compared visually,
// but Monod still drives prescribedLoad. Validated offline (LOO-CV on
// pooled history) to beat Monod by ~4% RMSE at λ=100 with per-grip
// prior + shrinkage, with the win growing as more data accumulates.
// See Step 2a in the migration toward a three-exp-primary architecture.
const THREE_EXP_LAMBDA_DEFAULT = 100;

// Solve a 3x3 linear system A x = b via Cramer's rule. Returns null if
// singular. Used internally by fitThreeExpAmps.
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
// Solve a 2x2 linear system A x = b. Returns null if singular.
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
// taus:   [τ₁, τ₂, τ₃] in seconds (use PHYS_MODEL_DEFAULT.tauR by default)
// prior:  [a₀, b₀, c₀] target amplitudes for shrinkage
// lambda: shrinkage strength (0 = no shrinkage; large = ignore data)
//
// Returns [a, b, c] all ≥ 0. Falls back to prior if no points.
//
// Algorithm: closed-form normal-equations solve, then enumerate active
// sets if any component goes negative. With only 3 free parameters the
// active-set enumeration is bounded (8 cases) so the whole thing is
// O(1) per call modulo the O(N) normal-equation accumulation.
function fitThreeExpAmps(pts, opts = {}) {
  const taus  = opts.taus  || [PHYS_MODEL_DEFAULT.tauR.fast, PHYS_MODEL_DEFAULT.tauR.medium, PHYS_MODEL_DEFAULT.tauR.slow];
  const prior = opts.prior || [0, 0, 0];
  const lambda = opts.lambda == null ? 0 : opts.lambda;
  if (!pts || pts.length === 0) return prior.slice();
  // Design matrix X (n×3), targets y (n)
  const X = pts.map(p => taus.map(t => Math.exp(-p.T / t)));
  const y = pts.map(p => p.F);
  // Normal equations: (XᵀX + λI) β = Xᵀy + λ·prior
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
  // Enumerate active sets (which components are forced to 0)
  const candidates = [];
  // 1. All free — try the unconstrained 3-DOF solve
  const sol3 = _solve3(A, rhs);
  if (sol3 && sol3.every(v => v >= -1e-9)) candidates.push(sol3.map(v => Math.max(0, v)));
  // 2. One forced to 0 — solve the remaining 2x2
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
  // 3. Two forced to 0 — solve the remaining 1x1
  for (let nz = 0; nz < 3; nz++) {
    if (A[nz][nz] < 1e-12) continue;
    const v = rhs[nz] / A[nz][nz];
    if (v >= -1e-9) {
      const sol = [0, 0, 0];
      sol[nz] = Math.max(0, v);
      candidates.push(sol);
    }
  }
  // 4. All zero (prior-only fallback)
  candidates.push([0, 0, 0]);
  // Pick the candidate with lowest objective value
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
function predForceThreeExp(amps, T, taus = null) {
  const tau = taus || [PHYS_MODEL_DEFAULT.tauR.fast, PHYS_MODEL_DEFAULT.tauR.medium, PHYS_MODEL_DEFAULT.tauR.slow];
  return amps[0]*Math.exp(-T/tau[0]) + amps[1]*Math.exp(-T/tau[1]) + amps[2]*Math.exp(-T/tau[2]);
}

// Build per-grip three-exp prior by pooling all that grip's failures
// across hands. Used as the shrinkage target for per-(hand, grip) fits.
// Returns Map<grip, [a, b, c]>. Pooling within-grip avoids the cross-
// muscle (FDP vs FDS) amplitude contamination that broke the global
// pooled prior in offline validation.
function buildThreeExpPriors(history) {
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
    if (pts.length < 2) continue; // need at least 2 points to fit anything
    out.set(grip, fitThreeExpAmps(pts, { lambda: 0 }));
  }
  return out;
}

// Fit a Monod curve on a set of failure reps, with adaptive hand
// selection: if both hands are present and their CFs agree within
// tolerance, pool them for a tighter fit; if they diverge sharply,
// trust the ceiling hand (the weaker hand is typically noise — sparse
// data, fatigue, mis-logged failures — not a different underlying
// curve). Falls back gracefully when only one hand has usable data or
// the per-hand fits can't satisfy the minimum-durations requirement.
//
// `rows` should already be filtered to the set of failure reps you
// care about (e.g. all grips, a single grip, a date window, etc.). The
// helper handles hand-splitting internally so callers don't repeat
// that logic.
function fitAdaptiveHandCurve(rows) {
  const CF_ASYMMETRY_TOL = 0.20;
  if (!rows || rows.length < 2) return null;
  const fitFor = (subset) => {
    if (subset.length < 2) return null;
    // Require 2+ distinct target durations — Monod linearization needs
    // spread on the 1/T axis to be meaningful.
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

// Predicted force at a given duration (s) from a CF/W fit.
function predForce(fit, t) { return fit.CF + fit.W / t; }

// Area under F = CF + W/t from tMin to tMax (analytical integral).
// = CF*(tMax-tMin) + W*ln(tMax/tMin)
// Units: kg·s — captures total capacity across the full power→capacity range.
function computeAUC(CF, W, tMin = 10, tMax = 120) {
  return CF * (tMax - tMin) + W * Math.log(tMax / tMin);
}

// Per-session relative response of the two Monod parameters to each
// training protocol — the POPULATION PRIOR. Values are fractional
// (% of current); ratios within a row and among rows matter, not the
// overall magnitude, since we only compare protocols.
//
// Physiological story (CF = F-D asymptote, W′ = finite reserve above it):
//   • Power (short max efforts) primarily builds W′ — the anaerobic
//     reserve — with minor CF carry-over via MVC neural gains.
//   • Strength (mid-duration max hangs, 1RM work) raises the absolute
//     force ceiling. Since CF typically sits ~60–70% of max, lifting
//     the ceiling lifts CF proportionally — the "ceiling effect."
//     Largest CF-response of the three.
//   • Capacity (sustained threshold work) raises CF as a fraction of
//     the existing ceiling — the "ratio effect." Real but bounded;
//     once you're near the trainable CF:max ratio ceiling, further
//     gains require lifting max itself (i.e., strength work).
//
// These are priors, not truths. computePersonalResponse() fits them to
// the user's own CF/W' trajectory and shrinks the prior toward the
// observed rate as evidence accumulates.
const PROTOCOL_RESPONSE = {
  power:     { cf: 0.010, w: 0.060 },  // W′-dominant, tiny CF via MVC
  strength:  { cf: 0.045, w: 0.015 },  // CF-dominant via ceiling effect
  endurance: { cf: 0.030, w: 0.008 },  // CF via ratio effect, small W′
};

// Integration window for the "climbing-relevant" AUC — covers power
// through capacity durations. CF is weighted (tMax−tMin) = 110; W′ is
// weighted ln(tMax/tMin) ≈ 2.485, so CF dominates AUC by ~44×. This
// matches the climbing-grade literature: sustainable finger force
// (CF) is a stronger predictor of grade than finite reserve (W′).
const AUC_T_MIN = 10;
const AUC_T_MAX = 120;

// ─────────────────────────────────────────────────────────────
// SESSION PLANNER — per-rep fatigue curve prediction
// ─────────────────────────────────────────────────────────────
// Uses the canonical three-compartment depletion/recovery model
// (PHYS_MODEL_DEFAULT). Each compartment depletes during a hang and
// recovers during rest. Returns an array of predicted hold times
// (seconds) for each rep. Pass an explicit physModel to use a fitted
// (hand, grip)-specific model; otherwise falls back to defaults.
function predictRepTimes({ numReps, firstRepTime, restSeconds, physModel = PHYS_MODEL_DEFAULT }) {
  // Compartments: [amplitude, depletion_tau, recovery_tau]
  const comps = [
    { A: physModel.weights.fast,   tauD: physModel.tauD.fast,   tauR: physModel.tauR.fast   },  // PCr  — fast
    { A: physModel.weights.medium, tauD: physModel.tauD.medium, tauR: physModel.tauR.medium },  // Glycolytic — medium
    { A: physModel.weights.slow,   tauD: physModel.tauD.slow,   tauR: physModel.tauR.slow   },  // Oxidative  — slow
  ];

  // State: available fraction (0–1) for each compartment, starting fresh
  const state = comps.map(c => ({ ...c, avail: 1.0 }));

  const times = [];
  for (let i = 0; i < numReps; i++) {
    // Capacity this rep = weighted sum of available fractions
    const capacity = state.reduce((s, c) => s + c.A * c.avail, 0); // sum(Ai) = 1
    const t = Math.max(0, Math.round(firstRepTime * capacity * 10) / 10);
    times.push(t);

    // Deplete each compartment over this rep's duration
    for (const c of state) {
      const dep = 1 - Math.exp(-t / c.tauD);
      c.avail = Math.max(0, c.avail * (1 - dep));
    }

    // Recover during rest (if not the last rep)
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
// READINESS / RECOVERY HELPERS
// ─────────────────────────────────────────────────────────────
// Computes a 1-10 readiness score from recent training history.
// Uses an exponential decay model with ~24h recovery half-life.
// Score 10 = fully fresh; 1 = extremely fatigued.
function computeReadiness(history) {
  if (!history || history.length === 0) return 10;
  const todayStr = today();

  // Session load = sum of normalized rep doses (weight/refW × sqrt(dur/refDur))
  const byDate = {};
  for (const r of history) {
    if (!r.date) continue;
    if (!byDate[r.date]) byDate[r.date] = [];
    byDate[r.date].push(r);
  }

  let totalRemaining = 0;
  for (const [date, reps] of Object.entries(byDate)) {
    const load = reps.reduce((sum, r) => {
      const w = effectiveLoad(r) || r.weight_kg || 10;
      const d = r.actual_time_s || 10;
      return sum + (w / 20) * Math.sqrt(d / 45);
    }, 0);

    // Estimate hours since this session (no time-of-day stored, approximate)
    const hoursAgo = date === todayStr
      ? 3                          // trained today — assume a few hours ago
      : (new Date(todayStr) - new Date(date)) / (1000 * 3600 * 24) * 24 + 8;

    // Exponential decay: ~50% remaining after 24h
    totalRemaining += load * Math.exp(-hoursAgo / 24);
  }

  // Reference: a heavy session of 15 reps at baseline → load ≈ 15
  // 15 remaining = max fatigue (score 1); 0 = fully fresh (score 10)
  return Math.max(1, Math.round(10 - clamp(totalRemaining / 15 * 9, 0, 9)));
}

function recoveryLabel(score) {
  if (score >= 8) return { text: "Good day to push",            color: C.green,  emoji: "🟢" };
  if (score >= 5) return { text: "Quality volume day",          color: C.yellow, emoji: "🟡" };
  return              { text: "Consider light work or rest",   color: C.red,    emoji: "🔴" };
}

// 5-point subjective feeling scale → 1-10 score + label
const FEEL_OPTIONS = [
  { val: 1, emoji: "😴", label: "Wrecked"    },
  { val: 2, emoji: "😓", label: "Tired"      },
  { val: 3, emoji: "😐", label: "OK"         },
  { val: 4, emoji: "💪", label: "Good"       },
  { val: 5, emoji: "🔥", label: "Fired up"   },
];
// Map 1-5 subjective → 1-10 display score
const subjToScore = (v) => v * 2;

// ─────────────────────────────────────────────────────────────
// FATIGUE MODEL — THREE-COMPARTMENT IV-KINETICS ANALOGY
// ─────────────────────────────────────────────────────────────
// F(t) = F₀ · Σᵢ Aᵢ · exp(−t / τᵢ)
// F is the fraction of max strength currently *unavailable* due to fatigue.
// Three compartments model fast (PCr), medium (glycolytic), and slow (metabolic) recovery.
//
// Dose from one rep adds fatigue proportional to relative load × duration.

function fatigueAfterRest(F, restSeconds, p = DEF_FAT) {
  const { A1, tau1, A2, tau2, A3, tau3 } = p;
  return F * (
    A1 * Math.exp(-restSeconds / tau1) +
    A2 * Math.exp(-restSeconds / tau2) +
    A3 * Math.exp(-restSeconds / tau3)
  );
}

// Default dose-strength constant. Sets how much fatigue accumulates per kg·s of
// effort relative to that hand/grip's sMax. Empirical population prior; can be
// back-fit from a user's own history (see fitDoseK). Pulled from the canonical
// PHYS_MODEL_DEFAULT so model-tuning is a single-knob job.
function fatigueDose(weightKg, durationS, sMaxKg, k = PHYS_MODEL_DEFAULT.doseK) {
  if (!sMaxKg || sMaxKg <= 0) return 0;
  return clamp((weightKg / sMaxKg) * durationS * k, 0, 0.90);
}

const availFrac = (F) => clamp(1 - F, 0.05, 1.0);

// ─────────────────────────────────────────────────────────────
// FATIGUE-ADJUSTED LOAD INDEX
// ─────────────────────────────────────────────────────────────
// Within a set, the same posted load gets HARDER each rep as the muscle
// fatigues. Plain Monod fits (1/T_actual, load_actual) will then misread
// later reps in a set as "you were weaker than this" and pull CF/W' down.
//
// The fix: walk each session/hand/set chronologically, accumulating fatigue
// via the same model the live workout uses (fatigueDose + fatigueAfterRest),
// and divide each rep's load by availFrac to get its FRESH-EQUIVALENT load —
// the load a rested muscle would need to be given to replicate that effort.
// Monod then fits on (1/T_actual, fresh_equivalent_load), which removes the
// within-set droop and gives an honest CF/W' for the underlying physiology.
//
// Returns Map<repKey, { fresh, availFrac, load }>. Use freshLoadFor(rep, map)
// to look up. Falls back to actual load if a rep isn't in the map.
function repKey(r) {
  if (r.id) return `id:${r.id}`;
  return `${r.session_id || r.date}|${r.set_num || 1}|${r.rep_num || 1}|${r.hand}`;
}

function buildSMaxIndex(history) {
  // sMax per (hand, grip) = max observed effective load × 1.2 (matches the
  // sMaxL / sMaxR computation used at runtime). Falls back to 20 kg if a
  // hand/grip pair has no usable data — same default used in workout state.
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

// Returns the canonical three-compartment physModel for a (hand, grip)
// pair, with sMax filled in from the user's history. Taus and weights
// are still population priors (PHYS_MODEL_DEFAULT) at this stage; the
// follow-up commit will personalize weights and sMax via fitThreeExpModel
// with shrinkage to these defaults. doseK can also be overridden per-user
// via fitDoseK output.
//
// Pass an optional opts.sMaxIndex to share a precomputed index across
// multiple lookups in the same render pass.
// eslint-disable-next-line no-unused-vars -- exposed as the future single source of truth for the migration to fitThreeExpModel-driven prescriptions; not yet consumed but committed now so the API is ready when the fitter lands.
function getPhysModel(history, hand, grip, opts = {}) {
  const { sMaxIndex = null, doseK = null } = opts;
  const idx = sMaxIndex || buildSMaxIndex(history);
  const sMax = (hand && grip) ? (idx.get(`${hand}|${grip}`) ?? null) : null;
  return {
    ...PHYS_MODEL_DEFAULT,
    sMax,
    doseK: doseK ?? PHYS_MODEL_DEFAULT.doseK,
  };
}

function buildFreshLoadMap(history, opts = {}) {
  const { fatParams = DEF_FAT, doseK = PHYS_MODEL_DEFAULT.doseK, sMaxIndex = null } = opts;
  const out = new Map();
  if (!history || history.length === 0) return out;

  const sMaxByKey = sMaxIndex || buildSMaxIndex(history);

  // Group by session + hand (fatigue state is per-hand at runtime, except in
  // alt-mode — which we can't reliably detect from rep records, so we use
  // per-hand grouping as a clean approximation).
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
      // Match runtime: fatigue resets at set boundary.
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

function freshLoadFor(rep, freshMap) {
  if (!freshMap) return effectiveLoad(rep);
  const entry = freshMap.get(repKey(rep));
  return entry ? entry.fresh : effectiveLoad(rep);
}

// Back-fit the dose-strength constant k from a user's history. The signal is
// within-set decay: at constant posted load, actual_time_s should drop rep
// after rep. Under correct k, dividing each rep's posted load by availFrac
// yields a roughly constant fresh-equivalent load within the set. The wrong
// k leaves a systematic trend (decay → k too low; rise → k too high).
//
// Strategy: grid search k ∈ [0.003, 0.030] minimising the mean within-set
// variance in fresh-equivalent load, weighted by set length. Only sets with
// 3+ reps at constant target_duration contribute (we need spread to detect
// the trend). Returns the best k or null if too little data.
function fitDoseK(history, opts = {}) {
  const { kMin = 0.0005, kMax = 0.030, steps = 60, fatParams = DEF_FAT } = opts;
  if (!history || history.length < 6) return null;

  // Group reps by (session, hand, set) to find valid within-set sequences.
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
    if (tdSet.size > 1) continue; // mixed-target sets aren't comparable
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
      // Coefficient of variation makes sets with different absolute loads
      // (Crusher 30+ kg vs Micro 10 kg) comparable.
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

// Shortfall threshold: a rep that finishes meaningfully before its target
// duration is treated as a failure for fitting purposes, even if the user
// didn't tap "fail". Without this, holding 26 kg for 33s on a 45s target
// gets logged as a success and the F-D fit thinks you're stronger than
// you actually are. 95% gives a small buffer for clock drift / late taps.
const SHORTFALL_TOL = 0.95;
function isShortfall(actualTime, targetDuration) {
  if (!(actualTime > 0) || !(targetDuration > 0)) return false;
  return actualTime < targetDuration * SHORTFALL_TOL;
}

// ─────────────────────────────────────────────────────────────
// HISTORICAL ESTIMATION
// ─────────────────────────────────────────────────────────────
// Effective load for a rep — prefer Tindeq avg_force_kg, fall back to weight_kg.
// Used for CURVE FITTING (the actual force delivered during the hang is what
// shapes the F-D curve, regardless of whether there was load on a pin or not).
function effectiveLoad(r) {
  const f = Number(r.avg_force_kg);
  const w = Number(r.weight_kg);
  if (f > 0 && f < 500) return f;
  if (w > 0) return w;
  return 0;
}

// Prescribable load for a rep — what the user should aim to produce
// next session. For Tindeq-isometric setups (spring/anchor, no pin),
// avg_force_kg IS the actual load delivered, AND it's what the
// prescription should be in (the user can't "load" anything externally;
// they pull until the gauge reads X). The weight_kg field in those
// reps is just the system's prescribed target stored alongside, not
// an actual external load.
//
// For future weighted-rep setups (hangboard with pulley + weight pin
// + inline Tindeq), this would prefer weight_kg. Right now everyone
// is on Tindeq-isometric, so this matches effectiveLoad. Kept as a
// distinct function so the semantic is named — when we add weighted-
// rep support, only this function changes.
function loadedWeight(r) {
  const f = Number(r.avg_force_kg);
  if (f > 0 && f < 500) return f;
  const w = Number(r.weight_kg);
  if (w > 0) return w;
  return 0;
}

// Returns the weighted-recent-average weight at which the user
// achieved close to targetDuration seconds to failure.
function estimateRefWeight(history, hand, grip, targetDuration) {
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

function suggestWeight(refWeight, fatigue) {
  if (refWeight == null) return null;
  return Math.round(refWeight * availFrac(fatigue) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// RPE 10 PROGRESSION BUMP
// ─────────────────────────────────────────────────────────────
// In RPE 10 (rep-to-failure) training, the goal is for rep 1 to fail
// at the prescribed target time. A SUCCESS at rep 1 (held to or
// beyond target) is evidence the load was too light — the user has
// capacity beyond what we prescribed. The Monod fit only weakly
// updates on success-only data (success is just a lower bound on
// the curve, not a point on it), so the prescription can stall
// instead of progressing. This explicit per-session bump closes
// that loop: count consecutive recent rep-1 successes at the same
// (hand, grip, targetTime) and multiply the prescription by
// (1 + BUMP_PER_SUCCESS)^streak. As soon as a real failure happens,
// the streak resets and the curve takes over (failure points DO
// directly anchor the curve, so the curve-driven path naturally
// produces the right next prescription with diminishing returns
// built in).
const BUMP_PER_SUCCESS = 0.05;   // +5% per success-session at this scope
const MAX_BUMP_MULT = 1.30;       // cap at +30% (≈5-6 successes); beyond
                                  // that, calibration has drifted enough
                                  // that the user should manually re-anchor

function rpeProgressionMultiplier(history, hand, grip, targetDuration) {
  if (!hand || !grip || !targetDuration || !history || history.length === 0) return 1;
  // Find rep 1 of each session matching this (hand, grip, targetTime).
  // Group by session_id (or date as fallback) so multiple-rep sessions
  // collapse to their leading rep.
  const rep1ByScope = new Map();
  for (const r of history) {
    if (r.hand !== hand || r.grip !== grip) continue;
    if (r.target_duration !== targetDuration) continue;
    if ((r.rep_num || 1) !== 1) continue;
    const sid = r.session_id || r.date || "unknown";
    rep1ByScope.set(sid, r);
  }
  // Sort by date descending (most recent first), then count how many
  // consecutive rep 1s were "successes" (not flagged failed AND held to
  // ≥95% of target — covers the case where shortfalls weren't tagged).
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
// LOAD AUTO-PRESCRIPTION from fitted CF/W' (Monod-Scherrer)
// ─────────────────────────────────────────────────────────────
// Returns prescribed load (kg) for a target time-to-exhaustion on a given grip/hand.
// Uses the hyperbolic form: F = CF + W'/T, then applies the RPE 10
// progression bump (above) so success-only sessions still progress.
//
// Failures anchor the curve directly (you failed at load L after T seconds
// → F(T) = L). Successful reps that hit or exceeded their target act as
// LOWER BOUNDS on the curve (you held L for T seconds without failing →
// F(T) ≥ L). Without the success-floor pass, the prescription would lag
// actual capacity whenever you cleared a target instead of pushing to true
// failure. See fitCFWithSuccessFloor for the constraint-handling logic.
//
// Typical targets: Power T=7, Strength T=45, Capacity T=120.
function prescribedLoad(history, hand, grip, targetDuration, freshMap = null) {
  if (!history || !targetDuration) return null;
  const handMatch = r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.actual_time_s > 0 &&
    effectiveLoad(r) > 0;

  const failures = history.filter(r => r.failed && handMatch(r));
  // Conservative success set: only include reps that actually hit or
  // exceeded their target duration. Reps that fell short but weren't
  // tagged as failures are ambiguous — including them would falsely
  // constrain the curve below where the user really is.
  const successes = history.filter(r =>
    !r.failed && handMatch(r) &&
    r.target_duration > 0 &&
    r.actual_time_s >= r.target_duration
  );

  if (failures.length < 2 && successes.length < 2) return null;

  // Fatigue-adjust loads BEFORE feeding to Monod. Within-set fatigue makes
  // later reps appear "weaker than fresh" when read at face value, dragging
  // CF/W' down. We replace each rep's posted load with its fresh-equivalent
  // (load / availFrac at the start of the rep) so the curve fits the
  // underlying physiology rather than the within-set droop. If no map is
  // passed, build one on the fly.
  const fmap = freshMap || buildFreshLoadMap(history);
  const failurePts = failures.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const successPts = successes.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));

  const fit = fitCFWithSuccessFloor(failurePts, successPts);
  if (!fit) return null;
  // RPE 10 progression bump: scales the curve-evaluated prescription up
  // when recent rep-1 outcomes have all been successes at this scope.
  // Curve-derived prescription naturally produces the right next value
  // when there's been a failure (the failure point anchors the curve);
  // this bump compensates for the success-only stall.
  const baseLoad = fit.CF + fit.W / targetDuration;
  const bump = rpeProgressionMultiplier(history, hand, grip, targetDuration);
  return Math.round(baseLoad * bump * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// EMPIRICAL PRESCRIPTION  (the coaching "next-session" rule)
// ─────────────────────────────────────────────────────────────
// Returns the load to ACTUALLY TRAIN at next session for a given
// (hand, grip, target_duration), grounded in the user's most recent
// rep 1 outcome at this exact scope rather than in a global curve
// extrapolation. This is the prescription a thoughtful coach would
// give: "you held 26 kg for 30s on a 45s target last session — try
// 24 kg next time" (failure case) or "you held 26 kg for 45s — try
// 27 kg next time" (success case).
//
// Why empirical instead of curve-extrapolated:
//   - The curve fit is a global model. At extreme zones (short Power,
//     long Capacity) it can extrapolate aggressively, prescribing 2x
//     what the user has actually proven they can do.
//   - The user's last rep 1 at this exact scope is a real data point
//     that requires no extrapolation.
//   - Coaching should bound risk: prescribing 30% above what you've
//     ever done is bad RPE 10 practice.
//
// Returns null if no recent rep 1 exists at this scope; caller is
// expected to fall back to prescribedLoad() in that case (cold start).
//
// recentDays bounds the lookback to avoid stale data after detraining
// or long breaks.
const EMPIRICAL_LOOKBACK_DAYS = 30;

function empiricalPrescription(history, hand, grip, targetDuration) {
  if (!history || !hand || !grip || !targetDuration) return null;
  // Lookback cutoff (local time, matching ymdLocal/today)
  const cutoffMs = Date.now() - EMPIRICAL_LOOKBACK_DAYS * 86400 * 1000;
  const cutoff = ymdLocal(new Date(cutoffMs));

  // Collect rep 1 of each session matching this exact scope
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

  // Sort by date desc, take most recent
  const rep1s = [...sessionRep1.values()]
    .sort((a, b) => (b.date || "").localeCompare(a.date || ""));
  const last = rep1s[0];
  // Use LOADED weight for the prescription (what the user actually put
  // on the pin / pulled against), not the avg_force gauge reading. They
  // can differ meaningfully on weighted reps; the prescription should
  // tell the user what to LOAD, not what their measured force was.
  const F_actual = loadedWeight(last);
  const T_actual = last.actual_time_s;
  const T_target = targetDuration;
  const wasSuccess = !last.failed && T_actual >= T_target * 0.95;

  if (wasSuccess) {
    // Success case: count consecutive recent successes for the streak
    // bump. Same +5%/streak rule as rpeProgressionMultiplier, capped.
    let streak = 0;
    for (const r of rep1s) {
      if (r.failed) break;
      if (!(r.actual_time_s >= targetDuration * 0.95)) break;
      streak += 1;
    }
    const bump = Math.min(MAX_BUMP_MULT, Math.pow(1 + BUMP_PER_SUCCESS, streak));
    return Math.round(F_actual * bump * 10) / 10;
  } else {
    // Failure case: use the W'-update math anchored to a stable CF.
    // Assumption: CF (sustainable aerobic asymptote) doesn't shift
    // session-to-session, so we can solve for new W' given the new
    // failure point, then prescribe at T_target. Falls back to a
    // simple linear scale if no Monod fit is available.
    const failurePts = history
      .filter(r => r.failed && r.hand === hand && r.grip === grip
        && r.actual_time_s > 0 && effectiveLoad(r) > 0)
      .map(r => ({ x: 1 / r.actual_time_s, y: effectiveLoad(r) }));
    const fit = failurePts.length >= 2 ? fitCF(failurePts) : null;
    if (fit && F_actual > fit.CF) {
      const newWprime = (F_actual - fit.CF) * T_actual;
      const next = fit.CF + newWprime / T_target;
      return Math.round(Math.max(next, fit.CF) * 10) / 10;
    }
    // No fit available: scale linearly. If you held F for T and
    // target is longer (T_target > T_actual), prescribe lighter.
    // Bounded so we don't drop more than 30% in one session.
    const scale = Math.max(0.7, T_actual / T_target);
    return Math.round(F_actual * scale * 10) / 10;
  }
}

// ─────────────────────────────────────────────────────────────
// PRESCRIPTION POTENTIAL  (the coaching "what's possible" view)
// ─────────────────────────────────────────────────────────────
// Returns the curve-derived ceiling at a given (hand, grip, target T):
// what the model thinks the user's physiology could support if balanced.
// Used as the diagnostic "ceiling" alongside the empirical prescription —
// the GAP between the two is the training opportunity.
//
// Returns { value, lower, upper, reliability } or null:
//   value       — point estimate (Monod-derived, with bump removed)
//   lower/upper — bracket from Monod and three-exp fits
//   reliability — "well-supported" | "marginal" | "extrapolation"
//
// Reliability tiers gate how the UI presents the potential:
//   - well-supported: failure data exists within ±20% of target T,
//     AND |Monod − three-exp| / Monod < 0.15
//   - marginal: failures exist within ±50% but models disagree, OR
//     no failures within ±20% but some within ±50%
//   - extrapolation: no failures within ±50% of target T → don't
//     show numeric potential; suggest training the zone instead
function prescriptionPotential(history, hand, grip, targetDuration, opts = {}) {
  if (!history || !hand || !grip || !targetDuration) return null;
  const { freshMap = null, threeExpPriors = null } = opts;

  // Filter failures matching scope
  const failures = history.filter(r =>
    r.failed && r.hand === hand && r.grip === grip
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );

  // Reliability classification — how close are failures to target T?
  const within20 = failures.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.20
  ).length;
  const within50 = failures.filter(r =>
    Math.abs(r.actual_time_s - targetDuration) / targetDuration <= 0.50
  ).length;

  // Monod potential (no streak bump applied — that's a separate signal
  // for empirical, not for the curve ceiling).
  const fmap = freshMap || buildFreshLoadMap(history);
  const failurePts = failures.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const successes = history.filter(r =>
    !r.failed && r.hand === hand && r.grip === grip
    && r.target_duration > 0 && r.actual_time_s >= r.target_duration
    && r.actual_time_s > 0 && effectiveLoad(r) > 0
  );
  const successPts = successes.map(r => ({ x: 1 / r.actual_time_s, y: freshLoadFor(r, fmap) }));
  const monodFit = (failurePts.length + successPts.length >= 2)
    ? fitCFWithSuccessFloor(failurePts, successPts)
    : null;
  const monodValue = monodFit ? monodFit.CF + monodFit.W / targetDuration : null;

  // Three-exp potential (if priors available and enough data)
  let threeExpValue = null;
  if (threeExpPriors && threeExpPriors.get && failures.length >= 2) {
    const prior = threeExpPriors.get(grip);
    if (prior) {
      const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
      const lambda = THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1);
      const amps = fitThreeExpAmps(pts, { prior, lambda });
      if (amps[0] + amps[1] + amps[2] > 0) {
        const v = predForceThreeExp(amps, targetDuration);
        if (v > 0) threeExpValue = v;
      }
    }
  }

  // Need at least Monod to return anything
  if (monodValue == null) return null;

  // Bracket: lower/upper from Monod and three-exp where both exist
  const values = [monodValue, threeExpValue].filter(v => v != null);
  const lower = Math.min(...values);
  const upper = Math.max(...values);

  // Reliability classification
  let reliability;
  if (within20 >= 1 && threeExpValue != null
      && Math.abs(monodValue - threeExpValue) / monodValue < 0.15) {
    reliability = "well-supported";
  } else if (within50 >= 1) {
    reliability = "marginal";
  } else {
    reliability = "extrapolation";
  }

  return {
    value: Math.round(monodValue * 10) / 10,
    lower: Math.round(lower * 10) / 10,
    upper: Math.round(upper * 10) / 10,
    reliability,
    threeExpValue: threeExpValue != null ? Math.round(threeExpValue * 10) / 10 : null,
  };
}

// ─────────────────────────────────────────────────────────────
// PER-COMPARTMENT AUC (training dose delivered to each energy system)
// ─────────────────────────────────────────────────────────────
// Textbook PK-style integral: dose_i = load × A_i × τ_Di × (1 − e^(−t/τ_Di))
// Short reps saturate compartment 1; long reps (>> τ_Di) saturate that compartment.
// Rest between reps is ignored (rest delivers no dose; only clears for subsequent reps).
//
// Returns { fast, medium, slow, total } in kg·s units (force-time integrated dose).
// Compartment 1 (fast/PCr), 2 (medium/glycolytic), 3 (slow/oxidative).
function sessionCompartmentAUC(reps, physModel = PHYS_MODEL_DEFAULT) {
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
// 5-zone classifier: categorises a single hang by its
// time-under-tension. The 45s boundaries come from 15 × 3s pulse
// framing; we treat them as TUT thresholds.
// Boundaries: <45s power, 45–81s pwr-str, 84–129s str,
//             132–177s str-end, 180s+ end.
// Returns { key, label, short, color } or null for zero/invalid reps.
// ─────────────────────────────────────────────────────────────
const ZONE5 = [
  { key: "power",              label: "Power",              short: "Pwr",   color: "#e05560", min:   0, max:  45 },
  { key: "power_strength",     label: "Power-Strength",     short: "Pwr-Str", color: "#e68a48", min:  45, max:  82 },
  { key: "strength",           label: "Strength",           short: "Str",   color: "#e07a30", min:  82, max: 130 },
  { key: "strength_endurance", label: "Strength-Capacity",  short: "Str-Cap", color: "#7aa0d8", min: 130, max: 178 },
  { key: "endurance",          label: "Capacity",           short: "Cap",   color: "#3b82f6", min: 178, max: Infinity },
];
function classifyZone5(durationSec) {
  if (!durationSec || durationSec <= 0) return null;
  return ZONE5.find(z => durationSec >= z.min && durationSec < z.max) ?? ZONE5[ZONE5.length - 1];
}
// Majority-zone for a set of reps (by count). Returns a ZONE5 entry or null.
function dominantZone5(reps) {
  const counts = Object.fromEntries(ZONE5.map(z => [z.key, 0]));
  for (const r of reps || []) {
    const z = classifyZone5(r.actual_time_s);
    if (z) counts[z.key] += 1;
  }
  const entries = Object.entries(counts).filter(([, n]) => n > 0);
  if (!entries.length) return null;
  entries.sort((a, b) => b[1] - a[1]);
  return ZONE5.find(z => z.key === entries[0][0]);
}
// Convert the intended goal key from GOAL_CONFIG (power / strength / endurance)
// into a ZONE5 key so we can compare intended vs. landed zone.
// eslint-disable-next-line no-unused-vars
const GOAL_TO_ZONE5 = { power: "power", strength: "strength", endurance: "endurance" };

// ─────────────────────────────────────────────────────────────
// GAMIFICATION
// ─────────────────────────────────────────────────────────────

// A rep counts toward badges only if the athlete completed at least
// 80% of the target duration (screens out bailed reps).
function isQualifyingRep(r, targetDuration) {
  if (!r.actual_time_s || !targetDuration) return true; // no time data → don't exclude
  return r.actual_time_s >= targetDuration * 0.98;
}

// Group reps into sessions by their session_id (or date as fallback),
// returning an array of { sessionKey, date, reps[] } sorted oldest first.
function groupSessions(history, hand, grip, targetDuration) {
  const matches = history.filter(r =>
    r.hand === hand &&
    (!grip || r.grip === grip) &&
    r.target_duration === targetDuration &&
    effectiveLoad(r) > 0 &&
    isQualifyingRep(r, targetDuration)
  );
  const map = new Map();
  matches.forEach(r => {
    const key = r.session_id || r.date;
    if (!map.has(key)) map.set(key, { key, date: r.date, reps: [] });
    map.get(key).reps.push(r);
  });
  return [...map.values()].sort((a, b) => a.date < b.date ? -1 : 1);
}

// Baseline = best qualifying rep from the FIRST session only.
function getBaseline(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length === 0) return null;
  const firstReps = sessions[0].reps;
  return Math.max(...firstReps.map(r => effectiveLoad(r)));
}

// Best load = best qualifying rep from sessions AFTER the first.
// (First session always = badge 1 regardless of within-session variance.)
function getBestLoad(history, hand, grip, targetDuration) {
  const sessions = groupSessions(history, hand, grip, targetDuration);
  if (sessions.length < 2) return null; // no improvement sessions yet
  const laterReps = sessions.slice(1).flatMap(s => s.reps);
  if (laterReps.length === 0) return null;
  return Math.max(...laterReps.map(r => effectiveLoad(r)));
}

function calcLevel(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline || baseline <= 0) return 1;
  const best = getBestLoad(history, hand, grip, targetDuration);
  if (!best || best <= baseline) return 1; // first session or no improvement yet
  return Math.max(1, 1 + Math.floor(Math.log(best / baseline) / Math.log(LEVEL_STEP)));
}

function levelTitle(level) {
  return `Level ${level}`;
}

// Next badge threshold = baseline × LEVEL_STEP^(currentLevel)
function nextLevelTarget(history, hand, grip, targetDuration) {
  const baseline = getBaseline(history, hand, grip, targetDuration);
  if (!baseline) return null;
  const level = calcLevel(history, hand, grip, targetDuration);
  return Math.round(baseline * Math.pow(LEVEL_STEP, level) * 10) / 10;
}

// ─────────────────────────────────────────────────────────────
// TINDEQ PROGRESSOR BLUETOOTH HOOK
// ─────────────────────────────────────────────────────────────
// BLE packet format (Progressor firmware):
//   Byte 0     : response code (0x01 = weight data)
//   Byte  1    : payload length in bytes (0x78 = 120 = 15 samples × 8 bytes)
//   Bytes 2..N : samples, each 8 bytes:
//                  [0..3] float32 LE — weight in kg
//                  [4..7] uint32  LE — timestamp in µs from session start
//
// If your device uses a different format, update parseTindeqPacket().
function parseTindeqPacket(dataView, onSample) {
  if (dataView.byteLength < 2) return;

  if (dataView.getUint8(0) !== RESPONSE_WEIGHT) return;
  // Byte 1 is payload length; samples start at byte 2
  let offset = 2;
  while (offset + 8 <= dataView.byteLength) {
    const kg = dataView.getFloat32(offset, /* littleEndian= */ true);
    const ts = dataView.getUint32(offset + 4, true); // µs

    // Sanity check — valid finger-training forces are 0–500 kg
    if (!isFinite(kg) || kg > 500 || kg < -10) {
      offset += 8;
      continue;
    }

    onSample({ kg: Math.max(0, kg), ts });
    offset += 8;
  }
}

function useTindeq() {
  const [connected,     setConnected]     = useState(false);
  const [reconnecting,  setReconnecting]  = useState(false);
  const [force,         setForce]         = useState(0);
  const [peak,          setPeak]          = useState(0);
  const [avgForce,      setAvgForce]      = useState(0);
  const [bleError,      setBleError]      = useState(null);

  const ctrlRef             = useRef(null);
  const deviceRef           = useRef(null);   // kept for auto-reconnect
  const reconnectingRef     = useRef(false);  // guard against concurrent reconnects
  const peakRef             = useRef(0);
  const sumRef              = useRef(0);   // running sum for average
  const countRef            = useRef(0);   // sample count for average
  const belowSinceRef       = useRef(null);
  const measuringRef        = useRef(false);
  const autoFailCallbackRef = useRef(null); // set by ActiveSessionView
  const targetKgRef         = useRef(null); // set by ActiveSessionView each rep

  // ── Auto-detect mode (spring-strap / no-hands-needed workflow) ───────────
  const adOnStartRef    = useRef(null);   // () => void — called when pull begins
  const adOnEndRef      = useRef(null);   // ({actualTime, avgForce}) => void — called when rep ends
  const adActiveRef     = useRef(false);  // true while a rep is in progress
  const adStartTimeRef  = useRef(null);   // Date.now() when pull began
  const adSumRef        = useRef(0);      // accumulating force sum
  const adCountRef      = useRef(0);      // sample count
  const adBelowRef      = useRef(null);   // timestamp when force first dipped below end-threshold
  const AD_START_KG  = 4;    // force must exceed this to begin auto-rep
  const AD_END_KG    = 3;    // force must drop below this to end auto-rep
  const AD_END_MS    = 500;  // ms below end-threshold before rep is confirmed done
  const AD_MIN_MS    = 1500; // minimum rep duration — filters noise

  // Stable setter — lets views register/clear the callback without prop drilling
  const setAutoFailCallback = useCallback((fn) => {
    autoFailCallbackRef.current = fn ?? null;
  }, []);

  // ── Packet handler — defined once, reused across reconnects ──
  const handlePacket = useCallback((evt) => {
    parseTindeqPacket(evt.target.value, ({ kg }) => {
      setForce(kg);
      if (kg > peakRef.current) { peakRef.current = kg; setPeak(kg); }

      if (measuringRef.current && kg > 0) {
        sumRef.current   += kg;
        countRef.current += 1;
        setAvgForce(sumRef.current / countRef.current);
      }

      if (measuringRef.current) {
        const tgt = targetKgRef.current;
        if (tgt != null && tgt > 0) {
          const threshold = tgt * 0.95;
          if (kg < threshold) {
            if (belowSinceRef.current === null) belowSinceRef.current = Date.now();
            else if (Date.now() - belowSinceRef.current > 1500) {
              belowSinceRef.current = null;
              autoFailCallbackRef.current?.();
            }
          } else {
            belowSinceRef.current = null;
          }
        }
      }

      if (adOnStartRef.current || adOnEndRef.current) {
        const now = Date.now();
        if (!adActiveRef.current) {
          if (kg >= AD_START_KG) {
            adActiveRef.current    = true;
            adStartTimeRef.current = now;
            adSumRef.current       = kg;
            adCountRef.current     = 1;
            adBelowRef.current     = null;
            adOnStartRef.current?.();
          }
        } else {
          adSumRef.current  += kg;
          adCountRef.current += 1;
          if (kg < AD_END_KG) {
            if (adBelowRef.current === null) adBelowRef.current = now;
            else if (now - adBelowRef.current >= AD_END_MS) {
              const actualTime = (adBelowRef.current - adStartTimeRef.current) / 1000;
              if (actualTime * 1000 >= AD_MIN_MS) {
                const avg = adSumRef.current / adCountRef.current;
                const cb  = adOnEndRef.current;
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adBelowRef.current     = null;
                cb?.({ actualTime, avgForce: avg });
              } else {
                adActiveRef.current    = false;
                adStartTimeRef.current = null;
                adSumRef.current       = 0;
                adCountRef.current     = 0;
                adBelowRef.current     = null;
              }
            }
          } else {
            adBelowRef.current = null;
          }
        }
      }
    });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── GATT setup — called on initial connect and every reconnect ──
  const setupGatt = useCallback(async (device) => {
    const server = await device.gatt.connect();
    const svc    = await server.getPrimaryService(TINDEQ_SERVICE);
    const dataC  = await svc.getCharacteristic(TINDEQ_NOTIFY);
    ctrlRef.current = await svc.getCharacteristic(TINDEQ_WRITE);
    dataC.addEventListener("characteristicvaluechanged", handlePacket);
    await dataC.startNotifications();
    // If a rep was in progress when we dropped, restart the measurement stream
    if (measuringRef.current) {
      await ctrlRef.current.writeValue(CMD_START);
    }
  }, [handlePacket]);

  // NOTE: No app-layer keepalive — the OS/link layer already keeps BLE alive.
  // Writing CMD_TARE every 25 s used to race with user actions on Chrome/Android
  // and actually caused drops rather than preventing them.

  const connect = useCallback(async () => {
    setBleError(null);
    if (!navigator?.bluetooth) {
      setBleError("Web Bluetooth unavailable — open in Chrome on desktop or Android.");
      return false;
    }
    try {
      const device = await navigator.bluetooth.requestDevice({
        filters: [{ namePrefix: "Progressor" }],
        optionalServices: [TINDEQ_SERVICE],
      });
      deviceRef.current = device;

      // Single-shot reconnect after 1.5 s to handle brief signal blips.
      // Aggressive retry loops can poison the adapter state on Android —
      // if this one try fails, surface a clean error and let the user reconnect.
      device.addEventListener("gattserverdisconnected", async () => {
        setConnected(false);
        if (reconnectingRef.current) return;
        reconnectingRef.current = true;
        setReconnecting(true);
        await new Promise(r => setTimeout(r, 1500));
        try {
          await setupGatt(device);
          setConnected(true);
        } catch {
          setBleError("Connection lost — tap Connect BLE to reconnect.");
        } finally {
          setReconnecting(false);
          reconnectingRef.current = false;
        }
      });

      await setupGatt(device);
      setConnected(true);
      return true;
    } catch (err) {
      setBleError(err.message || "Connection failed");
      return false;
    }
  }, [setupGatt]);

  const startMeasuring = useCallback(async () => {
    peakRef.current  = 0;  setPeak(0);
    sumRef.current   = 0;
    countRef.current = 0;  setAvgForce(0);
    setForce(0);
    belowSinceRef.current = null;
    measuringRef.current  = true;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  const stopMeasuring = useCallback(async () => {
    measuringRef.current = false;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_STOP);
  }, []);

  const resetPeak = useCallback(() => {
    peakRef.current = 0; setPeak(0);
  }, []);

  const tare = useCallback(async () => {
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_TARE);
    peakRef.current = 0; setPeak(0); setForce(0);
  }, []);

  // Start auto-detect mode: Tindeq streams continuously, reps are detected by
  // force threshold crossings. onRepStart fires when a pull begins; onRepEnd
  // fires with { actualTime, avgForce } when the force drops back to baseline.
  const startAutoDetect = useCallback(async (onRepStart, onRepEnd) => {
    adActiveRef.current    = false;
    adStartTimeRef.current = null;
    adSumRef.current       = 0;
    adCountRef.current     = 0;
    adBelowRef.current     = null;
    adOnStartRef.current   = onRepStart ?? null;
    adOnEndRef.current     = onRepEnd   ?? null;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_START);
  }, []);

  const stopAutoDetect = useCallback(async () => {
    adOnStartRef.current = null;
    adOnEndRef.current   = null;
    adActiveRef.current  = false;
    if (ctrlRef.current) await ctrlRef.current.writeValue(CMD_STOP);
  }, []);

  return { connected, reconnecting, force, peak, avgForce, bleError, connect, startMeasuring, stopMeasuring, resetPeak, tare, targetKgRef, setAutoFailCallback, startAutoDetect, stopAutoDetect };
}

// ─────────────────────────────────────────────────────────────
// SUPABASE HELPERS
// ─────────────────────────────────────────────────────────────
// workout_sessions table — run once in Supabase SQL editor:
//   CREATE TABLE workout_sessions (
//     id text PRIMARY KEY,
//     date text, workout text, session_number integer,
//     exercises jsonb,
//     created_at timestamptz DEFAULT now()
//   );
//   ALTER TABLE workout_sessions ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON workout_sessions FOR ALL USING (auth.uid() IS NOT NULL);

async function pushWorkoutSession(session) {
  try {
    const { error } = await supabase.from("workout_sessions").upsert({
      id:             session.id,
      date:           session.date,
      completed_at:   session.completedAt ?? null,
      workout:        session.workout,
      session_number: session.sessionNumber,
      exercises:      session.exercises,
    }, { onConflict: "id" });
    if (error) { console.warn("Supabase workout push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout push exception:", e.message);
    return false;
  }
}

async function fetchWorkoutSessions() {
  const { data, error } = await supabase
    .from("workout_sessions")
    .select("*")
    .order("date", { ascending: false });
  if (error) { console.warn("Supabase workout fetch:", error.message); return null; }
  return (data || []).map(s => ({
    id:            s.id,
    date:          s.date,
    completedAt:   s.completed_at ?? null,
    workout:       s.workout,
    sessionNumber: s.session_number,
    exercises:     s.exercises || {},
  }));
}

async function deleteWorkoutSession(id) {
  try {
    const { error } = await supabase.from("workout_sessions").delete().eq("id", id);
    if (error) { console.warn("Supabase workout delete:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase workout delete exception:", e.message);
    return false;
  }
}

// The new schema uses a `reps` table. Create it with:
//   CREATE TABLE reps (
//     id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
//     created_at timestamptz DEFAULT now(),
//     date text, grip text, hand text,
//     target_duration integer, weight_kg real, actual_time_s real,
//     avg_force_kg real, peak_force_kg real,
//     set_num integer, rep_num integer,
//     rest_s integer, session_id text,
//     failed boolean DEFAULT false
//   );
//   ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
//   CREATE POLICY "auth_all" ON reps FOR ALL USING (auth.uid() IS NOT NULL);
function repPayload(rep) {
  return {
    date: rep.date, grip: rep.grip, hand: rep.hand,
    target_duration: rep.target_duration, weight_kg: rep.weight_kg,
    actual_time_s: rep.actual_time_s, avg_force_kg: rep.avg_force_kg,
    peak_force_kg: rep.peak_force_kg ?? 0,
    set_num: rep.set_num, rep_num: rep.rep_num,
    rest_s: rep.rest_s, session_id: rep.session_id,
    failed: rep.failed ?? false,
    session_started_at: rep.session_started_at ?? null,
  };
}

// Returns true on success, false on failure (caller should queue the rep).
async function pushRep(rep) {
  try {
    const { error } = await supabase.from("reps").insert([repPayload(rep)]);
    if (error) { console.warn("Supabase push:", error.message); return false; }
    return true;
  } catch (e) {
    console.warn("Supabase push exception:", e.message);
    return false;
  }
}

// Add reps to the local retry queue.
function enqueueReps(reps) {
  const q = loadLS(LS_QUEUE_KEY) || [];
  const existing = new Set(q.map(r => r.id));
  const toAdd = reps.filter(r => r.id && !existing.has(r.id));
  if (toAdd.length > 0) saveLS(LS_QUEUE_KEY, [...q, ...toAdd]);
}

// Attempt to push all queued reps; remove each one on success.
async function flushQueue() {
  const q = loadLS(LS_QUEUE_KEY) || [];
  if (q.length === 0) return 0;
  let remaining = [...q];
  let flushed = 0;
  for (const rep of q) {
    const ok = await pushRep(rep);
    if (ok) {
      remaining = remaining.filter(r => r.id !== rep.id);
      flushed++;
    }
  }
  saveLS(LS_QUEUE_KEY, remaining);
  return flushed;
}

async function fetchReps() {
  const { data, error } = await supabase
    .from("reps").select("*").order("date", { ascending: false });
  if (error) { console.warn("Supabase fetch:", error.message); return null; }
  return (data || []).map(r => ({
    id: r.id, date: r.date ?? today(),
    grip: r.grip ?? "", hand: r.hand ?? "L",
    target_duration: Number(r.target_duration) || 45,
    weight_kg: Number(r.weight_kg) || 0,
    actual_time_s: Number(r.actual_time_s) || 0,
    avg_force_kg: Number(r.avg_force_kg) || 0,
    peak_force_kg: Number(r.peak_force_kg) || 0,
    set_num: Number(r.set_num) || 1,
    rep_num: Number(r.rep_num) || 1,
    rest_s: Number(r.rest_s) || 20,
    session_id: r.session_id ?? "",
    failed: r.failed ?? false,
    session_started_at: r.session_started_at ?? null,
  }));
}

// ─────────────────────────────────────────────────────────────
// DESIGN TOKENS
// ─────────────────────────────────────────────────────────────
const C = {
  bg:      "#0d1117",
  card:    "#161b22",
  border:  "#30363d",
  text:    "#e6edf3",
  muted:   "#8b949e",
  blue:    "#58a6ff",
  green:   "#3fb950",
  red:     "#f85149",
  orange:  "#f0883e",
  purple:  "#bc8cff",
  yellow:  "#e3b341",
};

const base = {
  fontFamily: "'Segoe UI', system-ui, sans-serif",
  color: C.text,
  background: C.bg,
  minHeight: "100vh",
  padding: "0",
  margin: "0",
};

// ─────────────────────────────────────────────────────────────
// SHARED UI COMPONENTS
// ─────────────────────────────────────────────────────────────
function Card({ children, style }) {
  return (
    <div style={{
      background: C.card, border: `1px solid ${C.border}`,
      borderRadius: 12, padding: "20px 24px", marginBottom: 16,
      ...style,
    }}>
      {children}
    </div>
  );
}

function Btn({ children, onClick, color = C.blue, disabled, style, small }) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      style={{
        background: disabled ? C.border : color,
        color: "#fff", border: "none", borderRadius: 8,
        padding: small ? "6px 14px" : "10px 22px",
        fontSize: small ? 13 : 15, fontWeight: 600,
        cursor: disabled ? "not-allowed" : "pointer",
        opacity: disabled ? 0.5 : 1,
        transition: "opacity 0.15s",
        ...style,
      }}
    >
      {children}
    </button>
  );
}

function Label({ children }) {
  return <div style={{ fontSize: 12, color: C.muted, marginBottom: 4, textTransform: "uppercase", letterSpacing: "0.05em" }}>{children}</div>;
}

function Sect({ title, children }) {
  return (
    <div style={{ marginBottom: 20 }}>
      <div style={{ fontSize: 11, color: C.muted, textTransform: "uppercase", letterSpacing: "0.08em", marginBottom: 10, paddingBottom: 6, borderBottom: `1px solid ${C.border}` }}>
        {title}
      </div>
      {children}
    </div>
  );
}

// Inline body-weight prompt — shown in session setup when BW is stale (>3 days)
function BwPrompt({ unit = "lbs", onSave }) {
  const bwLog  = loadLS(LS_BW_LOG_KEY) || [];
  const latest = bwLog.length ? bwLog[bwLog.length - 1] : null;
  const daysSince = latest
    ? Math.floor((Date.now() - new Date(latest.date).getTime()) / 864e5)
    : Infinity;

  const [editing,  setEditing]  = useState(false);
  const [inputVal, setInputVal] = useState(() =>
    latest ? fmt0(toDisp(latest.kg, unit)) : ""
  );

  // Only show if stale or never set
  if (daysSince < 3) return null;

  const save = () => {
    // Integer precision — body weight doesn't need decimal accuracy
    const kg = fromDisp(Math.round(parseFloat(inputVal)), unit);
    if (!isNaN(kg) && kg > 0) { onSave(kg); setEditing(false); }
  };

  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 10,
      padding: "10px 14px", borderRadius: 10, marginBottom: 14,
      background: C.card, border: `1px solid ${C.border}`,
    }}>
      <span style={{ fontSize: 16 }}>⚖️</span>
      {!editing ? (
        <>
          <span style={{ flex: 1, fontSize: 13, color: C.muted }}>
            {latest
              ? <>Still <b style={{ color: C.text }}>{fmt0(toDisp(latest.kg, unit))} {unit}</b>?</>
              : <span>Body weight not set</span>}
          </span>
          <button onClick={() => setEditing(true)} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.text, fontSize: 12, fontWeight: 600,
          }}>{latest ? "Update" : "Set"}</button>
          {latest && (
            <button onClick={() => onSave(latest.kg)} style={{
              padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
              background: C.green + "33", color: C.green, fontSize: 12, fontWeight: 600,
            }}>✓ Yes</button>
          )}
        </>
      ) : (
        <>
          <input
            type="number"
            inputMode="numeric"
            step={1}
            min={30}
            max={500}
            value={inputVal}
            onChange={e => setInputVal(e.target.value)}
            onKeyDown={e => e.key === "Enter" && save()}
            autoFocus
            style={{
              flex: 1, background: C.bg, border: `1px solid ${C.border}`,
              borderRadius: 6, color: C.text, fontSize: 14, padding: "5px 8px",
            }}
          />
          <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
          <button onClick={save} style={{
            padding: "5px 12px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.blue, color: "#000", fontSize: 12, fontWeight: 700,
          }}>Save</button>
          <button onClick={() => setEditing(false)} style={{
            padding: "5px 8px", borderRadius: 8, border: "none", cursor: "pointer",
            background: C.border, color: C.muted, fontSize: 12,
          }}>✕</button>
        </>
      )}
    </div>
  );
}

function BigTimer({ seconds, targetSeconds, running }) {
  const pct = targetSeconds ? Math.min(seconds / targetSeconds, 1) : 0;
  const over = seconds >= targetSeconds;
  const color = running ? (over ? C.green : C.blue) : C.muted;
  return (
    <div style={{ textAlign: "center", padding: "24px 0" }}>
      <div style={{ fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color, lineHeight: 1 }}>
        {fmtTime(seconds)}
      </div>
      <div style={{ marginTop: 12, fontSize: 13, color: C.muted }}>
        target: {fmtTime(targetSeconds)}
      </div>
      <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: color, borderRadius: 3, transition: "width 0.2s" }} />
      </div>
    </div>
  );
}

// targetKg: the weight the user is aiming to hit (suggested or manual, in kg)
function ForceGauge({ force, avg, peak, targetKg = null, maxDisplay = 50, unit = "lbs" }) {
  const fPct    = clamp(force / maxDisplay, 0, 1);
  const avgPct  = clamp(avg   / maxDisplay, 0, 1);
  const tgtPct  = targetKg != null ? clamp(targetKg / maxDisplay, 0, 1) : null;

  // Color zones relative to target:
  //   below target         → orange
  //   at/above target      → green
  //   10%+ above target    → purple
  let barColor = C.blue; // no target = neutral blue
  let numColor = C.blue;
  if (targetKg != null && targetKg > 0) {
    if (force >= targetKg * 1.10) { barColor = C.purple; numColor = C.purple; }
    else if (force >= targetKg * 0.99) { barColor = C.green;  numColor = C.green;  }
    else                               { barColor = C.orange; numColor = C.orange; }
  }

  return (
    <div style={{ marginTop: 8 }}>
      {/* Large live-force number, same scale as BigTimer */}
      <div style={{ textAlign: "center", fontSize: 108, fontWeight: 800, fontVariantNumeric: "tabular-nums", color: numColor, lineHeight: 1 }}>
        {fmtW(force, unit)}
      </div>
      <div style={{ textAlign: "center", fontSize: 13, color: C.muted, marginTop: 4, marginBottom: 10 }}>
        {unit}{targetKg != null ? ` · target ${fmtW(targetKg, unit)} ${unit}` : ""}
      </div>
      {/* Stats row */}
      <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, color: C.muted, marginBottom: 6 }}>
        <span>Avg: <b style={{ color: C.green }}>{fmtW(avg, unit)} {unit}</b></span>
        <span>Peak: <b style={{ color: C.orange }}>{fmtW(peak, unit)} {unit}</b></span>
      </div>
      {/* Bar */}
      <div style={{ position: "relative", height: 28, background: C.border, borderRadius: 6, overflow: "hidden" }}>
        <div style={{ position: "absolute", height: "100%", width: `${fPct * 100}%`, background: barColor, borderRadius: 6, transition: "width 0.05s" }} />
        <div style={{ position: "absolute", top: 0, bottom: 0, left: `${avgPct * 100}%`, width: 3, background: C.green }} />
        {tgtPct != null && (
          <div style={{ position: "absolute", top: 0, bottom: 0, left: `${tgtPct * 100}%`, width: 2, background: "#ffffff60" }} />
        )}
      </div>
    </div>
  );
}

function RepDots({ total, done, current }) {
  return (
    <div style={{ display: "flex", gap: 8, justifyContent: "center", margin: "16px 0" }}>
      {Array.from({ length: total }, (_, i) => {
        const isDone = i < done;
        const isCur  = i === done;
        return (
          <div key={i} style={{
            width: 16, height: 16, borderRadius: "50%",
            background: isDone ? C.green : isCur ? C.blue : C.border,
            border: isCur ? `2px solid ${C.blue}` : "2px solid transparent",
            boxShadow: isCur ? `0 0 8px ${C.blue}` : "none",
            transition: "all 0.2s",
          }} />
        );
      })}
    </div>
  );
}


// ─────────────────────────────────────────────────────────────
// SESSION PLANNER CARD
// ─────────────────────────────────────────────────────────────
// Shows a goal picker + predicted per-rep fatigue curve + "Use this plan" button.
// Requires a live CF/W′ estimate fitted from training history.
// Uniform protocol: 20s rest between every hang, 4–6 hangs per session
// depending on zone. The set count is chosen so per-hang hold-time
// converges to its asymptote (you've drained to compartment-3 steady state).
// Power drains only the fast pool which refills ~75% in 20s, so it takes ~6
// hangs to hit the tail. Capacity drains all three pools per hang, so the tail
// is reached in ~4 hangs. Strength sits between.
const GOAL_CONFIG = {
  power: {
    label: "Power", emoji: "⚡", color: "#e05560",
    refTime: 7, restDefault: 20, repsDefault: 6, setsDefault: 1, setRestDefault: 0,
    intensity: "6 × 5–7s max · 20s rest",
    setsRationale: "Power protocol: 6 hangs of 5–7s at near-max load with 20s rest. 20s refills ~75% of PCr (τ₁≈15s) between hangs — enough to keep output high but not enough to fully recover. Six hangs reaches the asymptote where subsequent hangs would produce similar output; beyond that you're spinning your wheels. Use as a pre-climbing warm-up; primes neural drive without shredding you. Load auto-prescribed from CF + W'/7.",
  },
  strength: {
    label: "Strength", emoji: "💪", color: "#e07a30",
    refTime: 45, restDefault: 20, repsDefault: 5, setsDefault: 1, setRestDefault: 0,
    intensity: "45s + 4 to failure · 20s rest",
    setsRationale: "Strength protocol: hang 1 targets 45s, hangs 2–5 go to failure, 20s rest between. 20s refills PCr but barely touches the glycolytic pool (τ₂≈90s → ~20% recovery), so fatigue compounds and each subsequent hang falls short of the last. Stop at 5 hangs: you've reached the compartment-2 + 3 steady state. The rep-time decay curve is a personal τ₂ probe — watch it flatten over weeks as glycolytic recovery improves. Load auto-prescribed from CF + W'/45.",
  },
  endurance: {
    label: "Capacity", emoji: "🏔️", color: "#3b82f6",
    refTime: 120, restDefault: 20, repsDefault: 4, setsDefault: 1, setRestDefault: 0,
    intensity: "120s + 3 to failure · 20s rest · just above CF",
    setsRationale: "Capacity protocol at load ≈ CF + W'/120 (a hair above Critical Force). Hang 1 targets 120s continuous; hangs 2–4 go to failure with 20s rest. Each hang drains all three pools; 20s rest refills the fast pool but leaves medium and slow heavily depleted, so hold-time drops fast toward the CF asymptote. Stop at 4 hangs — subsequent hangs would be nearly flat on the tail. Trains CF / capillarity / mitochondrial density. Load auto-prescribed from CF + W'/120.",
  },
};

// ─────────────────────────────────────────────────────────────
// BADGE CONFIG — seven milestones from Genesis to Realization
// Thresholds are % AUC improvement above the Genesis snapshot.
// Badge 1 (Genesis) is earned by completing one session in each zone.
// ─────────────────────────────────────────────────────────────
const BADGE_CONFIG = [
  { id: "genesis",     label: "Genesis",     emoji: "🌱", threshold: 0,   desc: "One session in every zone — the curve awakens" },
  { id: "foundation",  label: "Foundation",  emoji: "🏛️", threshold: 10,  desc: "10% above Genesis — the base is taking shape" },
  { id: "progression", label: "Progression", emoji: "📈", threshold: 22,  desc: "22% above Genesis — the model sees real upward movement" },
  { id: "momentum",    label: "Momentum",    emoji: "⚡", threshold: 37,  desc: "37% above Genesis — adaptation is compounding" },
  { id: "grind",       label: "The Grind",   emoji: "⚙️", threshold: 55,  desc: "55% above Genesis — past the easy gains" },
  { id: "threshold",   label: "Threshold",   emoji: "🔥", threshold: 75,  desc: "75% above Genesis — crossing into rare territory" },
  { id: "realization", label: "Realization", emoji: "🏔️", threshold: 100, desc: "2× your Genesis capacity — the potential fulfilled" },
];

function SessionPlannerCard({ liveEstimate, onApplyPlan, recommendedZone = null, recommendedGrip = null, recommendedLabel = "recommended", recommendedScope = null }) {
  // Default goal to the recommended zone when we know it; fall back to strength
  const initGoal = (recommendedZone && GOAL_CONFIG[recommendedZone]) ? recommendedZone : "strength";
  const [goal,    setGoal]    = useState(initGoal);
  const [numReps, setNumReps] = useState(GOAL_CONFIG[initGoal].repsDefault);
  const [rest,    setRest]    = useState(GOAL_CONFIG[initGoal].restDefault);
  const [numSets,  setNumSets]  = useState(GOAL_CONFIG[initGoal].setsDefault);
  const [setRestS, setSetRestS] = useState(GOAL_CONFIG[initGoal].setRestDefault);

  const handleGoal = (g) => {
    setGoal(g);
    setNumReps(GOAL_CONFIG[g].repsDefault);
    setRest(GOAL_CONFIG[g].restDefault);
    setNumSets(GOAL_CONFIG[g].setsDefault);
    setSetRestS(GOAL_CONFIG[g].setRestDefault);
  };

  const gc = GOAL_CONFIG[goal];
  const firstRepTime = gc.refTime;

  const repTimes = useMemo(
    () => predictRepTimes({ numReps, firstRepTime, restSeconds: rest }),
    [numReps, firstRepTime, rest]
  );

  const chartData = repTimes.map((t, i) => ({ rep: i + 1, time: t }));
  const tail = repTimes.length > 1 ? Math.round((repTimes[repTimes.length - 1] / firstRepTime) * 100) : 100;

  // Total session volume: sum of all predicted hold times across all sets
  const totalVolume = Math.round(repTimes.reduce((s, t) => s + t, 0) * numSets);

  return (
    <Card style={{ marginBottom: 16, border: `1px solid ${gc.color}40` }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
        <div>
          <div style={{ fontSize: 14, fontWeight: 700 }}>🗓 Session Planner</div>
          {recommendedScope && (
            <div style={{ fontSize: 10, color: C.muted, marginTop: 2 }}>
              Recommendation for <span style={{ color: C.text, fontWeight: 600 }}>{recommendedScope}</span>
            </div>
          )}
        </div>
        {recommendedGrip && (
          <div style={{
            fontSize: 10, fontWeight: 700, letterSpacing: 0.3,
            padding: "2px 8px", borderRadius: 10,
            background: gc.color + "22", color: gc.color,
          }}>
            {recommendedGrip}
          </div>
        )}
      </div>

      {/* Goal picker */}
      <div style={{ display: "flex", gap: 8, marginBottom: 14 }}>
        {Object.entries(GOAL_CONFIG).map(([key, g]) => {
          const isRec = key === recommendedZone;
          return (
            <button key={key} onClick={() => handleGoal(key)} style={{
              flex: 1, padding: "8px 4px", borderRadius: 10, cursor: "pointer",
              background: goal === key ? g.color : C.border,
              color: goal === key ? "#fff" : C.muted,
              fontWeight: 700, fontSize: 12, transition: "all 0.15s",
              border: isRec ? `2px solid ${g.color}` : "2px solid transparent",
              position: "relative",
            }}>
              {isRec && (
                <div style={{
                  position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                  fontSize: 9, fontWeight: 700, background: g.color, color: "#fff",
                  padding: "1px 5px", borderRadius: 6, whiteSpace: "nowrap",
                }}>
                  {recommendedLabel}
                </div>
              )}
              <div style={{ fontSize: 16 }}>{g.emoji}</div>
              <div style={{ marginTop: 2 }}>{g.label}</div>
            </button>
          );
        })}
      </div>

      {/* Prescription summary strip */}
      <div style={{
        display: "flex", gap: 6, marginBottom: 14,
        background: C.bg, borderRadius: 10, padding: "10px 14px", alignItems: "center",
      }}>
        {[
          { label: "First rep",  value: `${firstRepTime}s` },
          { label: "Reps",       value: numReps },
          { label: "Sets",       value: numSets },
          { label: "Rep rest",   value: `${rest}s` },
          { label: "Set rest",   value: `${setRestS}s` },
        ].map(({ label, value }, i, arr) => (
          <React.Fragment key={label}>
            <div style={{ textAlign: "center", flex: 1 }}>
              <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: "0.05em" }}>{label}</div>
              <div style={{ fontSize: 15, fontWeight: 800, color: gc.color }}>{value}</div>
            </div>
            {i < arr.length - 1 && <div style={{ color: C.border, fontSize: 16 }}>·</div>}
          </React.Fragment>
        ))}
      </div>

      {/* Sliders — within-set structure */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
        Within Set
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Reps</span><span style={{ fontWeight: 700, color: C.text }}>{numReps}</span>
          </div>
          <input type="range" min={2} max={12} value={numReps} onChange={e => setNumReps(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Rep rest</span><span style={{ fontWeight: 700, color: C.text }}>{rest}s</span>
          </div>
          <input type="range" min={5} max={300} step={5} value={rest} onChange={e => setRest(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
      </div>

      {/* Sliders — between-set structure */}
      <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, textTransform: "uppercase", letterSpacing: "0.06em", marginBottom: 8 }}>
        Between Sets
      </div>
      <div style={{ display: "flex", gap: 16, marginBottom: 14 }}>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Sets</span><span style={{ fontWeight: 700, color: C.text }}>{numSets}</span>
          </div>
          <input type="range" min={1} max={8} value={numSets} onChange={e => setNumSets(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
        <div style={{ flex: 1 }}>
          <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 4 }}>
            <span>Set rest</span><span style={{ fontWeight: 700, color: C.text }}>{setRestS}s</span>
          </div>
          <input type="range" min={60} max={1800} step={60} value={setRestS} onChange={e => setSetRestS(Number(e.target.value))}
            style={{ width: "100%", accentColor: gc.color }} />
        </div>
      </div>

      {/* Sets rationale */}
      <div style={{
        background: gc.color + "12", borderLeft: `3px solid ${gc.color}`,
        borderRadius: "0 8px 8px 0", padding: "8px 12px", marginBottom: 14,
        fontSize: 12, color: C.muted, lineHeight: 1.6,
      }}>
        {gc.setsRationale}
      </div>

      {/* Predicted fatigue curve (within one set) */}
      <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>
        Predicted hold time per rep · tail at <b style={{ color: gc.color }}>{tail}%</b>
        &nbsp;· total volume ~<b style={{ color: gc.color }}>{totalVolume}s</b> across {numSets} set{numSets !== 1 ? "s" : ""}
      </div>
      <ResponsiveContainer width="100%" height={130}>
        <LineChart data={chartData} margin={{ top: 4, right: 12, bottom: 24, left: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
          <XAxis dataKey="rep" tick={{ fill: C.muted, fontSize: 11 }}
            label={{ value: "Rep (within set)", position: "insideBottom", offset: -14, fill: C.muted, fontSize: 11 }} />
          <YAxis tick={{ fill: C.muted, fontSize: 10 }} unit="s" width={34} domain={[0, firstRepTime * 1.15]} />
          <ReferenceLine y={firstRepTime} stroke={C.border} strokeDasharray="4 2" />
          <Tooltip
            contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
            formatter={(val) => [`${val}s`, "Hold"]}
          />
          <Line dataKey="time" stroke={gc.color} strokeWidth={2.5}
            dot={{ fill: gc.color, r: 4, strokeWidth: 0 }} name="Hold" />
        </LineChart>
      </ResponsiveContainer>

      {/* CTA */}
      <Btn
        onClick={() => onApplyPlan({
          goal,
          targetTime: firstRepTime, repsPerSet: numReps, restTime: rest,
          numSets, setRestTime: setRestS,
        })}
        color={gc.color}
        style={{ width: "100%", marginTop: 12, padding: "12px 0", borderRadius: 10, fontSize: 14, fontWeight: 700 }}
      >
        Use This Plan →
      </Btn>
    </Card>
  );
}

// ─────────────────────────────────────────────────────────────
// ZONE COVERAGE CARD
// Rolling 30-day count of Power / Strength / Capacity sessions.
// Shows which zone is undertrained and should be trained next.
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// CLIMBING LOG
// Each logged entry = one climb (discipline, grade, ascent style).
// Climbing is tracked for readiness / context but is intentionally
// NOT credited to zone coverage (see computeZoneCoverage note).
// ─────────────────────────────────────────────────────────────
const CLIMB_DISCIPLINES = [
  { key: "boulder",  label: "Boulder",  emoji: "⚡", desc: "Power / max moves"     },
  { key: "top_rope", label: "Top rope", emoji: "🧗", desc: "Roped, top-anchor"     },
  { key: "lead",     label: "Lead",     emoji: "🪢", desc: "Roped, clip as you go" },
];

const ASCENT_STYLES = [
  { key: "onsight",  label: "Onsight",  desc: "1st try, no beta"      },
  { key: "flash",    label: "Flash",    desc: "1st try, with beta"    },
  { key: "redpoint", label: "Redpoint", desc: "Sent after working"    },
  { key: "attempt",  label: "Attempt",  desc: "Worked but didn't send"},
];

// V0..V13 covers the vast majority of recreational to advanced boulder grades.
const V_GRADES   = Array.from({ length: 14 }, (_, i) => `V${i}`);
// YDS 5.6..5.14d with a-d subgrades above 5.10.
const YDS_GRADES = (() => {
  const base = ["5.6", "5.7", "5.8", "5.9"];
  const suffix = ["a", "b", "c", "d"];
  const sub    = [];
  for (const n of [10, 11, 12, 13, 14]) {
    for (const s of suffix) sub.push(`5.${n}${s}`);
  }
  return [...base, ...sub];
})();

function gradesFor(discipline) {
  return discipline === "boulder" ? V_GRADES : YDS_GRADES;
}

function defaultGradeFor(discipline) {
  return discipline === "boulder" ? "V3" : "5.10a";
}

function disciplineMeta(key) {
  return CLIMB_DISCIPLINES.find(d => d.key === key)
      || { key, label: key, emoji: "🧗", desc: "" };
}

function ascentMeta(key) {
  return ASCENT_STYLES.find(a => a.key === key)
      || { key, label: key, desc: "" };
}

// Pretty one-liner for a single climb entry. Handles legacy
// intensity/duration entries so old data still renders.
function describeClimb(a) {
  if (a.discipline || a.grade || a.ascent) {
    const d = disciplineMeta(a.discipline).label;
    const g = a.grade || "—";
    const s = a.ascent ? ascentMeta(a.ascent).label : "";
    return s ? `${d} · ${g} · ${s}` : `${d} · ${g}`;
  }
  // Legacy (pre-grade) entries
  const parts = [];
  if (a.intensity)    parts.push(a.intensity);
  if (a.duration_min) parts.push(`${a.duration_min}m`);
  return parts.join(" · ") || "Climbing session";
}

// Numeric ordering for mixed V / YDS grades. Returns a rank that is
// comparable within a discipline family; -1 for anything we don't
// recognize so legacy entries don't skew max/min computations.
function gradeRank(grade) {
  if (!grade) return -1;
  const vMatch = /^V(\d+)$/.exec(grade);
  if (vMatch) return parseInt(vMatch[1], 10);
  const ydsMatch = /^5\.(\d+)([abcd])?$/.exec(grade);
  if (ydsMatch) {
    const n = parseInt(ydsMatch[1], 10);
    const s = ydsMatch[2] ? "abcd".indexOf(ydsMatch[2]) / 4 : 0;
    return n + s;
  }
  return -1;
}

// Shared date-grouped climb list. Used in the Climbing tab, the
// History tab's climbing domain, and anywhere else we want to show
// per-climb rows.
function ClimbingHistoryList({ climbs, onDeleteActivity = null }) {
  const byDate = useMemo(() => {
    const m = new Map();
    for (const c of climbs) {
      const d = c.date || "—";
      if (!m.has(d)) m.set(d, []);
      m.get(d).push(c);
    }
    return [...m.entries()];
  }, [climbs]);

  if (climbs.length === 0) {
    return (
      <Card>
        <div style={{ color: C.muted, fontSize: 13 }}>
          No climbs logged yet. Use the Climbing tab to log your first climb.
        </div>
      </Card>
    );
  }

  return byDate.map(([date, list]) => (
    <Card key={date}>
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
        {date} · {list.length} climb{list.length === 1 ? "" : "s"}
      </div>
      {list.map(c => {
        const isSend = c.ascent && c.ascent !== "attempt";
        const disc   = disciplineMeta(c.discipline);
        return (
          <div key={c.id || `${c.date}-${c.grade}-${c.ascent}`} style={{
            display: "flex", alignItems: "center", gap: 10,
            padding: "8px 0",
            borderTop: `1px solid ${C.border}`,
          }}>
            <div style={{ fontSize: 18 }}>{disc.emoji}</div>
            <div style={{ flex: 1 }}>
              <div style={{ fontSize: 13, fontWeight: 600 }}>
                {c.grade || "—"}{" "}
                <span style={{ color: C.muted, fontWeight: 400 }}>
                  {disc.label}
                </span>
              </div>
              <div style={{ fontSize: 11, color: isSend ? C.green : C.muted }}>
                {c.ascent ? ascentMeta(c.ascent).label : describeClimb(c)}
              </div>
            </div>
            {onDeleteActivity && c.id && (
              <button
                onClick={() => {
                  if (window.confirm("Delete this climb?")) onDeleteActivity(c.id);
                }}
                style={{
                  background: "none", border: "none", color: C.muted,
                  cursor: "pointer", fontSize: 16, padding: "4px 6px",
                }}
                title="Delete climb"
              >
                ×
              </button>
            )}
          </div>
        );
      })}
    </Card>
  ));
}

function ClimbingLogWidget({ activities = [], onLog = () => {} }) {
  const [open,       setOpen]       = useState(false);
  const [discipline, setDiscipline] = useState("boulder");
  const [grade,      setGrade]      = useState(defaultGradeFor("boulder"));
  const [ascent,     setAscent]     = useState("flash");
  const [logged,     setLogged]     = useState(false);

  const todayActivities = activities.filter(a => a.date === today() && a.type === "climbing");
  const hasToday        = todayActivities.length > 0;

  const handleDiscipline = (key) => {
    setDiscipline(key);
    // If switching grading systems, reset grade to the new default so
    // we never end up with a V-grade on a lead route or vice versa.
    const valid = gradesFor(key);
    if (!valid.includes(grade)) setGrade(defaultGradeFor(key));
  };

  const handleLog = () => {
    onLog({ date: today(), type: "climbing", discipline, grade, ascent });
    setLogged(true);
    setTimeout(() => setLogged(false), 3000);
  };

  return (
    <div style={{ marginBottom: 16 }}>
      {/* Collapsed row */}
      {!open && (
        <button
          onClick={() => setOpen(true)}
          style={{
            width: "100%", padding: "10px 16px", borderRadius: 10, cursor: "pointer",
            background: C.card, border: `1px solid ${C.border}`,
            display: "flex", alignItems: "center", justifyContent: "space-between",
            color: C.text, fontSize: 13,
          }}
        >
          <span>
            🧗 {hasToday
              ? `${todayActivities.length} climb${todayActivities.length === 1 ? "" : "s"} logged today`
              : logged ? "✓ Climb logged!" : "Log a climb"}
          </span>
          <span style={{ fontSize: 11, color: C.muted }}>discipline · grade · style</span>
        </button>
      )}

      {/* Expanded form */}
      {open && (
        <Card style={{ border: `1px solid ${C.blue}40` }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 12 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>🧗 Log Climb</div>
            <button onClick={() => setOpen(false)} style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 18, lineHeight: 1 }}>×</button>
          </div>

          {/* Discipline picker */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Discipline</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {CLIMB_DISCIPLINES.map(({ key, label, emoji }) => (
              <button key={key} onClick={() => handleDiscipline(key)} style={{
                flex: "1 1 30%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                border: discipline === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                background: discipline === key ? C.blue + "22" : C.bg,
                color: C.text, textAlign: "center",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{emoji} {label}</div>
              </button>
            ))}
          </div>

          {/* Grade picker (V for boulder, YDS for TR/lead) */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>
            Grade ({discipline === "boulder" ? "V-scale" : "YDS"})
          </div>
          <select
            value={grade}
            onChange={(e) => setGrade(e.target.value)}
            style={{
              width: "100%", padding: "8px 10px", marginBottom: 14, borderRadius: 8,
              background: C.bg, color: C.text, border: `1px solid ${C.border}`,
              fontSize: 13,
            }}
          >
            {gradesFor(discipline).map(g => (
              <option key={g} value={g}>{g}</option>
            ))}
          </select>

          {/* Ascent style */}
          <div style={{ fontSize: 12, color: C.muted, marginBottom: 6 }}>Ascent</div>
          <div style={{ display: "flex", gap: 6, marginBottom: 14, flexWrap: "wrap" }}>
            {ASCENT_STYLES.map(({ key, label, desc }) => (
              <button key={key} onClick={() => setAscent(key)} style={{
                flex: "1 1 40%", padding: "8px 6px", borderRadius: 8, cursor: "pointer",
                border: ascent === key ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                background: ascent === key ? C.blue + "22" : C.bg,
                color: C.text, textAlign: "left",
              }}>
                <div style={{ fontSize: 13, fontWeight: 600 }}>{label}</div>
                <div style={{ fontSize: 10, color: C.muted }}>{desc}</div>
              </button>
            ))}
          </div>

          <Btn onClick={handleLog} color={C.blue} style={{ width: "100%", padding: "10px 0", borderRadius: 8 }}>
            Log Climb
          </Btn>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// 1RM legacy — the OneRMWidget has been removed from the UI now that
// the power protocol (6 × 5–7s max hangs at 20s rest) is used as the
// pre-climb warm-up and replaces a standalone 1RM test.
// RM_GRIPS stays so the 1RM PR tracker on the Analysis tab can render
// historical data; computeZoneCoverage still treats any existing
// `type: "oneRM"` activity entries as Power credit.
// ─────────────────────────────────────────────────────────────
const RM_GRIPS = ["Micro", "Crusher"];

// Zone coverage counts only grip-training sessions (and legacy 1RM activities,
// which were finger-specific max efforts). Climbing sessions are intentionally
// NOT credited to any zone — the old heuristic (hard→strength, easy→capacity,
// boulder→power) over-counted climbing toward training zones it didn't really
// stimulate in a finger-specific way. ClimbingLogWidget still logs climbs so
// the data is preserved for future fatigue-accounting work, but it no longer
// inflates the Power / Strength / Capacity buckets on the coverage card.
function computeZoneCoverage(history, activities = []) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - 30);
  const cutoffStr = ymdLocal(cutoff);

  // Grip-training sessions
  const sessions = {};
  for (const r of history) {
    if ((r.date ?? "") < cutoffStr) continue;
    const sid = r.session_id || r.date;
    if (!sessions[sid]) sessions[sid] = { date: r.date, durations: [] };
    const d = r.target_duration || r.actual_time_s;
    if (d > 0) sessions[sid].durations.push(d);
  }

  let power = 0, strength = 0, endurance = 0;
  for (const s of Object.values(sessions)) {
    if (!s.durations.length) continue;
    const sorted = [...s.durations].sort((a, b) => a - b);
    const median = sorted[Math.floor(sorted.length / 2)];
    // Half-open intervals [lo, hi) so boundary values land consistently
    // with computeLimiterZone. A capacity protocol (target 120s) goes to
    // endurance, not strength.
    if (median < POWER_MAX)         power++;     // [0, 20)
    else if (median < STRENGTH_MAX) strength++;  // [20, 120)
    else                            endurance++; // [120, ∞)
  }

  // Legacy 1RM activities still credit Power — they are finger-specific max
  // efforts from before the power protocol was introduced.
  for (const a of activities) {
    if ((a.date ?? "") < cutoffStr) continue;
    if (a.type === "oneRM") power++;
  }

  const total = power + strength + endurance;
  const recommended =
    power <= strength && power <= endurance ? "power" :
    strength <= endurance                    ? "strength" : "endurance";

  return { power, strength, endurance, total, recommended };
}

// Physiological limiter: which compartment is the user's capacity
// shortfall relative to their own force-duration curve?
// Returns { zone, grip } | null. Null means no/ambiguous data — caller
// should fall back to coverage.
//
// WHY SEGMENT BY GRIP.
// Absolute force on Crusher (~30 kg CF) and Micro (~10 kg CF) are not
// on the same scale — different joint, different skin, different
// tendon moment arm. Pooling them into one Monod fit produces a fit
// pulled toward the average and residuals that reflect tool choice
// rather than physiology. Each grip gets its own CF/W' fit, just as
// prescribedLoad already does for load prescription.
//
// PRIMARY SIGNAL — Monod cross-zone residual.
// Within a single grip, for each zone Z, fit F = CF + W'/T on rep-1
// failures from the OTHER two zones, then predict force at each of
// Z's actual_time_s values. The residual = predicted − actual is the
// capacity shortfall in Z relative to the curve implied by the other
// two zones. The zone with the biggest positive residual is the one
// that falls farthest below the user's own curve for that grip.
//
// Why Monod and not true three-compartment decay?
// Three-compartment (F = F_max × Σ A_i·e^(-T/τ_i)) either (a) assumes
// textbook A_i/τ_i and reintroduces the reference-athlete bias, or
// (b) frees all 6+ parameters and needs far more data to fit stably.
// Monod is a 2-parameter linear fit (via fitCF) that closely
// approximates the three-compartment shape over 5s–300s and is
// numerically stable at the data volumes we actually see.
//
// FALLBACK — failure-count distribution within the same grip.
// If a grip has data but not enough for cross-zone CV (e.g. only two
// zones trained), fall back to the least-trained zone by rep-1
// failure count within that grip. Under RPE-10 every session ends in
// failure by design — fail RATE saturates near 1.0 so count is the
// only usable summary statistic.
//
// GRIP SELECTION.
// If the user trains multiple grips, we rank grips by recent rep-1
// failure volume (most-trained grip = user's current focus) and
// return the recommendation for the first grip whose data supports
// one. A grip with a balanced curve is skipped — we try the next.
//
// Why only rep 1?  Reps 2+ in strength/capacity are to-failure by
// protocol design — their failed flag is ~100% true regardless of
// physiology. Rep 1 is the clean probe of "did you meet the zone's
// demand".
//
// Why bucket by target_duration?  A failing rep of a strength session
// may drop to 10s (power by actual_time_s), but it's still strength-
// protocol data. target_duration reflects intended zone.
const LIMITER_WINDOW_DAYS      = 30;
const LIMITER_MIN_FAILURES     = 3;    // total within a grip before we trust the signal
const LIMITER_MIN_PTS_TRAIN    = 2;    // each of the two "training" zones needs this many points
const LIMITER_MIN_PTS_HELDOUT  = 1;    // the held-out zone needs at least this many
const LIMITER_RESIDUAL_KG      = 0.5;  // smallest gap we'll call a limiter — below this the curve is balanced
function computeLimiterZone(history) {
  const cutoff = new Date();
  cutoff.setDate(cutoff.getDate() - LIMITER_WINDOW_DAYS);
  const cutoffStr = ymdLocal(cutoff);

  const allFailures = history.filter(r =>
    r.rep_num === 1 && r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 &&
    (r.date || "") >= cutoffStr &&
    r.grip   // require known grip — otherwise we can't attribute
  );
  if (allFailures.length < LIMITER_MIN_FAILURES) return null;

  // Segment by grip. Force scales aren't comparable across grips.
  const byGrip = {};
  for (const r of allFailures) (byGrip[r.grip] ||= []).push(r);

  const zoneOf = (td) =>
    td < POWER_MAX        ? "power"    :
    td < STRENGTH_MAX     ? "strength" :
                            "endurance";

  // Try each grip, most-trained-in-30-days first. Return the first
  // grip whose data supports a recommendation. Skipping a grip with
  // a balanced curve is correct — it means that grip is on-curve,
  // and the next-most-trained grip may still have a deficit.
  const rankedGrips = Object.entries(byGrip)
    .sort(([, a], [, b]) => b.length - a.length);

  for (const [grip, failures] of rankedGrips) {
    if (failures.length < LIMITER_MIN_FAILURES) continue;

    const byZone = { power: [], strength: [], endurance: [] };
    for (const r of failures) byZone[zoneOf(r.target_duration)].push(r);

    // ── Primary: Monod cross-zone residual (per grip) ──
    const zones = ["power", "strength", "endurance"];
    const residuals = {};
    let cvWorked = true;
    for (const Z of zones) {
      const heldOut = byZone[Z];
      const others  = zones.filter(z => z !== Z);
      const bothTrainZonesOk = others.every(z => byZone[z].length >= LIMITER_MIN_PTS_TRAIN);
      if (!bothTrainZonesOk || heldOut.length < LIMITER_MIN_PTS_HELDOUT) {
        cvWorked = false;
        break;
      }
      const trainPts = others
        .flatMap(z => byZone[z])
        .map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const fit = fitCF(trainPts);
      if (!fit) { cvWorked = false; break; }

      // Average predicted − actual across all held-out rep-1 failures.
      // Positive = actual fell short of the cross-zone prediction.
      const gaps = heldOut.map(r => predForce(fit, r.actual_time_s) - r.avg_force_kg);
      residuals[Z] = gaps.reduce((a, b) => a + b, 0) / gaps.length;
    }

    if (cvWorked) {
      const ranked = Object.entries(residuals).sort(([, a], [, b]) => b - a);
      // Only return a pick if the top gap is meaningfully positive.
      // Below LIMITER_RESIDUAL_KG this grip's curve is balanced — try
      // the next grip rather than falling through to counts (counts
      // would disagree with a balanced curve and pick noise).
      if (ranked[0][1] > LIMITER_RESIDUAL_KG) return { zone: ranked[0][0], grip };
      continue;
    }

    // ── Fallback: failure-count within this grip ──
    const counts = {
      power:     byZone.power.length,
      strength:  byZone.strength.length,
      endurance: byZone.endurance.length,
    };
    const vals = Object.values(counts);
    if (vals.every(v => v === vals[0])) continue;
    const picked = Object.entries(counts).sort(([, a], [, b]) => a - b)[0][0];
    return { zone: picked, grip };
  }
  return null;
}

// ── Personalized response calibration ───────────────────────────────
// Fits per-zone CF/W′ response rates from the user's own training log
// and shrinks them toward the PROTOCOL_RESPONSE prior with Bayesian
// shrinkage. Early on (thin data) the returned coefficients equal the
// prior; as training-under-tension accumulates in a given zone, the
// fit pulls toward the observed personal rate. A zone needs at least
// MIN_SESSIONS effective session-equivalents before any personal
// signal is blended in.
//
// Attribution: proportional by time-under-tension (TUT), not by rep
// count or dominant zone. A day with 15s of power warm-up + 180s of
// strength work gets 8% / 92% attribution, not all-or-nothing to the
// dominant zone. This correctly handles the common case where a user
// does a short max-effort warm-up (power) before their main training
// block — the warm-up gets its proportional share, the main block
// gets most of it. No user-facing toggle required: if power always
// comes in small TUT doses, its effective-n stays small and its
// personal calibration stays near prior.
//
// Per-day loop: for each calendar day with failures, refit Monod on
// all data up to that day vs. through the previous day. Fractional
// ΔCF and ΔW′ are split across zones proportional to that day's TUT
// per zone, then accumulated as weighted observations. Noise in
// single-day deltas averages out over many weighted observations.
// Negative observed rates are floored at zero (likely confounds:
// illness, taper, bad mount) rather than propagated as "training
// hurt me" into a negative coefficient.
//
// Shrinkage: posterior = (k₀·prior + n_eff·weighted_mean) / (k₀ + n_eff).
// With k₀ = PERSONAL_RESPONSE_PRIOR_WEIGHT, a zone needs roughly k₀
// session-equivalents of evidence before personal rates dominate. n_eff
// is fractional: a warm-up contributing 8% TUT counts as 0.08 sessions.
const PERSONAL_RESPONSE_PRIOR_WEIGHT = 10;  // pseudo-sessions
const PERSONAL_RESPONSE_MIN_SESSIONS = 5;    // hard gate per zone (effective-n)

function computePersonalResponse(history) {
  const zoneOf = (td) =>
    td < POWER_MAX    ? "power"    :
    td < STRENGTH_MAX ? "strength" :
                        "endurance";

  // Default: everyone starts at the prior with source='prior', n=0.
  const result = {
    power:     { ...PROTOCOL_RESPONSE.power,     n: 0, source: "prior" },
    strength:  { ...PROTOCOL_RESPONSE.strength,  n: 0, source: "prior" },
    endurance: { ...PROTOCOL_RESPONSE.endurance, n: 0, source: "prior" },
  };

  if (!history || history.length < 4) return result;

  const failures = history.filter(r =>
    r.failed &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0 && r.target_duration > 0 && r.date
  );
  if (failures.length < 4) return result;

  // Sort and bucket by date.
  const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
  const byDate = {};
  for (const r of sorted) (byDate[r.date] ||= []).push(r);
  const dates = Object.keys(byDate).sort();

  // Walk dates; at each date with enough prior data, refit before/after
  // and split the fractional delta across zones by TUT proportion.
  // obs[zone] is an array of { weight, dCF, dW } — weight = TUT fraction.
  const obs = { power: [], strength: [], endurance: [] };

  for (const date of dates) {
    const before = sorted.filter(r => r.date < date);
    const after  = sorted.filter(r => r.date <= date);
    if (before.length < 2) continue;

    const fitBefore = fitCF(before.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    const fitAfter  = fitCF(after.map(r  => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
    if (!fitBefore || !fitAfter) continue;
    if (fitBefore.CF <= 0) continue;

    const dCF = (fitAfter.CF - fitBefore.CF) / fitBefore.CF;
    const dW  = fitBefore.W > 0 ? (fitAfter.W - fitBefore.W) / fitBefore.W : 0;

    // TUT per zone for the day — sum actual_time_s bucketed by the zone
    // each rep was *targeting* (target_duration), not the zone the rep
    // fell into. A failed capacity-target rep at 60s still attributes
    // to capacity training. Matches the zone-bucketing convention used
    // everywhere else in the app.
    const tut = { power: 0, strength: 0, endurance: 0 };
    for (const r of byDate[date]) tut[zoneOf(r.target_duration)] += r.actual_time_s;
    const totalTUT = tut.power + tut.strength + tut.endurance;
    if (totalTUT <= 0) continue;

    for (const zone of Object.keys(tut)) {
      const w = tut[zone] / totalTUT;
      if (w > 0) obs[zone].push({ weight: w, dCF, dW });
    }
  }

  // Weighted shrinkage. Effective-n = Σ weights (can be fractional).
  const k0 = PERSONAL_RESPONSE_PRIOR_WEIGHT;
  for (const zone of Object.keys(PROTOCOL_RESPONSE)) {
    const zoneObs = obs[zone];
    const nEff = zoneObs.reduce((s, o) => s + o.weight, 0);

    if (nEff < PERSONAL_RESPONSE_MIN_SESSIONS) {
      result[zone] = { ...PROTOCOL_RESPONSE[zone], n: nEff, source: "prior" };
      continue;
    }

    // Weighted mean of observed fractional deltas. Divides by Σweights
    // so each day's total contribution (across all zones) is 1 unit of
    // evidence, split proportionally by that day's TUT distribution.
    const wMeanCF = zoneObs.reduce((s, o) => s + o.weight * o.dCF, 0) / nEff;
    const wMeanW  = zoneObs.reduce((s, o) => s + o.weight * o.dW,  0) / nEff;
    const prior   = PROTOCOL_RESPONSE[zone];

    // Floor at zero: negative observed rate is almost always confounded
    // (illness, injury, mount variance) rather than true anti-response.
    const cfBlended = Math.max(0, (k0 * prior.cf + nEff * wMeanCF) / (k0 + nEff));
    const wBlended  = Math.max(0, (k0 * prior.w  + nEff * wMeanW)  / (k0 + nEff));

    result[zone] = {
      cf: cfBlended,
      w:  wBlended,
      n:  nEff,
      source: "blended",
    };
  }

  return result;
}

// Zone Workout Summary — neutral 30-day volume breakdown. Does NOT
// prescribe training: the SessionPlanner owns the recommendation
// (per-grip Monod cross-zone residual). This card is purely a log.
// computeZoneCoverage still returns .recommended because the planner
// uses it as a fallback when there's too little failure data for the
// curve-residual signal; we just don't display that prescription here.
function ZoneCoverageCard({ history, activities = [] }) {
  const coverage = useMemo(() => computeZoneCoverage(history, activities),
    [history, activities]); // eslint-disable-line react-hooks/exhaustive-deps

  if (coverage.total === 0) return null;

  const zones = [
    { key: "power",     label: "⚡ Power",     val: coverage.power,     color: "#e05560" },
    { key: "strength",  label: "💪 Strength",  val: coverage.strength,  color: "#e07a30" },
    { key: "endurance", label: "🏔️ Capacity",  val: coverage.endurance, color: "#3b82f6" },
  ];
  const maxVal = Math.max(coverage.power, coverage.strength, coverage.endurance, 1);

  return (
    <Card style={{ marginBottom: 16 }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
        <div style={{ fontSize: 14, fontWeight: 700 }}>Zone Workout Summary</div>
        <div style={{ fontSize: 11, color: C.muted }}>last 30 days · {coverage.total} sessions</div>
      </div>
      {zones.map(({ key, label, val, color }) => (
        <div key={key} style={{ marginBottom: 10 }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 4 }}>
            <div style={{ fontSize: 12, color: C.muted, display: "flex", alignItems: "center", gap: 6 }}>
              {label}
            </div>
            <div style={{ fontSize: 12, fontWeight: 600, color: C.muted }}>{val}</div>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{
              height: "100%", borderRadius: 3,
              width: `${(val / maxVal) * 100}%`,
              background: color,
              opacity: 0.85,
            }} />
          </div>
        </div>
      ))}
    </Card>
  );
}

function SetupView({ config, setConfig, onStart, history, freshMap = null, unit = "lbs", onBwSave = () => {}, readiness = null, todaySubj = null, onSubjReadiness = () => {}, isEstimated = false, liveEstimate = null, gripEstimates = {}, activities = [], onLogActivity = () => {}, connectSlot = null }) {
  const [customGrip, setCustomGrip] = useState("");

  const handleGrip = (g) => setConfig(c => ({ ...c, grip: g }));

  // Note: model-prescribed first-rep loads are computed inline in the
  // Prescribed Load card below, where we show all three zones at once
  // (F = CF + W'/refTime(zone)). The fallback chain there is:
  //   1. per-hand × per-grip failure fit (most specific)
  //   2. per-hand, any-grip failure fit (more data, less specific)
  //   3. historical weighted-average weight at similar target time

  // Level progress for current config — always both hands now
  const levelL      = calcLevel(history, "L", config.grip, config.targetTime);
  const levelR      = calcLevel(history, "R", config.grip, config.targetTime);
  const bestLoadL   = getBestLoad(history, "L", config.grip, config.targetTime);
  const bestLoadR   = getBestLoad(history, "R", config.grip, config.targetTime);
  const nextTargetL = nextLevelTarget(history, "L", config.grip, config.targetTime);
  const nextTargetR = nextLevelTarget(history, "R", config.grip, config.targetTime);
  const hasLevelData = (bestLoadL != null || bestLoadR != null) && config.grip;

  // Fatigue-adjusted load index for the prescribed-load card (computed once
  // per history change, then reused across the multiple prescribedLoad calls
  // in the card below). Uses the user's back-fit dose constant when there's
  // enough within-set data; otherwise falls back to the population prior.
  // Stable fingerprint so the 60-step grid search inside fitDoseK
  // doesn't re-run on every history reference change (Supabase syncs,
  // unrelated state updates that touch the App-level history array).
  // Keyed on length + last rep's id + last rep's date — captures the
  // dominant "new rep added" case. Edits to old reps will use the
  // stale k until the next session, which is fine since k varies
  // gently with sample size and the fatigue model isn't sensitive to
  // small k shifts (CV² minimum is broad — see fitDoseK).
  // freshMap is now provided by App via prop so the in-workout
  // startSession path uses the SAME memoized fatigue map (with the
  // user-fitted doseK) — without that sharing, the Setup-card
  // prescription and the in-workout "Rep 1 suggested weight" disagreed
  // by 1-2 lbs because startSession was falling back to DEF_DOSE_K.
  // Three-exp prior memo stays local to SetupView since it isn't
  // currently consumed elsewhere.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]); // eslint-disable-line react-hooks/exhaustive-deps

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 20px", fontSize: 22, fontWeight: 700 }}>Session Setup</h2>

      <Card>
        <Sect title="Grip Type">
          <div style={{ display: "flex", flexWrap: "wrap", gap: 8, marginBottom: 8 }}>
            {GRIP_PRESETS.map(g => (
              <button
                key={g}
                onClick={() => handleGrip(g)}
                style={{
                  padding: "6px 14px", borderRadius: 20, fontSize: 13,
                  cursor: "pointer", fontWeight: 500,
                  background: config.grip === g ? C.orange : C.border,
                  color: config.grip === g ? "#fff" : C.muted,
                  border: "none",
                }}
              >
                {g}
              </button>
            ))}
          </div>
          <div style={{ display: "flex", gap: 8 }}>
            <input
              value={customGrip}
              onChange={e => setCustomGrip(e.target.value)}
              placeholder="Custom grip…"
              style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14 }}
            />
            <Btn small onClick={() => { if (customGrip.trim()) { handleGrip(customGrip.trim()); setCustomGrip(""); } }}>
              Use
            </Btn>
          </div>
        </Sect>
      </Card>

      {/* Zone Workout Summary — neutral 30-day volume breakdown (no prescription) */}
      {/* Level progress for selected config */}
      {hasLevelData && (
        <Card style={{ marginBottom: 12 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            {config.grip} · {config.targetTime}s
          </div>
          <div style={{ display: "flex", gap: 12 }}>
            {[
              { key: "L", label: "Left",  level: levelL, best: bestLoadL, next: nextTargetL },
              { key: "R", label: "Right", level: levelR, best: bestLoadR, next: nextTargetR },
            ].map(row => (
              <div key={row.key} style={{ flex: 1, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>{row.label}</div>
                <div style={{ fontSize: 16, fontWeight: 800, color: C.text }}>
                  {row.best != null
                    ? <>{LEVEL_EMOJIS[Math.min(row.level - 1, LEVEL_EMOJIS.length - 1)]} L{row.level}</>
                    : <span style={{ color: C.muted, fontWeight: 500 }}>—</span>}
                </div>
                {row.best != null && (
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 2 }}>
                    {fmtW(row.best, unit)} {unit}
                    {row.next != null && <> · next {fmtW(row.next, unit)}</>}
                  </div>
                )}
                {row.next != null && row.best != null && (
                  <div style={{ width: "100%", height: 4, background: C.border, borderRadius: 2, marginTop: 6 }}>
                    <div style={{
                      height: "100%", borderRadius: 2, background: C.green,
                      width: `${Math.min(100, (row.best / row.next) * 100)}%`,
                    }} />
                  </div>
                )}
              </div>
            ))}
          </div>
        </Card>
      )}

      {(history.length > 0 || activities.length > 0) && <ZoneCoverageCard history={history} activities={activities} />}

      {/* Session Planner — always shown; defaults to the limiter zone
          (Monod cross-zone residual: the zone that falls farthest
          below the curve fit on the other two zones' rep-1 failures
          in the last 30 days), falling back to coverage when failure
          data is too sparse for the cross-zone fit. Matches the
          Analysis tab's precedence so the two views never disagree. */}
      {(() => {
        const limiter = computeLimiterZone(history);
        const limiterGrip = limiter?.grip ?? null;
        // Prefer a grip-specific Monod fit when the user has picked a
        // grip — FDP (pinch / open-hand rollers) and FDS (crusher) are
        // separate muscles with separate force-duration curves, and
        // training one doesn't fully transfer to the other. Fall back
        // to the overall pooled fit if no grip is selected yet or the
        // selected grip doesn't have enough data for its own fit.
        const gripFit = config.grip && gripEstimates[config.grip];
        const fitForRec = gripFit ?? liveEstimate;
        const scopeLabel = gripFit ? config.grip : (config.grip ? `${config.grip} (pooled)` : "overall");
        let zone = null;
        // Track WHICH signal picked the zone so we can label the badge
        // honestly: "biggest gain" for ΔAUC, "limiter" for curve-shape,
        // "least trained" for coverage fallback.
        let label = "recommended";
        if (fitForRec && fitForRec.CF > 0) {
          // Rank protocols by projected ΔAUC using the PERSONAL response
          // (prior when data is thin; blended with observed rates as the
          // training log grows). Matches AnalysisView so the two views
          // prescribe the same zone.
          const { CF, W } = fitForRec;
          const response = computePersonalResponse(history);
          let bestKey = null, bestGain = -Infinity;
          for (const [key, resp] of Object.entries(response)) {
            const gain = CF * resp.cf * (AUC_T_MAX - AUC_T_MIN)
                       + W  * resp.w  * Math.log(AUC_T_MAX / AUC_T_MIN);
            if (gain > bestGain) { bestGain = gain; bestKey = key; }
          }
          zone = bestKey;
          label = "biggest gain";
        } else if (limiter?.zone) {
          zone = limiter.zone;
          label = "limiter";
        } else {
          const cov = computeZoneCoverage(history, activities);
          if (cov.total > 0) {
            zone = cov.recommended;
            label = "least trained";
          }
        }
        return (
          <SessionPlannerCard
            liveEstimate={fitForRec}
            recommendedZone={zone}
            recommendedGrip={limiterGrip}
            recommendedLabel={label}
            recommendedScope={scopeLabel}
            onApplyPlan={({ goal, targetTime, repsPerSet, restTime, numSets, setRestTime }) =>
              setConfig(c => ({ ...c, goal, targetTime, repsPerSet, restTime, numSets, setRestTime }))
            }
          />
        );
      })()}

      {/* Prescribed load — appears once a grip is selected. Shows loads
          for ALL THREE zones side-by-side so the user doesn't have to
          guess which target time the card is reflecting. Load for each
          zone = CF + W'/refTime(zone). Load is CONSTANT across all reps
          of a set: rep 1 hits target, rep 2+ fall short as compartments
          drain. Source label reflects whichever fit (per-grip / cross-
          grip / history) backs the primary zone column. */}
      {config.grip && (() => {
        // Coaching prescription: empirical-first (anchored to user's
        // most recent rep 1 outcome at this exact scope), with the
        // curve-derived "potential" shown alongside as a diagnostic
        // ceiling. The GAP between train-at and potential is the
        // training opportunity — biggest gap = weakest compartment
        // relative to the rest of the user's physiology.
        //
        // Three sources of truth per cell:
        //   - TRAIN AT: empirical or curve-fallback (the load to use)
        //   - POTENTIAL: curve ceiling (Monod or three-exp consensus)
        //   - GAP: (potential − train_at) / train_at as percentage
        //
        // Reliability tiers gate the potential display:
        //   well-supported → show numeric potential confidently
        //   marginal → show potential with "models disagree" caveat
        //   extrapolation → don't show numeric, suggest training the zone

        const cellFor = (hand, t) => {
          // Empirical-first: anchored to user's most recent rep 1
          const emp = empiricalPrescription(history, hand, config.grip, t);
          let trainAt, source;
          if (emp != null) {
            trainAt = emp;
            source = "empirical";
          } else {
            // Cold start: fall back to the curve. Try per-grip first,
            // then cross-grip, then historical average.
            const v1 = prescribedLoad(history, hand, config.grip, t, freshMap);
            if (v1 != null) { trainAt = v1; source = "curve-grip"; }
            else {
              const v2 = prescribedLoad(history, hand, null, t, freshMap);
              if (v2 != null) { trainAt = v2; source = "curve-global"; }
              else {
                const v3 = estimateRefWeight(history, hand, config.grip, t);
                if (v3 != null) { trainAt = v3; source = "history"; }
                else return { trainAt: null, source: null, potential: null };
              }
            }
          }
          // Potential ceiling — curve-derived, with reliability tier.
          const potential = prescriptionPotential(history, hand, config.grip, t, {
            freshMap, threeExpPriors,
          });
          return { trainAt, source, potential };
        };

        const zones = ["power", "strength", "endurance"].map(zoneKey => {
          const t = GOAL_CONFIG[zoneKey].refTime;
          const L = cellFor("L", t);
          const R = cellFor("R", t);
          return { key: zoneKey, cfg: GOAL_CONFIG[zoneKey], t, L, R };
        });
        const anyLoaded = zones.some(z => z.L.trainAt != null || z.R.trainAt != null);
        if (!anyLoaded) return null;

        // Find the widest reliable gap across all (zone, hand) cells —
        // that's the recommendation engine's "biggest leverage" pointer.
        let widestGap = null;
        for (const z of zones) {
          for (const [handLabel, cell] of [["L", z.L], ["R", z.R]]) {
            if (!cell.potential || !cell.trainAt) continue;
            if (cell.potential.reliability === "extrapolation") continue;
            const gap = (cell.potential.value - cell.trainAt) / cell.trainAt;
            if (widestGap == null || gap > widestGap.gap) {
              widestGap = { zoneKey: z.key, zoneLabel: z.cfg.label, hand: handLabel, gap, cell };
            }
          }
        }

        // Format helpers
        const fmtPct = (g) => `${g >= 0 ? "+" : ""}${Math.round(g * 100)}%`;
        const gapColor = (g) => Math.abs(g) < 0.05 ? C.muted
                              : g > 0.20 ? C.red
                              : g > 0.10 ? C.orange
                              : C.green;

        return (
          <Card style={{ borderColor: C.blue }}>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
              Coaching prescription · {config.grip}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 8, fontStyle: "italic" }}>
              <b style={{ color: C.text, fontStyle: "normal" }}>Train at</b> = what to lift today (anchored to your most recent rep 1 + RPE 10 push).{" "}
              <b style={{ color: C.text, fontStyle: "normal" }}>Potential</b> = what the curve says you could support if your physiology were balanced.{" "}
              <b style={{ color: C.text, fontStyle: "normal" }}>Gap</b> = the training opportunity in that zone.
            </div>
            {widestGap && widestGap.gap > 0.10 && (
              <div style={{ fontSize: 12, color: C.text, background: widestGap.cell.cfg?.color + "20" || C.bg,
                            border: `1px solid ${gapColor(widestGap.gap)}66`, borderRadius: 8,
                            padding: "8px 10px", marginBottom: 10 }}>
                <span style={{ fontWeight: 700, color: gapColor(widestGap.gap) }}>Biggest gap: {widestGap.zoneLabel}</span>
                {" — your "}
                {widestGap.zoneKey === "power" ? "fast (PCr)" : widestGap.zoneKey === "strength" ? "middle (glycolytic)" : "slow (oxidative)"}
                {" compartment is your widest opportunity ("}
                <b>{fmtPct(widestGap.gap)}</b>
                {" headroom on "}
                {widestGap.hand === "L" ? "Left" : "Right"}
                {"). Training there has the most leverage."}
              </div>
            )}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 12 }}>
              {zones.map(({ key, cfg, t, L, R }) => {
                const isActive = config.goal === key;
                return (
                  <div
                    key={key}
                    style={{
                      padding: "10px 12px",
                      background: isActive ? cfg.color + "22" : C.bg,
                      border: `1px solid ${isActive ? cfg.color : C.border}`,
                      borderRadius: 10,
                    }}
                  >
                    <div style={{ fontSize: 11, fontWeight: 700, color: cfg.color, marginBottom: 2 }}>
                      {cfg.emoji} {cfg.label}
                    </div>
                    <div style={{ fontSize: 10, color: C.muted, marginBottom: 8 }}>
                      target {t}s
                    </div>
                    <div style={{ display: "flex", justifyContent: "space-between", gap: 8 }}>
                      {[["L", L], ["R", R]].map(([handLabel, cell]) => {
                        const sourceMark = cell.source === "curve-global" ? "°"
                                         : cell.source === "history" ? "ʰ"
                                         : cell.source === "curve-grip" ? "*"
                                         : "";
                        const sourceTitle = cell.source === "curve-global"
                            ? `Cold start: not enough recent ${config.grip} data on ${handLabel} at ${t}s, falling back to cross-grip curve.`
                          : cell.source === "history"
                            ? `Cold start: no model fit available, using historical average on ${handLabel} ${config.grip} at ${t}s.`
                          : cell.source === "curve-grip"
                            ? `Cold start: no recent rep 1 at this target, using ${config.grip} curve fit on ${handLabel}.`
                            : `Empirical: anchored to your most recent rep 1 on ${handLabel} ${config.grip} at ${t}s, with RPE 10 progression.`;
                        const pot = cell.potential;
                        const gap = (pot && cell.trainAt && pot.reliability !== "extrapolation")
                          ? (pot.value - cell.trainAt) / cell.trainAt : null;
                        return (
                          <div key={handLabel} style={{ flex: 1 }}>
                            <div style={{ fontSize: 9, color: C.muted, textTransform: "uppercase", letterSpacing: 0.5 }}>{handLabel}</div>
                            <div style={{ fontSize: 16, fontWeight: 700, color: C.blue }} title={sourceTitle}>
                              {cell.trainAt != null ? `${fmtW(cell.trainAt, unit)}` : "—"}
                              {sourceMark && (
                                <span style={{ fontSize: 11, color: C.yellow, marginLeft: 2 }}>
                                  {sourceMark}
                                </span>
                              )}
                            </div>
                            {pot && pot.reliability !== "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3 }}>
                                pot {pot.reliability === "marginal"
                                  ? `${fmtW(pot.lower, unit)}–${fmtW(pot.upper, unit)}`
                                  : fmtW(pot.value, unit)}
                                {pot.reliability === "marginal" && (
                                  <span title="Monod and three-exp models disagree at this duration — treat the range as the credible band, not a precise number." style={{ color: C.yellow, marginLeft: 2 }}>
                                    ?
                                  </span>
                                )}
                              </div>
                            )}
                            {pot && pot.reliability === "extrapolation" && (
                              <div style={{ fontSize: 9, color: C.muted, marginTop: 3, fontStyle: "italic" }} title={`No failure data within ±50% of ${t}s — the curve is extrapolating. Train this zone to anchor it.`}>
                                pot ?
                              </div>
                            )}
                            {gap != null && (
                              <div style={{ fontSize: 9, fontWeight: 600, color: gapColor(gap), marginTop: 2 }}
                                   title={`Gap: train-at ${fmtW(cell.trainAt, unit)} → potential ${fmtW(pot.value, unit)} = ${fmtPct(gap)} headroom. ${gap > 0.10 ? "Worth training this zone." : "Already close to your modeled potential here."}`}>
                                gap {fmtPct(gap)}
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </div>
                );
              })}
            </div>
            <div style={{ fontSize: 10, color: C.muted, marginTop: 8, display: "flex", justifyContent: "space-between", flexWrap: "wrap", gap: 8 }}>
              <span>
                <span style={{ color: C.muted }}>* = curve fallback (no recent rep 1) · ° = cross-grip · ʰ = historical avg · ? = uncertain potential</span>
              </span>
              <span>values in {unit}</span>
            </div>
          </Card>
        );
      })()}

      {/* Readiness / how-do-you-feel widget */}
      {(() => {
        const rl = readiness != null ? recoveryLabel(readiness) : null;
        const selectedFeel = FEEL_OPTIONS.find(f => f.val === todaySubj);
        return (
          <div style={{
            marginBottom: 16, padding: "14px 16px",
            background: C.card, border: `1px solid ${rl ? rl.color + "44" : C.border}`,
            borderRadius: 12,
          }}>
            <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 12 }}>
              <div style={{ fontSize: 13, fontWeight: 600, color: C.text }}>
                How do you feel today?
              </div>
              {readiness != null && rl && (
                <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                  <div style={{
                    width: 36, height: 36, borderRadius: 18,
                    background: rl.color + "22",
                    display: "flex", alignItems: "center", justifyContent: "center",
                    fontSize: 18, fontWeight: 900, color: rl.color,
                  }}>
                    {readiness}
                  </div>
                  <div style={{ fontSize: 12, color: rl.color, fontWeight: 600 }}>{rl.text}</div>
                </div>
              )}
            </div>

            {/* 5-emoji picker */}
            <div style={{ display: "flex", gap: 8 }}>
              {FEEL_OPTIONS.map(f => {
                const selected = todaySubj === f.val;
                return (
                  <button
                    key={f.val}
                    onClick={() => onSubjReadiness(f.val)}
                    title={f.label}
                    style={{
                      flex: 1, padding: "10px 0", borderRadius: 10, cursor: "pointer",
                      border: selected ? `2px solid ${recoveryLabel(subjToScore(f.val)).color}` : `2px solid ${C.border}`,
                      background: selected ? recoveryLabel(subjToScore(f.val)).color + "22" : C.bg,
                      fontSize: 22, lineHeight: 1, transition: "all 0.15s",
                    }}
                  >
                    {f.emoji}
                    <div style={{ fontSize: 9, color: selected ? recoveryLabel(subjToScore(f.val)).color : C.muted, marginTop: 3, fontWeight: selected ? 700 : 400 }}>
                      {f.label}
                    </div>
                  </button>
                );
              })}
            </div>

            {/* Source label */}
            <div style={{ marginTop: 9, fontSize: 11, color: C.muted, textAlign: "right" }}>
              {todaySubj != null
                ? `You rated today ${selectedFeel?.emoji} ${selectedFeel?.label} — tap to update`
                : isEstimated
                  ? "Estimated from logged training only — doesn't include climbing or other activity"
                  : ""}
            </div>
          </div>
        );
      })()}

      <BwPrompt unit={unit} onSave={onBwSave} />

      {/* Tindeq Connect slot — rendered just above the Start button */}
      {connectSlot}

      <Btn
        onClick={onStart}
        disabled={!config.grip}
        style={{ width: "100%", padding: "16px 0", fontSize: 17, borderRadius: 12 }}
      >
        {config.grip ? "Start Session →" : "Select a grip to start"}
      </Btn>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ACTIVE SESSION VIEW
// ─────────────────────────────────────────────────────────────
function ActiveSessionView({ session, onRepDone, onAbort, tindeq, autoStart = false, unit = "lbs" }) {
  const { config, currentSet, currentRep, activeHand } = session;

  // repPhase: 'ready' (show Start button, first rep only)
  //           'countdown' (3-2-1)
  //           'active' (rep in progress)
  const [repPhase,     setRepPhase]    = useState(autoStart ? "active" : "ready");
  const [countdown,    setCountdown]   = useState(3);
  const [elapsed,      setElapsed]     = useState(0);
  const [manualWeight, setManualWeight] = useState(null);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  // Suggested weight per hand — held CONSTANT within a set. We don't
  // fatigue-discount the displayed weight; the user holds the same load
  // each rep and we track how actual_time_s decays. See also AutoRepSessionView.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const suggestions = useMemo(() => {
    const handList = config.hand === "Both" ? ["L", "R"] : [config.hand];
    return Object.fromEntries(
      handList.map(h => [h, {
        suggested: suggestWeight(session.refWeights?.[h] ?? null, 0),
      }])
    );
  }, [config.hand, session.refWeights]);

  // Actually start recording the rep
  const startRep = useCallback(async () => {
    setElapsed(0);
    startTimeRef.current = Date.now();
    setRepPhase("active");
    if (tindeq.connected) {
      await tindeq.tare();
      await tindeq.startMeasuring();
    }
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, [tindeq]);

  // Auto-start on mount when autoStart=true
  useEffect(() => {
    if (autoStart) { startRep(); }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // 3-2-1 countdown
  useEffect(() => {
    if (repPhase !== "countdown") return;
    if (countdown <= 0) { startRep(); return; }
    const t = setTimeout(() => setCountdown(c => c - 1), 1000);
    return () => clearTimeout(t);
  }, [repPhase, countdown, startRep]);

  // Tracks whether this rep was ended by auto-failure (vs manual tap).
  const autoFailedRef = useRef(false);

  // End rep — called by manual tap (failed=false) or auto-failure (failed=true).
  const endRep = useCallback(async () => {
    if (!startTimeRef.current) return;
    const failed = autoFailedRef.current;
    autoFailedRef.current = false;
    clearInterval(timerRef.current);
    const actualTime = (Date.now() - startTimeRef.current) / 1000;
    startTimeRef.current = null;
    setRepPhase("ready");
    if (tindeq.connected) await tindeq.stopMeasuring();
    onRepDone({ actualTime, avgForce: tindeq.avgForce, failed });
  }, [tindeq, onRepDone]);

  // Wire auto-failure → endRep for the duration of an active rep only.
  // Cleanup nulls the callback whenever phase changes or the component unmounts,
  // eliminating the stale-ref gap that caused auto-fail to silently stop working
  // after the first rep.
  useEffect(() => {
    if (repPhase !== "active") {
      tindeq.setAutoFailCallback(null);
      return;
    }
    tindeq.setAutoFailCallback(() => {
      autoFailedRef.current = true;
      endRep();
    });
    return () => tindeq.setAutoFailCallback(null);
  }, [tindeq, repPhase, endRep]);

  useEffect(() => () => clearInterval(timerRef.current), []);

  // Active suggestion follows the active hand (or the only configured hand)
  const activeSugHand = config.hand === "Both" ? activeHand : config.hand;
  const sug = suggestions[activeSugHand] ?? null;

  // Effective target weight in kg for color-coding and auto-failure threshold
  const targetKg = manualWeight ?? sug?.suggested ?? null;

  // Keep the Tindeq hook's target ref in sync so auto-failure uses the right threshold
  useEffect(() => {
    tindeq.targetKgRef.current = repPhase === "active" ? targetKg : null;
  }, [tindeq, repPhase, targetKg]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Set {currentSet + 1} of {config.numSets}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>
            {config.grip} · {config.hand === "Both"
              ? (activeHand === "L" ? "Left Hand" : "Right Hand")
              : config.hand === "L" ? "Left" : "Right"}
          </div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Countdown overlay */}
      {repPhase === "countdown" && (
        <Card style={{ textAlign: "center", padding: "40px 0" }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Get ready…</div>
          <div style={{ fontSize: 96, fontWeight: 900, color: C.yellow, lineHeight: 1 }}>
            {countdown === 0 ? "GO" : countdown}
          </div>
          <div style={{ fontSize: 14, color: C.muted, marginTop: 8 }}>
            {fmtW(sug?.suggested ?? 0, unit)} {unit}
          </div>
        </Card>
      )}

      {/* Timer (shown during active rep) */}
      {repPhase === "active" && (
        <Card>
          <BigTimer seconds={elapsed} targetSeconds={config.targetTime} running={true} />
          {tindeq.connected ? (
            <ForceGauge force={tindeq.force} avg={tindeq.avgForce} peak={tindeq.peak} targetKg={targetKg} unit={unit} />
          ) : (
            <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 8 }}>
              No Tindeq — tap Done when you let go.
            </div>
          )}
        </Card>
      )}

      {/* Weight suggestion (shown when ready) */}
      {repPhase === "ready" && (
        <Card>
          {/* Big active-hand indicator so it's obvious which hand to use */}
          {config.hand === "Both" && (
            <div style={{ textAlign: "center", marginBottom: 12 }}>
              <div style={{
                fontSize: 13, color: C.muted, letterSpacing: 1.2,
                textTransform: "uppercase", marginBottom: 2,
              }}>Use your</div>
              <div style={{
                fontSize: 26, fontWeight: 900,
                color: activeHand === "R" ? C.orange : C.blue,
              }}>
                {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
              </div>
            </div>
          )}
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>
            Rep {currentRep + 1} suggested weight
          </div>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {sug?.suggested != null ? `${fmtW(sug.suggested, unit)} ${unit}` : "—"}
          </div>
          <div style={{ marginTop: 12, display: "flex", gap: 8, alignItems: "center" }}>
            <input
              type="number" min={0} step={0.5}
              value={manualWeight != null ? fmtW(manualWeight, unit) : ""}
              onChange={e => setManualWeight(e.target.value === "" ? null : fromDisp(Number(e.target.value), unit))}
              placeholder={`Override ${unit}…`}
              style={{ width: 120, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 15 }}
            />
            <span style={{ fontSize: 12, color: C.muted }}>{unit} (override)</span>
          </div>
        </Card>
      )}

      {/* Controls */}
      <div style={{ display: "flex", gap: 12, marginTop: 8 }}>
        {repPhase === "ready" && (
          <Btn
            onClick={() => { setCountdown(3); setRepPhase("countdown"); }}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.green}
          >
            ▶ Start Rep
          </Btn>
        )}
        {repPhase === "active" && (
          <Btn
            onClick={endRep}
            style={{ flex: 1, padding: "18px 0", fontSize: 18, borderRadius: 12 }}
            color={C.red}
          >
            ✕ Done
          </Btn>
        )}
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// REST VIEW
// ─────────────────────────────────────────────────────────────
function playBeep(freq = 880, duration = 0.12, volume = 0.4) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const osc = ctx.createOscillator();
    const gain = ctx.createGain();
    osc.connect(gain); gain.connect(ctx.destination);
    osc.frequency.value = freq;
    gain.gain.setValueAtTime(volume, ctx.currentTime);
    gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
    osc.start(ctx.currentTime);
    osc.stop(ctx.currentTime + duration);
    osc.onended = () => ctx.close();
  } catch (e) { /* audio not available */ }
}

function RestView({ lastRep, nextWeight, restSeconds, onRestDone, setNum, numSets, repNum, repsPerSet, unit = "lbs" }) {
  const [remaining, setRemaining] = useState(restSeconds);
  const intervalRef = useRef(null);

  useEffect(() => {
    setRemaining(restSeconds);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onRestDone(); return 0; }
        const next = r - 1;
        if (next <= 3 && next >= 1) playBeep(next === 1 ? 1100 : 880);
        return next;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [restSeconds]);

  const pct = remaining / restSeconds;
  const isLastRepInSet = repNum >= repsPerSet;
  const isLastSet      = setNum >= numSets;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <Card>
        <div style={{ textAlign: "center", paddingBottom: 8 }}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            {isLastRepInSet
              ? (isLastSet ? "Last set complete!" : "Set complete — rest before next set")
              : `Rest — rep ${repNum} of ${repsPerSet}`}
          </div>
          <div style={{ fontSize: 64, fontWeight: 800, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1 }}>
            {remaining}s
          </div>
          <div style={{ marginTop: 10, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
            <div style={{ height: "100%", width: `${pct * 100}%`, background: C.green, borderRadius: 3, transition: "width 1s linear" }} />
          </div>
        </div>
      </Card>

      {lastRep && (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Last rep result</div>
          <div style={{ display: "flex", gap: 32 }}>
            <div>
              <Label>Time</Label>
              <span style={{
                fontSize: 28, fontWeight: 700,
                color: lastRep.actualTime >= lastRep.targetTime ? C.green : C.red,
              }}>
                {Math.round(lastRep.actualTime)}s
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>target {lastRep.targetTime}s</div>
            </div>
            {lastRep.peakForce > 0 && (
              <div>
                <Label>Peak Force</Label>
                <span style={{ fontSize: 28, fontWeight: 700, color: C.orange }}>
                  {fmtW(lastRep.peakForce, unit)} {unit}
                </span>
              </div>
            )}
          </div>
        </Card>
      )}

      {nextWeight != null && !isLastRepInSet && (
        <Card style={{ borderColor: C.blue }}>
          <Label>Next rep suggested weight</Label>
          <div style={{ fontSize: 36, fontWeight: 800, color: C.blue }}>
            {fmtW(nextWeight, unit)} {unit}
          </div>
        </Card>
      )}

      <Btn
        onClick={() => { clearInterval(intervalRef.current); onRestDone(); }}
        style={{ width: "100%", padding: "14px 0", fontSize: 16, borderRadius: 12 }}
        color={C.muted}
      >
        Skip rest →
      </Btn>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// BETWEEN-SETS VIEW
// ─────────────────────────────────────────────────────────────
function SwitchHandsView({ onReady }) {
  const [remaining, setRemaining] = useState(10);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onReady(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 56 }}>🤚➡️✋</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to Right Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Left hand complete. Get ready to train right hand.</p>
      <div style={{ fontSize: 80, fontWeight: 900, color: remaining > 3 ? C.green : C.orange, lineHeight: 1, marginBottom: 24 }}>
        {remaining}
      </div>
      <Btn onClick={() => { clearInterval(intervalRef.current); onReady(); }}
        style={{ padding: "14px 40px", fontSize: 16, borderRadius: 12 }}>
        Ready →
      </Btn>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ALT-HAND SWITCH VIEW (alternating mode: quick hand swap prompt)
// ─────────────────────────────────────────────────────────────
function AltSwitchView({ toHand, onReady }) {
  const handName  = toHand === "L" ? "Left" : "Right";
  const handEmoji = toHand === "L" ? "🤚" : "✋";
  const [remaining, setRemaining] = useState(3);
  const intervalRef = useRef(null);

  useEffect(() => {
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onReady(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 64 }}>{handEmoji}</div>
      <h2 style={{ margin: "16px 0 8px" }}>Switch to {handName} Hand</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Get in position — rep starts in…</p>
      <div style={{ fontSize: 80, fontWeight: 900, color: remaining > 1 ? C.green : C.orange, lineHeight: 1, marginBottom: 32 }}>
        {remaining}
      </div>
      <Btn
        onClick={() => { clearInterval(intervalRef.current); onReady(); }}
        style={{ padding: "14px 40px", fontSize: 16, borderRadius: 12 }}
      >
        Ready →
      </Btn>
    </div>
  );
}

function BetweenSetsView({ completedSet, totalSets, onNextSet, setRestTime = 180 }) {
  const [remaining, setRemaining] = useState(setRestTime);
  const intervalRef = useRef(null);

  useEffect(() => {
    setRemaining(setRestTime);
    intervalRef.current = setInterval(() => {
      setRemaining(r => {
        if (r <= 1) { clearInterval(intervalRef.current); onNextSet(); return 0; }
        return r - 1;
      });
    }, 1000);
    return () => clearInterval(intervalRef.current);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [setRestTime]);

  const pct = remaining / setRestTime;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "40px 16px", textAlign: "center" }}>
      <div style={{ fontSize: 48 }}>🏔️</div>
      <h2 style={{ margin: "12px 0 4px" }}>Set {completedSet} of {totalSets} done!</h2>
      <p style={{ color: C.muted, marginBottom: 24 }}>Rest between sets</p>
      <div style={{ fontSize: 72, fontWeight: 900, color: pct > 0.3 ? C.green : C.orange, lineHeight: 1, marginBottom: 16 }}>
        {remaining}s
      </div>
      <div style={{ height: 8, background: C.border, borderRadius: 4, overflow: "hidden", marginBottom: 32, maxWidth: 300, margin: "0 auto 32px" }}>
        <div style={{ height: "100%", width: `${pct * 100}%`, background: pct > 0.3 ? C.green : C.orange, borderRadius: 4, transition: "width 1s linear" }} />
      </div>
      {completedSet < totalSets && (
        <Btn
          onClick={() => { clearInterval(intervalRef.current); onNextSet(); }}
          style={{ padding: "16px 48px", fontSize: 17, borderRadius: 12 }}
        >
          Start Set {completedSet + 1} →
        </Btn>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SESSION SUMMARY
// ─────────────────────────────────────────────────────────────
function SessionSummaryView({ reps, config, leveledUp, newLevel, onDone, unit = "lbs" }) {
  const sets = useMemo(() => {
    const groups = {};
    for (const r of reps) {
      const k = r.set_num;
      if (!groups[k]) groups[k] = [];
      groups[k].push(r);
    }
    return Object.entries(groups).map(([s, rs]) => ({ setNum: Number(s), reps: rs }));
  }, [reps]);

  const totalReps  = reps.length;
  const avgTime    = totalReps > 0 ? reps.reduce((a, r) => a + r.actual_time_s, 0) / totalReps : 0;
  const maxWeight  = Math.max(...reps.map(r => r.weight_kg), 0);
  const hasForce   = reps.some(r => r.avg_force_kg > 0 && r.avg_force_kg < 500);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {leveledUp && (
        <Card style={{ background: "#1c1f0a", borderColor: C.green, marginBottom: 20 }}>
          <div style={{ textAlign: "center" }}>
            <div style={{ fontSize: 48 }}>{LEVEL_EMOJIS[Math.min(newLevel - 1, LEVEL_EMOJIS.length - 1)]}</div>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.green }}>Level Up!</div>
            <div style={{ fontSize: 16, color: C.text, marginTop: 4 }}>
              {levelTitle(newLevel)}
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 6 }}>
              5% load improvement — keep going
            </div>
          </div>
        </Card>
      )}

      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Session Complete</h2>

      <Card>
        <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr 1fr", gap: 16, textAlign: "center" }}>
          <div>
            <Label>Total Reps</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{totalReps}</div>
          </div>
          <div>
            <Label>Avg Time</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtTime(avgTime)}</div>
          </div>
          <div>
            <Label>Top Weight</Label>
            <div style={{ fontSize: 28, fontWeight: 700 }}>{fmtW(maxWeight, unit)} {unit}</div>
          </div>
          {hasForce && (
            <div style={{ gridColumn: "1 / -1" }}>
              <Label>Avg Force (Tindeq)</Label>
              <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>
                {fmtW(reps.reduce((a, r) => a + (r.avg_force_kg || 0), 0) / reps.filter(r => r.avg_force_kg > 0).length, unit)} {unit}
              </div>
            </div>
          )}
        </div>
      </Card>

      {sets.map(({ setNum, reps: sReps }) => (
        <Card key={setNum}>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Set {setNum}</div>
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <thead>
              <tr style={{ color: C.muted }}>
                <th style={{ textAlign: "left", paddingBottom: 6 }}>Rep</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Weight</th>
                <th style={{ textAlign: "right", paddingBottom: 6 }}>Time</th>
                {hasForce && <th style={{ textAlign: "right", paddingBottom: 6 }}>Avg F</th>}
              </tr>
            </thead>
            <tbody>
              {sReps.map(r => (
                <tr key={r.rep_num} style={{ borderTop: `1px solid ${C.border}` }}>
                  <td style={{ padding: "6px 0" }}>{r.rep_num}</td>
                  <td style={{ textAlign: "right" }}>{fmtW(r.weight_kg, unit)} {unit}</td>
                  <td style={{ textAlign: "right", color: r.actual_time_s >= config.targetTime ? C.green : C.red }}>
                    {fmtTime(r.actual_time_s)}
                  </td>
                  {hasForce && (
                    <td style={{ textAlign: "right", color: C.green }}>
                      {r.avg_force_kg > 0 ? `${fmtW(r.avg_force_kg, unit)} ${unit}` : "—"}
                    </td>
                  )}
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      ))}

      <div style={{ display: "flex", gap: 12 }}>
        <Btn onClick={() => downloadCSV(reps)} color={C.muted} style={{ flex: 1 }}>
          ↓ Export CSV
        </Btn>
        <Btn onClick={onDone} style={{ flex: 2 }}>
          Back to Setup
        </Btn>
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// HISTORY VIEW
// ─────────────────────────────────────────────────────────────
// ── Workout session history sub-view ──────────────────────────
function WorkoutHistoryView({ unit = "lbs", bodyWeight = null }) {
  // Always read fresh from localStorage — no useState wrapper so newly
  // completed sessions appear immediately without needing a remount.
  const [tick,           setTick]           = useState(0); // increment to force re-read
  const [editIdx,        setEditIdx]        = useState(null);
  const [editWorkout,    setEditWorkout]    = useState(null);
  const [confirmDeleteId, setConfirmDeleteId] = useState(null);
  const [filterEx,   setFilterEx]   = useState("");  // "" = all, or exercise id
  const [filterDays, setFilterDays] = useState(0);   // 0 = all time, else last N days
  const [relMode,    setRelMode]    = useState(false);

  const log      = useMemo(() => loadLS(LS_WORKOUT_LOG_KEY)  || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const bwLog    = useMemo(() => loadLS(LS_BW_LOG_KEY)       || [], [tick]); // eslint-disable-line react-hooks/exhaustive-deps
  const syncedIds = useMemo(() => new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []), [tick]); // eslint-disable-line react-hooks/exhaustive-deps

  // Flat name lookup across all workout definitions
  const exNames = useMemo(() => {
    const map = {};
    for (const wk of Object.values(DEFAULT_WORKOUTS)) {
      for (const ex of (wk.exercises || [])) {
        if (!map[ex.id]) map[ex.id] = ex.name || ex.id.replace(/_/g, " ");
      }
    }
    return map;
  }, []);

  // Exercises that appear in the log with actual sets (reps + weight) — the measurable ones
  const measurableExIds = useMemo(() => {
    const seen = new Set();
    for (const s of log) {
      for (const [id, data] of Object.entries(s.exercises || {})) {
        if (data.sets && data.sets.length > 0) seen.add(id);
      }
    }
    return [...seen].sort((a, b) => (exNames[a] || a).localeCompare(exNames[b] || b));
  }, [log, exNames]);

  // Apply filters — a session matches if it contains the selected exercise with sets
  const filtered = useMemo(() => {
    const cutoff = filterDays > 0
      ? ymdLocal(new Date(Date.now() - filterDays * 864e5))
      : null;
    return log.filter(s => {
      if (cutoff && s.date < cutoff) return false;
      if (filterEx) {
        const exData = s.exercises?.[filterEx];
        if (!exData?.sets?.length) return false;
      }
      return true;
    });
  }, [log, filterEx, filterDays]);

  // Sorted newest-first for display; track original index for saves
  const sorted = useMemo(() =>
    filtered.map((s) => ({ ...s, origIdx: log.indexOf(s) }))
            .sort((a, b) => a.date < b.date ? 1 : -1),
    [filtered, log]
  );

  const saveEdit = (origIdx) => {
    const updated = log.map((s, i) => i === origIdx ? { ...s, workout: editWorkout } : s);
    saveLS(LS_WORKOUT_LOG_KEY, updated);
    setTick(t => t + 1);
    setEditIdx(null);
    setEditWorkout(null);
  };

  const deleteSession = (sessionId) => {
    // Remove from localStorage
    saveLS(LS_WORKOUT_LOG_KEY, log.filter(s => s.id !== sessionId));
    // Remove from synced set
    const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    synced.delete(sessionId);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    // Add to tombstone set so the merge never re-adds it from Supabase
    const deleted = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
    deleted.add(sessionId);
    saveLS(LS_WORKOUT_DELETED_KEY, [...deleted]);
    // Best-effort delete from Supabase
    deleteWorkoutSession(sessionId);
    setConfirmDeleteId(null);
    setTick(t => t + 1);
  };

  if (!log.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 15 }}>
      No workout sessions yet — start a workout!
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginBottom: 8 }}>
        {bodyWeight != null && (
          <button onClick={() => setRelMode(r => !r)} style={{
            padding: "5px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: relMode ? C.purple : C.border,
            color: relMode ? "#fff" : C.muted, fontWeight: relMode ? 700 : 400,
          }}>% BW</button>
        )}
        <Btn small onClick={() => downloadWorkoutCSV(log)} color={C.muted}>↓ CSV</Btn>
      </div>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {measurableExIds.map(id => (
          <button key={id} onClick={() => setFilterEx(filterEx === id ? "" : id)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterEx === id ? C.orange : C.border,
            color: filterEx === id ? "#fff" : C.muted, border: "none",
          }}>{exNames[id] || id}</button>
        ))}
        {[30, 60, 90].map(days => (
          <button key={days} onClick={() => setFilterDays(filterDays === days ? 0 : days)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: filterDays === days ? C.blue : C.border,
            color: filterDays === days ? "#fff" : C.muted, border: "none",
          }}>{days}d</button>
        ))}
      </div>

      {sorted.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 40, fontSize: 15 }}>
          No sessions match these filters.
        </div>
      )}

      {sorted.map((session) => {
        const { origIdx } = session;
        const isEditing = editIdx === origIdx;
        const wkDef = DEFAULT_WORKOUTS[session.workout] || {};

        return (
          <Card key={origIdx} style={{ marginBottom: 10 }}>
            {/* Session header */}
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 10 }}>
              <div>
                <span style={{ fontWeight: 700, fontSize: 15 }}>Workout {session.workout}</span>
                {wkDef.name && !isEditing && (
                  <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>{wkDef.name}</span>
                )}
              </div>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {session.sessionNumber && !isEditing && (
                  <span style={{ fontSize: 11, color: C.muted }}>#{session.sessionNumber}</span>
                )}
                <span style={{ fontSize: 12, color: C.muted }}>
                  {session.date}{session.completedAt ? " · " + fmtClock(session.completedAt) : ""}
                  {(() => { const e = bwOnDate(bwLog, session.date); return e ? " · " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                <span
                  title={session.id && syncedIds.has(session.id) ? "Synced to cloud" : "Local only — not yet synced"}
                  style={{ fontSize: 13, opacity: 0.7 }}
                >
                  {session.id && syncedIds.has(session.id) ? "☁️" : "📱"}
                </span>
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => { setEditIdx(origIdx); setEditWorkout(session.workout); }}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Edit workout type"
                  >✏️</button>
                )}
                {!isEditing && confirmDeleteId !== session.id && (
                  <button
                    onClick={() => setConfirmDeleteId(session.id)}
                    style={{ background: "none", border: "none", color: C.muted, fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1 }}
                    title="Delete session"
                  >🗑</button>
                )}
                {confirmDeleteId === session.id && (
                  <span style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <span style={{ fontSize: 12, color: C.red }}>Delete?</span>
                    <button onClick={() => deleteSession(session.id)} style={{
                      background: C.red, border: "none", borderRadius: 6, color: "#fff",
                      fontSize: 12, fontWeight: 700, padding: "3px 10px", cursor: "pointer",
                    }}>Yes</button>
                    <button onClick={() => setConfirmDeleteId(null)} style={{
                      background: C.border, border: "none", borderRadius: 6, color: C.muted,
                      fontSize: 12, padding: "3px 8px", cursor: "pointer",
                    }}>No</button>
                  </span>
                )}
              </div>
            </div>

            {/* Edit: reclassify workout type */}
            {isEditing && (
              <div style={{ marginBottom: 12, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>Change workout type:</div>
                <div style={{ display: "flex", gap: 6, flexWrap: "wrap", marginBottom: 10 }}>
                  {Object.keys(DEFAULT_WORKOUTS).map(key => (
                    <button key={key} onClick={() => setEditWorkout(key)} style={{
                      padding: "6px 12px", borderRadius: 8, border: "none", cursor: "pointer",
                      fontWeight: 700, fontSize: 13, textAlign: "center",
                      background: editWorkout === key ? C.blue : C.border,
                      color: editWorkout === key ? "#fff" : C.muted,
                    }}>
                      <div>{key}</div>
                      <div style={{ fontSize: 9, fontWeight: 400, marginTop: 1, opacity: 0.8 }}>
                        {DEFAULT_WORKOUTS[key]?.name || ""}
                      </div>
                    </button>
                  ))}
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => saveEdit(origIdx)} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 12, fontWeight: 700, padding: "5px 14px", cursor: "pointer",
                  }}>Save</button>
                  <button onClick={() => { setEditIdx(null); setEditWorkout(null); }} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 12, padding: "5px 10px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Exercises — render all that have actual data, regardless of workout definition */}
            {Object.entries(session.exercises || {}).map(([id, data]) => {
              const exName = exNames[id] || id.replace(/_/g, " ");

              if (data.sets && data.sets.length) {
                const anyDone = data.sets.some(s => s.done);
                if (!anyDone) return null;
                return (
                  <div key={id} style={{ marginBottom: 8 }}>
                    <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>{exName}</div>
                    <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                      {data.sets.map((s, si) => (
                        <span key={si} style={{
                          padding: "3px 10px", borderRadius: 7, fontSize: 12,
                          background: s.done ? "#1a2f1a" : C.border,
                          border: `1px solid ${s.done ? C.green : C.border}`,
                          color: s.done ? C.text : C.muted,
                        }}>
                          {(() => {
                            if (!s.weight) return "—";
                            const w = parseFloat(s.weight);
                            if (relMode && bodyWeight != null && bodyWeight > 0) {
                              const bwDisp = toDisp(bodyWeight, unit);
                              const pct = Math.round((w / bwDisp) * 100);
                              return `${w >= bwDisp ? "+" : ""}${pct}% BW`;
                            }
                            return `${s.weight} ${unit}`;
                          })()}
                        </span>
                      ))}
                    </div>
                  </div>
                );
              }

              if (data.done) {
                return (
                  <div key={id} style={{ fontSize: 12, color: C.muted, marginBottom: 3 }}>
                    <span style={{ color: C.green, marginRight: 5 }}>✓</span>{exName}
                  </div>
                );
              }
              return null;
            })}
          </Card>
        );
      })}
    </div>
  );
}

function HistoryView({ history, onDownload, unit = "lbs", bodyWeight = null, onDeleteSession, onUpdateSession, onDeleteRep, onUpdateRep, onAddRep, notes = {}, onNoteChange, activities = [], onDeleteActivity = () => {} }) {
  const [domain,      setDomain]      = useState(() => loadLS(LS_HISTORY_DOMAIN_KEY) || "fingers");
  const switchDomain = (d) => { setDomain(d); saveLS(LS_HISTORY_DOMAIN_KEY, d); };
  const [grip,        setGrip]        = useState("");
  const [hand,        setHand]        = useState("");
  const [target,      setTarget]      = useState(0);
  const [confirmKey,  setConfirmKey]  = useState(null);
  const [editKey,     setEditKey]     = useState(null);
  const [editHand,    setEditHand]    = useState("L");
  const [editGrip,    setEditGrip]    = useState("");
  const [editTarget,  setEditTarget]  = useState(null); // target_duration seconds
  const [noteKey,     setNoteKey]     = useState(null); // session currently showing note editor
  // Per-rep editing
  const [repEditMode, setRepEditMode] = useState(null);        // sessKey with reps in edit mode
  const [editingRep,  setEditingRep]  = useState(null);        // { sessKey, repIdx, rep }
  const [addingRep,   setAddingRep]   = useState(null);        // sessKey being added to
  const [editRepLoad, setEditRepLoad] = useState("");          // display-unit load (edit or add)
  const [editRepTime, setEditRepTime] = useState("");          // seconds (edit or add)
  const [editRepHand, setEditRepHand] = useState(null);        // "L" | "R" — null in add-mode means "auto-derive at save"
  // Manual session entry
  const [addingSession,    setAddingSession]    = useState(false);
  const [newSessDate,      setNewSessDate]      = useState(() => ymdLocal());
  const [newSessGrip,      setNewSessGrip]      = useState("");
  const [newSessTarget,    setNewSessTarget]    = useState(TARGET_OPTIONS[0].seconds);
  const [newSessReps,      setNewSessReps]      = useState([]);  // [{ load, time, hand }]
  const [newRepLoad,       setNewRepLoad]       = useState("");
  const [newRepTime,       setNewRepTime]       = useState("");

  const openRepEdit = (sessKey, repIdx, rep) => {
    setAddingRep(null);
    setEditingRep({ sessKey, repIdx, rep });
    setEditRepLoad(String(fmt1(toDisp(effectiveLoad(rep), unit))));
    setEditRepTime(String(rep.actual_time_s));
    setEditRepHand(rep.hand === "L" || rep.hand === "R" ? rep.hand : null);
  };
  const closeRepEdit = () => { setEditingRep(null); setAddingRep(null); setEditRepHand(null); };

  const saveRepEdit = () => {
    if (!editingRep) return;
    const loadKg = fromDisp(parseFloat(editRepLoad), unit);
    const newTime = parseFloat(editRepTime);
    const updates = { actual_time_s: newTime };
    if (editingRep.rep.avg_force_kg > 0) updates.avg_force_kg = loadKg;
    else updates.weight_kg = loadKg;
    if (editRepHand === "L" || editRepHand === "R") updates.hand = editRepHand;
    // Re-derive failed from the new time so edits keep the flag honest.
    const tgt = editingRep.rep.target_duration;
    if (tgt > 0 && newTime > 0) updates.failed = isShortfall(newTime, tgt);
    onUpdateRep(editingRep.rep, updates);
    closeRepEdit();
  };

  const openRepAdd = (sessKey) => {
    setEditingRep(null);
    setAddingRep(sessKey);
    setEditRepLoad("");
    setEditRepTime("");
    setEditRepHand(null); // null = auto-derive from session in saveRepAdd
  };

  const saveRepAdd = (sess) => {
    const loadKg = fromDisp(parseFloat(editRepLoad), unit);
    const time   = parseFloat(editRepTime);
    if (!loadKg || !time) return;
    const existingReps = sess.reps;
    const maxRepNum = existingReps.length
      ? Math.max(...existingReps.map(r => r.rep_num || 0))
      : 0;
    const maxSetNum = existingReps.length
      ? Math.max(...existingReps.map(r => r.set_num || 1))
      : 1;
    const sessionId = existingReps[0]?.session_id || null;
    // Derive hand for the new rep:
    //  - If the user explicitly picked L or R in the editor, honor it.
    //  - Otherwise single-hand session: use sess.hand
    //  - Otherwise mixed/Both session: alternate from last rep's hand (fallback L)
    let newHand;
    if (editRepHand === "L" || editRepHand === "R") {
      newHand = editRepHand;
    } else {
      newHand = sess.hand;
      if (sess.hand === "B") {
        const lastHand = existingReps.length ? existingReps[existingReps.length - 1].hand : null;
        newHand = lastHand === "L" ? "R" : "L";
      }
    }
    const newRep = {
      date:            sess.date,
      grip:            sess.grip,
      hand:            newHand,
      target_duration: sess.target_duration,
      actual_time_s:   time,
      avg_force_kg:    loadKg,
      weight_kg:       loadKg,
      peak_force_kg:   0,
      set_num:         maxSetNum,
      rep_num:         maxRepNum + 1,
      rest_s:          0,
      session_id:      sessionId,
      failed:          isShortfall(time, sess.target_duration),
    };
    onAddRep(newRep);
    closeRepEdit();
  };

  const saveNewSession = () => {
    if (!newSessGrip || newSessReps.length === 0) return;
    const genId = () => { try { return crypto.randomUUID(); } catch { return `mr_${Date.now()}_${Math.random().toString(36).slice(2,9)}_${Math.random().toString(36).slice(2,5)}`; } };
    const sessionId = genId();
    const reps = newSessReps.map((r, i) => {
      const loadKg = fromDisp(parseFloat(r.load), unit);
      return {
        id:              genId(),   // unique id so addReps dedup doesn't drop reps 2+
        date:            newSessDate,
        grip:            newSessGrip,
        hand:            r.hand || (i % 2 === 0 ? "L" : "R"),
        target_duration: newSessTarget,
        actual_time_s:   parseFloat(r.time),
        avg_force_kg:    loadKg,
        weight_kg:       loadKg,
        peak_force_kg:   0,
        set_num:         1,
        rep_num:         i + 1,
        rest_s:          0,
        session_id:      sessionId,
        failed:          isShortfall(parseFloat(r.time), newSessTarget),
      };
    });
    // Pass all reps at once so addReps dedupes against the original state, not incremental updates
    onAddRep(reps);
    setAddingSession(false);
    setNewSessReps([]);
    setNewSessGrip("");
    setNewRepLoad(""); setNewRepTime("");
  };

  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const filtered = useMemo(() => history.filter(r =>
    (!grip   || r.grip === grip) &&
    (!hand   || r.hand === hand || r.hand === "B") &&  // "Both" sessions visible under any hand filter
    (!target || r.target_duration === target)
  ), [history, grip, hand, target]);

  // Group by session_id then date. Derive `hand` from the union of rep hands,
  // so a Both-mode session with L and R reps shows "Both" (not just the first rep's hand).
  const grouped = useMemo(() => {
    const map = {};
    for (const r of filtered) {
      const key = r.session_id || r.date;
      if (!map[key]) map[key] = { date: r.date, grip: r.grip, hand: r.hand, target_duration: r.target_duration, reps: [] };
      map[key].reps.push(r);
    }
    for (const sess of Object.values(map)) {
      const hands = new Set(sess.reps.map(r => r.hand).filter(Boolean));
      if (hands.has("L") && hands.has("R")) sess.hand = "B";
      else if (hands.has("L")) sess.hand = "L";
      else if (hands.has("R")) sess.hand = "R";
      // else leave the original (covers legacy "B" and empty)
    }
    return Object.values(map).sort((a, b) => a.date < b.date ? 1 : -1);
  }, [filtered]);

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 }}>
        <h2 style={{ margin: 0, fontSize: 22 }}>History</h2>
        <div style={{ display: "flex", gap: 8 }}>
          {domain === "fingers" && <Btn small onClick={() => { setAddingSession(s => !s); setNewSessDate(ymdLocal()); setNewSessGrip(""); setNewSessTarget(TARGET_OPTIONS[0].seconds); setNewSessReps([]); setNewRepLoad(""); setNewRepTime(""); }} color={addingSession ? C.red : C.green}>＋ Session</Btn>}
          {domain === "fingers" && <Btn small onClick={onDownload} color={C.muted}>↓ CSV</Btn>}
        </div>
      </div>

      {/* ── Add Session form ── */}
      {domain === "fingers" && addingSession && (
        <Card style={{ marginBottom: 16, background: "#0d1f0d" }}>
          <div style={{ fontSize: 13, fontWeight: 700, marginBottom: 10, color: C.green }}>New session</div>
          {/* Date */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Date</span>
            <input type="date" value={newSessDate} onChange={e => setNewSessDate(e.target.value)}
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }} />
          </div>
          {/* Grip */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 10 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Grip</span>
            <div style={{ display: "flex", gap: 4, flexWrap: "wrap", flex: 1 }}>
              {GRIP_PRESETS.map(g => (
                <button key={g} onClick={() => setNewSessGrip(g)} style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12,
                  background: newSessGrip === g ? C.orange : C.border,
                  color: newSessGrip === g ? "#fff" : C.muted,
                }}>{g}</button>
              ))}
              <input value={newSessGrip} onChange={e => setNewSessGrip(e.target.value)}
                placeholder="or type…"
                style={{ flex: 1, minWidth: 70, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 12 }} />
            </div>
          </div>
          {/* Zone */}
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 12 }}>
            <span style={{ fontSize: 12, color: C.muted, width: 40 }}>Zone</span>
            <div style={{ display: "flex", gap: 4 }}>
              {TARGET_OPTIONS.map(o => (
                <button key={o.seconds} onClick={() => setNewSessTarget(o.seconds)} style={{
                  padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                  background: newSessTarget === o.seconds ? C.blue : C.border,
                  color: newSessTarget === o.seconds ? "#fff" : C.muted,
                }}>{o.label}</button>
              ))}
            </div>
          </div>
          {/* Reps list */}
          {newSessReps.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Reps added — tap L/R to flip</div>
              <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
                {newSessReps.map((r, i) => (
                  <span key={i} style={{ display: "flex", alignItems: "center", gap: 4, padding: "3px 8px", borderRadius: 7, fontSize: 12, background: "#1a2f1a", border: `1px solid ${C.green}`, color: C.text }}>
                    <button onClick={() => setNewSessReps(rs => rs.map((x, j) => j === i ? { ...x, hand: x.hand === "L" ? "R" : "L" } : x))}
                      style={{
                        background: r.hand === "L" ? C.purple : C.orange,
                        border: "none", borderRadius: 4,
                        color: "#fff", fontWeight: 700, fontSize: 10,
                        padding: "1px 5px", cursor: "pointer", lineHeight: 1.2,
                      }}>{r.hand}</button>
                    {r.load}{unit} · {r.time}s
                    <button onClick={() => setNewSessReps(rs => rs.filter((_, j) => j !== i))}
                      style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 11, padding: 0, lineHeight: 1 }}>✕</button>
                  </span>
                ))}
              </div>
            </div>
          )}
          {/* Add rep row */}
          <div style={{ display: "flex", gap: 6, alignItems: "center", marginBottom: 12 }}>
            <input type="number" value={newRepLoad} onChange={e => setNewRepLoad(e.target.value)}
              placeholder={`Load (${unit})`}
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 13 }} />
            <input type="number" value={newRepTime} onChange={e => setNewRepTime(e.target.value)}
              placeholder="Time (s)"
              style={{ flex: 1, background: C.border, border: "none", borderRadius: 6, padding: "5px 8px", color: C.text, fontSize: 13 }} />
            <button onClick={() => {
              if (!newRepLoad || !newRepTime) return;
              // Alternate L/R default: first rep L, then flip from last rep's hand
              const lastHand = newSessReps.length ? newSessReps[newSessReps.length - 1].hand : null;
              const nextHand = lastHand === "L" ? "R" : "L";
              setNewSessReps(rs => [...rs, { load: newRepLoad, time: newRepTime, hand: nextHand }]);
              setNewRepLoad(""); setNewRepTime("");
            }} style={{
              background: C.green, border: "none", borderRadius: 6, color: "#000",
              fontWeight: 700, fontSize: 13, padding: "5px 12px", cursor: "pointer",
            }}>＋ Rep</button>
          </div>
          {/* Save / Cancel */}
          <div style={{ display: "flex", gap: 8 }}>
            <button onClick={saveNewSession} disabled={!newSessGrip || newSessReps.length === 0} style={{
              background: (!newSessGrip || newSessReps.length === 0) ? C.border : C.green,
              border: "none", borderRadius: 6, color: (!newSessGrip || newSessReps.length === 0) ? C.muted : "#000",
              fontSize: 13, fontWeight: 700, padding: "6px 16px", cursor: "pointer",
            }}>Save session</button>
            <button onClick={() => { setAddingSession(false); setNewSessReps([]); }} style={{
              background: C.border, border: "none", borderRadius: 6, color: C.muted,
              fontSize: 13, padding: "6px 12px", cursor: "pointer",
            }}>Cancel</button>
          </div>
        </Card>
      )}

      {/* Domain toggle */}
      <div style={{ display: "flex", background: C.border, borderRadius: 24, padding: 3, marginBottom: 20, gap: 2 }}>
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["climbing", "🧗 Climbing"]].map(([key, label]) => (
          <button key={key} onClick={() => switchDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 13,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout"  && <WorkoutHistoryView unit={unit} bodyWeight={bodyWeight} />}
      {domain === "climbing" && (
        <ClimbingHistoryList
          climbs={activities
            .filter(a => a.type === "climbing")
            .slice()
            .sort((a, b) => (b.date || "").localeCompare(a.date || ""))}
          onDeleteActivity={onDeleteActivity}
        />
      )}
      {domain === "fingers" && <>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {grips.map(g => (
          <button key={g} onClick={() => setGrip(grip === g ? "" : g)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: grip === g ? C.orange : C.border,
            color: grip === g ? "#fff" : C.muted, border: "none",
          }}>{g}</button>
        ))}
        {["L","R"].map(h => (
          <button key={h} onClick={() => setHand(hand === h ? "" : h)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: hand === h ? C.purple : C.border,
            color: hand === h ? "#fff" : C.muted, border: "none",
          }}>{h === "L" ? "Left" : "Right"}</button>
        ))}
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setTarget(target === o.seconds ? 0 : o.seconds)} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer",
            background: target === o.seconds ? C.blue : C.border,
            color: target === o.seconds ? "#fff" : C.muted, border: "none",
          }}>{o.label}</button>
        ))}
      </div>

      {grouped.length === 0 && (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 15 }}>
          No sessions yet — start training!
        </div>
      )}

      {grouped.slice(0, 30).map((sess, i) => {
        const sessKey = sess.reps[0]?.session_id || sess.date;
        const isConfirming = confirmKey === sessKey;
        const isEditing    = editKey    === sessKey;
        return (
          <Card key={i} style={{ marginBottom: 10 }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 8 }}>
              <div>
                <b>{sess.grip}</b>
                <span style={{ marginLeft: 8, fontSize: 12, color: C.muted }}>
                  {sess.hand === "L" ? "Left" : sess.hand === "R" ? "Right" : "L + R"}
                  {" · "}{TARGET_OPTIONS.find(o => o.seconds === sess.target_duration)?.label ?? sess.target_duration + "s"}
                </span>
              </div>
              <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
                <span style={{ fontSize: 12, color: C.muted }}>
                  {sess.date}{sess.reps[0]?.session_started_at ? " · " + fmtClock(sess.reps[0].session_started_at) : ""}
                  {(() => { const e = bwOnDate(bwLog, sess.date); return e ? " · " + fmt1(toDisp(e.kg, unit)) + " " + unit : ""; })()}
                </span>
                {!isConfirming && !isEditing && (
                  <>
                    <button
                      onClick={() => setNoteKey(noteKey === sessKey ? null : sessKey)}
                      style={{
                        background: "none", border: "none",
                        color: notes[sessKey] ? C.yellow : C.muted,
                        fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                      }}
                      title={notes[sessKey] ? "View/edit note" : "Add note"}
                    >📝</button>
                    <button onClick={() => {
                      setEditKey(sessKey);
                      setEditHand(sess.hand);
                      setEditGrip(sess.grip);
                      setEditTarget(sess.target_duration);
                      setRepEditMode(sessKey);   // also enable per-rep editing
                      setConfirmKey(null);
                      setNoteKey(null);
                      closeRepEdit();
                    }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 13, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Edit session & reps">✏️</button>
                    <button onClick={() => { setConfirmKey(sessKey); setEditKey(null); setNoteKey(null); }} style={{
                      background: "none", border: "none", color: C.muted,
                      fontSize: 14, cursor: "pointer", padding: "0 2px", lineHeight: 1,
                    }} title="Delete session">🗑</button>
                  </>
                )}
                {isConfirming && (
                  <>
                    <button onClick={() => { onDeleteSession(sessKey); setConfirmKey(null); }} style={{
                      background: C.red, border: "none", borderRadius: 6, color: "#fff",
                      fontSize: 11, fontWeight: 700, padding: "3px 8px", cursor: "pointer",
                    }}>Delete</button>
                    <button onClick={() => setConfirmKey(null)} style={{
                      background: C.border, border: "none", borderRadius: 6, color: C.muted,
                      fontSize: 11, padding: "3px 8px", cursor: "pointer",
                    }}>Cancel</button>
                  </>
                )}
              </div>
            </div>

            {/* Edit UI */}
            {isEditing && (
              <div style={{ marginBottom: 10, padding: 10, background: C.bg, borderRadius: 8 }}>
                {/* Row 1: hand + grip */}
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center", marginBottom: 8 }}>
                  <div style={{ display: "flex", gap: 4 }}>
                    {["L","R","B"].map(h => (
                      <button key={h} onClick={() => setEditHand(h)} style={{
                        padding: "4px 10px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                        background: editHand === h ? C.purple : C.border,
                        color: editHand === h ? "#fff" : C.muted,
                      }}>{h === "L" ? "Left" : h === "R" ? "Right" : "Both"}</button>
                    ))}
                  </div>
                  <input
                    value={editGrip}
                    onChange={e => setEditGrip(e.target.value)}
                    placeholder="Grip type"
                    style={{ flex: 1, minWidth: 80, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 12 }}
                  />
                </div>
                {/* Row 2: zone / target duration */}
                <div style={{ display: "flex", gap: 4, marginBottom: 10 }}>
                  {TARGET_OPTIONS.map(o => (
                    <button key={o.seconds} onClick={() => setEditTarget(o.seconds)} style={{
                      padding: "4px 12px", borderRadius: 6, border: "none", cursor: "pointer", fontSize: 12, fontWeight: 600,
                      background: editTarget === o.seconds ? C.blue : C.border,
                      color: editTarget === o.seconds ? "#fff" : C.muted,
                    }}>{o.label}</button>
                  ))}
                </div>
                {/* Row 3: save / cancel */}
                <div style={{ display: "flex", gap: 8 }}>
                  <button onClick={() => {
                    onUpdateSession(sessKey, { hand: editHand, grip: editGrip, target_duration: editTarget });
                    setEditKey(null);
                    setRepEditMode(null);
                    closeRepEdit();
                  }} style={{
                    background: C.green, border: "none", borderRadius: 6, color: "#000",
                    fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                  }}>Done</button>
                  <button onClick={() => {
                    setEditKey(null);
                    setRepEditMode(null);
                    closeRepEdit();
                  }} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 11, padding: "4px 8px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
                <div style={{ marginTop: 8, fontSize: 11, color: C.muted, fontStyle: "italic" }}>
                  Tap a rep chip below to edit its load, time, or hand · use + to add a rep · × to delete.
                </div>
              </div>
            )}

            {/* Rep chips */}
            {(() => {
              const sortedReps = sess.reps.slice().sort((a, b) => a.set_num - b.set_num || a.rep_num - b.rep_num);
              const renderChip = (r, j) => {
                const isRepEditing = editingRep?.sessKey === sessKey && editingRep?.repIdx === j;
                const passed = r.actual_time_s >= sess.target_duration;
                return (
                  <div key={j} style={{ position: "relative", display: "inline-flex", alignItems: "center", gap: 0 }}>
                    <div
                      onClick={() => repEditMode === sessKey && !isRepEditing && openRepEdit(sessKey, j, r)}
                      style={{
                        padding: "4px 10px", borderRadius: 8, fontSize: 12,
                        background: isRepEditing ? C.blue + "33" : passed ? "#1a2f1a" : "#2f1a1a",
                        border: `1px solid ${isRepEditing ? C.blue : passed ? C.green : C.red}`,
                        cursor: repEditMode === sessKey ? "pointer" : "default",
                        paddingRight: repEditMode === sessKey ? 22 : 10,
                      }}
                    >
                      <b>{fmtW(effectiveLoad(r), unit)}{unit}</b> · {fmtTime(r.actual_time_s)}
                    </div>
                    {repEditMode === sessKey && (
                      <button
                        onClick={() => onDeleteRep(r)}
                        title="Delete this rep"
                        style={{
                          position: "absolute", right: 3, top: "50%", transform: "translateY(-50%)",
                          background: C.red, color: "#fff", border: "none", borderRadius: "50%",
                          width: 16, height: 16, fontSize: 10, lineHeight: "16px", textAlign: "center",
                          cursor: "pointer", padding: 0, fontWeight: 700,
                        }}
                      >×</button>
                    )}
                  </div>
                );
              };
              // Both-mode session → two-column layout (Left | Right).
              // Single-hand session → existing flex-wrap row.
              if (sess.hand === "B") {
                return (
                  <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10 }}>
                    {["L", "R"].map(handKey => (
                      <div key={handKey}>
                        <div style={{
                          fontSize: 10, fontWeight: 700, letterSpacing: 1,
                          color: handKey === "L" ? C.blue : C.orange, marginBottom: 6,
                        }}>{handKey === "L" ? "LEFT" : "RIGHT"}</div>
                        <div style={{ display: "flex", flexDirection: "column", gap: 6, alignItems: "flex-start" }}>
                          {sortedReps.map((r, j) => r.hand === handKey ? renderChip(r, j) : null)}
                        </div>
                      </div>
                    ))}
                  </div>
                );
              }
              return (
                <div style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
                  {sortedReps.map((r, j) => renderChip(r, j))}
                </div>
              );
            })()}

            {/* + Add rep button */}
            {repEditMode === sessKey && !editingRep && addingRep !== sessKey && (
              <button
                onClick={() => openRepAdd(sessKey)}
                style={{
                  marginTop: 8, width: "100%", padding: "6px 0",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, borderRadius: 8, fontSize: 12, cursor: "pointer",
                }}
              >+ Add rep</button>
            )}

            {/* Inline rep editor / adder */}
            {(editingRep?.sessKey === sessKey || addingRep === sessKey) && (
              <div style={{ marginTop: 10, padding: 10, background: C.bg, borderRadius: 8 }}>
                <div style={{ fontSize: 12, color: C.muted, marginBottom: 8 }}>
                  {addingRep === sessKey ? "Add rep" : "Edit rep"}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "flex-end", marginBottom: 8 }}>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Load ({unit})</label>
                    <input
                      autoFocus
                      type="number"
                      value={editRepLoad}
                      onChange={e => setEditRepLoad(e.target.value)}
                      style={{ width: 80, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Time (s)</label>
                    <input
                      type="number"
                      value={editRepTime}
                      onChange={e => setEditRepTime(e.target.value)}
                      style={{ width: 60, background: C.border, border: "none", borderRadius: 6, padding: "4px 8px", color: C.text, fontSize: 13 }}
                    />
                  </div>
                  <div style={{ display: "flex", flexDirection: "column", gap: 3 }}>
                    <label style={{ fontSize: 10, color: C.muted }}>Hand</label>
                    <div style={{ display: "flex", gap: 4 }}>
                      {["L", "R"].map(h => {
                        const selected = editRepHand === h;
                        return (
                          <button
                            key={h}
                            type="button"
                            onClick={() => setEditRepHand(h)}
                            style={{
                              width: 32, padding: "4px 0",
                              background: selected ? C.blue : C.border,
                              color: selected ? "#000" : C.muted,
                              border: "none", borderRadius: 6,
                              fontSize: 12, fontWeight: 700, cursor: "pointer",
                            }}
                          >{h}</button>
                        );
                      })}
                    </div>
                  </div>
                </div>
                <div style={{ display: "flex", gap: 8 }}>
                  <button
                    onClick={() => addingRep === sessKey ? saveRepAdd(sess) : saveRepEdit()}
                    style={{
                      background: C.green, border: "none", borderRadius: 6, color: "#000",
                      fontSize: 11, fontWeight: 700, padding: "4px 10px", cursor: "pointer",
                    }}
                  >Save</button>
                  <button onClick={closeRepEdit} style={{
                    background: C.border, border: "none", borderRadius: 6, color: C.muted,
                    fontSize: 11, padding: "4px 8px", cursor: "pointer",
                  }}>Cancel</button>
                </div>
              </div>
            )}

            {/* Note preview (when note exists and editor is closed) */}
            {notes[sessKey] && noteKey !== sessKey && (
              <div style={{
                marginTop: 10, padding: "7px 10px",
                background: "#1f1a00", borderRadius: 7,
                fontSize: 12, color: C.yellow, lineHeight: 1.5,
                borderLeft: `3px solid ${C.yellow}`,
              }}>
                📝 {notes[sessKey]}
              </div>
            )}

            {/* Note editor */}
            {noteKey === sessKey && (
              <div style={{ marginTop: 10 }}>
                <textarea
                  autoFocus
                  value={notes[sessKey] || ""}
                  onChange={e => onNoteChange(sessKey, e.target.value)}
                  placeholder="Add a note — how did it feel? Any context?"
                  rows={3}
                  style={{
                    width: "100%", boxSizing: "border-box",
                    background: "#1f1a00", border: `1px solid ${C.yellow}55`,
                    borderRadius: 7, padding: "8px 10px",
                    color: C.text, fontSize: 12, lineHeight: 1.5,
                    resize: "vertical",
                  }}
                />
                <div style={{ display: "flex", justifyContent: "flex-end", gap: 8, marginTop: 6 }}>
                  {notes[sessKey] && (
                    <button onClick={() => { onNoteChange(sessKey, ""); setNoteKey(null); }} style={{
                      background: "none", border: `1px solid ${C.border}`,
                      color: C.muted, borderRadius: 6, padding: "3px 10px", fontSize: 11, cursor: "pointer",
                    }}>Clear</button>
                  )}
                  <button onClick={() => setNoteKey(null)} style={{
                    background: C.yellow, border: "none",
                    color: "#000", borderRadius: 6, padding: "3px 12px", fontSize: 11,
                    fontWeight: 700, cursor: "pointer",
                  }}>Done</button>
                </div>
              </div>
            )}
          </Card>
        );
      })}
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// TRENDS VIEW
// ─────────────────────────────────────────────────────────────
// ── Workout strength-trend sub-view ──────────────────────────
function WorkoutTrendsView({ unit = "lbs" }) {
  // Always read fresh from localStorage
  const wLog = useMemo(() => loadLS(LS_WORKOUT_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps
  // All exercises that have logged weight data
  const exerciseOptions = useMemo(() => {
    const seen = new Map(); // id → name
    for (const session of wLog) {
      for (const [id, data] of Object.entries(session.exercises || {})) {
        if (data.sets && data.sets.some(s => s.weight && s.done)) {
          if (!seen.has(id)) {
            let name = id.replace(/_/g, " ");
            for (const wk of Object.values(DEFAULT_WORKOUTS)) {
              const ex = (wk.exercises || []).find(e => e.id === id);
              if (ex && ex.name) { name = ex.name; break; }
            }
            seen.set(id, name);
          }
        }
      }
    }
    return [...seen.entries()].map(([id, name]) => ({ id, name }));
  }, [wLog]);

  const [selEx, setSelEx] = useState(null);
  // Auto-select first available exercise
  const activeEx = selEx && exerciseOptions.find(e => e.id === selEx) ? selEx : (exerciseOptions[0]?.id || null);

  const chartData = useMemo(() => {
    if (!activeEx) return [];
    const points = [];
    for (const session of wLog) {
      const exData = session.exercises?.[activeEx];
      if (!exData?.sets) continue;
      const weights = exData.sets
        .filter(s => s.done && s.weight)
        .map(s => parseFloat(s.weight))
        .filter(w => !isNaN(w) && w > 0);
      if (!weights.length) continue;
      const maxW = Math.max(...weights);
      const dispW = unit === "kg" ? Math.round(maxW / 2.205 * 10) / 10 : maxW;
      points.push({ date: session.date, max: dispW, workout: session.workout });
    }
    points.sort((a, b) => a.date < b.date ? -1 : 1);
    let pr = -Infinity;
    return points.map(p => {
      const isPR = p.max > pr;
      if (isPR) pr = p.max;
      return { ...p, isPR };
    });
  }, [wLog, activeEx, unit]);

  const currentPR = useMemo(() => [...chartData].filter(d => d.isPR).slice(-1)[0], [chartData]);

  if (!exerciseOptions.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Complete a workout session to see strength trends.
    </div>
  );

  return (
    <div>
      {/* Exercise selector */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
        {exerciseOptions.map(ex => (
          <button key={ex.id} onClick={() => setSelEx(ex.id)} style={{
            padding: "6px 14px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none", fontSize: 12,
            background: activeEx === ex.id ? C.blue : C.border,
            color: activeEx === ex.id ? "#fff" : C.muted,
          }}>{ex.name}</button>
        ))}
      </div>

      {currentPR && (
        <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
          <div style={{ display: "flex", gap: 16, alignItems: "center" }}>
            <span style={{ fontSize: 18 }}>🏆</span>
            <div>
              <Label>Personal Record</Label>
              <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                {currentPR.max} {unit}
              </span>
              <div style={{ fontSize: 11, color: C.muted }}>{currentPR.date}</div>
            </div>
          </div>
        </Card>
      )}

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log 2+ sessions with this exercise to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
            Max weight per session · {exerciseOptions.find(e => e.id === activeEx)?.name}
          </div>
          <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
            <span style={{ color: C.yellow }}>★</span> = personal record
          </div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="max"
                stroke={C.blue}
                strokeWidth={2}
                name="Max weight"
                connectNulls
                dot={(props) => {
                  const { cx, cy, payload } = props;
                  if (!payload.isPR) return (
                    <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={C.blue} opacity={0.6} />
                  );
                  return (
                    <g key={`pr-${cx}-${cy}`}>
                      <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                      <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                      <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                    </g>
                  );
                }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

function BodyWeightTrendsView({ unit = "lbs" }) {
  const bwLog = useMemo(() => loadLS(LS_BW_LOG_KEY) || [], []); // eslint-disable-line react-hooks/exhaustive-deps
  const chartData = useMemo(() =>
    bwLog.map(e => ({ date: e.date, weight: Math.round(toDisp(e.kg, unit) * 10) / 10 })),
    [bwLog, unit]
  );
  const latest = chartData[chartData.length - 1];
  const first  = chartData[0];
  const delta  = latest && first && chartData.length > 1
    ? Math.round((latest.weight - first.weight) * 10) / 10
    : null;

  if (!chartData.length) return (
    <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
      Update your body weight in Settings to start tracking it here.
    </div>
  );

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16 }}>
        <Card style={{ flex: 1 }}>
          <Label>Current</Label>
          <div style={{ fontSize: 22, fontWeight: 800, color: C.text }}>
            {latest?.weight} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
          </div>
          <div style={{ fontSize: 11, color: C.muted }}>{latest?.date}</div>
        </Card>
        {delta != null && (
          <Card style={{ flex: 1 }}>
            <Label>Change</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: delta < 0 ? C.green : delta > 0 ? C.orange : C.muted }}>
              {delta > 0 ? "+" : ""}{delta} <span style={{ fontSize: 13, fontWeight: 400, color: C.muted }}>{unit}</span>
            </div>
            <div style={{ fontSize: 11, color: C.muted }}>since {first?.date}</div>
          </Card>
        )}
      </div>

      {chartData.length < 2 ? (
        <Card>
          <div style={{ color: C.muted, fontSize: 13, textAlign: "center", padding: "16px 0" }}>
            Log your weight again after updating it in Settings to see a trend line.
          </div>
        </Card>
      ) : (
        <Card>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Body weight over time</div>
          <ResponsiveContainer width="100%" height={240}>
            <LineChart data={chartData}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
              <YAxis
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={` ${unit}`}
                domain={["auto", "auto"]}
              />
              <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
              <Line
                type="monotone"
                dataKey="weight"
                stroke={C.purple}
                strokeWidth={2}
                name={`Weight (${unit})`}
                dot={{ r: 4, fill: C.purple }}
                activeDot={{ r: 6 }}
              />
            </LineChart>
          </ResponsiveContainer>
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CLIMBING TRENDS
// Weekly volume (stacked by discipline) + hardest-send line for
// boulder (V-scale) and rope (YDS). Attempts drop off the
// hardest-send line because they aren't sends.
// ─────────────────────────────────────────────────────────────
function weekKey(isoDate) {
  // Returns the ISO date of the Monday of the week this date falls in.
  // Used as the x-axis key for weekly aggregates.
  const d = new Date(isoDate + "T00:00:00Z");
  if (isNaN(d.getTime())) return isoDate;
  const day = d.getUTCDay(); // 0=Sun..6=Sat
  const mondayOffset = day === 0 ? -6 : 1 - day;
  d.setUTCDate(d.getUTCDate() + mondayOffset);
  return d.toISOString().slice(0, 10);
}

function ClimbingTrendsView({ activities = [] }) {
  const climbs = useMemo(
    () => activities.filter(a => a.type === "climbing" && a.date),
    [activities]
  );

  // Weekly aggregate: volume by discipline + hardest send per family.
  const weekly = useMemo(() => {
    const weeks = new Map(); // weekKey -> { week, boulder, top_rope, lead, hardestV, hardestYDS, sends, total }
    for (const c of climbs) {
      const wk = weekKey(c.date);
      if (!weeks.has(wk)) {
        weeks.set(wk, {
          week: wk,
          boulder: 0, top_rope: 0, lead: 0,
          hardestV: null, hardestYDS: null,
          sends: 0, total: 0,
        });
      }
      const w = weeks.get(wk);
      w.total += 1;
      const isSend = c.ascent && c.ascent !== "attempt";
      if (isSend) w.sends += 1;
      if (c.discipline === "boulder")  w.boulder  += 1;
      if (c.discipline === "top_rope") w.top_rope += 1;
      if (c.discipline === "lead")     w.lead     += 1;

      // Only sends count toward the hardest-grade line.
      if (isSend) {
        const rank = gradeRank(c.grade);
        if (c.discipline === "boulder" && rank >= 0) {
          if (w.hardestV == null || rank > w.hardestV.rank) {
            w.hardestV = { rank, label: c.grade };
          }
        } else if ((c.discipline === "top_rope" || c.discipline === "lead") && rank >= 0) {
          if (w.hardestYDS == null || rank > w.hardestYDS.rank) {
            w.hardestYDS = { rank, label: c.grade };
          }
        }
      }
    }
    return [...weeks.values()].sort((a, b) => (a.week < b.week ? -1 : 1));
  }, [climbs]);

  // Flatten hardest-grade into chart-friendly numeric series.
  const chart = useMemo(() => weekly.map(w => ({
    week:         w.week,
    boulder:      w.boulder,
    top_rope:     w.top_rope,
    lead:         w.lead,
    hardestV:     w.hardestV?.rank ?? null,
    hardestVLbl:  w.hardestV?.label ?? "",
    hardestYDS:   w.hardestYDS?.rank ?? null,
    hardestYDSLbl: w.hardestYDS?.label ?? "",
    sendRate:     w.total > 0 ? Math.round((w.sends / w.total) * 100) : 0,
  })), [weekly]);

  const totals = useMemo(() => {
    const sends = climbs.filter(c => c.ascent && c.ascent !== "attempt");
    const maxV   = sends
      .filter(c => c.discipline === "boulder")
      .map(c => ({ rank: gradeRank(c.grade), label: c.grade }))
      .filter(x => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank)[0];
    const maxYDS = sends
      .filter(c => c.discipline === "top_rope" || c.discipline === "lead")
      .map(c => ({ rank: gradeRank(c.grade), label: c.grade }))
      .filter(x => x.rank >= 0)
      .sort((a, b) => b.rank - a.rank)[0];
    return { total: climbs.length, sends: sends.length, maxV, maxYDS };
  }, [climbs]);

  if (climbs.length === 0) {
    return (
      <div style={{ textAlign: "center", color: C.muted, marginTop: 60, fontSize: 14 }}>
        Log a climb in the Climbing tab to start tracking climbing trends.
      </div>
    );
  }

  return (
    <div>
      <div style={{ display: "flex", gap: 12, marginBottom: 16, flexWrap: "wrap" }}>
        <Card style={{ flex: "1 1 120px" }}>
          <Label>Total climbs</Label>
          <div style={{ fontSize: 22, fontWeight: 800 }}>{totals.total}</div>
          <div style={{ fontSize: 11, color: C.muted }}>{totals.sends} sends</div>
        </Card>
        {totals.maxV && (
          <Card style={{ flex: "1 1 120px" }}>
            <Label>Hardest boulder</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.orange }}>{totals.maxV.label}</div>
            <div style={{ fontSize: 11, color: C.muted }}>send PR</div>
          </Card>
        )}
        {totals.maxYDS && (
          <Card style={{ flex: "1 1 120px" }}>
            <Label>Hardest rope</Label>
            <div style={{ fontSize: 22, fontWeight: 800, color: C.blue }}>{totals.maxYDS.label}</div>
            <div style={{ fontSize: 11, color: C.muted }}>send PR</div>
          </Card>
        )}
      </div>

      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Weekly volume by discipline</div>
        <ResponsiveContainer width="100%" height={220}>
          <BarChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis tick={{ fill: C.muted, fontSize: 11 }} allowDecimals={false} />
            <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
            <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
            <Bar dataKey="boulder"  stackId="v" name="Boulder"  fill={C.orange} />
            <Bar dataKey="lead"     stackId="v" name="Lead"     fill={C.purple} />
            <Bar dataKey="top_rope" stackId="v" name="Top rope" fill={C.blue}   />
          </BarChart>
        </ResponsiveContainer>
      </Card>

      <Card>
        <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>Hardest send per week</div>
        <ResponsiveContainer width="100%" height={220}>
          <LineChart data={chart}>
            <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
            <XAxis dataKey="week" tick={{ fill: C.muted, fontSize: 10 }} />
            <YAxis
              yAxisId="v"
              orientation="left"
              tick={{ fill: C.orange, fontSize: 11 }}
              tickFormatter={(v) => v == null ? "" : `V${v}`}
              domain={["auto", "auto"]}
            />
            <YAxis
              yAxisId="yds"
              orientation="right"
              tick={{ fill: C.blue, fontSize: 11 }}
              tickFormatter={(v) => {
                if (v == null) return "";
                const n    = Math.floor(v);
                const frac = v - n;
                const sub  = ["a", "b", "c", "d"][Math.round(frac * 4)] || "";
                return `5.${n}${sub}`;
              }}
              domain={["auto", "auto"]}
            />
            <Tooltip
              contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }}
              formatter={(val, name, entry) => {
                if (name === "Boulder") return [entry.payload.hardestVLbl || "—", name];
                if (name === "Rope")    return [entry.payload.hardestYDSLbl || "—", name];
                return [val, name];
              }}
            />
            <Legend wrapperStyle={{ fontSize: 11, color: C.muted }} />
            <Line
              yAxisId="v"
              type="monotone"
              dataKey="hardestV"
              stroke={C.orange}
              strokeWidth={2}
              name="Boulder"
              connectNulls
              dot={{ r: 4, fill: C.orange }}
            />
            <Line
              yAxisId="yds"
              type="monotone"
              dataKey="hardestYDS"
              stroke={C.blue}
              strokeWidth={2}
              name="Rope"
              connectNulls
              dot={{ r: 4, fill: C.blue }}
            />
          </LineChart>
        </ResponsiveContainer>
      </Card>
    </div>
  );
}

function TrendsView({ history, unit = "lbs", activities = [] }) {
  const [domain, setDomain] = useState("fingers"); // "fingers" | "workout" | "body" | "climbing"
  const [sel,     setSel]     = useState(45);
  const [selHand, setSelHand] = useState("");   // "" = both
  const [selGrip, setSelGrip] = useState("");   // "" = all grips

  const grips = useMemo(() => [...new Set(history.map(r => r.grip).filter(Boolean))].sort(), [history]);

  const data = useMemo(() => {
    const byDate = {};
    for (const r of history.filter(r =>
      r.target_duration === sel &&
      effectiveLoad(r) > 0 &&
      (!selGrip || r.grip === selGrip)
    )) {
      const d = r.date || "";
      if (!byDate[d]) byDate[d] = { date: d, L: null, R: null };
      const load = toDisp(effectiveLoad(r), unit);
      if (r.hand === "L") byDate[d].L = Math.max(byDate[d].L ?? 0, load);
      if (r.hand === "R") byDate[d].R = Math.max(byDate[d].R ?? 0, load);
    }
    // Sort chronologically, then flag PR points
    const sorted = Object.values(byDate).sort((a, b) => a.date < b.date ? -1 : 1);
    let maxL = -Infinity, maxR = -Infinity;
    return sorted.map(d => {
      const isPR_L = d.L != null && d.L > maxL;
      const isPR_R = d.R != null && d.R > maxR;
      if (isPR_L) maxL = d.L;
      if (isPR_R) maxR = d.R;
      return { ...d, isPR_L, isPR_R };
    });
  }, [history, sel, selGrip, unit]);

  // Latest PR values for summary display
  const latestPR = useMemo(() => {
    const prsL = data.filter(d => d.isPR_L);
    const prsR = data.filter(d => d.isPR_R);
    return {
      L: prsL.length ? prsL[prsL.length - 1] : null,
      R: prsR.length ? prsR[prsR.length - 1] : null,
    };
  }, [data]);

  const lines = selHand === "L" ? [{ key: "L", color: C.blue,   name: "Left"  }]
              : selHand === "R" ? [{ key: "R", color: C.orange, name: "Right" }]
              : [{ key: "L", color: C.blue, name: "Left" }, { key: "R", color: C.orange, name: "Right" }];

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Trends</h2>

      {/* Domain toggle: Fingers / Workout / Body / Climbing */}
      <div style={{ display: "flex", background: C.border, borderRadius: 24, padding: 3, marginBottom: 20, gap: 2 }}>
        {[["fingers", "🖐 Fingers"], ["workout", "🏋️ Workout"], ["body", "⚖️ Body"], ["climbing", "🧗 Climbing"]].map(([key, label]) => (
          <button key={key} onClick={() => setDomain(key)} style={{
            flex: 1, padding: "8px 0", borderRadius: 20, border: "none", cursor: "pointer",
            fontWeight: 700, fontSize: 12,
            background: domain === key ? C.blue : "transparent",
            color: domain === key ? "#fff" : C.muted,
            transition: "background 0.15s",
          }}>{label}</button>
        ))}
      </div>

      {domain === "workout"  && <WorkoutTrendsView unit={unit} />}
      {domain === "body"     && <BodyWeightTrendsView unit={unit} />}
      {domain === "climbing" && <ClimbingTrendsView activities={activities} />}
      {domain === "fingers"  && <>

      {/* Filters */}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 12 }}>
        {["L","R"].map(h => (
          <button key={h} onClick={() => setSelHand(selHand === h ? "" : h)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: selHand === h ? C.purple : C.border,
            color: selHand === h ? "#fff" : C.muted,
          }}>{h === "L" ? "Left" : "Right"}</button>
        ))}
        {TARGET_OPTIONS.map(o => (
          <button key={o.seconds} onClick={() => setSel(o.seconds)} style={{
            padding: "6px 18px", borderRadius: 20, cursor: "pointer", fontWeight: 600, border: "none",
            background: sel === o.seconds ? C.blue : C.border,
            color: sel === o.seconds ? "#fff" : C.muted,
          }}>{o.label}</button>
        ))}
      </div>
      {grips.length > 0 && (
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: 16 }}>
          <button onClick={() => setSelGrip("")} style={{
            padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
            background: !selGrip ? C.orange : C.border,
            color: !selGrip ? "#fff" : C.muted,
          }}>All Grips</button>
          {grips.map(g => (
            <button key={g} onClick={() => setSelGrip(selGrip === g ? "" : g)} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: selGrip === g ? C.orange : C.border,
              color: selGrip === g ? "#fff" : C.muted,
            }}>{g}</button>
          ))}
        </div>
      )}

      {data.length === 0 ? (
        <div style={{ textAlign: "center", color: C.muted, marginTop: 60 }}>
          No data for this filter yet.
        </div>
      ) : (
        <>
          {/* PR summary */}
          {(latestPR.L || latestPR.R) && (
            <Card style={{ marginBottom: 12, borderColor: C.yellow + "55" }}>
              <div style={{ display: "flex", gap: 24, alignItems: "center" }}>
                <span style={{ fontSize: 18 }}>🏆</span>
                {latestPR.L && (selHand === "" || selHand === "L") && (
                  <div>
                    <Label>Left PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.L.L)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.L.date}</div>
                  </div>
                )}
                {latestPR.R && (selHand === "" || selHand === "R") && (
                  <div>
                    <Label>Right PR</Label>
                    <span style={{ fontSize: 22, fontWeight: 800, color: C.yellow }}>
                      {fmt1(latestPR.R.R)} {unit}
                    </span>
                    <div style={{ fontSize: 11, color: C.muted }}>{latestPR.R.date}</div>
                  </div>
                )}
              </div>
            </Card>
          )}

          <Card>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 4 }}>
              Best daily load · {TARGET_OPTIONS.find(o => o.seconds === sel)?.label}
              {selGrip ? ` · ${selGrip}` : ""}
            </div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 10 }}>
              <span style={{ color: C.yellow }}>★</span> = personal record
            </div>
            <ResponsiveContainer width="100%" height={240}>
              <LineChart data={data}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 10 }} />
                <YAxis tick={{ fill: C.muted, fontSize: 11 }} unit={` ${unit}`} />
                <Tooltip contentStyle={{ background: C.card, border: `1px solid ${C.border}`, color: C.text }} />
                <Legend />
                {lines.map(l => (
                  <Line
                    key={l.key}
                    type="monotone"
                    dataKey={l.key}
                    stroke={l.color}
                    strokeWidth={2}
                    name={l.name}
                    connectNulls
                    dot={(props) => {
                      const { cx, cy, payload } = props;
                      const isPR = l.key === "L" ? payload.isPR_L : payload.isPR_R;
                      const val  = payload[l.key];
                      if (val == null) return null;
                      if (!isPR) return (
                        <circle key={`dot-${cx}-${cy}`} cx={cx} cy={cy} r={2.5} fill={l.color} opacity={0.6} />
                      );
                      return (
                        <g key={`pr-${cx}-${cy}`}>
                          <circle cx={cx} cy={cy} r={7} fill={C.yellow} opacity={0.2} />
                          <circle cx={cx} cy={cy} r={4} fill={C.yellow} />
                          <text x={cx} y={cy - 12} textAnchor="middle" fill={C.yellow} fontSize={9} fontWeight="bold">PR</text>
                        </g>
                      );
                    }}
                  />
                ))}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        </>
      )}
      </>}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// ANALYSIS VIEW  — Force-Duration Curve + Training Recommendations
// ─────────────────────────────────────────────────────────────
// Zone boundaries (seconds)
const POWER_MAX    = 20;
const STRENGTH_MAX = 120;

// Shared recommendation metadata — used by both the pooled/selGrip-scoped
// `recommendation` useMemo and the per-grip `gripRecs` useMemo so the
// title/color/caption shown for "Train Power / Strength / Capacity" stay
// consistent between scopes.
const ZONE_DETAILS = {
  power: {
    title: "Train Power", color: C.red,
    caption: "short, high-force efforts that develop W′, the finite anaerobic reserve above your CF asymptote.",
  },
  strength: {
    title: "Train Strength", color: C.orange,
    caption: "mid-duration max hangs that lift the force ceiling — and with it, CF.",
  },
  endurance: {
    title: "Train Capacity", color: C.blue,
    caption: "sustained threshold holds that raise CF as a fraction of your existing ceiling.",
  },
};

// Pure helper: given a {CF, W} fit and personalResponse map, compute the
// projected ΔAUC for each protocol and return the rec payload. Separate
// from the React memos so it can be called once per grip.
function buildRecFromFit(fit, personalResponse, unit) {
  if (!fit) return null;
  const { CF, W } = fit;
  const gains = {};
  for (const [key, resp] of Object.entries(personalResponse)) {
    const dCF = CF * resp.cf;
    const dW  = W  * resp.w;
    const gainKg = dCF * (AUC_T_MAX - AUC_T_MIN) + dW * Math.log(AUC_T_MAX / AUC_T_MIN);
    gains[key] = toDisp(gainKg, unit);
  }
  const bestKey = Object.entries(gains).reduce((a, b) => b[1] > a[1] ? b : a)[0];
  const d = ZONE_DETAILS[bestKey];
  const responseSource = {};
  for (const key of Object.keys(personalResponse)) {
    responseSource[key] = {
      source: personalResponse[key].source,
      n:      personalResponse[key].n,
    };
  }
  return {
    key:     bestKey,
    title:   d.title,
    color:   d.color,
    insight: `Largest projected AUC gain from ${d.caption}`,
    gains,
    aucGain: gains[bestKey],
    responseSource,
  };
}

function AnalysisView({ history, unit = "lbs", bodyWeight = null, baseline = null, activities = [], liveEstimate = null, gripEstimates = {} }) {
  const [selHand,   setSelHand]   = useState("L");
  const [selGrip,   setSelGrip]   = useState("");
  const [relMode,   setRelMode]   = useState(false); // relative strength toggle

  const grips = useMemo(() =>
    [...new Set(history.map(r => r.grip).filter(Boolean))].sort(),
    [history]
  );

  // All reps with usable force + time data for the selected filters
  const reps = useMemo(() => history.filter(r =>
    r.hand === selHand &&
    (!selGrip || r.grip === selGrip) &&
    r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
    r.actual_time_s > 0
  ), [history, selHand, selGrip]);

  const failures  = reps.filter(r => r.failed);
  const successes = reps.filter(r => !r.failed);

  const maxDur = Math.max(...reps.map(r => r.actual_time_s), STRENGTH_MAX + 60);

  // ── Critical Force estimation via Monod-Scherrer linearization ──
  // Delegates to the standalone fitCF() helper.
  const cfEstimate = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
    return fitCF(pts);
  }, [failures]);

  // ── Capacity improvement % vs baseline ──
  // Reference durations for each domain (seconds)
  const REF = { power: 10, strength: 45, endurance: 180 };

  // Reusable: compute {power, strength, endurance, total} Δ% for a
  // current fit against a reference fit. The reference is injected so
  // the pooled path and per-grip path can each compare apples-to-
  // apples (pooled-current vs pooled-baseline; Micro-now vs Micro-
  // then; Crusher-now vs Crusher-then).
  const improvementForFit = (fit, ref) => {
    if (!ref || !fit) return null;
    const pct = (t) => {
      const cur  = predForce(fit, t);
      const base = predForce(ref, t);
      if (base <= 0) return null;
      return Math.round((cur / base - 1) * 100);
    };
    const p = pct(REF.power);
    const s = pct(REF.strength);
    const e = pct(REF.endurance);
    if (p == null || s == null || e == null) return null;
    return { power: p, strength: s, endurance: e, total: Math.round((p + s + e) / 3) };
  };

  const improvement = useMemo(
    () => improvementForFit(cfEstimate, baseline),
    [baseline, cfEstimate] // eslint-disable-line react-hooks/exhaustive-deps
  );

  // Per-grip baselines — for each grip, find the earliest window of
  // failure reps (≥5 reps, ≥3 distinct target durations) and fit a
  // Monod-Scherrer snapshot from just that grip's reps. This mirrors
  // the global auto-baseline seeding logic (App-level useEffect) but
  // scoped per grip, with a tighter threshold:
  //   - ≥5 reps (vs 3 globally) to damp W' estimate variance
  //   - ≥3 distinct durations (vs 2 globally) so the Monod fit has
  //     real spread along the 1/T axis instead of a 2-point line
  // Small-N Monod fits have high variance in W' — the anaerobic
  // numerator — and that noise is amplified at short T by the 1/T
  // factor. A 3-rep baseline across 2 durations was producing
  // optimistic W' values that later fits naturally pulled down,
  // showing up as phantom "Power regression" of -50% or so. 5 reps
  // across 3 durations gives a far more stable intercept+slope.
  const gripBaselines = useMemo(() => {
    const out = {};
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    for (const [grip, reps] of Object.entries(byGrip)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const fit = fitCF(acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg })));
          if (fit) out[grip] = { date: acc[0].date, CF: fit.CF, W: fit.W };
          break;
        }
      }
    }
    return out;
  }, [history]);

  // Per-grip capacity improvement — each grip's current fit vs its
  // own per-grip baseline. Only emitted for grips that have both a
  // per-grip baseline AND a per-grip current fit, so the card never
  // shows a misleading cross-muscle comparison.
  const gripImprovement = useMemo(() => {
    const out = {};
    for (const [grip, fit] of Object.entries(gripEstimates)) {
      const ref = gripBaselines[grip];
      if (!ref) continue;
      const imp = improvementForFit(fit, ref);
      if (imp) out[grip] = { ...imp, baselineDate: ref.date };
    }
    return out;
  }, [gripBaselines, gripEstimates]); // eslint-disable-line react-hooks/exhaustive-deps


  // ── Per-hand × per-grip baselines ──
  // Same seeding logic as gripBaselines but scoped to a single hand on
  // a single grip. Needed because Monod W' has high variance at small
  // N — if we compared each (grip,hand) fit against the POOLED global
  // baseline, cross-muscle (FDP vs FDS) and cross-hand asymmetries
  // contaminated the reference and produced phantom regressions on
  // whichever hand/grip combo started above the pooled mean. With a
  // per-(grip,hand) baseline, Δ% is an apples-to-apples comparison.
  // Threshold: ≥5 failures across ≥3 distinct durations per combo.
  const perHandGripBaselines = useMemo(() => {
    const out = {};
    const byKey = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!byKey[key]) byKey[key] = [];
      byKey[key].push(r);
    }
    for (const [key, reps] of Object.entries(byKey)) {
      reps.sort((a, b) => (a.date || "").localeCompare(b.date || ""));
      const acc = [];
      const durs = new Set();
      for (const r of reps) {
        acc.push(r);
        durs.add(r.target_duration);
        if (acc.length >= 5 && durs.size >= 3) {
          const fit = fitCF(acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg })));
          if (fit) out[key] = { date: acc[0].date, CF: fit.CF, W: fit.W };
          break;
        }
      }
    }
    return out;
  }, [history]);

  // Progress toward unlocking a per-grip (or per-grip × hand) baseline.
  // Returns {failures, distinctDurations, ready} so UI placeholders can
  // show "3 of 5 failures · 2 of 3 durations" instead of the static
  // "need ≥5 failures across ≥3 target durations" — the user can see
  // exactly how close they are to a stable comparison being unlocked.
  // Hand is optional; pass null/undefined to count across both hands.
  const FAIL_THRESHOLD = 5;
  const DUR_THRESHOLD  = 3;
  const baselineProgress = (grip, hand = null) => {
    let failures = 0;
    const durs = new Set();
    for (const r of history) {
      if (!r.failed || r.grip !== grip) continue;
      if (hand && r.hand !== hand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      failures += 1;
      if (r.target_duration) durs.add(r.target_duration);
    }
    return {
      failures,
      distinctDurations: durs.size,
      ready: failures >= FAIL_THRESHOLD && durs.size >= DUR_THRESHOLD,
    };
  };

  // ── Per-hand / per-grip CF & W' breakdown ──
  // Groups failure reps by grip × hand, fits Monod (F = CF + W'/T) for
  // each group, and reports CF and W' alongside their delta vs that
  // same (grip,hand)'s own baseline snapshot (see perHandGripBaselines
  // above for why per-hand-per-grip, not pooled). When a combo doesn't
  // yet qualify for a stable baseline, we still emit the row but with
  // cfPct=null so the UI can show current CF without a misleading Δ%.
  const perHandImprovement = useMemo(() => {
    const groups = {};
    for (const r of history) {
      if (!r.failed || !r.grip || !r.hand || r.hand === "Both") continue;
      if (r.avg_force_kg <= 0 || r.actual_time_s <= 0) continue;
      const key = `${r.grip}|${r.hand}`;
      if (!groups[key]) groups[key] = [];
      groups[key].push(r);
    }
    const result = {};
    for (const [key, reps] of Object.entries(groups)) {
      if (reps.length < 2) continue;
      const curPts = reps.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
      const cur    = fitCF(curPts);
      if (!cur) continue;
      const [grip, hand] = key.split("|");
      const ref = perHandGripBaselines[key];
      const cfPct = ref && ref.CF > 0 ? Math.round((cur.CF / ref.CF - 1) * 100) : null;
      const wPct  = ref && ref.W  > 0 ? Math.round((cur.W  / ref.W  - 1) * 100) : null;
      result[key] = {
        grip, hand, n: reps.length,
        cf: cur.CF, w: cur.W,
        cfPct, wPct,
        baselineDate: ref?.date ?? null,
        hasBaseline: !!ref,
      };
    }
    return Object.keys(result).length > 0 ? result : null;
  }, [history, perHandGripBaselines]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Curve parameters over time ──
  // For each date with failure data, refit Monod (F = CF + W'/T) using
  // all failures up to that date and record CF and W' directly. Plotted
  // on dual axes: CF (force units) tracks the slow aerobic asymptote,
  // W' (force·s) tracks the faster anaerobic capacity. Showing the two
  // raw fit parameters is more legible than the three derived zone %s.
  const cumulativeData = useMemo(() => {
    if (failures.length < 2) return [];
    const sorted = [...failures].sort((a, b) => a.date.localeCompare(b.date));
    const dates  = [...new Set(sorted.map(r => r.date))];
    return dates.map(date => {
      const upTo = sorted.filter(r => r.date <= date);
      if (upTo.length < 2) return null;
      const fit = fitCF(upTo.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
      if (!fit) return null;
      return {
        date,
        cf: toDisp(fit.CF, unit),
        w:  toDisp(fit.W,  unit),  // W' has units of force·s; same linear conversion as force
      };
    }).filter(Boolean);
  }, [failures, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip cumulative CF, used by CF Over Time when no grip filter
  // is active. Without this split, a Micro-heavy session pulls the
  // pooled CF curve down (FDP CF ~6 kg vs FDS CF ~25 kg) and looks
  // like a regression even though both grips might be improving in
  // isolation. Same scope rules as the pooled version: respects
  // selHand, requires ≥2 failures per grip up to each cumulative
  // date, returns one merged Recharts dataset keyed by date with
  // per-grip CF columns (e.g. {date, "Micro_cf": 6.1, "Crusher_cf": 24.3}).
  const cumulativeDataByGrip = useMemo(() => {
    if (selGrip) return null; // pooled chart already correct when scoped
    const byGrip = {};
    for (const r of history) {
      if (!r.failed || !r.grip) continue;
      if (selHand && r.hand !== selHand) continue;
      if (!(r.avg_force_kg > 0 && r.avg_force_kg < 500)) continue;
      if (!(r.actual_time_s > 0)) continue;
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    const grips = Object.keys(byGrip).filter(g => byGrip[g].length >= 2);
    if (grips.length < 2) return null; // single-grip user — pooled is fine
    const allDates = [...new Set(history.filter(r => r.failed).map(r => r.date))].sort();
    const rows = [];
    for (const date of allDates) {
      const row = { date };
      let any = false;
      for (const grip of grips) {
        const upTo = byGrip[grip].filter(r => r.date <= date);
        if (upTo.length < 2) continue;
        const fit = fitCF(upTo.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg })));
        if (!fit) continue;
        row[`${grip}_cf`] = toDisp(fit.CF, unit);
        any = true;
      }
      if (any) rows.push(row);
    }
    return { rows, grips };
  }, [history, selHand, selGrip, unit]); // eslint-disable-line react-hooks/exhaustive-deps

  // Note: AUC values used to live here (aucEstimate / aucBaseline /
  // aucHistory) backing a dedicated "Climbing Capacity · AUC" card.
  // That card was removed because the Capacity Improvement card
  // already shows each grip's Total % (which IS the AUC % gain) and
  // the CF & W' Over Time chart already shows trajectory. AUC math
  // still lives in computeAUC and is used by the recommendation
  // engine and ΔAUC ranking.

  // Fitted force-duration curve points for overlay.
  // Clipped at T≥5s — the Monod asymptote F = CF + W'/T diverges as
  // T→0, which exploded the Y-axis with ~6-figure forces. Below ~5s
  // we're outside the Monod validity range anyway (MVC ceiling, neural
  // rather than metabolic limitation), so nothing is lost by clipping.
  const F_D_T_MIN = 5;
  const curveData = useMemo(() => {
    if (!cfEstimate) return [];
    const { CF, W } = cfEstimate;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    return Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      return { x: t, y: toDisp(Math.max(CF + W / t, CF), unit) };
    });
  }, [cfEstimate, maxDur, unit]);

  // ── Three-exp shadow model ──
  // Per-grip prior pooled across hands (avoids cross-muscle scale
  // contamination — Crusher and Micro have wildly different absolute
  // forces). Fit once per history change; reused for any (hand, grip)
  // scope the user selects.
  const threeExpPriors = useMemo(() => buildThreeExpPriors(history), [history]);

  // Three-exp fit for the current (selHand, selGrip) scope. Uses the
  // same `failures` array that backs cfEstimate, so the fits are
  // directly comparable. When no grip is selected, we can't pick a
  // prior — fall back to no-shrinkage fit (which validation showed
  // loses to Monod by ~3% on aggregate, fine as a degenerate case).
  const threeExpFit = useMemo(() => {
    if (failures.length < 2) return null;
    const pts = failures.map(r => ({ T: r.actual_time_s, F: r.avg_force_kg }));
    const prior = selGrip ? (threeExpPriors.get(selGrip) || [0,0,0]) : [0,0,0];
    const lambda = selGrip ? THREE_EXP_LAMBDA_DEFAULT / Math.max(failures.length, 1) : 0;
    const amps = fitThreeExpAmps(pts, { prior, lambda });
    if (amps[0] + amps[1] + amps[2] <= 0) return null;
    return { amps, prior, lambda };
  }, [failures, selGrip, threeExpPriors]);

  // Predicted curve for chart overlay — same T grid as curveData so the
  // two lines align visually.
  const threeExpCurveData = useMemo(() => {
    if (!threeExpFit) return [];
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    return Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      const f = predForceThreeExp(threeExpFit.amps, t);
      return { x: t, y: toDisp(Math.max(f, 0), unit) };
    });
  }, [threeExpFit, maxDur, unit]);

  // Train RMSE on the failure points for both models — directional
  // signal of fit quality. NOTE: this is training RMSE not holdout, so
  // it's biased optimistic for both; the relative comparison between
  // the two models on the SAME data is still meaningful. Holdout
  // validation lives in the offline sim (validate_three_exp_v3.js).
  const modelRMSE = useMemo(() => {
    if (failures.length < 2 || !cfEstimate || !threeExpFit) return null;
    let mErr = 0, eErr = 0;
    for (const r of failures) {
      const T = r.actual_time_s, F = r.avg_force_kg;
      const mPred = cfEstimate.CF + cfEstimate.W / T;
      const ePred = predForceThreeExp(threeExpFit.amps, T);
      mErr += (mPred - F) ** 2;
      eErr += (ePred - F) ** 2;
    }
    return {
      monod:    Math.sqrt(mErr / failures.length),
      threeExp: Math.sqrt(eErr / failures.length),
      n:        failures.length,
    };
  }, [failures, cfEstimate, threeExpFit]);

  // Per-hand curves (L vs R overlay). Independent fits over the same
  // selGrip scope — lets users see hand asymmetry directly. Only
  // produced when both hands have enough failures to fit.
  const perHandCurves = useMemo(() => {
    const groups = { L: [], R: [] };
    for (const r of history) {
      if (!r.failed) continue;
      if (selGrip && r.grip !== selGrip) continue;
      if (r.avg_force_kg <= 0 || r.actual_time_s <= 0) continue;
      if (!(r.hand in groups)) continue;
      groups[r.hand].push({ x: 1 / r.actual_time_s, y: r.avg_force_kg });
    }
    const fitL = fitCF(groups.L);
    const fitR = fitCF(groups.R);
    if (!fitL || !fitR) return null;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const sample = (fit) => Array.from({ length: 80 }, (_, i) => {
      const t = F_D_T_MIN + ((tMax - F_D_T_MIN) / 79) * i;
      return { x: t, yKg: Math.max(fit.CF + fit.W / t, fit.CF) };
    });
    return { L: sample(fitL), R: sample(fitR) };
  }, [history, selGrip, maxDur]);

  // Bootstrap confidence band — resample failure points with
  // replacement, refit each sample, take 5th/95th percentile of
  // predicted force at each T. Band narrows as more data accumulates,
  // so users can see when the fit is actually trustworthy. Deterministic
  // RNG seeded from the data so the band is stable across renders.
  const confidenceBand = useMemo(() => {
    if (!failures || failures.length < 3) return null;
    const pts = failures.map(r => ({ x: 1 / r.actual_time_s, y: r.avg_force_kg }));
    const N = 150;
    const tMax = Math.max(maxDur, F_D_T_MIN + 10);
    const nSamples = 60;
    const ts = Array.from({ length: nSamples }, (_, i) =>
      F_D_T_MIN + ((tMax - F_D_T_MIN) / (nSamples - 1)) * i
    );
    let seed = (pts.length * 1000 + Math.floor(pts[0].x * 1e6)) >>> 0;
    const rng = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
    const curves = [];
    for (let i = 0; i < N; i++) {
      const sample = Array.from({ length: pts.length }, () => pts[Math.floor(rng() * pts.length)]);
      const fit = fitCF(sample);
      if (fit) curves.push(ts.map(t => Math.max(fit.CF + fit.W / t, fit.CF)));
    }
    if (curves.length < 20) return null;
    return ts.map((t, j) => {
      const vals = curves.map(c => c[j]).sort((a, b) => a - b);
      const p5  = vals[Math.floor(vals.length * 0.05)];
      const p95 = vals[Math.min(Math.floor(vals.length * 0.95), vals.length - 1)];
      return { x: t, lowKg: p5, highKg: p95 };
    });
  }, [failures, maxDur]);

  // Limiter zone (the zone that falls farthest below the F-D curve
  // predicted by the other two zones). Drives the saturated background
  // highlight on the F-D chart — visual echo of the SessionPlanner's
  // recommendation, so the chart and the planner tell the same story.
  const limiterZoneBounds = useMemo(() => {
    const lim = computeLimiterZone(history);
    if (!lim) return null;
    const zoneMap = {
      power:     { x1: 0,            x2: POWER_MAX,    color: C.red,    label: "Limiter: Power"    },
      strength:  { x1: POWER_MAX,    x2: STRENGTH_MAX, color: C.orange, label: "Limiter: Strength" },
      endurance: { x1: STRENGTH_MAX, x2: maxDur + 10,  color: C.blue,   label: "Limiter: Capacity" },
    };
    return zoneMap[lim.zone] || null;
  }, [history, maxDur]);

  // ── Relative strength helpers ──
  const useRel = relMode && bodyWeight != null && bodyWeight > 0;
  // Convert a kg force value to the display value (abs or relative)
  const fmtForce = (kg) => {
    if (kg == null) return "—";
    if (useRel) return fmt1(kg / bodyWeight);     // unitless ratio
    return fmtW(kg, unit);
  };
  const forceUnit = useRel ? "× BW" : unit;

  // Scatter data — recalculated when relMode toggles
  const successDotsRel = successes.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
  const failureDotsRel = failures.map(r => ({
    x: r.actual_time_s,
    y: useRel ? r.avg_force_kg / bodyWeight : toDisp(r.avg_force_kg, unit),
    date: r.date, grip: r.grip,
  }));
  const curveDataRel = curveData.map(d => ({
    x: d.x,
    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
  }));
  const threeExpCurveDataRel = threeExpCurveData.map(d => ({
    x: d.x,
    y: useRel && bodyWeight > 0 ? d.y / (bodyWeight * (unit === "lbs" ? KG_TO_LBS : 1)) : d.y,
  }));
  // Unit-transform helper for memos that hold values in kg (perHandCurves,
  // confidenceBand): converts to display unit or × BW depending on relMode.
  const kgToDisp = (kg) => useRel && bodyWeight > 0 ? kg / bodyWeight : toDisp(kg, unit);
  const perHandCurvesRel = perHandCurves ? {
    L: perHandCurves.L.map(d => ({ x: d.x, y: kgToDisp(d.yKg) })),
    R: perHandCurves.R.map(d => ({ x: d.x, y: kgToDisp(d.yKg) })),
  } : null;
  const confidenceBandRel = confidenceBand ? confidenceBand.map(d => ({
    x: d.x, low: kgToDisp(d.lowKg), high: kgToDisp(d.highKg),
  })) : null;
  const maxForceRel = Math.max(
    ...(useRel
      ? reps.map(r => r.avg_force_kg / bodyWeight)
      : reps.map(r => toDisp(r.avg_force_kg, unit))),
    useRel ? 0.5 : 40
  );

  // ── Zone breakdown (power / strength / capacity) ──
  // Buckets each rep by target_duration (what zone it was *training*),
  // not actual_time_s, so a failed Capacity-target hang that broke at
  // 60s still counts as a Capacity failure. Without this, Capacity
  // failures are structurally impossible when the target sits exactly
  // on the zone boundary (120s). Falls back to actual_time_s when a
  // rep has no target_duration (legacy data).
  //
  // Failure detection is computed live from actual_time_s < target_duration
  // to match the red/green rendering in History. The stored r.failed flag
  // only flips on auto-failure (Tindeq force-drop); manually-ended short
  // hangs leave r.failed=false even though the rep clearly failed.
  const zones = useMemo(() => {
    const zoneStats = (lo, hi) => {
      const z = reps.filter(r => {
        const t = r.target_duration > 0 ? r.target_duration : r.actual_time_s;
        return t >= lo && t < hi;
      });
      const f = z.filter(r => {
        if (r.target_duration > 0) return r.actual_time_s < r.target_duration;
        return r.failed;
      }).length;
      return { total: z.length, failures: f, successes: z.length - f,
               failRate: z.length > 0 ? f / z.length : null };
    };
    return {
      power:     { ...zoneStats(0, POWER_MAX),                label: "Power",     color: C.red,    desc: "0–20s",    system: "Phosphocreatine",  tau: `τ₁ ≈ ${PHYS_MODEL_DEFAULT.tauR.fast}s`   },
      strength:  { ...zoneStats(POWER_MAX, STRENGTH_MAX),     label: "Strength",  color: C.orange, desc: "20–120s",  system: "Glycolytic",       tau: `τ₂ ≈ ${PHYS_MODEL_DEFAULT.tauR.medium}s` },
      endurance: { ...zoneStats(STRENGTH_MAX, Infinity),      label: "Capacity",  color: C.blue,   desc: "120s+",    system: "Oxidative",        tau: `τ₃ ≈ ${PHYS_MODEL_DEFAULT.tauR.slow}s`   },
    };
  }, [reps]);

  // ── Personal response calibration ──
  // Fits CF/W′ response rates per zone from the user's own history and
  // shrinks toward PROTOCOL_RESPONSE. Used by the recommendation engine
  // instead of the raw prior so the engine's "what grows AUC fastest"
  // adapts to this climber's actual measured response.
  const personalResponse = useMemo(
    () => computePersonalResponse(history),
    [history]
  );

  // ── Unified training recommendation ──
  // Primary signal: marginal AUC gain. For each protocol (power /
  // strength / capacity), take the PERSONAL response rates (prior if
  // thin data, blended with observed otherwise), project ΔCF and ΔW′
  // at current parameter values, and integrate to a projected ΔAUC
  // over the climbing-relevant 10–120s window. Pick the protocol with
  // the largest projected ΔAUC.
  //
  // Secondary: Monod cross-zone residual (limiter) and zone coverage,
  // kept as diagnostics alongside the ΔAUC ranking so users can see
  // where the curve is lopsided and which zones are under-trained.
  const recommendation = useMemo(() => {
    // Limiter (curve shape) — kept as secondary diagnostic
    const limiter = computeLimiterZone(history);
    const limiterKey  = limiter?.zone ?? null;
    const limiterGrip = limiter?.grip ?? null;

    // Coverage (training distribution) — kept as tertiary diagnostic
    const coverage = computeZoneCoverage(history, activities);
    const coverageKey = coverage.total > 0 ? coverage.recommended : null;

    // Prefer a grip-specific fit when the user has picked a grip in
    // the Analysis filter: FDP (pinch / open-hand rollers) and FDS
    // (crusher) are separate muscles with separate curves, so the
    // recommendation should follow whichever muscle is in focus. Fall
    // back to the pooled liveEstimate when no grip is selected, and
    // finally to cfEstimate (the filter-dependent display fit) as a
    // last resort. Either way the engine matches the Setup view.
    const gripFit = selGrip ? gripEstimates[selGrip] : null;
    const fitForRec = gripFit ?? liveEstimate ?? cfEstimate;
    if (!fitForRec) {
      const fallbackKey = limiterKey ?? coverageKey;
      if (!fallbackKey) return null;
      const d = ZONE_DETAILS[fallbackKey];
      return {
        key: fallbackKey,
        title: d.title, color: d.color,
        insight: `Need 2+ failures across different durations to rank protocols by projected AUC gain. For now: ${d.caption}`,
        gains: null, aucGain: null,
        limiterKey, limiterGrip,
        coverageKey,
        agree: true,
        responseSource: null,
        coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
      };
    }

    // Primary ΔAUC ranking — delegated to the shared helper so per-grip
    // recs (gripRecs below) compute the same way.
    const base = buildRecFromFit(fitForRec, personalResponse, unit);

    // Does the Monod limiter agree with the ΔAUC winner?
    const agree = !limiterKey || limiterKey === base.key;

    return {
      ...base,
      limiterKey, limiterGrip,
      coverageKey,
      agree,
      coverageZoneLabel: coverageKey ? ZONE_DETAILS[coverageKey].title.replace("Train ", "") : null,
    };
  }, [liveEstimate, gripEstimates, selGrip, history, activities, unit, personalResponse]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip recommendations — one rec per grip with a fit in
  // `gripEstimates`. Used to render side-by-side Micro/Crusher cards
  // in "Next Session Focus" when no single grip is selected, so the
  // user can see the separate verdicts for the two different muscles
  // (FDP for Micro, FDS for Crusher).
  const gripRecs = useMemo(() => {
    const out = {};
    for (const [grip, fit] of Object.entries(gripEstimates)) {
      const rec = buildRecFromFit(fit, personalResponse, unit);
      if (rec) out[grip] = { ...rec, grip, CF: fit.CF, W: fit.W, n: fit.n };
    }
    return out;
  }, [gripEstimates, personalResponse, unit]);

  const unexplored = Object.entries(zones)
    .filter(([, z]) => z.total === 0)
    .map(([, z]) => z.label);

  // Custom tooltip for scatter chart
  const ScatterTooltip = ({ active, payload, unit: tipUnit }) => {
    if (!active || !payload?.[0]) return null;
    const d = payload[0].payload;
    const u = tipUnit || unit;
    return (
      <div style={{ background: C.card, border: `1px solid ${C.border}`, padding: "8px 12px", borderRadius: 8, fontSize: 12 }}>
        <div style={{ fontWeight: 700, marginBottom: 4 }}>{d.date}{d.grip ? ` · ${d.grip}` : ""}</div>
        <div>Duration: <b>{fmt1(d.x)}s</b></div>
        <div>Force: <b>{fmt1(d.y)} {u}</b></div>
      </div>
    );
  };

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 4px", fontSize: 22 }}>Force-Duration Analysis</h2>
      <p style={{ margin: "0 0 16px", fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
        Where failures fall on the fatigue curve reveals which energy system is your limiter — and what to train next.
      </p>

      {/* Filters */}
      <Card style={{ marginBottom: 16 }}>
        <div style={{ display: "flex", gap: 8, flexWrap: "wrap", marginBottom: grips.length ? 10 : 0 }}>
          {["L", "R"].map(h => (
            <button key={h} onClick={() => setSelHand(h)} style={{
              padding: "6px 18px", borderRadius: 20, cursor: "pointer",
              fontWeight: 600, border: "none",
              background: selHand === h ? C.purple : C.border,
              color: selHand === h ? "#fff" : C.muted,
            }}>{h === "L" ? "Left" : "Right"}</button>
          ))}
        </div>
        {grips.length > 0 && (
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button onClick={() => setSelGrip("")} style={{
              padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
              background: !selGrip ? C.orange : C.border, color: !selGrip ? "#fff" : C.muted,
            }}>All Grips</button>
            {grips.map(g => (
              <button key={g} onClick={() => setSelGrip(g)} style={{
                padding: "4px 12px", borderRadius: 20, fontSize: 12, cursor: "pointer", border: "none",
                background: selGrip === g ? C.orange : C.border, color: selGrip === g ? "#fff" : C.muted,
              }}>{g}</button>
            ))}
          </div>
        )}
      </Card>

      {/* ── 1RM PR tracker ── */}
      {(() => {
        const rmReps = activities.filter(a => a.type === "oneRM" && a.weight_kg > 0);
        if (rmReps.length === 0) return null;

        // Build per-grip datasets
        const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
        const allDates = [...new Set(rmReps.map(a => a.date))].sort();
        const gripData = {};
        for (const g of RM_GRIPS) {
          const byDate = {};
          for (const a of rmReps.filter(r => r.grip === g || (!r.grip && g === "Micro"))) {
            if (!byDate[a.date] || a.weight_kg > byDate[a.date]) byDate[a.date] = a.weight_kg;
          }
          if (Object.keys(byDate).length > 0) {
            gripData[g] = {
              pr: Math.max(...Object.values(byDate)),
              latest: byDate[allDates.filter(d => byDate[d]).at(-1)] ?? 0,
              byDate,
            };
          }
        }
        if (Object.keys(gripData).length === 0) return null;

        // Merge into chart data — one row per date, one column per grip
        const chartData = allDates.map(date => {
          const row = { date };
          for (const g of RM_GRIPS) {
            if (gripData[g]?.byDate[date]) row[g] = toDisp(gripData[g].byDate[date], unit);
          }
          return row;
        });
        const hasChart = chartData.length >= 2;

        return (
          <Card style={{ marginBottom: 16, border: `1px solid ${"#e05560"}30` }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 10 }}>🏋️ 1RM Progress</div>

            {/* PR summary per grip */}
            <div style={{ display: "flex", gap: 16, marginBottom: 12 }}>
              {RM_GRIPS.filter(g => gripData[g]).map(g => {
                const { pr, latest } = gripData[g];
                const isPR = latest >= pr;
                return (
                  <div key={g}>
                    <div style={{ fontSize: 11, color: C.muted }}>{g} PR</div>
                    <div style={{ fontSize: 20, fontWeight: 800, color: GRIP_COLORS[g], lineHeight: 1.1 }}>
                      {fmtW(pr, unit)} {unit}
                    </div>
                    {isPR && chartData.length > 1 && (
                      <div style={{ fontSize: 11, color: GRIP_COLORS[g], fontWeight: 600 }}>🎉 PR today!</div>
                    )}
                  </div>
                );
              })}
            </div>

            {hasChart && (
              <ResponsiveContainer width="100%" height={110}>
                <LineChart data={chartData} margin={{ top: 4, right: 8, bottom: 0, left: 0 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                  <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }}
                    tickFormatter={d => d.slice(5)} interval="preserveStartEnd" />
                  <YAxis hide domain={["auto", "auto"]} />
                  <Tooltip
                    contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 8, fontSize: 12 }}
                    formatter={(v, name) => [`${fmt1(v)} ${unit}`, name]}
                    labelFormatter={d => d}
                  />
                  {RM_GRIPS.filter(g => gripData[g]).map(g => (
                    <Line key={g} type="monotone" dataKey={g}
                      stroke={GRIP_COLORS[g]} strokeWidth={2.5}
                      dot={{ r: 3, fill: GRIP_COLORS[g] }} connectNulls />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            )}
            <div style={{ fontSize: 11, color: C.muted, marginTop: 8 }}>
              Max single effort · logged pre-climb
            </div>
          </Card>
        );
      })()}

      {/* ── Capacity Improvement summary ──
          When no grip filter is active AND ≥2 grips have fits, split
          the card into per-grip sections so Micro (FDP) and Crusher
          (FDS) each show their own Δ% against the shared baseline. */}
      {baseline && (improvement || Object.keys(gripImprovement).length > 0) && (() => {
        // Reusable row renderer — one header + one Power/Strength/Capacity
        // row of three Δ% tiles.
        const renderRow = (label, imp) => (
          <div style={{ marginBottom: 12 }}>
            <div style={{ display: "flex", alignItems: "baseline", justifyContent: "space-between", marginBottom: 8 }}>
              {label && (
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>
                  {label}
                </div>
              )}
              <div style={{ display: "flex", alignItems: "baseline", gap: 6, marginLeft: "auto" }}>
                <div style={{ fontSize: 26, fontWeight: 900, color: imp.total >= 0 ? C.green : C.red, lineHeight: 1 }}>
                  {imp.total >= 0 ? "+" : ""}{imp.total}%
                </div>
                <div style={{ fontSize: 11, color: C.muted }}>total</div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 8 }}>
              {[
                { label: "⚡ Power",     val: imp.power,     color: C.red    },
                { label: "💪 Strength",  val: imp.strength,  color: C.orange },
                { label: "🏔️ Capacity",  val: imp.endurance, color: C.blue   },
              ].map(({ label, val, color }) => (
                <div key={label} style={{
                  flex: 1, background: C.bg, borderRadius: 10, padding: "8px 6px", textAlign: "center",
                  border: `1px solid ${color}30`,
                }}>
                  <div style={{ fontSize: 10, color: C.muted, marginBottom: 3 }}>{label}</div>
                  <div style={{ fontSize: 17, fontWeight: 800, color: val >= 0 ? color : C.red }}>
                    {val >= 0 ? "+" : ""}{val}%
                  </div>
                </div>
              ))}
            </div>
          </div>
        );

        // perGripMode is keyed off having multiple per-grip CURRENT fits,
        // not improvements — so users mid-data-collection see an honest
        // "early days" message instead of falling back to the pooled
        // improvement number, which would re-introduce the same cross-
        // muscle artifact (Crusher's high-CF reps inflating Micro's
        // baseline) that motivated the per-grip split in the first
        // place.
        const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
        const gripImpEntries = Object.entries(gripImprovement);

        // When a grip filter is active, cfEstimate is scoped to that
        // grip AND to selHand (via the `failures` filter). Comparing
        // it against a baseline of a different scope produces an
        // apples-to-oranges comparison. We have three baselines to
        // pick from, listed by tightness:
        //   1. perHandGripBaselines[grip|hand]  — exact scope match
        //   2. gripBaselines[grip]               — pools hands, per-grip
        //   3. (fall through to early-days)
        //
        // To keep the comparison apples-to-apples, the LHS (current
        // fit) is recomputed at the SAME scope as whichever baseline
        // we end up using, instead of always using the hand-scoped
        // cfEstimate. Without this, a (Micro, Left) current vs
        // (Micro pooled-hands) baseline still mixes hand asymmetry
        // into the Δ% — same flavor as the cross-muscle artifact,
        // just smaller.
        let scopedImp = null;
        let scopedBaselineDate = null;
        let scopedScopeLabel = null;
        if (selGrip) {
          const phgKey = selHand && selHand !== "Both" ? `${selGrip}|${selHand}` : null;
          const phgRef = phgKey ? perHandGripBaselines[phgKey] : null;
          const gRef   = gripBaselines[selGrip];
          if (phgRef) {
            // Tightest match: use cfEstimate (already hand+grip scoped) vs
            // per-hand-grip baseline.
            scopedImp = improvementForFit(cfEstimate, phgRef);
            scopedBaselineDate = phgRef.date;
            scopedScopeLabel = `${selGrip} · ${selHand === "L" ? "Left" : "Right"}`;
          } else if (gRef && gripEstimates[selGrip]) {
            // Fallback: per-hand-grip baseline doesn't exist yet, but the
            // grip-pooled baseline does. Use the grip-pooled CURRENT fit
            // (gripEstimates[selGrip], which pools both hands) so both
            // sides of the comparison live in the same scope.
            scopedImp = improvementForFit(gripEstimates[selGrip], gRef);
            scopedBaselineDate = gRef.date;
            scopedScopeLabel = `${selGrip} (both hands)`;
          }
        }

        return (
          <Card style={{ marginBottom: 16, border: `1px solid ${C.purple}40` }}>
            <div style={{ display: "flex", justifyContent: "space-between", alignItems: "flex-start", marginBottom: 12 }}>
              <div style={{ fontSize: 14, fontWeight: 700 }}>Capacity Improvement</div>
              {!perGripMode && !selGrip && (
                <div style={{ fontSize: 11, color: C.muted }}>since {baseline.date}</div>
              )}
              {selGrip && scopedImp && (
                <div style={{ fontSize: 11, color: C.muted }}>since {scopedBaselineDate}</div>
              )}
            </div>
            {perGripMode ? (
              gripImpEntries.length > 0 ? (
                <>
                  {gripImpEntries.map(([grip, imp], i, arr) => (
                    <div key={grip} style={{
                      paddingBottom: i < arr.length - 1 ? 12 : 0,
                      borderBottom: i < arr.length - 1 ? `1px solid ${C.border}` : "none",
                      marginBottom: i < arr.length - 1 ? 12 : 0,
                    }}>
                      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 4 }}>
                        <div style={{ fontSize: 12, fontWeight: 700, color: C.text }}>{grip}</div>
                        <div style={{ fontSize: 10, color: C.muted }}>since {imp.baselineDate}</div>
                      </div>
                      {renderRow(null, imp)}
                    </div>
                  ))}
                  {/* Show an "early days" placeholder for any grip with a
                      current fit but no qualifying per-grip baseline yet,
                      so the user knows we're aware of it and waiting on
                      more data rather than silently dropping it. */}
                  {Object.keys(gripEstimates).filter(g => !gripImprovement[g]).map(grip => {
                    const p = baselineProgress(grip);
                    return (
                      <div key={grip} style={{
                        paddingTop: 12, marginTop: 12, borderTop: `1px solid ${C.border}`,
                        fontSize: 11, color: C.muted, lineHeight: 1.5,
                      }}>
                        <b style={{ color: C.text }}>{grip}</b>{" · "}
                        <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text }}>
                          {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                        </span>
                        {" · "}
                        <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text }}>
                          {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                        </span>
                      </div>
                    );
                  })}
                </>
              ) : (
                <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                  Need ≥5 failures across ≥3 target durations <i>per grip</i> to seed a stable per-grip baseline. Until then the comparison is too noisy to be useful (small-sample Monod fits have high W′ variance, which inflates predicted force at short durations).
                </div>
              )
            ) : selGrip ? (
              scopedImp ? (
                <>
                  <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                    {scopedScopeLabel} vs {scopedScopeLabel} baseline
                  </div>
                  {renderRow(null, scopedImp)}
                </>
              ) : (() => {
                const handForProg = selHand && selHand !== "Both" ? selHand : null;
                const p = baselineProgress(selGrip, handForProg);
                const handLabel = handForProg ? (handForProg === "L" ? "Left" : "Right") : null;
                return (
                  <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                    Need ≥{FAIL_THRESHOLD} failures across ≥{DUR_THRESHOLD} target durations on <b>{selGrip}</b>{handLabel ? ` (${handLabel})` : ""} for a fair apples-to-apples comparison. Pooled global baseline isn't shown here — it mixes muscle groups (FDP pinch vs FDS crush) and would produce misleading Δ%.
                    <div style={{ marginTop: 6, fontSize: 11 }}>
                      Progress:{" "}
                      <span style={{ color: p.failures >= FAIL_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                        {Math.min(p.failures, FAIL_THRESHOLD)} of {FAIL_THRESHOLD} failures
                      </span>
                      {" · "}
                      <span style={{ color: p.distinctDurations >= DUR_THRESHOLD ? C.green : C.text, fontWeight: 600 }}>
                        {Math.min(p.distinctDurations, DUR_THRESHOLD)} of {DUR_THRESHOLD} durations
                      </span>
                    </div>
                  </div>
                );
              })()
            ) : improvement ? (
              renderRow(null, improvement)
            ) : null}
          </Card>
        );
      })()}

      {/* ── Curve parameters over time ── */}
      {cumulativeData.length >= 2 && (() => {
        // When no grip filter is active and ≥2 grips have data, split
        // into per-grip lines. The pooled CF can otherwise drift down
        // on Micro-heavy sessions (FDP CF ~6 kg dragging the average
        // away from FDS CF ~25 kg) and read as a regression even when
        // both grips are individually improving — same cross-muscle
        // artifact the Capacity Improvement card was fixed for.
        const splitMode = cumulativeDataByGrip && cumulativeDataByGrip.rows.length >= 2;
        const GRIP_COLORS = { Micro: "#e05560", Crusher: C.orange };
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>CF Over Time</div>
            <div style={{ fontSize: 12, color: C.muted, marginBottom: 10 }}>
              {splitMode
                ? <>Critical force per grip — recomputed after every failure. Split avoids mixing FDP (Micro) and FDS (Crusher) CF on the same line.</>
                : <>Your critical force — the sustainable aerobic asymptote of the force-duration fit — recomputed after every failure.</>}
            </div>
            <ResponsiveContainer width="100%" height={200}>
              <LineChart data={splitMode ? cumulativeDataByGrip.rows : cumulativeData} margin={{ top: 6, right: 14, bottom: 28, left: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
                <XAxis dataKey="date" tick={{ fill: C.muted, fontSize: 9 }} angle={-30} textAnchor="end" interval="preserveStartEnd"
                  label={{ value: "Date", position: "insideBottom", offset: -18, fill: C.muted, fontSize: 11 }} />
                <YAxis tick={{ fill: C.blue, fontSize: 11 }} width={46}
                  label={{ value: `CF (${unit})`, angle: -90, position: "insideLeft", fill: C.blue, fontSize: 11 }} />
                <Tooltip
                  contentStyle={{ background: C.card, border: `1px solid ${C.border}`, fontSize: 12 }}
                  formatter={(val, name) => [fmt1(val), name]}
                />
                {splitMode
                  ? cumulativeDataByGrip.grips.map(g => (
                      <Line key={g} dataKey={`${g}_cf`} stroke={GRIP_COLORS[g] || C.blue}
                        strokeWidth={2} dot={false} name={`${g} CF (${unit})`} connectNulls />
                    ))
                  : <Line dataKey="cf" stroke={C.blue} strokeWidth={2} dot={false} name={`CF (${unit})`} />}
              </LineChart>
            </ResponsiveContainer>
          </Card>
        );
      })()}

      {/* ── Per-hand / per-grip CF breakdown ── */}
      {perHandImprovement && (() => {
        // Group rows by grip
        const byGrip = {};
        for (const row of Object.values(perHandImprovement)) {
          if (!byGrip[row.grip]) byGrip[row.grip] = {};
          byGrip[row.grip][row.hand] = row;
        }
        // Small helper — colour deltas green/red with a neutral muted
        // band for near-zero noise (|delta| < ~2% reads as "flat").
        const deltaColour = (pct) => pct > 2 ? C.green : pct < -2 ? C.red : C.muted;
        const anyBaselined = Object.values(perHandImprovement).some(r => r.hasBaseline);
        return (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Per-Hand Critical Force</div>
            <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
              Critical force (asymptotic sustainable load) fit to your rep-1 failures per grip × hand.
              Δ% compares each hand to <i>its own</i> earliest qualifying snapshot (≥5 failures across ≥3 target durations) — avoids mixing FDP/FDS or L/R baselines.
            </div>
            {Object.entries(byGrip).map(([grip, hands]) => (
              <div key={grip} style={{ marginBottom: 14 }}>
                <div style={{ fontSize: 12, fontWeight: 700, color: C.text, marginBottom: 8 }}>{grip}</div>
                {["L", "R"].filter(h => hands[h]).map(h => {
                  const row = hands[h];
                  return (
                    <div key={h} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                      <div style={{ width: 28, fontSize: 12, fontWeight: 700, color: C.muted, flexShrink: 0 }}>
                        {h === "L" ? "←L" : "R→"}
                      </div>
                      <div style={{
                        flex: 1, background: C.bg, borderRadius: 8, padding: "6px 8px", textAlign: "center",
                        border: `1px solid ${C.blue}25`,
                      }}>
                        <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.3 }}>CF</div>
                        <div style={{ fontSize: 14, fontWeight: 700, color: C.blue }}>
                          {fmtW(row.cf, unit)} <span style={{ fontSize: 10, color: C.muted, fontWeight: 500 }}>{unit}</span>
                        </div>
                        {row.cfPct != null ? (
                          <div style={{ fontSize: 10, fontWeight: 600, color: deltaColour(row.cfPct) }}>
                            {row.cfPct > 0 ? "+" : ""}{row.cfPct}%
                            <span style={{ color: C.muted, fontWeight: 500 }}> · since {row.baselineDate}</span>
                          </div>
                        ) : (() => {
                          const p = baselineProgress(grip, h);
                          return (
                            <div style={{ fontSize: 10, fontWeight: 500, color: C.muted, fontStyle: "italic" }}>
                              early days · {Math.min(p.failures, FAIL_THRESHOLD)}/{FAIL_THRESHOLD} fails · {Math.min(p.distinctDurations, DUR_THRESHOLD)}/{DUR_THRESHOLD} durs
                            </div>
                          );
                        })()}
                      </div>
                    </div>
                  );
                })}
              </div>
            ))}
            {!anyBaselined && (
              <div style={{ fontSize: 11, color: C.muted, marginTop: 4, fontStyle: "italic" }}>
                No hand has enough data yet for a stable per-hand baseline — showing current CF without Δ%.
              </div>
            )}
          </Card>
        );
      })()}

      {reps.length === 0 ? (
        <Card>
          <div style={{ textAlign: "center", padding: "32px 0", color: C.muted }}>
            <div style={{ fontSize: 40, marginBottom: 12 }}>📊</div>
            <div>No session data yet for this selection.</div>
            <div style={{ fontSize: 12, marginTop: 8 }}>Complete some sessions to see your force-duration curve.</div>
          </div>
        </Card>
      ) : (<>

        {/* ── Force-Duration scatter ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 4 }}>
            <div style={{ fontSize: 14, fontWeight: 700 }}>Force vs. Duration</div>
            {bodyWeight != null && (
              <div style={{ display: "flex", gap: 4 }}>
                {["Absolute", "Relative"].map(mode => (
                  <button key={mode} onClick={() => setRelMode(mode === "Relative")} style={{
                    padding: "3px 10px", borderRadius: 12, fontSize: 11, cursor: "pointer", border: "none", fontWeight: 600,
                    background: (mode === "Relative") === relMode ? C.purple : C.border,
                    color: (mode === "Relative") === relMode ? "#fff" : C.muted,
                  }}>{mode}</button>
                ))}
              </div>
            )}
          </div>
          <div style={{ display: "flex", gap: 16, fontSize: 11, color: C.muted, marginBottom: 10, flexWrap: "wrap" }}>
            <span><span style={{ color: C.green }}>●</span> Completed</span>
            <span><span style={{ color: C.red }}>●</span> Auto-failed</span>
            {cfEstimate && <span><span style={{ color: C.purple }}>―</span> F-D curve</span>}
            {cfEstimate && <span><span style={{ color: C.purple }}>╌</span> Critical Force</span>}
            {threeExpCurveDataRel.length > 0 && <span title="Experimental shadow model — not driving prescriptions"><span style={{ color: C.yellow }}>╌</span> 3-exp (shadow)</span>}
            {confidenceBandRel && <span><span style={{ color: C.purple, opacity: 0.4 }}>▓</span> 90% band</span>}
            {perHandCurvesRel && <span><span style={{ color: C.blue }}>―</span> L &nbsp;<span style={{ color: C.orange }}>―</span> R</span>}
            {limiterZoneBounds && <span style={{ color: limiterZoneBounds.color, fontWeight: 600 }}>● {limiterZoneBounds.label}</span>}
            {useRel && <span style={{ color: C.purple }}>× bodyweight ({fmtW(bodyWeight, unit)} {unit})</span>}
          </div>
          <ResponsiveContainer width="100%" height={260}>
            <ComposedChart margin={{ top: 10, right: 16, bottom: 28, left: 0 }}>
              <CartesianGrid strokeDasharray="3 3" stroke={C.border} />
              <XAxis
                type="number" dataKey="x"
                domain={[0, maxDur + 10]}
                label={{ value: "Duration (s)", position: "insideBottom", offset: -16, fill: C.muted, fontSize: 11 }}
                tick={{ fill: C.muted, fontSize: 11 }}
              />
              <YAxis
                type="number"
                domain={[0, Math.ceil(maxForceRel * 1.15 / (useRel ? 0.1 : 10)) * (useRel ? 0.1 : 10)]}
                tick={{ fill: C.muted, fontSize: 11 }}
                unit={useRel ? "" : ` ${unit}`}
                width={42}
              />
              <Tooltip content={<ScatterTooltip unit={forceUnit} />} />
              {/* Zone backgrounds — neutral tint for non-limiter zones,
                  extra saturation on the limiter zone so the chart
                  echoes the SessionPlanner recommendation. */}
              <ReferenceArea x1={0}            x2={POWER_MAX}    fill={C.red}    fillOpacity={limiterZoneBounds?.x1 === 0            ? 0.22 : 0.07} />
              <ReferenceArea x1={POWER_MAX}    x2={STRENGTH_MAX} fill={C.orange} fillOpacity={limiterZoneBounds?.x1 === POWER_MAX    ? 0.22 : 0.07} />
              <ReferenceArea x1={STRENGTH_MAX} x2={maxDur + 10}  fill={C.blue}   fillOpacity={limiterZoneBounds?.x1 === STRENGTH_MAX ? 0.22 : 0.07} />
              {/* Bootstrap confidence band — subtle dashed bounds
                  showing 5th/95th percentile of resampled fits. Narrows
                  as more failure data accumulates. */}
              {confidenceBandRel && (
                <Line data={confidenceBandRel} dataKey="low"  stroke={C.purple} strokeOpacity={0.35}
                      strokeDasharray="3 3" strokeWidth={1} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {confidenceBandRel && (
                <Line data={confidenceBandRel} dataKey="high" stroke={C.purple} strokeOpacity={0.35}
                      strokeDasharray="3 3" strokeWidth={1} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {/* Critical Force horizontal line */}
              {cfEstimate && (
                <ReferenceLine
                  y={useRel ? cfEstimate.CF / bodyWeight : toDisp(cfEstimate.CF, unit)}
                  stroke={C.purple} strokeDasharray="6 3" strokeWidth={1.5}
                  label={{ value: `CF ${fmtForce(cfEstimate.CF)} ${forceUnit}`, position: "insideTopRight", fill: C.purple, fontSize: 10 }}
                />
              )}
              {/* Per-hand L vs R overlay curves */}
              {perHandCurvesRel && (
                <Line data={perHandCurvesRel.L} dataKey="y" stroke={C.blue}   strokeWidth={1.5}
                      strokeOpacity={0.75} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {perHandCurvesRel && (
                <Line data={perHandCurvesRel.R} dataKey="y" stroke={C.orange} strokeWidth={1.5}
                      strokeOpacity={0.75} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {/* Main fitted force-duration curve */}
              {curveDataRel.length > 0 && (
                <Line data={curveDataRel} dataKey="y" stroke={C.purple} strokeWidth={2} dot={false} legendType="none" isAnimationActive={false} />
              )}
              {/* Three-exp shadow model overlay — dashed yellow.
                  Validated offline to beat Monod by ~4% RMSE at λ=100;
                  not yet driving prescriptions. */}
              {threeExpCurveDataRel.length > 0 && (
                <Line data={threeExpCurveDataRel} dataKey="y" stroke={C.yellow}
                      strokeWidth={1.5} strokeDasharray="5 4" dot={false}
                      legendType="none" isAnimationActive={false} />
              )}
              {/* Completed reps */}
              <Scatter data={successDotsRel} fill={C.green} opacity={0.85} name="Completed" />
              {/* Failed reps */}
              <Scatter data={failureDotsRel} fill={C.red} opacity={0.95} name="Auto-failed" />
            </ComposedChart>
          </ResponsiveContainer>
          {/* Zone labels */}
          <div style={{ display: "flex", justifyContent: "space-around", marginTop: 4, fontSize: 10, color: C.muted }}>
            <span style={{ color: C.red }}>⚡ Power &lt;20s</span>
            <span style={{ color: C.orange }}>💪 Strength 20–120s</span>
            <span style={{ color: C.blue }}>🔄 Capacity 120s+</span>
          </div>
          {/* Three-exp shadow-model diagnostic — running comparison of
              fit quality. Training RMSE on the displayed failures, so
              biased optimistic for both models, but the relative
              comparison on the SAME data is meaningful. Holdout
              validation lives in the offline sim. The model is in
              shadow mode: visible in the chart and here, but
              prescribedLoad still uses Monod. */}
          {modelRMSE && (
            <div style={{ marginTop: 8, padding: "6px 8px", background: C.bg, borderRadius: 6, fontSize: 10, color: C.muted, lineHeight: 1.5 }}>
              <span style={{ color: C.yellow, fontWeight: 600 }}>3-exp shadow</span>
              {" · Monod RMSE "}
              <span style={{ color: C.text }}>{modelRMSE.monod.toFixed(2)} {unit === "lbs" ? "kg" : "kg"}</span>
              {" · 3-exp RMSE "}
              <span style={{ color: modelRMSE.threeExp < modelRMSE.monod ? C.green : C.text }}>
                {modelRMSE.threeExp.toFixed(2)} kg
              </span>
              {" · N="}{modelRMSE.n}
              {" · "}
              <span style={{ fontStyle: "italic" }}>
                training fit, not holdout — prescriptions still use Monod
              </span>
            </div>
          )}
        </Card>

        {/* ── Critical Force card ──
            When no grip filter is active AND ≥2 grips have fits, render
            one card per grip (Micro, Crusher) so each muscle's CF / W′
            and curve shape are read independently. Otherwise fall back
            to the pooled / selGrip-scoped single card. */}
        {(() => {
          // Shared renderer for the CF/W′/curve-shape body of the card.
          const renderCFBody = (fit) => {
            const ratio = fit.CF > 0 ? fit.W / fit.CF : 0;
            const pct   = Math.min(100, Math.max(0, (ratio / 120) * 100));
            const { shape, color: sc, caption } =
              ratio < 30  ? { shape: "CF-dominant (Flat)",    color: C.blue,   caption: "Your curve is flat — CF is high relative to W′. Your sustainable force is well developed; your finite anaerobic reserve is small." } :
              ratio < 80  ? { shape: "Balanced",              color: C.green,  caption: "CF and W′ are roughly proportional — neither the aerobic asymptote nor the anaerobic reserve dominates the curve." } :
                            { shape: "W′-dominant (Steep)",   color: C.orange, caption: "Your curve is steep — W′ is large relative to CF. Your short-burst capacity is well developed; your sustainable asymptote is lower." };
            return (
              <>
                <div style={{ display: "flex", gap: 0, marginBottom: 12 }}>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Critical Force (CF)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.purple, lineHeight: 1 }}>
                      {fmtW(fit.CF, unit)}
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit} · max sustainable</div>
                  </div>
                  <div style={{ flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 4 }}>Anaerobic Capacity (W′)</div>
                    <div style={{ fontSize: 32, fontWeight: 800, color: C.orange, lineHeight: 1 }}>
                      {fmtW(fit.W, unit)}·s
                    </div>
                    <div style={{ fontSize: 11, color: C.muted, marginTop: 4 }}>{unit}·s · finite reserve above CF</div>
                  </div>
                </div>
                <div style={{ marginBottom: 12 }}>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 11, color: C.muted, marginBottom: 5 }}>
                    <span>Curve Shape</span>
                    <span style={{ color: sc, fontWeight: 700 }}>{shape}</span>
                  </div>
                  <div style={{ position: "relative", height: 8, borderRadius: 4, overflow: "hidden",
                    background: "linear-gradient(to right, #3b82f6, #22c55e, #e07a30)" }}>
                    <div style={{
                      position: "absolute", top: "50%", left: `${pct}%`,
                      transform: "translate(-50%, -50%)",
                      width: 14, height: 14, borderRadius: 7,
                      background: "#fff", border: `2px solid ${sc}`,
                      boxShadow: "0 0 4px rgba(0,0,0,0.4)",
                    }} />
                  </div>
                  <div style={{ display: "flex", justifyContent: "space-between", fontSize: 9, color: C.muted, marginTop: 3 }}>
                    <span>Flat (CF dominant)</span><span>Steep (W′ dominant)</span>
                  </div>
                  <div style={{ fontSize: 11, color: C.muted, marginTop: 6, lineHeight: 1.5 }}>
                    {caption} See <b>Next Session Focus</b> above for what to train next.
                  </div>
                </div>
                <div style={{ fontSize: 12, color: C.muted, borderTop: `1px solid ${C.border}`, paddingTop: 10 }}>
                  Estimated from {fit.n} failure point{fit.n !== 1 ? "s" : ""}. Accuracy improves as failures span multiple time domains — try power hangs (5–10s) and capacity hangs (2+ min) to sharpen the curve.
                </div>
              </>
            );
          };

          const perGripMode = !selGrip && Object.keys(gripEstimates).length >= 2;
          if (perGripMode) {
            return (
              <>
                {Object.entries(gripEstimates).map(([grip, fit]) => (
                  <Card key={grip} style={{ marginBottom: 16 }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                      <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{grip}</div>
                    </div>
                    {renderCFBody(fit)}
                  </Card>
                ))}
              </>
            );
          }

          if (cfEstimate) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 12 }}>
                  <div style={{ fontSize: 14, fontWeight: 700 }}>Critical Force Estimate</div>
                  {selGrip && (
                    <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                  )}
                </div>
                {renderCFBody(cfEstimate)}
              </Card>
            );
          }

          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${C.yellow}30` }}>
              <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
                {failures.length === 0 ? "⚠ Critical Force requires failure data" : "⚠ Need 2+ failures at different durations to fit the curve"}
              </div>
              <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
                {failures.length === 0
                  ? "The shape of your force-duration curve is defined by reps that end in auto-failure. Completed reps set the floor; failed reps define the curve."
                  : "You have failure data in one time domain. Add failures at a shorter or longer duration to fit the Monod-Scherrer curve and estimate Critical Force."}
              </div>
            </Card>
          );
        })()}

        {/* The Climbing Capacity chart card lived here. Removed because
            the Capacity Improvement card below already shows each grip's
            Total % (= AUC % gain) and CF & W' Over Time already shows
            the trajectory of the underlying fit parameters. */}

        {/* ── Per-compartment AUC (dose delivered per energy system, per session) ── */}
        {(() => {
          // Group selected reps by session_id; fall back to date
          const bySession = new Map();
          for (const r of reps) {
            const key = r.session_id || r.date;
            if (!bySession.has(key)) bySession.set(key, { key, date: r.date, reps: [] });
            bySession.get(key).reps.push(r);
          }
          const sessions = [...bySession.values()]
            .sort((a, b) => a.date.localeCompare(b.date))
            .slice(-10)
            .map(s => {
              const auc = sessionCompartmentAUC(s.reps);
              const dom = dominantZone5(s.reps);
              return {
                label: s.date.slice(5), // "MM-DD"
                Fast: Math.round(auc.fast),
                Medium: Math.round(auc.medium),
                Slow: Math.round(auc.slow),
                total: Math.round(auc.total),
                n: s.reps.length,
                reps: s.reps,
                dom,
              };
            });
          if (sessions.length === 0) return null;
          const last = sessions[sessions.length - 1];
          const pct = (v) => last.total > 0 ? Math.round((v / last.total) * 100) : 0;
          // Build the last-session zone distribution (count of reps per ZONE5 bucket)
          const lastZoneCounts = ZONE5.map(z => ({
            ...z,
            count: last.reps.filter(r => classifyZone5(r.actual_time_s)?.key === z.key).length,
          }));
          const lastTotalReps = lastZoneCounts.reduce((s, z) => s + z.count, 0);
          return (
            <Card style={{ marginBottom: 16 }}>
              <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 4 }}>Per-Compartment Dose (AUC)</div>
              <div style={{ fontSize: 11, color: C.muted, marginBottom: 12, lineHeight: 1.5 }}>
                Training dose delivered to each energy system per session. Dose = load × A<sub>i</sub> × τ<sub>Di</sub> · (1 − e<sup>−t/τ<sub>Di</sub></sup>).
                Units: kg·s.
              </div>
              <div style={{ height: 180 }}>
                <ResponsiveContainer>
                  <BarChart data={sessions} margin={{ top: 6, right: 8, left: 0, bottom: 0 }}>
                    <CartesianGrid stroke={C.border} strokeDasharray="3 3" />
                    <XAxis dataKey="label" stroke={C.muted} tick={{ fontSize: 10 }} />
                    <YAxis stroke={C.muted} tick={{ fontSize: 10 }} />
                    <Tooltip
                      contentStyle={{ background: C.card, border: `1px solid ${C.border}`, borderRadius: 6, fontSize: 12 }}
                      labelStyle={{ color: C.muted }}
                    />
                    <Legend wrapperStyle={{ fontSize: 11 }} />
                    <Bar dataKey="Fast"   stackId="a" fill="#e05560" />
                    <Bar dataKey="Medium" stackId="a" fill="#e07a30" />
                    <Bar dataKey="Slow"   stackId="a" fill="#3b82f6" />
                  </BarChart>
                </ResponsiveContainer>
              </div>
              {/* Last-session breakdown */}
              <div style={{
                display: "grid", gridTemplateColumns: "1fr 1fr 1fr",
                gap: 8, marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}`,
              }}>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>FAST · PCR</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e05560" }}>{last.Fast}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Fast)}% · τ 15s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>MEDIUM · GLYCO</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#e07a30" }}>{last.Medium}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Medium)}% · τ 90s</div>
                </div>
                <div>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5 }}>SLOW · OXID</div>
                  <div style={{ fontSize: 18, fontWeight: 800, color: "#3b82f6" }}>{last.Slow}</div>
                  <div style={{ fontSize: 10, color: C.muted }}>{pct(last.Slow)}% · τ 600s</div>
                </div>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8, fontStyle: "italic" }}>
                Last session: {last.n} rep{last.n !== 1 ? "s" : ""}, {last.total} kg·s total dose.
                {last.dom && <> · landed in <span style={{ color: last.dom.color, fontWeight: 700, fontStyle: "normal" }}>{last.dom.label}</span></>}
              </div>

              {/* ── Last-session zone distribution (5-zone classifier) ── */}
              {lastTotalReps > 0 && (
                <div style={{ marginTop: 12, paddingTop: 10, borderTop: `1px solid ${C.border}` }}>
                  <div style={{ fontSize: 10, color: C.muted, letterSpacing: 0.5, marginBottom: 6, textTransform: "uppercase" }}>
                    Landed Zones · last session
                  </div>
                  <div style={{ display: "flex", height: 8, borderRadius: 4, overflow: "hidden", marginBottom: 6 }}>
                    {lastZoneCounts.map(z => z.count > 0 && (
                      <div
                        key={z.key}
                        title={`${z.label}: ${z.count} rep${z.count !== 1 ? "s" : ""}`}
                        style={{
                          flex: z.count,
                          background: z.color,
                        }}
                      />
                    ))}
                  </div>
                  <div style={{ display: "flex", flexWrap: "wrap", gap: 8, fontSize: 10, color: C.muted }}>
                    {lastZoneCounts.filter(z => z.count > 0).map(z => (
                      <span key={z.key} style={{ display: "inline-flex", alignItems: "center", gap: 4 }}>
                        <span style={{ width: 8, height: 8, borderRadius: 2, background: z.color, display: "inline-block" }} />
                        {z.short} · {z.count}
                      </span>
                    ))}
                  </div>
                </div>
              )}
            </Card>
          );
        })()}

        {/* ── Energy system breakdown ── */}
        <Card style={{ marginBottom: 16 }}>
          <div style={{ fontSize: 14, fontWeight: 700, marginBottom: 14 }}>Energy System Breakdown</div>
          {Object.entries(zones).map(([, z]) => (
            <div key={z.label} style={{ marginBottom: 16 }}>
              <div style={{ display: "flex", justifyContent: "space-between", fontSize: 12, marginBottom: 5 }}>
                <span>
                  <span style={{ color: z.color, fontWeight: 700 }}>{z.label}</span>
                  <span style={{ color: C.muted }}> · {z.system} · {z.tau}</span>
                </span>
                <span style={{ color: C.muted }}>
                  {z.total === 0 ? "No data" : `${z.failures} fail / ${z.total} total`}
                </span>
              </div>
              <div style={{ height: 10, background: C.border, borderRadius: 5, overflow: "hidden" }}>
                {z.failRate !== null && (
                  <div style={{ height: "100%", width: `${z.failRate * 100}%`, background: z.color, borderRadius: 5, transition: "width 0.4s" }} />
                )}
              </div>
              {z.total === 0 && (
                <div style={{ fontSize: 11, color: C.muted, marginTop: 3 }}>
                  Add {z.desc} hangs to characterise this system.
                </div>
              )}
            </div>
          ))}
        </Card>

        {/* ── Unified training recommendation ──
            When no grip filter is active AND ≥2 grips have fits, render
            a separate card per grip so Micro (FDP) and Crusher (FDS)
            each get their own verdict — they are independent muscles
            with independent force-duration curves, so pooling hides
            the real story. Otherwise fall back to the single pooled /
            selGrip-scoped card with the limiter/coverage diagnostics. */}
        {(() => {
          // Helper — render one projected-ΔAUC bars block for a rec.
          const renderGainsBars = (rec) => rec.gains && (
            <div style={{
              background: C.bg, borderRadius: 8, padding: "8px 10px",
              marginBottom: 10, fontSize: 11,
            }}>
              <div style={{ color: C.muted, letterSpacing: 0.4, textTransform: "uppercase", fontSize: 10, marginBottom: 6 }}>
                Projected ΔAUC · next session
              </div>
              {[
                { k: "power",     lbl: "Power",    col: C.red },
                { k: "strength",  lbl: "Strength", col: C.orange },
                { k: "endurance", lbl: "Capacity", col: C.blue },
              ].map(r => {
                const v = rec.gains[r.k];
                const pct = rec.gains[rec.key] > 0 ? (v / rec.gains[rec.key]) * 100 : 0;
                const isBest = r.k === rec.key;
                const rs = rec.responseSource?.[r.k];
                const calibrated = rs?.source === "blended";
                return (
                  <div key={r.k} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 4 }}>
                    <span style={{ width: 62, color: r.col, fontWeight: isBest ? 700 : 400 }}>
                      {r.lbl}
                      {calibrated && (
                        <span
                          title={`Calibrated from ${Math.round(rs.n)} session-equivalents (TUT-weighted)`}
                          style={{ marginLeft: 3, fontSize: 8, color: C.green, verticalAlign: "super" }}
                        >●</span>
                      )}
                    </span>
                    <div style={{ flex: 1, height: 6, background: C.border, borderRadius: 3, overflow: "hidden" }}>
                      <div style={{ height: "100%", width: `${pct}%`, background: r.col, borderRadius: 3, transition: "width 0.3s" }} />
                    </div>
                    <span style={{ width: 56, textAlign: "right", color: isBest ? r.col : C.muted, fontWeight: isBest ? 700 : 400 }}>
                      +{fmt1(v)} {unit}·s
                    </span>
                  </div>
                );
              })}
              {rec.responseSource && (() => {
                const calibrated = Object.entries(rec.responseSource).filter(([, s]) => s.source === "blended");
                if (calibrated.length === 0) {
                  return (
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 6, fontStyle: "italic" }}>
                      Using population prior. Response rates will calibrate to your own data after {PERSONAL_RESPONSE_MIN_SESSIONS}+ sessions per zone.
                    </div>
                  );
                }
                const labels = { power: "Power", strength: "Strength", endurance: "Capacity" };
                const parts = calibrated.map(([k, s]) => `${labels[k]} (${Math.round(s.n)})`).join(", ");
                return (
                  <div style={{ fontSize: 10, color: C.muted, marginTop: 6 }}>
                    <span style={{ color: C.green }}>●</span> Calibrated from your history: {parts}.
                    {calibrated.length < 3 && " Others still on prior."}
                  </div>
                );
              })()}
            </div>
          );

          // Per-grip split mode: one card per grip with its own verdict.
          const perGripMode = !selGrip && Object.keys(gripRecs).length >= 2;
          if (perGripMode) {
            return (
              <>
                {Object.values(gripRecs).map(rec => (
                  <Card key={rec.grip} style={{ marginBottom: 16, border: `1px solid ${rec.color}40` }}>
                    <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                      <div style={{ fontSize: 11, color: rec.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                        Next Session Focus
                      </div>
                      <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>
                        {rec.grip}
                      </div>
                    </div>
                    <div style={{ fontSize: 22, fontWeight: 800, color: rec.color, marginBottom: 10 }}>
                      {rec.title}
                    </div>
                    <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                      {rec.insight}
                    </div>
                    {renderGainsBars(rec)}
                    <div style={{ fontSize: 10, color: C.muted, marginTop: 4 }}>
                      CF {fmtW(rec.CF, unit)} {unit} · W′ {fmtW(rec.W, unit)} {unit}·s · {rec.n} failure{rec.n !== 1 ? "s" : ""}
                    </div>
                  </Card>
                ))}
              </>
            );
          }

          // Single-card mode — pooled fit, or user has picked a specific
          // grip. Shows the full limiter/coverage diagnostics panel.
          if (!recommendation) {
            return (
              <Card style={{ marginBottom: 16 }}>
                <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.5 }}>
                  🔬 Train close to your limit in at least one time domain so the auto-failure system can record a failure point. That unlocks personalized training recommendations.
                </div>
              </Card>
            );
          }
          return (
            <Card style={{ marginBottom: 16, border: `1px solid ${recommendation.color}40` }}>
              <div style={{ display: "flex", justifyContent: "space-between", alignItems: "baseline", marginBottom: 6 }}>
                <div style={{ fontSize: 11, color: recommendation.color, fontWeight: 700, textTransform: "uppercase", letterSpacing: "0.08em" }}>
                  Next Session Focus
                </div>
                {selGrip && (
                  <div style={{ fontSize: 11, color: C.muted, fontWeight: 600 }}>{selGrip}</div>
                )}
              </div>
              <div style={{ fontSize: 22, fontWeight: 800, color: recommendation.color, marginBottom: 10 }}>
                {recommendation.title}
              </div>
              <div style={{ fontSize: 13, color: C.text, marginBottom: 14, lineHeight: 1.6 }}>
                {recommendation.insight}
              </div>
              {renderGainsBars(recommendation)}
              {/* Secondary diagnostics */}
              <div style={{ display: "flex", flexDirection: "column", gap: 5 }}>
                {recommendation.limiterKey && recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Shape:</span>
                    <span>
                      Curve-shape diagnostic agrees — this zone also falls farthest below its own Monod curve
                      {recommendation.limiterGrip ? <> on <b>{recommendation.limiterGrip}</b></> : null}.
                    </span>
                  </div>
                )}
                {recommendation.limiterKey && !recommendation.agree && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.yellow, fontWeight: 700, flexShrink: 0 }}>⚡ Shape:</span>
                    <span>
                      Curve-shape diagnostic points elsewhere
                      {recommendation.limiterGrip ? <> (<b>{recommendation.limiterGrip}</b>)</> : null},
                      but AUC ranks this protocol as the biggest capacity win. Growing area dominates balancing shape.
                    </span>
                  </div>
                )}
                {recommendation.coverageKey && recommendation.coverageKey === recommendation.key && (
                  <div style={{ fontSize: 11, color: C.muted, display: "flex", gap: 6, alignItems: "flex-start" }}>
                    <span style={{ color: C.green, fontWeight: 700, flexShrink: 0 }}>✓ Coverage:</span>
                    <span>Session count agrees — this is also your least-trained zone in the last 30 days.</span>
                  </div>
                )}
              </div>
            </Card>
          );
        })()}

        {/* Unexplored zones notice */}
        {unexplored.length > 0 && (
          <Card style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 13, color: C.yellow, marginBottom: 6 }}>
              📍 Unexplored: <b>{unexplored.join(", ")}</b>
            </div>
            <div style={{ fontSize: 12, color: C.muted, lineHeight: 1.5 }}>
              Data from {unexplored.join(" and ").toLowerCase()} hangs would complete your profile and reveal hidden limiters. A single session to failure in each zone is enough to start.
            </div>
          </Card>
        )}

      </>)}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// SETTINGS VIEW
// ─────────────────────────────────────────────────────────────
function SettingsView({
  user, loginEmail, setLoginEmail,
  onSendOtp = () => {}, onVerifyOtp = () => {}, onCancelOtp = () => {},
  otpSent = false, otpCode = "", setOtpCode = () => {},
  otpBusy = false, otpError = null,
  onSignOut,
  unit = "lbs", onUnitChange = () => {},
  bodyWeight = null, onBWChange = () => {},
  trip = DEFAULT_TRIP, onTripChange = () => {},
  onPullFromCloud = () => {}, pullStatus = "idle", lastPulledAt = null,
}) {
  const [showSQL, setShowSQL] = useState(false);
  const sql = `-- Run this once in your Supabase SQL editor (fresh install):
CREATE TABLE reps (
  id uuid DEFAULT gen_random_uuid() PRIMARY KEY,
  created_at timestamptz DEFAULT now(),
  date text, grip text, hand text,
  target_duration integer,
  weight_kg real, actual_time_s real,
  avg_force_kg real, peak_force_kg real,
  set_num integer, rep_num integer,
  rest_s integer, session_id text,
  failed boolean DEFAULT false
);
ALTER TABLE reps ENABLE ROW LEVEL SECURITY;
CREATE POLICY "auth_all" ON reps
  FOR ALL USING (auth.uid() IS NOT NULL);

-- If upgrading an existing table, run this instead:
-- ALTER TABLE reps ADD COLUMN IF NOT EXISTS failed boolean DEFAULT false;`;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      <h2 style={{ margin: "0 0 16px", fontSize: 22 }}>Settings</h2>

      <Card>
        <Sect title="Units">
          <div style={{ display: "flex", gap: 8 }}>
            {["lbs", "kg"].map(u => (
              <button key={u} onClick={() => onUnitChange(u)} style={{
                flex: 1, padding: "10px 0", borderRadius: 8, cursor: "pointer", fontWeight: 700, fontSize: 16,
                background: unit === u ? C.blue : C.border,
                color: unit === u ? "#fff" : C.muted, border: "none",
              }}>{u}</button>
            ))}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Body Weight">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Used to show <b>relative strength</b> (force ÷ bodyweight) in the Analysis tab.
            Helps compare progress through weight changes.
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <input
              type="number" inputMode="numeric" min={30} max={500} step={1}
              value={bodyWeight != null ? fmt0(toDisp(bodyWeight, unit)) : ""}
              onChange={e => {
                const v = e.target.value === "" ? null : fromDisp(Math.round(Number(e.target.value)), unit);
                onBWChange(v);
              }}
              placeholder={`Weight in ${unit}`}
              style={{
                width: 110, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <span style={{ fontSize: 14, color: C.muted }}>{unit}</span>
            {bodyWeight != null && (
              <span style={{ fontSize: 12, color: C.muted, marginLeft: 4 }}>
                ({unit === "lbs" ? `${fmt0(bodyWeight)} kg` : `${fmt0(bodyWeight * KG_TO_LBS)} lbs`})
              </span>
            )}
          </div>
        </Sect>
      </Card>

      <Card>
        <Sect title="Training Goal">
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 10, lineHeight: 1.5 }}>
            Target trip or event. Drives the countdown + taper reminder on the Workout tab.
          </div>
          <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <input
              type="text"
              value={trip.name || ""}
              onChange={e => onTripChange({ name: e.target.value })}
              placeholder="Name (e.g. Tensleep)"
              style={{
                flex: "1 1 160px", minWidth: 140, background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
            <input
              type="date"
              value={trip.date || ""}
              onChange={e => onTripChange({ date: e.target.value })}
              style={{
                background: C.bg,
                border: `1px solid ${C.border}`, borderRadius: 8,
                padding: "8px 12px", color: C.text, fontSize: 15,
              }}
            />
          </div>
          {(() => {
            const cd = tripCountdown(trip.date);
            if (!cd) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Pick a date to enable the countdown.
                </div>
              );
            }
            if (cd.past) {
              return (
                <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                  Trip date is in the past — update it to a future date.
                </div>
              );
            }
            return (
              <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
                {cd.weeks}wk · {cd.days}d until {trip.name || "trip"} ({cd.tripLabel}). Taper starts {cd.taperLabel}.
              </div>
            );
          })()}
        </Sect>
      </Card>

      <Card>
        <Sect title="Cloud Sync (Supabase)">
          {user ? (
            <div>
              <div style={{ fontSize: 14, marginBottom: 12 }}>
                Signed in as <b>{user.email}</b>
              </div>
              <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
                <Btn
                  small
                  color={pullStatus === "pulling" ? C.muted : C.blue}
                  onClick={onPullFromCloud}
                  disabled={pullStatus === "pulling"}
                >
                  {pullStatus === "pulling" ? "Pulling…" : "⟳ Pull from Cloud"}
                </Btn>
                <Btn small color={C.red} onClick={onSignOut}>Sign Out</Btn>
              </div>
              <div style={{ fontSize: 11, color: C.muted, marginTop: 8, lineHeight: 1.5 }}>
                {pullStatus === "ok" && lastPulledAt && (
                  <>Pulled at {new Date(lastPulledAt).toLocaleTimeString()} · </>
                )}
                {pullStatus === "err" && (
                  <span style={{ color: C.red }}>Pull failed — check network. </span>
                )}
                Auto-sync happens on sign-in. Use this if a workout saved on another
                device isn't showing here yet.
              </div>
            </div>
          ) : !otpSent ? (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Sign in to sync data across devices. We'll email you a 6-digit code.
              </div>
              <form
                onSubmit={e => { e.preventDefault(); onSendOtp(); }}
                style={{ display: "flex", gap: 8 }}
              >
                <input
                  type="email" value={loginEmail}
                  onChange={e => setLoginEmail(e.target.value)}
                  placeholder="your@email.com"
                  autoComplete="email"
                  style={{ flex: 1, background: C.bg, border: `1px solid ${C.border}`, borderRadius: 8, padding: "8px 12px", color: C.text, fontSize: 14 }}
                />
                <Btn small type="submit" onClick={onSendOtp} disabled={otpBusy || !loginEmail}>
                  {otpBusy ? "Sending…" : "Send Code"}
                </Btn>
              </form>
              {otpError && (
                <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{otpError}</div>
              )}
            </div>
          ) : (
            <div>
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                Code sent to <b style={{ color: C.text }}>{loginEmail}</b>. Enter it below.
              </div>
              <form
                onSubmit={e => { e.preventDefault(); onVerifyOtp(); }}
                style={{ display: "flex", gap: 8 }}
              >
                <input
                  type="text"
                  inputMode="numeric"
                  pattern="[0-9]*"
                  autoComplete="one-time-code"
                  value={otpCode}
                  onChange={e => setOtpCode(e.target.value.replace(/\D/g, "").slice(0, 6))}
                  placeholder="123456"
                  autoFocus
                  maxLength={6}
                  style={{
                    flex: 1, background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "8px 12px", color: C.text,
                    fontSize: 18, letterSpacing: 4, fontVariantNumeric: "tabular-nums",
                    textAlign: "center",
                  }}
                />
                <Btn small type="submit" onClick={onVerifyOtp} disabled={otpBusy || otpCode.length < 6}>
                  {otpBusy ? "Verifying…" : "Verify"}
                </Btn>
              </form>
              <div style={{ display: "flex", gap: 12, marginTop: 8, alignItems: "center" }}>
                <button
                  type="button"
                  onClick={onSendOtp}
                  disabled={otpBusy}
                  style={{ background: "none", border: "none", color: C.blue, fontSize: 12, cursor: "pointer", padding: 0 }}
                >Resend code</button>
                <button
                  type="button"
                  onClick={onCancelOtp}
                  style={{ background: "none", border: "none", color: C.muted, fontSize: 12, cursor: "pointer", padding: 0 }}
                >Use a different email</button>
              </div>
              {otpError && (
                <div style={{ fontSize: 12, color: C.red, marginTop: 8 }}>{otpError}</div>
              )}
            </div>
          )}
        </Sect>
      </Card>

      <Card>
        <Sect title="Tindeq Progressor">
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <p style={{ marginTop: 0 }}>
              The Tindeq Progressor connects via Web Bluetooth. Use <b>Chrome</b> on desktop or Android.
            </p>
            <p>
              Connect from the training screen. The app auto-detects failure when force drops below 50% of peak for &gt;500 ms.
            </p>
            <p style={{ marginBottom: 0 }}>
              If readings seem off, your firmware may use a slightly different BLE packet format — contact support.
            </p>
          </div>
        </Sect>
      </Card>

      <Card>
        <details>
          <summary style={{ fontSize: 12, color: C.muted, cursor: "pointer", userSelect: "none" }}>
            Developer options
          </summary>
          <div style={{ marginTop: 12 }}>
            <Sect title="Supabase Setup">
              <div style={{ fontSize: 13, color: C.muted, marginBottom: 10 }}>
                If this is a fresh install, run this SQL in your Supabase project to create the <code>reps</code> table.
              </div>
              <Btn small onClick={() => setShowSQL(s => !s)} color={C.muted}>
                {showSQL ? "Hide SQL" : "Show Setup SQL"}
              </Btn>
              {showSQL && (
                <pre style={{
                  marginTop: 12, background: C.bg, border: `1px solid ${C.border}`,
                  borderRadius: 8, padding: 12, fontSize: 11, color: C.green,
                  whiteSpace: "pre-wrap", overflowX: "auto",
                }}>{sql}</pre>
              )}
            </Sect>
          </div>
        </details>
      </Card>

      <Card>
        <Sect title="About">
          <div style={{ fontSize: 13, color: C.muted, lineHeight: 1.6 }}>
            <b>Fatigue Model:</b> Three-compartment IV-kinetics analogy. Fast (15 s), medium (90 s),
            and slow (600 s) exponential decay model phosphocreatine replenishment, glycolytic clearance,
            and metabolic byproduct removal respectively.
            <br /><br />
            <b>Level System:</b> Each 5% improvement in your best load at a target duration = +1 level.
            <br /><br />
            <b>Version:</b> Finger Training v3
          </div>
        </Sect>
      </Card>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// MAIN APP
// ─────────────────────────────────────────────────────────────
// ─────────────────────────────────────────────────────────────
// BADGES VIEW
// ─────────────────────────────────────────────────────────────
function BadgesView({ history, liveEstimate, genesisSnap }) {
  // Zone coverage for Genesis unlock
  const hasPower    = history.some(r => r.target_duration === 10);
  const hasStrength = history.some(r => r.target_duration === 45);
  const hasCapacity = history.some(r => r.target_duration === 120);
  const genesisEarned = hasPower && hasStrength && hasCapacity;

  // AUC progress
  const genesisAUC  = genesisSnap ? computeAUC(genesisSnap.CF, genesisSnap.W) : null;
  const currentAUC  = liveEstimate ? computeAUC(liveEstimate.CF, liveEstimate.W) : null;
  const pctImprove  = (genesisAUC && currentAUC && currentAUC > genesisAUC)
    ? (currentAUC - genesisAUC) / genesisAUC * 100
    : 0;

  // Which badges are earned
  const earnedIds = new Set(
    BADGE_CONFIG
      .filter((b, i) => i === 0 ? genesisEarned : genesisEarned && pctImprove >= b.threshold)
      .map(b => b.id)
  );
  const earnedList  = BADGE_CONFIG.filter(b => earnedIds.has(b.id));
  const currentBadge= earnedList[earnedList.length - 1] ?? null;
  const nextBadge   = BADGE_CONFIG.find(b => !earnedIds.has(b.id)) ?? null;

  // Progress bar toward next badge
  const prevThr = currentBadge?.threshold ?? 0;
  const nextThr = nextBadge?.threshold ?? 100;
  const toNext  = nextBadge
    ? Math.min(100, Math.max(0, (pctImprove - prevThr) / (nextThr - prevThr) * 100))
    : 100;

  const zonesHave = [hasPower, hasStrength, hasCapacity].filter(Boolean).length;

  return (
    <div style={{ padding: "20px 16px", maxWidth: 480, margin: "0 auto" }}>

      {/* Hero: current badge */}
      <div style={{ textAlign: "center", marginBottom: 28 }}>
        <div style={{ fontSize: 56, lineHeight: 1 }}>{currentBadge?.emoji ?? "⬜"}</div>
        <div style={{ fontSize: 22, fontWeight: 800, color: C.text, marginTop: 10 }}>
          {currentBadge?.label ?? "Begin your journey"}
        </div>
        {genesisEarned && currentAUC && (
          <div style={{ fontSize: 13, color: C.muted, marginTop: 4 }}>
            {pctImprove.toFixed(1)}% above your Genesis capacity
          </div>
        )}
      </div>

      {/* Genesis checklist — shown until earned */}
      {!genesisEarned && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ fontSize: 14, fontWeight: 700, color: C.text, marginBottom: 4 }}>
            Earn Genesis 🌱
          </div>
          <div style={{ fontSize: 13, color: C.muted, marginBottom: 12 }}>
            Log one session in each training zone to unlock your curve.
          </div>
          {[
            { label: "Power — 10s hang",     done: hasPower },
            { label: "Strength — 45s hang",   done: hasStrength },
            { label: "Capacity — 120s hang",  done: hasCapacity },
          ].map(z => (
            <div key={z.label} style={{ display: "flex", alignItems: "center", gap: 10, marginBottom: 8 }}>
              <span style={{ fontSize: 17 }}>{z.done ? "✅" : "⬜"}</span>
              <span style={{ fontSize: 13, color: z.done ? C.green : C.muted, fontWeight: z.done ? 600 : 400 }}>
                {z.label}
              </span>
            </div>
          ))}
          <div style={{ height: 5, background: C.border, borderRadius: 3, marginTop: 12 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.green,
              width: `${(zonesHave / 3) * 100}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 6 }}>{zonesHave} of 3 zones covered</div>
        </div>
      )}

      {/* Progress toward next badge */}
      {genesisEarned && nextBadge && (
        <div style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 12, padding: 16, marginBottom: 20,
        }}>
          <div style={{ display: "flex", justifyContent: "space-between", marginBottom: 8 }}>
            <span style={{ fontSize: 13, color: C.muted }}>Progress to {nextBadge.emoji} {nextBadge.label}</span>
            <span style={{ fontSize: 13, fontWeight: 700, color: C.blue }}>{toNext.toFixed(0)}%</span>
          </div>
          <div style={{ height: 6, background: C.border, borderRadius: 3 }}>
            <div style={{
              height: "100%", borderRadius: 3, background: C.blue,
              width: `${toNext}%`, transition: "width 0.4s",
            }} />
          </div>
          <div style={{ fontSize: 12, color: C.muted, marginTop: 8 }}>
            Need +{nextBadge.threshold}% · you're at +{pctImprove.toFixed(1)}%
          </div>
        </div>
      )}

      {/* All-earned celebration */}
      {genesisEarned && !nextBadge && (
        <div style={{
          background: "#1a2a1a", border: `1px solid ${C.green}`,
          borderRadius: 12, padding: 16, marginBottom: 20, textAlign: "center",
        }}>
          <div style={{ fontSize: 13, color: C.green, fontWeight: 700 }}>
            🏔️ Realization achieved — you've fulfilled the potential
          </div>
        </div>
      )}

      {/* Badge pyramid — Genesis at top (origin), Realization at bottom (destination) */}
      <div style={{ fontSize: 12, color: C.muted, marginBottom: 10, textAlign: "center", letterSpacing: "0.05em" }}>
        THE JOURNEY
      </div>
      <div style={{ display: "flex", flexDirection: "column", gap: 8 }}>
        {BADGE_CONFIG.map((badge) => {
          const earned  = earnedIds.has(badge.id);
          const current = currentBadge?.id === badge.id;
          return (
            <div key={badge.id} style={{
              background: earned ? C.card : "transparent",
              border: `1px solid ${current ? C.blue : earned ? C.border : C.border + "50"}`,
              borderRadius: 12, padding: "12px 16px",
              display: "flex", alignItems: "center", gap: 14,
              opacity: earned ? 1 : 0.38,
              boxShadow: current ? `0 0 0 2px ${C.blue}30` : "none",
            }}>
              <span style={{ fontSize: 28, filter: earned ? "none" : "grayscale(1)" }}>
                {badge.emoji}
              </span>
              <div style={{ flex: 1 }}>
                <div style={{
                  fontSize: 15, fontWeight: 700,
                  color: current ? C.blue : earned ? C.text : C.muted,
                  display: "flex", alignItems: "center", gap: 8,
                }}>
                  {badge.label}
                  {current && (
                    <span style={{
                      fontSize: 10, fontWeight: 700, color: C.blue,
                      background: C.blue + "20", borderRadius: 4,
                      padding: "1px 6px", letterSpacing: "0.06em",
                    }}>NOW</span>
                  )}
                </div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{badge.desc}</div>
              </div>
              <div style={{ fontSize: 12, color: C.muted, textAlign: "right", minWidth: 40 }}>
                {badge.threshold === 0 ? "start" : `+${badge.threshold}%`}
              </div>
            </div>
          );
        })}
      </div>

      {/* Footer note */}
      <div style={{ fontSize: 12, color: C.muted, textAlign: "center", marginTop: 20, lineHeight: 1.5 }}>
        % is AUC growth above your Genesis snapshot —<br />
        total force capacity across the 10–120s range.
      </div>
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// AUTO REP SESSION VIEW
// ─────────────────────────────────────────────────────────────
// Touchless session mode for spring-strap / pre-calibrated setups.
// Tindeq detects pull start and release automatically — no button taps needed.
// Each detected rep calls onRepDone with {actualTime, avgForce, failed:false}.
function AutoRepSessionView({ session, onRepDone, onAbort, tindeq, unit = "lbs" }) {
  const { config, currentSet, currentRep, activeHand, refWeights } = session;
  const handLabel = config.hand === "Both"
    ? (activeHand === "L" ? "Left Hand" : "Right Hand")
    : config.hand === "L" ? "Left Hand" : "Right Hand";

  // Program-recommended target weight for the active hand.
  // Held CONSTANT within a set — the user hangs the same load each rep and
  // we record how actual_time_s changes. Those rep-time curves then feed
  // the next session's prescription via the Monod fit. We intentionally do
  // NOT discount the suggested weight by within-set fatigue.
  const suggestedKg = useMemo(
    () => suggestWeight(refWeights?.[activeHand] ?? null, 0),
    [refWeights, activeHand]
  );

  // Keep Tindeq's target ref in sync so the force gauge & auto-fail threshold
  // reflect the program recommendation during the rep.
  useEffect(() => {
    tindeq.targetKgRef.current = suggestedKg;
    return () => { tindeq.targetKgRef.current = null; };
  }, [tindeq, suggestedKg]);

  const [repActive, setRepActive] = useState(false);
  const [elapsed,   setElapsed]   = useState(0);
  const startTimeRef = useRef(null);
  const timerRef     = useRef(null);

  const handleRepEnd = useCallback(({ actualTime, avgForce }) => {
    clearInterval(timerRef.current);
    setRepActive(false);
    setElapsed(0);
    startTimeRef.current = null;
    onRepDone({ actualTime, avgForce, failed: false });
  }, [onRepDone]);

  const handleRepStart = useCallback(() => {
    startTimeRef.current = Date.now();
    setRepActive(true);
    setElapsed(0);
    timerRef.current = setInterval(() => {
      setElapsed(Math.floor((Date.now() - startTimeRef.current) / 1000));
    }, 100);
  }, []);

  useEffect(() => {
    tindeq.startAutoDetect(handleRepStart, handleRepEnd);
    return () => {
      tindeq.stopAutoDetect();
      clearInterval(timerRef.current);
    };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);  // mount/unmount only — handleRepStart/End are stable refs

  const targetReached = elapsed >= config.targetTime;

  return (
    <div style={{ maxWidth: 480, margin: "0 auto", padding: "20px 16px" }}>
      {/* Header */}
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: 16 }}>
        <div>
          <div style={{ fontSize: 13, color: C.muted }}>Set {currentSet + 1} of {config.numSets}</div>
          <div style={{ fontSize: 18, fontWeight: 700 }}>{config.grip} · {handLabel}</div>
        </div>
        <Btn small color={C.red} onClick={onAbort}>End Session</Btn>
      </div>

      <RepDots total={config.repsPerSet} done={currentRep} current={currentRep} />

      {/* Status card */}
      <Card style={{ textAlign: "center", padding: "32px 16px", marginTop: 12 }}>
        {repActive ? (
          <>
            <div style={{ fontSize: 13, color: C.muted, marginBottom: 8 }}>Holding — release when done</div>
            <div style={{
              fontSize: 96, fontWeight: 900, lineHeight: 1,
              color: targetReached ? C.green : C.blue,
              fontVariantNumeric: "tabular-nums",
            }}>
              {elapsed}s
            </div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              target {config.targetTime}s
              {targetReached && <span style={{ color: C.green, marginLeft: 8 }}>✓ target reached</span>}
            </div>
          </>
        ) : (
          <>
            <div style={{
              fontSize: 13, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 4,
            }}>Use your</div>
            <div style={{
              fontSize: 32, fontWeight: 900,
              color: activeHand === "R" ? C.orange : C.blue,
              marginBottom: 14,
            }}>
              {activeHand === "R" ? "✋ Right Hand" : "🤚 Left Hand"}
            </div>

            {/* Program-recommended target weight */}
            <div style={{
              fontSize: 11, color: C.muted, letterSpacing: 1.2,
              textTransform: "uppercase", marginBottom: 2,
            }}>
              Program target
            </div>
            <div style={{
              fontSize: 44, fontWeight: 900, color: C.blue,
              lineHeight: 1, marginBottom: 14,
              fontVariantNumeric: "tabular-nums",
            }}>
              {suggestedKg != null ? `${fmtW(suggestedKg, unit)} ${unit}` : "—"}
            </div>

            <div style={{ fontSize: 40, marginBottom: 8 }}>⬇</div>
            <div style={{ fontSize: 22, fontWeight: 700, color: C.text }}>Pull to begin rep {currentRep + 1}</div>
            <div style={{ fontSize: 13, color: C.muted, marginTop: 8 }}>
              Target: <strong>{config.targetTime}s</strong> · Release when done
            </div>
          </>
        )}
      </Card>

      {/* Live force */}
      {tindeq.connected && (
        <Card style={{ marginTop: 12 }}>
          <ForceGauge
            force={tindeq.force}
            avg={0}
            peak={tindeq.peak}
            targetKg={suggestedKg}
            unit={unit}
          />
        </Card>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// WORKOUT PLAN
// ─────────────────────────────────────────────────────────────
const LS_WORKOUT_PLAN_KEY    = "ft_workout_plan";
const LS_WORKOUT_STATE_KEY   = "ft_workout_state";
const LS_WORKOUT_LOG_KEY     = "ft_workout_log";
const LS_WORKOUT_SYNCED_KEY  = "ft_workout_synced";  // Set<id> of sessions confirmed in Supabase
const LS_WORKOUT_DELETED_KEY = "ft_workout_deleted"; // Set<id> tombstones — never re-add from remote
const LS_HISTORY_DOMAIN_KEY  = "ft_history_domain";
const LS_TRIP_KEY            = "ft_trip";            // { date: "YYYY-MM-DD", name: "Tensleep" }

const DEFAULT_TRIP         = { date: "2026-08-22", name: "Tensleep" };
const WK_ROTATION          = ["A", "B", "C"];

// Parse a "YYYY-MM-DD" trip date string. Returns null for empty/invalid input.
function parseTripDate(tripDateStr) {
  if (!tripDateStr) return null;
  const d = new Date(tripDateStr + "T00:00:00");
  return isNaN(d) ? null : d;
}

function weeksToTrip(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return 0;
  return Math.max(0, Math.ceil((trip - new Date()) / (7 * 24 * 60 * 60 * 1000)));
}

// Trip countdown info — model-agnostic (conjugate-friendly).
// Does NOT impose linear Build/Push/Peak/Taper blocks. Reports weeks remaining
// and a taper window starting 7 days out (universal across training models).
function tripCountdown(tripDateStr) {
  const trip = parseTripDate(tripDateStr);
  if (!trip) return null;
  const now = new Date();
  const msPerDay = 24 * 60 * 60 * 1000;
  const days = Math.ceil((trip - now) / msPerDay);
  const weeks = Math.max(0, Math.ceil(days / 7));
  const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
  const fmt = (d) => d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
  const taperStart = addDays(trip, -7);
  return {
    trip,
    days,
    weeks,
    tripLabel: fmt(trip),
    taperLabel: fmt(taperStart),
    inTaper: days <= 7 && days >= 0,
    past: days < 0,
  };
}

const WTYPE_META = {
  F: { label: "F", bg: "#1a2d4a", color: "#58a6ff" },
  S: { label: "S", bg: "#2d1f00", color: "#e3b341" },
  H: { label: "H", bg: "#2d0000", color: "#f85149" },
  P: { label: "P", bg: "#2d1200", color: "#f0883e" },
  C: { label: "C", bg: "#002d10", color: "#3fb950" },
  X: { label: "↔", bg: "#1e1e2e", color: "#8b949e" },
};

// Exercise substitution options — shown during a live session when equipment is unavailable.
// Keys are exercise IDs from DEFAULT_WORKOUTS; values are arrays of alternatives.
// Swaps are session-only and do not modify the plan template.
const EXERCISE_SUBSTITUTES = {
  bench_press:   [
    { id: "ohp",           name: "Overhead press",         type: "S", reps: "5",       logWeight: true,  note: "KB or barbell" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "Good shoulder stability option" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  ohp:           [
    { id: "bench_press",   name: "Bench press",            type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "push_ups",      name: "Push-ups",               type: "S", reps: "8–12",    logWeight: false, note: "Weighted vest if bodyweight is easy" },
  ],
  pull_ups:      [
    { id: "lat_pulldown",  name: "Lat pulldown",           type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "ring_rows",     name: "Ring rows",              type: "S", reps: "8–10",    logWeight: false, note: "Elevate feet to increase difficulty" },
    { id: "band_pullups",  name: "Band-assisted pull-ups", type: "S", reps: "5",       logWeight: false, note: "" },
  ],
  landmine_rows: [
    { id: "db_rows",       name: "DB rows",                type: "S", reps: "5/side",  logWeight: true,  note: "" },
    { id: "cable_rows",    name: "Cable rows",             type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "trx_rows",      name: "TRX rows",               type: "S", reps: "8–10",    logWeight: false, note: "Feet elevated for more load" },
  ],
  dips:          [
    { id: "close_bench",   name: "Close-grip bench",       type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "tricep_ext",    name: "Tricep extension",       type: "S", reps: "8–10",    logWeight: true,  note: "Cable or DB" },
    { id: "kb_press",      name: "KB press",               type: "S", reps: "5",       logWeight: true,  note: "" },
  ],
  rdl:           [
    { id: "good_morning",  name: "Good mornings",          type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "kb_deadlift",   name: "KB deadlift",            type: "H", reps: "5",       logWeight: true,  note: "" },
    { id: "hip_hinge",     name: "Hip hinge (band)",       type: "H", reps: "8–10",    logWeight: false, note: "Band around hips, hinge toward wall" },
  ],
  trx_ham_curl:  [
    { id: "nordic_curl",   name: "Nordic curl",            type: "H", reps: "3–5",     logWeight: false, note: "Slow lowering; add 1 rep/1–2 wks" },
    { id: "sb_ham_curl",   name: "Stability ball curl",    type: "H", reps: "8–10",    logWeight: false, note: "" },
    { id: "glute_bridge",  name: "Single-leg glute bridge",type: "H", reps: "10/side", logWeight: false, note: "" },
  ],
  goblet_squat:  [
    { id: "step_up",       name: "Step-up",                type: "S", reps: "6–8/side",logWeight: true,  note: "Climbing & hiking strength" },
    { id: "box_squat",     name: "Box squat",              type: "S", reps: "5",       logWeight: true,  note: "" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6/side",  logWeight: true,  note: "" },
  ],
  step_up:       [
    { id: "goblet_squat",  name: "Goblet squat",           type: "S", reps: "8",       logWeight: true,  note: "Joint health — keep load moderate" },
    { id: "split_squat",   name: "Bulgarian split squat",  type: "S", reps: "6/side",  logWeight: true,  note: "" },
    { id: "lunge",         name: "Reverse lunge",          type: "S", reps: "8/side",  logWeight: true,  note: "" },
  ],
  bicep_curls:   [
    { id: "hammer_curls",  name: "Hammer curls",           type: "S", reps: "8",       logWeight: true,  note: "Brachialis emphasis" },
    { id: "band_curls",    name: "Band curls",             type: "S", reps: "10–12",   logWeight: false, note: "" },
    { id: "chin_up",       name: "Chin-ups (supinated)",   type: "S", reps: "5",       logWeight: true,  note: "Direct bicep transfer" },
  ],
  slam_balls:    [
    { id: "med_ball",      name: "Medicine ball throw",    type: "P", reps: "8–10",    logWeight: true,  note: "" },
    { id: "broad_jump",    name: "Broad jump",             type: "P", reps: "6–8",     logWeight: false, note: "" },
    { id: "box_jump",      name: "Box jump",               type: "P", reps: "6–8",     logWeight: false, note: "" },
  ],
  kb_snatch:     [
    { id: "kb_swing",      name: "KB swing",               type: "P", reps: "10",      logWeight: true,  note: "" },
    { id: "db_snatch",     name: "DB snatch",              type: "P", reps: "5/side",  logWeight: true,  note: "" },
    { id: "power_clean",   name: "Power clean",            type: "P", reps: "5",       logWeight: true,  note: "" },
  ],
};

const DEFAULT_WORKOUTS = {
  A: {
    name: "Lift Day 1 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5/side", logWeight: true,  note: "Alternate sides" },
      { id: "bench_press",   name: "Bench press",           type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "goblet_squat",  name: "Goblet squat",          type: "S", sets: 1,    reps: "8",      logWeight: true,  note: "Joint health — keep load moderate" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  B: {
    name: "Lift Day 2 (Push + Pull)",
    exercises: [
      { id: "pull_ups",      name: "Weighted pull-ups",     type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Add weight when all reps clean" },
      { id: "landmine_rows", name: "One-arm landmine rows", type: "S", sets: 2,    reps: "5/side", logWeight: true,  note: "Alternate sides" },
      { id: "ohp",           name: "Overhead press",        type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "KB or barbell" },
      { id: "dips",          name: "Dips",                  type: "S", sets: 2,    reps: "5",      logWeight: true,  note: "Weighted when bodyweight is easy" },
      { id: "bicep_curls",   name: "Bicep curls",           type: "S", sets: 2,    reps: "8",      logWeight: true,  note: "Undercling strength" },
      { id: "rdl",           name: "RDL",                   type: "H", sets: 2,    reps: "3–5",    logWeight: true,  note: "Heavy — load in lengthened position" },
      { id: "trx_ham_curl",  name: "TRX hamstring curl",    type: "H", sets: 2,    reps: "6–8",    logWeight: false, note: "Slow eccentric; single-leg when ready" },
      { id: "step_up",       name: "Step-up",               type: "S", sets: 1,    reps: "6–8/side", logWeight: true, note: "Climbing & hiking strength — load when bodyweight easy" },
      { id: "stretch",       name: "Stretching",            type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
  C: {
    name: "Power",
    exercises: [
      { id: "slam_balls",  name: "Slam balls", type: "P", sets: 2,    reps: "8–10",   logWeight: true,  note: "Advance weight when 10 reps hold full speed" },
      { id: "kb_snatch",   name: "KB snatch",  type: "P", sets: 2,    reps: "5/side", logWeight: true,  note: "Full hip snap, crisp catch" },
      { id: "stretch",     name: "Stretching", type: "X", sets: null, reps: null,     logWeight: false, note: "Couch · Splits machine · Hamstring lockout · Forearms · Lat" },
    ],
  },
};

// ── Type badge ────────────────────────────────────────────────
function WTypeBadge({ type }) {
  const m = WTYPE_META[type] || WTYPE_META.X;
  return (
    <span style={{
      display: "inline-flex", alignItems: "center", justifyContent: "center",
      width: 30, height: 30, borderRadius: "50%", flexShrink: 0,
      background: m.bg, color: m.color, fontSize: 11, fontWeight: 700,
    }}>{m.label}</span>
  );
}

// ── Exercise row (read-only) ──────────────────────────────────
function ExerciseRow({ ex, last }) {
  const setsReps = [ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ");
  return (
    <div style={{
      display: "flex", alignItems: "center", gap: 12,
      padding: "11px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
    }}>
      <WTypeBadge type={ex.type} />
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
        {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}
      </div>
      {setsReps && (
        <div style={{ fontSize: 13, color: C.muted, whiteSpace: "nowrap" }}>{setsReps}</div>
      )}
    </div>
  );
}

// ── Session logging row ───────────────────────────────────────
function SessionExRow({ ex, unit, prevSets, setsData, onSetsChange, done, onToggle, last }) {
  const allSetsDone = ex.logWeight && setsData?.sets
    ? setsData.sets.every(s => s.done)
    : !!done;
  const inputStyle = {
    width: 72, background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 7px", fontSize: 14,
    textAlign: "center",
  };
  const doneBtn = (isDone, onPress) => (
    <button onClick={onPress} style={{
      width: 28, height: 28, borderRadius: "50%", flexShrink: 0,
      background: isDone ? C.green : "transparent",
      border: `2px solid ${isDone ? C.green : C.border}`,
      color: isDone ? "#000" : C.muted,
      cursor: "pointer", fontSize: 12, display: "flex",
      alignItems: "center", justifyContent: "center",
    }}>{isDone ? "✓" : ""}</button>
  );
  return (
    <div style={{
      padding: "12px 0",
      borderBottom: last ? "none" : `1px solid ${C.border}`,
      opacity: allSetsDone ? 0.55 : 1,
    }}>
      <div style={{ display: "flex", alignItems: "flex-start", gap: 10 }}>
        <WTypeBadge type={ex.type} />
        <div style={{ flex: 1, minWidth: 0 }}>
          <div style={{ fontSize: 15, color: C.text }}>{ex.name}</div>
          {ex.note ? <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>{ex.note}</div> : null}

          {ex.logWeight && setsData?.sets ? (
            // ── Per-set rows ──
            <div style={{ marginTop: 10 }}>
              {/* Column headers */}
              <div style={{ display: "flex", gap: 8, marginBottom: 6, alignItems: "center" }}>
                <span style={{ fontSize: 11, color: C.muted, width: 36, flexShrink: 0 }}></span>
                <span style={{ fontSize: 11, color: C.muted, width: 48, textAlign: "center" }}>reps</span>
                <span style={{ fontSize: 11, color: C.muted, width: 72, textAlign: "center" }}>weight</span>
                {prevSets?.length > 0 && (
                  <span style={{ fontSize: 11, color: C.muted, width: 44, textAlign: "center" }}>prev</span>
                )}
              </div>

              {setsData.sets.map((s, i) => {
                const isExtra = i >= (ex.sets || 0);
                return (
                  <div key={i} style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 6 }}>
                    {/* Set label */}
                    <span style={{ fontSize: 12, color: isExtra ? C.orange : C.muted, width: 36, flexShrink: 0 }}>
                      S{i + 1}
                    </span>
                    {/* Reps input */}
                    <input
                      type="text" inputMode="text"
                      value={s.reps ?? ex.reps ?? ""}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], reps: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={{ ...inputStyle, width: 48, fontSize: 13 }}
                      placeholder={ex.reps || ""}
                    />
                    {/* Weight input */}
                    <input
                      type="number" inputMode="decimal"
                      value={s.weight}
                      onChange={e => {
                        const next = [...setsData.sets];
                        next[i] = { ...next[i], weight: e.target.value };
                        onSetsChange({ sets: next });
                      }}
                      style={inputStyle}
                    />
                    <span style={{ fontSize: 12, color: C.muted }}>{unit}</span>
                    {/* Prev weight */}
                    {prevSets?.[i] ? (
                      <span style={{ fontSize: 12, color: C.muted, width: 44 }}>{prevSets[i]}</span>
                    ) : prevSets?.length > 0 ? (
                      <span style={{ width: 44 }} />
                    ) : null}
                    {/* Done button */}
                    {doneBtn(s.done, () => {
                      const next = [...setsData.sets];
                      next[i] = { ...next[i], done: !next[i].done };
                      onSetsChange({ sets: next });
                    })}
                    {/* Remove extra set */}
                    {isExtra && (
                      <button
                        onClick={() => onSetsChange({ sets: setsData.sets.filter((_, j) => j !== i) })}
                        style={{ background: "none", border: "none", color: C.muted, cursor: "pointer", fontSize: 14, padding: "0 2px", lineHeight: 1 }}
                        title="Remove this set"
                      >−</button>
                    )}
                  </div>
                );
              })}

              {/* Add set button */}
              <button
                onClick={() => onSetsChange({
                  sets: [...setsData.sets, { weight: "", reps: ex.reps || "", done: false }]
                })}
                style={{
                  marginTop: 4, width: "100%", padding: "5px 0",
                  background: "none", border: `1px dashed ${C.border}`,
                  color: C.muted, borderRadius: 6, fontSize: 12, cursor: "pointer",
                }}
              >+ Set</button>
            </div>
          ) : (
            // ── No weight, just reps label ──
            <div style={{ fontSize: 12, color: C.muted, marginTop: 4 }}>
              {[ex.sets && `${ex.sets}×`, ex.reps].filter(Boolean).join(" ")}
            </div>
          )}
        </div>
        {/* Single done button for non-weight exercises */}
        {!ex.logWeight && doneBtn(!!done, onToggle)}
      </div>
    </div>
  );
}

// ── Plan editor for one workout ───────────────────────────────
function WorkoutEditor({ wKey, workout, onSave, onClose, onReset }) {
  const [exercises, setExercises] = useState(() => workout.exercises.map(e => ({ ...e })));
  const [name, setName] = useState(workout.name);

  const updateEx = (idx, field, val) => {
    setExercises(prev => prev.map((e, i) => i === idx ? { ...e, [field]: val } : e));
  };
  const addEx = () => setExercises(prev => [...prev, {
    id: `ex_${Date.now()}`, name: "New exercise", type: "S",
    sets: 3, reps: "5", logWeight: true, note: "",
  }]);
  const removeEx = (idx) => setExercises(prev => prev.filter((_, i) => i !== idx));
  const moveEx = (idx, dir) => {
    const next = [...exercises];
    const swapIdx = idx + dir;
    if (swapIdx < 0 || swapIdx >= next.length) return;
    [next[idx], next[swapIdx]] = [next[swapIdx], next[idx]];
    setExercises(next);
  };

  const inputStyle = {
    background: C.bg, border: `1px solid ${C.border}`,
    color: C.text, borderRadius: 6, padding: "4px 8px", fontSize: 13,
  };

  return (
    <div style={{ padding: "0 16px 32px" }}>
      {/* Workout name */}
      <div style={{ marginBottom: 16 }}>
        <div style={{ fontSize: 12, color: C.muted, marginBottom: 4 }}>Workout name</div>
        <input
          value={name} onChange={e => setName(e.target.value)}
          style={{ ...inputStyle, width: "100%", fontSize: 15 }}
        />
      </div>

      {/* Exercise rows */}
      {exercises.map((ex, idx) => (
        <div key={ex.id} style={{
          background: C.card, border: `1px solid ${C.border}`,
          borderRadius: 8, padding: 12, marginBottom: 8,
        }}>
          <div style={{ display: "flex", gap: 8, alignItems: "center", marginBottom: 8 }}>
            {/* Type selector */}
            <select
              value={ex.type}
              onChange={e => updateEx(idx, "type", e.target.value)}
              style={{ ...inputStyle, width: 52 }}
            >
              {Object.keys(WTYPE_META).map(t => (
                <option key={t} value={t}>{WTYPE_META[t].label}</option>
              ))}
            </select>
            {/* Name */}
            <input
              value={ex.name}
              onChange={e => updateEx(idx, "name", e.target.value)}
              style={{ ...inputStyle, flex: 1 }}
            />
            {/* Move up/down */}
            <button onClick={() => moveEx(idx, -1)} style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↑</button>
            <button onClick={() => moveEx(idx, 1)}  style={{ ...inputStyle, padding: "4px 7px", cursor: "pointer" }}>↓</button>
            {/* Delete */}
            <button onClick={() => removeEx(idx)} style={{ ...inputStyle, padding: "4px 7px", color: C.red, cursor: "pointer" }}>✕</button>
          </div>
          <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Sets</span>
              <input
                type="number" value={ex.sets ?? ""}
                onChange={e => updateEx(idx, "sets", e.target.value ? Number(e.target.value) : null)}
                style={{ ...inputStyle, width: 48 }}
              />
            </div>
            <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
              <span style={{ fontSize: 12, color: C.muted }}>Reps</span>
              <input
                value={ex.reps ?? ""}
                onChange={e => updateEx(idx, "reps", e.target.value || null)}
                style={{ ...inputStyle, width: 72 }}
              />
            </div>
            <label style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12, color: C.muted, cursor: "pointer" }}>
              <input
                type="checkbox" checked={!!ex.logWeight}
                onChange={e => updateEx(idx, "logWeight", e.target.checked)}
              />
              Log weight
            </label>
          </div>
          <div style={{ marginTop: 8 }}>
            <input
              value={ex.note || ""}
              onChange={e => updateEx(idx, "note", e.target.value)}
              placeholder="Note (optional)"
              style={{ ...inputStyle, width: "100%", fontSize: 12 }}
            />
          </div>
        </div>
      ))}

      <button onClick={addEx} style={{
        width: "100%", padding: "10px", marginBottom: 8,
        background: "transparent", border: `1px dashed ${C.border}`,
        color: C.muted, borderRadius: 8, cursor: "pointer", fontSize: 14,
      }}>+ Add exercise</button>

      <div style={{ display: "flex", gap: 8, marginTop: 8 }}>
        <button onClick={() => onSave(name, exercises)} style={{
          flex: 1, padding: "11px", background: C.blue, color: "#000",
          border: "none", borderRadius: 8, fontWeight: 700, cursor: "pointer", fontSize: 14,
        }}>Save</button>
        <button onClick={onClose} style={{
          flex: 1, padding: "11px", background: C.bg, color: C.text,
          border: `1px solid ${C.border}`, borderRadius: 8, cursor: "pointer", fontSize: 14,
        }}>Cancel</button>
        <button onClick={onReset} style={{
          padding: "11px 14px", background: C.bg, color: C.red,
          border: `1px solid ${C.red}`, borderRadius: 8, cursor: "pointer", fontSize: 13,
        }}>Reset</button>
      </div>
    </div>
  );
}

// ── Main WorkoutTab ───────────────────────────────────────────
function WorkoutTab({ unit, onSessionSaved, onBwSave = () => {}, trip = DEFAULT_TRIP }) {
  const [subTab, setSubTab]         = useState("today");
  const [plan,   setPlan]           = useState(() => loadLS(LS_WORKOUT_PLAN_KEY)  || DEFAULT_WORKOUTS);
  const [wState, setWState]         = useState(() => loadLS(LS_WORKOUT_STATE_KEY) || { rotationIndex: 0, sessionCount: 0 });
  const [wLog,   setWLog]           = useState(() => loadLS(LS_WORKOUT_LOG_KEY)   || []);
  const [sessionActive,  setSessionActive]  = useState(false);
  const [sessionData,    setSessionData]    = useState({});    // exId → {sets, done}
  const [swaps,          setSwaps]          = useState({});    // originalExId → substituteEx
  const [swapPickerFor,  setSwapPickerFor]  = useState(null);  // originalExId showing picker
  const [editingKey, setEditingKey] = useState(null);          // "A"|"B"|"C"|null

  const savePlan  = (p) => { setPlan(p);  saveLS(LS_WORKOUT_PLAN_KEY,  p); };
  const saveState = (s) => { setWState(s); saveLS(LS_WORKOUT_STATE_KEY, s); };
  const saveLog   = (l) => { setWLog(l);  saveLS(LS_WORKOUT_LOG_KEY,   l); };

  const rotKey    = WK_ROTATION[wState.rotationIndex % WK_ROTATION.length];
  // displayKey: the workout currently being previewed / logged. Defaults to the
  // recommendation (rotKey) but the user can override via the picker below.
  // If the user picks something other than rotKey and completes it, we log the
  // session but do NOT advance the rotation — so the "next up" queue persists.
  const [displayKey, setDisplayKey] = useState(rotKey);
  // If the recommendation changes (after a normal completion), reset the
  // displayed workout back to the new recommendation.
  useEffect(() => { setDisplayKey(rotKey); }, [rotKey]);
  const workout   = plan[displayKey] || plan[rotKey];
  const sessionN  = wState.sessionCount + 1;
  const wtr       = weeksToTrip(trip.date);

  // Switch the previewed workout. Clear any in-flight swaps since they
  // reference exercise IDs from the previous workout.
  const pickWorkout = (k) => {
    if (k === displayKey) return;
    setDisplayKey(k);
    setSwaps({});
    setSwapPickerFor(null);
  };

  // Previous best set weights for an exercise in this workout slot
  const prevBestSets = (exId) => {
    for (let i = wLog.length - 1; i >= 0; i--) {
      const e = wLog[i];
      if (e.workout === displayKey && e.exercises?.[exId]?.sets) {
        return e.exercises[exId].sets.map(s => s.weight).filter(Boolean);
      }
    }
    return [];
  };

  const startSession = () => {
    // Pre-populate weights and reps from last session for this workout
    const prevLog = [...wLog].reverse().find(e => e.workout === displayKey);
    const init = {};
    workout.exercises.forEach(ex => {
      const prevEx = prevLog?.exercises?.[ex.id];
      if (ex.logWeight && ex.sets) {
        init[ex.id] = {
          sets: Array.from({ length: ex.sets }, (_, i) => ({
            weight: prevEx?.sets?.[i]?.weight || "",
            reps:   prevEx?.sets?.[i]?.reps   || ex.reps || "",
            done: false,
          }))
        };
      } else {
        init[ex.id] = { done: false };
      }
    });
    setSessionData(init);
    setSwaps({});
    setSwapPickerFor(null);
    setSessionActive(true);
  };

  // Swap an exercise for the current session only
  const doSwap = (originalEx, substituteEx) => {
    const numSets = originalEx.sets || 2;
    setSessionData(prev => {
      const next = { ...prev };
      delete next[originalEx.id];
      next[substituteEx.id] = substituteEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: substituteEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => ({ ...prev, [originalEx.id]: { ...substituteEx, sets: numSets } }));
    setSwapPickerFor(null);
  };

  const revertSwap = (originalEx) => {
    const numSets = originalEx.sets || 2;
    const swapped = swaps[originalEx.id];
    setSessionData(prev => {
      const next = { ...prev };
      if (swapped) delete next[swapped.id];
      next[originalEx.id] = originalEx.logWeight
        ? { sets: Array.from({ length: numSets }, () => ({ weight: "", reps: originalEx.reps || "", done: false })) }
        : { done: false };
      return next;
    });
    setSwaps(prev => { const s = { ...prev }; delete s[originalEx.id]; return s; });
    setSwapPickerFor(null);
  };

  const genId = () => {
    try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2, 9)}`; }
  };

  const completeSession = () => {
    const session = { id: genId(), date: today(), completedAt: nowISO(), workout: displayKey, sessionNumber: sessionN, exercises: sessionData };
    // Read fresh from localStorage rather than the React state snapshot, which may
    // be stale if the migration effect rewrote the log after this component mounted.
    const freshLog = loadLS(LS_WORKOUT_LOG_KEY) || [];
    saveLog([...freshLog, session]);
    if (onSessionSaved) onSessionSaved(session);
    // Only advance the rotation when the recommended workout was actually done.
    // Picking a different workout (one that is not the recommended rotKey) logs
    // the session but leaves the rotation queue alone so nothing gets skipped.
    const didRecommended = displayKey === rotKey && WK_ROTATION.includes(displayKey);
    saveState({
      rotationIndex: didRecommended
        ? (wState.rotationIndex + 1) % WK_ROTATION.length
        : wState.rotationIndex,
      sessionCount: wState.sessionCount + 1,
    });
    setSessionActive(false);
    setSessionData({});
    setSwaps({});
    setSwapPickerFor(null);
  };

  const allDone = workout && workout.exercises.every(ex => {
    const activeId = swaps[ex.id]?.id ?? ex.id;
    const d = sessionData[activeId];
    if (!d) return false;
    if (ex.logWeight && d.sets) return d.sets.every(s => s.done);
    return !!d.done;
  });

  // ── Sub-tab pill bar ──
  const tabPill = (label, key) => (
    <button
      key={key}
      onClick={() => { setSubTab(key); setEditingKey(null); }}
      style={{
        flex: 1, padding: "9px 0", fontSize: 13, fontWeight: subTab === key ? 700 : 400,
        color: subTab === key ? C.blue : C.muted,
        background: "none", border: "none",
        borderBottom: subTab === key ? `2px solid ${C.blue}` : "2px solid transparent",
        cursor: "pointer",
      }}
    >{label}</button>
  );

  // ── Week calendar ──
  const WEEK_LABELS = ["Su", "Mo", "Tu", "We", "Th", "Fr", "Sa"];
  const WEEK_ROLES  = ["Climb", "Train", "Rest", "Climb+Train", "Rest", "Climb+Train", "Sabbath"];
  const todayDow    = new Date().getDay(); // 0=Sun

  // ── Render ──
  return (
    <div style={{ padding: "16px 16px 80px" }}>
      {/* Sub-tab nav */}
      <div style={{ display: "flex", borderBottom: `1px solid ${C.border}`, marginBottom: 20 }}>
        {tabPill("Today", "today")}
        {tabPill("Plan", "plan")}
      </div>

      {/* ─── TODAY view ─────────────────────────────────────── */}
      {subTab === "today" && !sessionActive && (
        <>
          {/* Workout card */}
          <Card style={{ marginBottom: 12 }}>
            {/* Workout picker — recommended is highlighted; pick any for this session */}
            <div style={{ display: "flex", gap: 6, marginBottom: 14 }}>
              {Object.keys(plan).map(k => {
                const isPicked = k === displayKey;
                const isRec    = k === rotKey;
                return (
                  <button key={k} onClick={() => pickWorkout(k)} style={{
                    flex: 1, padding: "10px 4px", borderRadius: 10, cursor: "pointer",
                    background: isPicked ? C.blue : C.border,
                    color:      isPicked ? "#000" : C.muted,
                    fontWeight: 700, fontSize: 14,
                    border: isRec ? `2px solid ${C.blue}` : "2px solid transparent",
                    position: "relative", transition: "all 0.15s",
                  }}>
                    {isRec && (
                      <div style={{
                        position: "absolute", top: -8, left: "50%", transform: "translateX(-50%)",
                        fontSize: 9, fontWeight: 700, background: C.blue, color: "#000",
                        padding: "1px 6px", borderRadius: 6, whiteSpace: "nowrap",
                        letterSpacing: "0.06em",
                      }}>
                        NEXT UP
                      </div>
                    )}
                    {k}
                  </button>
                );
              })}
            </div>

            <div style={{ display: "flex", alignItems: "flex-start", gap: 12, marginBottom: 14 }}>
              <div style={{ flex: 1, minWidth: 0 }}>
                <div style={{ fontSize: 11, color: C.muted, marginBottom: 2 }}>
                  WORKOUT {displayKey}
                  {displayKey === rotKey
                    ? "  ·  NEXT UP"
                    : <span style={{ color: C.orange }}>  ·  OUT OF ORDER — queue still starts with {rotKey}</span>
                  }
                </div>
                <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
                <div style={{ fontSize: 12, color: C.muted, marginTop: 3 }}>
                  {workout.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                </div>
              </div>
            </div>

            {/* Metrics row */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 16 }}>
              {[["Session #", sessionN], ["Weeks to trip", wtr]].map(([label, val]) => (
                <div key={label} style={{
                  background: C.bg, borderRadius: 8, padding: "10px 14px",
                  border: `1px solid ${C.border}`,
                }}>
                  <div style={{ fontSize: 11, color: C.muted }}>{label}</div>
                  <div style={{ fontSize: 24, fontWeight: 700, color: C.text }}>{val}</div>
                </div>
              ))}
            </div>

            {/* Exercise list — with swap UI on the preview card, so equipment
                substitutions can be set before starting the session. */}
            <div>
              {workout.exercises.map((ex, i) => {
                const isSwapped  = !!swaps[ex.id];
                const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
                const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
                const pickerOpen = swapPickerFor === ex.id;
                const isLast     = i === workout.exercises.length - 1;
                return (
                  <div key={ex.id}>
                    {subs.length > 0 && (
                      <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                        <button
                          onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                          style={{
                            fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                            background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                            color: isSwapped ? C.orange : C.muted,
                          }}
                        >
                          {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                        </button>
                      </div>
                    )}
                    {pickerOpen && (
                      <div style={{
                        background: C.bg, border: `1px solid ${C.border}`,
                        borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                      }}>
                        <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                          Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                        </div>
                        {isSwapped && (
                          <button
                            onClick={() => revertSwap(ex)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: C.border, border: "none", cursor: "pointer",
                              fontSize: 13, color: C.text, fontWeight: 600,
                            }}
                          >
                            ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                          </button>
                        )}
                        {subs.map(sub => (
                          <button
                            key={sub.id}
                            onClick={() => doSwap(ex, sub)}
                            style={{
                              display: "block", width: "100%", textAlign: "left",
                              padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                              background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                              border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                              cursor: "pointer", fontSize: 13, color: C.text,
                            }}
                          >
                            <span style={{ fontWeight: 600 }}>{sub.name}</span>
                            <span style={{ color: C.muted }}> · {sub.reps}</span>
                            {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                          </button>
                        ))}
                      </div>
                    )}
                    <ExerciseRow ex={activeEx} last={isLast} />
                  </div>
                );
              })}
            </div>

            <div style={{ marginTop: 16 }}>
              <BwPrompt unit={unit} onSave={onBwSave} />
            </div>
            <button
              onClick={startSession}
              style={{
                width: "100%", padding: "14px",
                background: C.blue, color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 16, cursor: "pointer",
              }}
            >Start session</button>
          </Card>

          {/* Week calendar */}
          <Card>
            <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 12, letterSpacing: 1 }}>THIS WEEK</div>
            <div style={{ display: "flex", justifyContent: "space-between" }}>
              {WEEK_LABELS.map((lbl, i) => {
                const isToday = i === todayDow;
                const role = WEEK_ROLES[i];
                const abbr = role === "Climb+Train" ? "CT" : role === "Sabbath" ? "S" : role[0];
                return (
                  <div key={lbl} style={{ textAlign: "center", flex: 1 }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 6 }}>{lbl}</div>
                    <div style={{
                      width: 34, height: 34, borderRadius: "50%", margin: "0 auto",
                      display: "flex", alignItems: "center", justifyContent: "center",
                      border: isToday ? `2px solid ${C.blue}` : `1px solid ${C.border}`,
                      background: isToday ? "#1a2d4a" : C.bg,
                      fontSize: 11, fontWeight: isToday ? 700 : 400,
                      color: isToday ? C.blue : C.muted,
                    }}>{abbr}</div>
                  </div>
                );
              })}
            </div>
          </Card>
        </>
      )}

      {/* ─── SESSION ACTIVE view ────────────────────────────── */}
      {subTab === "today" && sessionActive && (
        <Card>
          <div style={{ marginBottom: 16 }}>
            <div style={{ fontSize: 11, color: C.muted }}>WORKOUT {rotKey}  ·  SESSION #{sessionN}</div>
            <div style={{ fontSize: 20, fontWeight: 700, color: C.text }}>{workout.name}</div>
          </div>

          {workout.exercises.map((ex, i) => {
            const isSwapped  = !!swaps[ex.id];
            const activeEx   = isSwapped ? { ...swaps[ex.id] } : ex;
            const sKey       = activeEx.id;
            const subs       = EXERCISE_SUBSTITUTES[ex.id] || [];
            const pickerOpen = swapPickerFor === ex.id;
            const isLast     = i === workout.exercises.length - 1;

            return (
              <div key={ex.id}>
                {/* Swap button row */}
                {subs.length > 0 && (
                  <div style={{ display: "flex", justifyContent: "flex-end", marginBottom: 2 }}>
                    <button
                      onClick={() => setSwapPickerFor(pickerOpen ? null : ex.id)}
                      style={{
                        fontSize: 11, padding: "2px 8px", borderRadius: 4, cursor: "pointer",
                        background: "none", border: `1px solid ${isSwapped ? C.orange : C.border}`,
                        color: isSwapped ? C.orange : C.muted,
                      }}
                    >
                      {isSwapped ? `⇄ ${activeEx.name} (swapped)` : "⇄ swap"}
                    </button>
                  </div>
                )}

                {/* Inline swap picker */}
                {pickerOpen && (
                  <div style={{
                    background: C.bg, border: `1px solid ${C.border}`,
                    borderRadius: 8, padding: "10px 12px", marginBottom: 8,
                  }}>
                    <div style={{ fontSize: 11, color: C.muted, marginBottom: 8 }}>
                      Substitute for <strong style={{ color: C.text }}>{ex.name}</strong>:
                    </div>
                    {isSwapped && (
                      <button
                        onClick={() => revertSwap(ex)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: C.border, border: "none", cursor: "pointer",
                          fontSize: 13, color: C.text, fontWeight: 600,
                        }}
                      >
                        ↩ {ex.name} <span style={{ color: C.muted, fontWeight: 400 }}>(revert to original)</span>
                      </button>
                    )}
                    {subs.map(sub => (
                      <button
                        key={sub.id}
                        onClick={() => doSwap(ex, sub)}
                        style={{
                          display: "block", width: "100%", textAlign: "left",
                          padding: "8px 10px", marginBottom: 4, borderRadius: 6,
                          background: activeEx.id === sub.id ? C.orange + "22" : C.card,
                          border: `1px solid ${activeEx.id === sub.id ? C.orange : C.border}`,
                          cursor: "pointer", fontSize: 13, color: C.text,
                        }}
                      >
                        <span style={{ fontWeight: 600 }}>{sub.name}</span>
                        <span style={{ color: C.muted }}> · {sub.reps}</span>
                        {sub.note && <span style={{ color: C.muted, fontSize: 11 }}> — {sub.note}</span>}
                      </button>
                    ))}
                  </div>
                )}

                <SessionExRow
                  ex={activeEx}
                  unit={unit}
                  prevSets={prevBestSets(sKey)}
                  setsData={sessionData[sKey]}
                  onSetsChange={(val) => setSessionData(prev => ({ ...prev, [sKey]: val }))}
                  done={!!sessionData[sKey]?.done}
                  onToggle={() => setSessionData(prev => ({
                    ...prev,
                    [sKey]: { ...prev[sKey], done: !prev[sKey]?.done },
                  }))}
                  last={isLast && !pickerOpen}
                />
              </div>
            );
          })}

          <div style={{ display: "flex", gap: 10, marginTop: 20 }}>
            <button
              onClick={() => {
                if (allDone) {
                  completeSession();
                } else if (window.confirm("Some exercises aren't fully checked off — finish session anyway?")) {
                  completeSession();
                }
              }}
              style={{
                flex: 1, padding: "13px",
                background: allDone ? C.green : C.blue,
                color: "#000",
                border: "none", borderRadius: 10, fontWeight: 700,
                fontSize: 15, cursor: "pointer",
              }}
            >{allDone ? "Complete session ✓" : "Finish session →"}</button>
            <button
              onClick={() => { setSessionActive(false); setSessionData({}); setSwaps({}); setSwapPickerFor(null); }}
              style={{
                padding: "13px 16px", background: "transparent",
                border: `1px solid ${C.border}`, color: C.muted,
                borderRadius: 10, cursor: "pointer", fontSize: 14,
              }}
            >Abandon</button>
          </div>
        </Card>
      )}

      {/* ─── PLAN view ──────────────────────────────────────── */}
      {subTab === "plan" && (
        <>
          {editingKey ? (
            <WorkoutEditor
              wKey={editingKey}
              workout={plan[editingKey]}
              onSave={(name, exercises) => {
                savePlan({ ...plan, [editingKey]: { name, exercises } });
                setEditingKey(null);
              }}
              onClose={() => setEditingKey(null)}
              onReset={() => {
                if (window.confirm(`Reset Workout ${editingKey} to defaults?`)) {
                  savePlan({ ...plan, [editingKey]: DEFAULT_WORKOUTS[editingKey] });
                  setEditingKey(null);
                }
              }}
            />
          ) : (
            <>
              {/* Sequence rule callout */}
              <div style={{
                background: "#1a2d1a", border: `1px solid ${C.green}`,
                borderRadius: 8, padding: "10px 14px", marginBottom: 16,
                fontSize: 13, color: C.green,
              }}>
                <strong>A → B → C</strong>
                <span style={{ color: C.muted, fontWeight: 400 }}> · session-sequenced, not day-specific · C requires a rest day before climbing</span>
              </div>

              {/* Workout cards */}
              {["A", "B", "C"].map(key => {
                const wk = plan[key];
                const isNext = key === rotKey;
                return (
                  <Card key={key} style={{ marginBottom: 10, borderColor: isNext ? C.blue : C.border }}>
                    <div style={{ display: "flex", alignItems: "center", gap: 12, marginBottom: 12 }}>
                      <div style={{
                        width: 36, height: 36, borderRadius: 8, flexShrink: 0,
                        background: isNext ? "#1a2d4a" : C.bg,
                        border: `1px solid ${isNext ? C.blue : C.border}`,
                        display: "flex", alignItems: "center", justifyContent: "center",
                        fontSize: 16, fontWeight: 800, color: isNext ? C.blue : C.muted,
                      }}>{key}</div>
                      <div style={{ flex: 1 }}>
                        <div style={{ fontSize: 16, fontWeight: 700, color: C.text }}>{wk.name}</div>
                        <div style={{ fontSize: 12, color: C.muted, marginTop: 2 }}>
                          {wk.exercises.filter(e => e.type !== "X").map(e => e.name).join(" · ")}
                        </div>
                      </div>
                      <button
                        onClick={() => setEditingKey(key)}
                        style={{
                          padding: "6px 12px", background: "transparent",
                          border: `1px solid ${C.border}`, color: C.muted,
                          borderRadius: 6, cursor: "pointer", fontSize: 12,
                        }}
                      >Edit</button>
                    </div>
                    {wk.exercises.map((ex, i) => (
                      <ExerciseRow key={ex.id} ex={ex} last={i === wk.exercises.length - 1} />
                    ))}
                  </Card>
                );
              })}

              {/* Trip countdown — conjugate-friendly: countdown + taper window only */}
              {(() => {
                const cd = tripCountdown(trip.date);
                if (!cd) return null;
                const tripName = trip.name || "Trip";
                return (
                  <Card style={{ marginTop: 4 }}>
                    <div style={{ fontSize: 11, fontWeight: 700, color: C.muted, marginBottom: 10, letterSpacing: 1 }}>
                      {tripName.toUpperCase()} COUNTDOWN
                    </div>
                    {cd.past ? (
                      <div style={{ fontSize: 13, color: C.muted }}>
                        {cd.tripLabel} — trip date is in the past. Edit in Settings.
                      </div>
                    ) : (
                      <>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0", borderBottom: `1px solid ${C.border}` }}>
                          <div style={{ fontSize: 13, color: C.yellow, fontWeight: 600, minWidth: 90 }}>
                            {cd.weeks}wk · {cd.days}d
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            Until {tripName} ({cd.tripLabel})
                          </div>
                        </div>
                        <div style={{ display: "flex", gap: 10, padding: "7px 0" }}>
                          <div style={{
                            fontSize: 13,
                            color: cd.inTaper ? C.red : C.yellow,
                            fontWeight: 600, minWidth: 90,
                          }}>
                            {cd.inTaper ? "TAPER" : cd.taperLabel}
                          </div>
                          <div style={{ fontSize: 13, color: C.muted }}>
                            {cd.inTaper
                              ? "Cut volume 40%, hold intensity"
                              : "Taper window starts (T−7d)"}
                          </div>
                        </div>
                      </>
                    )}
                  </Card>
                );
              })()}
            </>
          )}
        </>
      )}
    </div>
  );
}

// ─────────────────────────────────────────────────────────────
// CLIMBING TAB
// Dedicated home for logging individual climbs and reviewing
// climbing history (discipline / grade / ascent style). Separate
// from finger-training zone coverage by design — climbing is not
// credited to Power / Strength / Capacity buckets.
// ─────────────────────────────────────────────────────────────
function ClimbingTab({ activities = [], onLogActivity = () => {}, onDeleteActivity = () => {} }) {
  const climbs = useMemo(
    () => activities
      .filter(a => a.type === "climbing")
      .slice()
      .sort((a, b) => (b.date || "").localeCompare(a.date || "")),
    [activities]
  );

  // Quick stats (last 30 days)
  const stats = useMemo(() => {
    const cutoff = new Date();
    cutoff.setDate(cutoff.getDate() - 30);
    const cutoffStr = ymdLocal(cutoff);
    const recent = climbs.filter(c => (c.date || "") >= cutoffStr);
    const sends  = recent.filter(c => c.ascent && c.ascent !== "attempt");
    return {
      total:  recent.length,
      sends:  sends.length,
      byDisc: CLIMB_DISCIPLINES.map(d => ({
        ...d,
        count: recent.filter(c => c.discipline === d.key).length,
      })),
    };
  }, [climbs]);

  return (
    <div style={{ padding: "16px 20px", maxWidth: 640, margin: "0 auto" }}>
      <Sect title="Log a climb">
        <ClimbingLogWidget activities={activities} onLog={onLogActivity} />
      </Sect>

      {climbs.length > 0 && (
        <Sect title="Last 30 days">
          <Card>
            <div style={{ display: "flex", gap: 12, marginBottom: 12 }}>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Climbs</div>
                <div style={{ fontSize: 22, fontWeight: 700 }}>{stats.total}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Sends</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.green }}>{stats.sends}</div>
              </div>
              <div style={{ flex: 1 }}>
                <div style={{ fontSize: 11, color: C.muted }}>Attempts</div>
                <div style={{ fontSize: 22, fontWeight: 700, color: C.muted }}>
                  {stats.total - stats.sends}
                </div>
              </div>
            </div>
            <div style={{ display: "flex", gap: 6, flexWrap: "wrap" }}>
              {stats.byDisc.filter(d => d.count > 0).map(d => (
                <div key={d.key} style={{
                  padding: "4px 10px", borderRadius: 999,
                  background: C.bg, border: `1px solid ${C.border}`,
                  fontSize: 12, color: C.muted,
                }}>
                  {d.emoji} {d.label} · {d.count}
                </div>
              ))}
            </div>
          </Card>
        </Sect>
      )}

      <Sect title="History">
        <ClimbingHistoryList climbs={climbs} onDeleteActivity={onDeleteActivity} />
      </Sect>
    </div>
  );
}

const TABS = ["Fingers", "Analysis", "Journey", "Workout", "Climbing", "History", "Trends", "Settings"];

export default function App() {
  // ── Auth ──────────────────────────────────────────────────
  const [user,       setUser]       = useState(null);
  const [loginEmail, setLoginEmail] = useState("");

  // ── Unit preference ───────────────────────────────────────
  const [unit, setUnit] = useState(() => loadLS("unit_pref") || "lbs");
  const saveUnit = (u) => { setUnit(u); saveLS("unit_pref", u); };

  // ── Body weight ───────────────────────────────────────────
  const [bodyWeight, setBodyWeight] = useState(() => loadLS(LS_BW_KEY) ?? null);
  const saveBW = (kg) => {
    setBodyWeight(kg);
    saveLS(LS_BW_KEY, kg);
    if (kg != null) {
      const log = loadLS(LS_BW_LOG_KEY) || [];
      const d = today();
      // Replace existing entry for today if present, otherwise append
      const updated = log.filter(e => e.date !== d);
      saveLS(LS_BW_LOG_KEY, [...updated, { date: d, kg }].sort((a, b) => a.date < b.date ? -1 : 1));
    }
  };

  // ── Trip (user-editable target trip) ──────────────────────
  const [trip, setTrip] = useState(() => {
    const stored = loadLS(LS_TRIP_KEY);
    return (stored && typeof stored === "object" && stored.date) ? stored : DEFAULT_TRIP;
  });
  const saveTrip = (next) => {
    const merged = { ...trip, ...next };
    setTrip(merged);
    saveLS(LS_TRIP_KEY, merged);
  };

  // ── Session notes ─────────────────────────────────────────
  const [notes, setNotes] = useState(() => loadLS(LS_NOTES_KEY) || {});
  const handleNoteChange = useCallback((sessKey, text) => {
    setNotes(prev => {
      const updated = text ? { ...prev, [sessKey]: text } : Object.fromEntries(
        Object.entries(prev).filter(([k]) => k !== sessKey)
      );
      saveLS(LS_NOTES_KEY, updated);
      return updated;
    });
  }, []);

  useEffect(() => {
    supabase.auth.getSession().then(({ data }) => setUser(data.session?.user ?? null));
    const { data: sub } = supabase.auth.onAuthStateChange((_e, s) => setUser(s?.user ?? null));
    return () => sub.subscription.unsubscribe();
  }, []);

  // ── History (all reps) ───────────────────────────────────
  const [history, setHistory] = useState(() => loadLS(LS_KEY) || []);
  useEffect(() => saveLS(LS_KEY, history), [history]);

  // App-level freshMap (fatigue-adjusted load lookup per rep). Lifted out
  // of SetupView so the in-workout startSession path uses the SAME memo
  // — without this, SetupView's prescription would compute with the
  // user-fitted doseK while startSession would fall back to DEF_DOSE_K
  // and produce a 1-2 lb discrepancy between Setup's "Prescribed load"
  // card and the in-workout "Rep 1 suggested weight." Sharing the memo
  // makes the two views byte-identical.
  const freshMapFp = useMemo(() => {
    const last = history[history.length - 1];
    return `${history.length}|${last?.id ?? ""}|${last?.date ?? ""}`;
  }, [history]);
  const freshMap = useMemo(() => {
    const k = fitDoseK(history) ?? PHYS_MODEL_DEFAULT.doseK;
    return buildFreshLoadMap(history, { doseK: k });
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Track how many reps are waiting to be synced to Supabase.
  const [pendingCount, setPendingCount] = useState(() => (loadLS(LS_QUEUE_KEY) || []).length);
  const refreshPending = () => setPendingCount((loadLS(LS_QUEUE_KEY) || []).length);

  // Load from Supabase when signed in; reconcile any offline reps first.
  //
  // Flow:
  //   1. flushQueue() — retry reps that failed a previous authenticated push.
  //   2. fetchReps() — grab the current remote state.
  //   3. Reconcile — find local reps not present remotely (identified by
  //      session_id + set_num + rep_num + hand) and push those. This is
  //      the critical step: reps added while logged out live only in LS,
  //      and without this step they'd be overwritten by setHistory(remote).
  //   4. Re-fetch after pushes so state reflects the full merged set.
  //
  // Only replace local history if Supabase actually returned rows — an empty
  // response (expired JWT silently blocked by RLS, network hiccup, etc.) must
  // never wipe out a good local cache.
  useEffect(() => {
    if (!user) return;
    let cancelled = false;
    (async () => {
      const flushed = await flushQueue();
      if (!cancelled && flushed > 0) refreshPending();

      const remote = await fetchReps();
      if (cancelled) return;

      if (remote) {
        // Reconcile local-only reps (offline sessions) up to the cloud.
        const localReps = loadLS(LS_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remote.map(keyFor));
        const toSync = localReps.filter(r => !remoteKeys.has(keyFor(r)));

        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        if (cancelled) return;

        // If we pushed offline reps, refetch so state includes them with
        // proper server-assigned ids. Otherwise use the first fetch.
        const finalReps = pushedAny ? (await fetchReps()) : remote;
        if (cancelled) return;
        if (finalReps && finalReps.length > 0) setHistory(finalReps);
      }

      if (!cancelled) refreshPending();
    })();
    return () => { cancelled = true; };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  // ── Workout session sync ─────────────────────────────────
  const markSynced = (id) => {
    if (!id) return;
    const s = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
    s.add(id);
    saveLS(LS_WORKOUT_SYNCED_KEY, [...s]);
  };

  const handleWorkoutSessionSaved = useCallback(async (session) => {
    if (!user) return;
    const ok = await pushWorkoutSession(session);
    if (ok) markSynced(session.id);
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (!user) return;
    fetchWorkoutSessions().then(async (remote) => {
      const local = loadLS(LS_WORKOUT_LOG_KEY) || [];

      // Mark all remote sessions as synced
      const remoteIds = new Set((remote || []).map(s => s.id).filter(Boolean));
      const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
      remoteIds.forEach(id => synced.add(id));

      // Merge any remote sessions not yet in local, skipping tombstoned deletions
      const localIds = new Set(local.map(s => s.id).filter(Boolean));
      const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
      const merged = [...local, ...(remote || []).filter(s => !localIds.has(s.id) && !deletedIds.has(s.id))];
      if (merged.length > local.length) saveLS(LS_WORKOUT_LOG_KEY, merged);

      // ── One-time migration: push local sessions missing from Supabase ──
      // Assign IDs to old sessions that never got one, then push all unsynced
      let changed = false;
      const genId = () => { try { return crypto.randomUUID(); } catch { return `ws_${Date.now()}_${Math.random().toString(36).slice(2,9)}`; } };
      const toMigrate = merged.map(s => {
        if (!s.id) { changed = true; return { ...s, id: genId() }; }
        return s;
      });
      if (changed) saveLS(LS_WORKOUT_LOG_KEY, toMigrate);

      for (const s of toMigrate) {
        if (!remoteIds.has(s.id) && !deletedIds.has(s.id)) {
          const ok = await pushWorkoutSession(s);
          if (ok) synced.add(s.id);
        }
      }

      saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const addReps = useCallback((newReps) => {
    setHistory(h => {
      const existing = new Set(h.map(r => r.id));
      const fresh    = newReps.filter(r => !existing.has(r.id));
      return [...fresh, ...h];
    });
    if (user) {
      // Push each rep; enqueue any that fail for later retry.
      newReps.forEach(rep => {
        pushRep(rep).then(ok => {
          if (!ok) { enqueueReps([rep]); refreshPending(); }
        });
      });
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateSession = useCallback(async (sessionKey, updates) => {
    // updates: { hand?, grip?, target_duration? }
    setHistory(h => h.map(r =>
      (r.session_id || r.date) === sessionKey ? { ...r, ...updates } : r
    ));
    if (user) {
      const { error } = await supabase.from("reps")
        .update(updates)
        .eq("session_id", sessionKey);
      if (error) console.warn("Supabase update:", error.message);
    }
  }, [user]);

  // Rep-level identity: prefer Supabase id, fall back to composite key
  const repMatchKey = (r) =>
    r.id ? `id:${r.id}` : `${r.session_id || r.date}|${r.set_num}|${r.rep_num}`;

  const deleteRep = useCallback(async (rep) => {
    const k = repMatchKey(rep);
    setHistory(h => h.filter(r => repMatchKey(r) !== k));
    if (user && rep.id) {
      const { error } = await supabase.from("reps").delete().eq("id", rep.id);
      if (error) console.warn("Supabase deleteRep:", error.message);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const updateRep = useCallback(async (rep, updates) => {
    const k = repMatchKey(rep);
    setHistory(h => h.map(r => repMatchKey(r) === k ? { ...r, ...updates } : r));
    if (user && rep.id) {
      const { error } = await supabase.from("reps").update(updates).eq("id", rep.id);
      if (error) console.warn("Supabase updateRep:", error.message);
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  const deleteSession = useCallback(async (sessionKey) => {
    // sessionKey is session_id or date (same key used in grouping)
    setHistory(h => h.filter(r => (r.session_id || r.date) !== sessionKey));
    if (user) {
      // Fetch the ids to delete (already removed from state, use a snapshot)
      // Delete from Supabase by session_id if available, else by date
      const { error } = await supabase.from("reps").delete()
        .or(`session_id.eq.${sessionKey},and(session_id.is.null,date.eq.${sessionKey})`);
      if (error) console.warn("Supabase delete:", error.message);
    }
  }, [user]);

  // ── Tab ───────────────────────────────────────────────────
  const [tab, setTab] = useState(0);

  // ── Readiness score ───────────────────────────────────────
  const computedReadiness = useMemo(() => computeReadiness(history), [history]);

  // Subjective daily check-in: { [date]: 1-5 }
  const [subjReadiness, setSubjReadiness] = useState(() => loadLS(LS_READINESS_KEY) || {});
  const todaySubj = subjReadiness[today()] ?? null; // null = not rated yet today

  const handleSubjReadiness = useCallback((val) => {
    setSubjReadiness(prev => {
      const updated = { ...prev, [today()]: val };
      saveLS(LS_READINESS_KEY, updated);
      return updated;
    });
  }, []);

  // Displayed readiness: subjective if rated today, otherwise computed estimate
  const readiness = todaySubj != null ? subjToScore(todaySubj) : computedReadiness;

  // ── Live CF/W′ estimate (all failure reps, both hands, all grips) ─────────────
  // Used by SessionPlannerCard and AnalysisView. Updates as training data grows.
  // All-grip adaptive fit — used as the overall curve when no single
  // grip is in focus (e.g. Badges view, fallback when user hasn't yet
  // picked a grip in Setup).
  //
  // Depends on freshMapFp (length+lastId+lastDate) instead of [history]
  // directly, same as freshMap, so unrelated state churn (cloud syncs
  // that touch the array reference without changing data) doesn't
  // re-fire the O(N) fit.
  const liveEstimate = useMemo(() => {
    const allFails = history.filter(r => r.failed && r.avg_force_kg > 0 && r.actual_time_s > 0);
    return fitAdaptiveHandCurve(allFails);
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Per-grip adaptive fits. FDP and FDS are different muscles (pinch /
  // open-hand roller vs crush roller) with separate force-duration
  // curves; pooling them hides per-muscle training decisions. Each
  // grip gets its own Monod fit so the recommendation engine can pick
  // the right zone for the specific muscle being trained. Same
  // freshMapFp memoization rationale as liveEstimate above.
  const gripEstimates = useMemo(() => {
    const fails = history.filter(r => r.failed && r.grip && r.avg_force_kg > 0 && r.actual_time_s > 0);
    const byGrip = {};
    for (const r of fails) {
      if (!byGrip[r.grip]) byGrip[r.grip] = [];
      byGrip[r.grip].push(r);
    }
    const out = {};
    for (const [grip, rows] of Object.entries(byGrip)) {
      const fit = fitAdaptiveHandCurve(rows);
      if (fit) out[grip] = fit;
    }
    return out;
  }, [freshMapFp]); // eslint-disable-line react-hooks/exhaustive-deps

  // Permanent baseline snapshot — set once from the earliest training data,
  // never overwritten. Seeded automatically (below) from the first few
  // failure reps spanning ≥2 zones.
  const [baseline, setBaseline] = useState(() => loadLS(LS_BASELINE_KEY));
  const [activities, setActivities] = useState(() => loadLS(LS_ACTIVITY_KEY) || []);

  // ── Auto-baseline ─────────────────────────────────────────
  // Seed the CF/W′ reference point from real training data instead of
  // requiring a formal calibration session. Fires once we have ≥3 failure
  // reps spanning ≥2 distinct target durations (so the Monod-Scherrer fit
  // has some spread to work with). The snapshot is dated to the earliest
  // rep in the seed set so "improvement" counts from when you started.
  useEffect(() => {
    if (baseline) return;
    const failures = history
      .filter(r =>
        r.failed &&
        r.avg_force_kg > 0 && r.avg_force_kg < 500 &&
        r.actual_time_s > 0
      )
      .sort((a, b) => (a.date || "").localeCompare(b.date || ""));
    const acc = [];
    const durs = new Set();
    for (const r of failures) {
      acc.push(r);
      durs.add(r.target_duration);
      if (acc.length >= 3 && durs.size >= 2) {
        const pts = acc.map(x => ({ x: 1 / x.actual_time_s, y: x.avg_force_kg }));
        const fit = fitCF(pts);
        if (fit) {
          const snap = { date: acc[0].date, CF: fit.CF, W: fit.W };
          saveLS(LS_BASELINE_KEY, snap);
          setBaseline(snap);
        }
        return;
      }
    }
  }, [history, baseline]);

  // Genesis badge snapshot — saved the first time all 3 zones have a session.
  // Must be declared BEFORE the detection useEffect below.
  const [genesisSnap, setGenesisSnap] = useState(() => loadLS(LS_GENESIS_KEY));

  // ── Genesis badge detection ───────────────────────────────
  // Snapshot CF/W′ the first time the user has logged at least one session
  // in each zone (Power 10s, Strength 45s, Capacity 120s). This becomes
  // the immutable baseline for all subsequent badge progress calculations.
  useEffect(() => {
    if (genesisSnap) return;           // already earned
    if (!liveEstimate) return;         // no curve yet
    const hasPower    = history.some(r => r.target_duration === 10);
    const hasStrength = history.some(r => r.target_duration === 45);
    const hasCapacity = history.some(r => r.target_duration === 120);
    if (hasPower && hasStrength && hasCapacity) {
      const auc  = computeAUC(liveEstimate.CF, liveEstimate.W);
      const snap = { date: today(), CF: liveEstimate.CF, W: liveEstimate.W, auc };
      saveLS(LS_GENESIS_KEY, snap);
      setGenesisSnap(snap);
    }
  }, [history, liveEstimate, genesisSnap]);

  const addActivity = useCallback((act) => {
    setActivities(prev => {
      const next = [...prev, { ...act, id: uid() }];
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);

  const deleteActivity = useCallback((id) => {
    setActivities(prev => {
      const next = prev.filter(a => a.id !== id);
      saveLS(LS_ACTIVITY_KEY, next);
      return next;
    });
  }, []);

  // ── Session Config ────────────────────────────────────────
  // hand is hard-coded to "Both": the user always trains both hands, either
  // alternating per rep or doing all-L-then-all-R. There's no UI toggle for
  // this anymore; it lives in config only so existing downstream code keeps
  // working.
  //
  // altMode is NOT stored here anymore — it's derived from restTime and
  // targetTime via configWithDerived below. Storing it as state was a bug
  // surface: any callsite doing setConfig({...altMode: true}) would have
  // its value silently overwritten on the next render, hiding the change.
  // Compute-on-read removes that footgun entirely.
  const [rawConfig, setConfig] = useState(() => ({
    hand:       "Both",
    grip:       "",
    goal:       "",  // "power" | "strength" | "endurance" — set when SessionPlanner plan is applied
    repsPerSet: 5,
    numSets:    3,
    targetTime: 45,
    restTime:   20,
    setRestTime: 180,
  }));

  // Augment rawConfig with derived altMode so every downstream reader
  // (handleRepDone, handleRestDone, SessionPlanner ETA, SetupView, etc.)
  // sees the right value without anyone having to remember to derive it.
  // setConfig still operates on rawConfig — any caller that tries to
  // setConfig({altMode: ...}) will be silently no-oped on the altMode
  // key, which is the desired behavior since altMode is fully derived
  // from restTime/targetTime. Worth doing this rather than a useEffect
  // that overwrites altMode in state, which had a stale-write race.
  const config = useMemo(() => ({
    ...rawConfig,
    altMode: rawConfig.restTime >= rawConfig.targetTime,
  }), [rawConfig]);

  // ── Session State Machine ─────────────────────────────────
  // phase: 'idle' | 'rep_ready' | 'rep_active' | 'resting' | 'between_sets' | 'switch_hands' | 'alt_switch' | 'done'
  const [phase,       setPhase]       = useState("idle");
  const [currentSet,  setCurrentSet]  = useState(0);
  const [currentRep,  setCurrentRep]  = useState(0);
  const [fatigue,     setFatigue]     = useState(0);
  const [sessionReps, setSessionReps] = useState([]);
  const [sessionId,        setSessionId]        = useState("");
  const [sessionStartedAt, setSessionStartedAt] = useState("");
  const [refWeights,       setRefWeights]        = useState({});
  const [lastRepResult, setLastRepResult] = useState(null);
  const [leveledUp,   setLeveledUp]   = useState(false);
  const [newLevel,    setNewLevel]    = useState(1);
  const [activeHand,  setActiveHand]  = useState("L"); // tracks current hand in Both mode
  const [altHandRep,  setAltHandRep]  = useState(false); // true while doing the interleaved alt-hand rep
  const [altRestTime, setAltRestTime] = useState(0);     // rest after alt rep = restTime − actual alt rep time

  // Max strength estimate (for fatigue dose calculation)
  // Use post-session-1 best; fall back to baseline (first session); then 20 kg if no data
  const sMaxL = useMemo(() => {
    const best = getBestLoad(history, "L", config.grip, config.targetTime)
               || getBaseline(history, "L", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);
  const sMaxR = useMemo(() => {
    const best = getBestLoad(history, "R", config.grip, config.targetTime)
               || getBaseline(history, "R", config.grip, config.targetTime);
    return best ? best * 1.2 : 20;
  }, [history, config.grip, config.targetTime]);

  // ── Tindeq ────────────────────────────────────────────────
  const tindeq = useTindeq();

  // ── Start session ─────────────────────────────────────────
  // refWeights drives the in-workout "Rep 1 suggested weight" display
  // and the weight that gets recorded against each rep. Prescribed via
  // the same model-based path as the Setup card (prescribedLoad,
  // i.e. Monod CF + W'/T) so the two views agree. Falls back to the
  // older empirical historical-average estimate when there isn't
  // enough data to fit Monod, then to whatever the user configured
  // as a last resort.
  const startSession = useCallback(() => {
    const sid = uid();
    const rw = {};
    // Empirical-first prescription path (matches the Setup card's
    // "Train at" cell). Cold-start fallbacks: per-grip Monod, then
    // cross-grip Monod, then historical average. Same chain the
    // Setup card uses, so the in-workout suggested weight matches
    // the Setup card to the kg.
    ["L", "R"].forEach(h => {
      rw[h] = empiricalPrescription(history, h, config.grip, config.targetTime)
           ?? prescribedLoad(history, h, config.grip, config.targetTime, freshMap)
           ?? prescribedLoad(history, h, null,        config.targetTime, freshMap)
           ?? estimateRefWeight(history, h, config.grip, config.targetTime);
    });
    const startedAt = nowISO();
    setSessionId(sid);
    setSessionStartedAt(startedAt);
    setRefWeights(rw);
    setSessionReps([]);
    setCurrentSet(0);
    setCurrentRep(0);
    setFatigue(0);
    setLeveledUp(false);
    setLastRepResult(null);
    setActiveHand(config.hand === "Both" ? "L" : config.hand);
    setAltHandRep(false);
    setPhase("rep_ready");
    setTab(0); // stay on Train tab
  }, [history, config, freshMap]);

  // ── Handle rep completion ─────────────────────────────────
  const handleRepDone = useCallback(({ actualTime, avgForce, failed = false }) => {
    const effectiveHand = config.hand === "Both" ? activeHand : config.hand;
    // Weight is constant across the set — no within-set fatigue discount.
    // The rep-time curve (actual_time_s) is what reflects fatigue and feeds
    // the next session's prescription via Monod.
    const weight = (() => {
      const ws = [suggestWeight(refWeights[effectiveHand], 0)].filter(Boolean);
      return ws.length > 0 ? ws[0] : 0;
    })();

    const roundedActual = Math.round(actualTime * 10) / 10;
    const derivedFailed = failed || isShortfall(roundedActual, config.targetTime);
    const repRecord = {
      id:              uid(),
      date:            today(),
      grip:            config.grip,
      hand:            effectiveHand,
      target_duration: config.targetTime,
      weight_kg:       Math.round(weight * 10) / 10,
      actual_time_s:   roundedActual,
      avg_force_kg:    (isFinite(avgForce) && avgForce > 0 && avgForce < 500)
                         ? Math.round(avgForce * 10) / 10
                         : null,
      set_num:         currentSet + 1,
      rep_num:         currentRep + 1,
      rest_s:             config.restTime,
      session_id:         sessionId,
      failed:             derivedFailed,
      session_started_at: sessionStartedAt || null,
    };

    setLastRepResult({ actualTime, avgForce, targetTime: config.targetTime });
    setSessionReps(reps => [...reps, repRecord]);
    addReps([repRecord]);

    // Update fatigue
    const sMax = config.hand === "R" ? sMaxR : sMaxL;
    const dose = fatigueDose(weight, actualTime, sMax);
    setFatigue(f => Math.min(f + dose, 0.95));

    // ── Alternating mode: interleave both hands rep-by-rep ────
    if (config.altMode && config.hand === "Both") {
      if (!altHandRep) {
        // Just finished primary hand — immediately switch to alt hand (no rest yet)
        setAltHandRep(true);
        setActiveHand(h => h === "L" ? "R" : "L");
        setPhase("alt_switch");
      } else {
        // Just finished alt hand — rest for (restTime − actual alt rep time), then back to primary
        setAltHandRep(false);
        setActiveHand(h => h === "L" ? "R" : "L"); // back to primary
        const rest = Math.max(5, config.restTime - Math.round(repRecord.actual_time_s));
        setAltRestTime(rest);
        const nextRep = currentRep + 1;
        if (nextRep >= config.repsPerSet) {
          const nextSet = currentSet + 1;
          if (nextSet >= config.numSets) {
            finishSession([...sessionReps, repRecord]);
          } else {
            setCurrentSet(nextSet);
            setCurrentRep(0);
            setFatigue(0);
            setPhase("between_sets");
          }
        } else {
          setCurrentRep(nextRep);
          setPhase("resting");
        }
      }
      return;
    }

    // ── Standard mode ─────────────────────────────────────────
    const nextRep = currentRep + 1;
    if (nextRep >= config.repsPerSet) {
      // Set complete
      const nextSet = currentSet + 1;
      if (nextSet >= config.numSets) {
        // All sets done for this hand
        if (config.hand === "Both" && activeHand === "L") {
          // Switch to right hand
          setCurrentSet(0);
          setCurrentRep(0);
          setFatigue(0);
          setActiveHand("R");
          setPhase("switch_hands");
        } else {
          finishSession([...sessionReps, repRecord]);
        }
      } else {
        setCurrentSet(nextSet);
        setCurrentRep(0);
        setFatigue(0);
        setPhase("between_sets");
      }
    } else {
      setCurrentRep(nextRep);
      setPhase("resting");
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config, currentRep, currentSet, fatigue, refWeights, sessionId, sessionStartedAt, sessionReps, addReps, sMaxL, sMaxR, activeHand]);

  const finishSession = useCallback((allReps) => {
    // Check for level up
    const hands = config.hand === "Both" ? ["L","R"] : [config.hand];
    let leveled = false;
    let maxNewLevel = 1;
    for (const h of hands) {
      const combined = [...history, ...allReps.filter(r => r.hand === h || r.hand === "B")];
      const oldLevel = calcLevel(history, h, config.grip, config.targetTime);
      const newLvl   = calcLevel(combined, h, config.grip, config.targetTime);
      if (newLvl > oldLevel) { leveled = true; maxNewLevel = Math.max(maxNewLevel, newLvl); }
    }
    setLeveledUp(leveled);
    setNewLevel(maxNewLevel);
    setPhase("done");
  }, [config, history]);

  const handleRestDone = useCallback(() => {
    const restUsed = config.altMode && config.hand === "Both" ? altRestTime : config.restTime;
    setFatigue(f => fatigueAfterRest(f, restUsed));
    // When Tindeq is connected, go to rep_ready so AutoRepSessionView can arm
    // auto-detection and wait for the next pull. When not connected, auto-start
    // the countdown so the user doesn't need to tap Start Rep.
    setPhase(tindeq.connected ? "rep_ready" : "rep_active");
  }, [config.altMode, config.hand, config.restTime, altRestTime, tindeq.connected]);

  const handleNextSet = useCallback(() => {
    setFatigue(0);
    setPhase("rep_ready");
  }, []);

  const handleAbort = useCallback(() => {
    if (sessionReps.length > 0) finishSession(sessionReps);
    else setPhase("idle");
  }, [sessionReps, finishSession]);

  // Compute next rep suggestion for rest screen — same constant set weight.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  const nextWeight = useMemo(() => {
    if (phase !== "resting") return null;
    const hand = config.hand === "Both" ? activeHand : config.hand;
    return suggestWeight(refWeights[hand], 0);
  }, [phase, config.hand, refWeights, activeHand]);

  // ── Manual cloud pull ─────────────────────────────────────
  // User-triggered refresh. Flushes any queued local reps first, then
  // refetches reps + workout_sessions from Supabase and merges into state.
  // Without this, devices only fetch once at auth; a workout pushed from
  // device A is invisible on device B until B is reloaded.
  const [pullStatus, setPullStatus] = useState("idle"); // 'idle' | 'pulling' | 'ok' | 'err'
  const [lastPulledAt, setLastPulledAt] = useState(null);
  const pullFromCloud = useCallback(async () => {
    if (!user) return;
    setPullStatus("pulling");
    try {
      const flushed = await flushQueue();
      if (flushed > 0) refreshPending();

      // Reps — reconcile any local-only reps before overwriting state.
      const remoteReps = await fetchReps();
      if (remoteReps) {
        const localReps = loadLS(LS_KEY) || [];
        const keyFor = r => `${r.session_id || r.date}|${r.set_num}|${r.rep_num}|${r.hand}`;
        const remoteKeys = new Set(remoteReps.map(keyFor));
        const toSync = localReps.filter(r => !remoteKeys.has(keyFor(r)));
        let pushedAny = false;
        for (const rep of toSync) {
          const ok = await pushRep(rep);
          if (ok) pushedAny = true;
          else enqueueReps([rep]);
        }
        const finalReps = pushedAny ? (await fetchReps()) : remoteReps;
        if (finalReps && finalReps.length > 0) setHistory(finalReps);
      }

      // Workout sessions — merge into localStorage (skipping tombstoned ids).
      // WorkoutView re-reads LS on mount, so new workouts appear once the
      // user next navigates there; we trigger a reload below to make them
      // visible immediately across all tabs that use those memos.
      let workoutChanged = false;
      const remote = await fetchWorkoutSessions();
      if (remote) {
        const local      = loadLS(LS_WORKOUT_LOG_KEY) || [];
        const localIds   = new Set(local.map(s => s.id).filter(Boolean));
        const deletedIds = new Set(loadLS(LS_WORKOUT_DELETED_KEY) || []);
        const additions  = remote.filter(s => !localIds.has(s.id) && !deletedIds.has(s.id));
        if (additions.length > 0) {
          saveLS(LS_WORKOUT_LOG_KEY, [...local, ...additions]);
          workoutChanged = true;
        }
        const synced = new Set(loadLS(LS_WORKOUT_SYNCED_KEY) || []);
        remote.forEach(s => s.id && synced.add(s.id));
        saveLS(LS_WORKOUT_SYNCED_KEY, [...synced]);
      }

      refreshPending();
      setLastPulledAt(Date.now());
      setPullStatus("ok");

      // If we merged in new workout_sessions from the cloud, reload so the
      // WorkoutView (which reads LS on mount) picks them up immediately.
      // Reps/history live in App state so they appear without reload.
      if (workoutChanged) {
        setTimeout(() => window.location.reload(), 400);
      }
    } catch (e) {
      console.warn("pullFromCloud failed:", e?.message);
      setPullStatus("err");
    }
  }, [user]); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Auth helpers (6-digit OTP) ────────────────────────────
  // We intentionally don't pass emailRedirectTo: users type the 6-digit
  // code into the app instead of clicking a magic link. This avoids the
  // Android "link opens in Gmail's in-app browser, session never reaches
  // Chrome" class of failures.
  //
  // IMPORTANT: Requires the Supabase "Magic Link" email template to
  // include {{ .Token }} so users actually see the code in their email.
  // Update at: Supabase dashboard -> Authentication -> Email Templates.
  const [otpSent,  setOtpSent]  = useState(false);
  const [otpCode,  setOtpCode]  = useState("");
  const [otpBusy,  setOtpBusy]  = useState(false);
  const [otpError, setOtpError] = useState(null);

  const sendOtp = async () => {
    if (!loginEmail || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.signInWithOtp({
      email: loginEmail,
      options: { shouldCreateUser: true },
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    setOtpSent(true);
    setOtpCode("");
  };

  const verifyOtp = async () => {
    const token = (otpCode || "").replace(/\s+/g, "");
    if (!loginEmail || !token || otpBusy) return;
    setOtpBusy(true);
    setOtpError(null);
    const { error } = await supabase.auth.verifyOtp({
      email: loginEmail,
      token,
      type: "email",
    });
    setOtpBusy(false);
    if (error) { setOtpError(error.message); return; }
    // Success: onAuthStateChange will set `user` and trigger the history fetch.
    setOtpSent(false);
    setOtpCode("");
  };

  const cancelOtp = () => {
    setOtpSent(false);
    setOtpCode("");
    setOtpError(null);
  };

  const signOut = async () => { await supabase.auth.signOut(); };

  // ── Render ────────────────────────────────────────────────
  return (
    <div style={base}>
      {/* Top nav */}
      <div style={{
        background: C.card, borderBottom: `1px solid ${C.border}`,
        display: "flex", alignItems: "center", padding: "0 16px",
        position: "sticky", top: 0, zIndex: 100,
      }}>
        <div style={{ fontSize: 16, fontWeight: 800, color: C.blue, marginRight: 16, padding: "14px 0" }}>
          🧗 Finger
        </div>
        {TABS.map((t, i) => (
          <button
            key={t}
            onClick={() => { setTab(i); if (i === 0 && phase !== "idle") {/* stay in session */} }}
            style={{
              padding: "14px 12px", fontSize: 13, fontWeight: tab === i ? 700 : 400,
              color: tab === i ? C.blue : C.muted, background: "none", border: "none",
              borderBottom: tab === i ? `2px solid ${C.blue}` : "2px solid transparent",
              cursor: "pointer", whiteSpace: "nowrap",
            }}
          >
            {t}
            {t === "Fingers" && phase !== "idle" && (
              <span style={{ marginLeft: 4, background: C.red, color: "#fff", borderRadius: 10, fontSize: 10, padding: "1px 5px" }}>●</span>
            )}
          </button>
        ))}
        {tindeq.connected && (
          <div style={{ marginLeft: "auto", fontSize: 11, color: C.green }}>⚡ Tindeq</div>
        )}
      </div>

      {/* Unsaved reps warning banner */}
      {pendingCount > 0 && (
        <div style={{
          background: "#3a1f00", borderBottom: `1px solid ${C.orange}`,
          padding: "8px 16px", display: "flex", alignItems: "center", gap: 10,
          fontSize: 13, color: C.orange,
        }}>
          <span>⚠️</span>
          <span>
            {pendingCount} rep{pendingCount !== 1 ? "s" : ""} couldn't sync to the cloud.
            {user ? " Retrying…" : " Sign in to retry."}
          </span>
          {user && (
            <button onClick={() => flushQueue().then(refreshPending)} style={{
              marginLeft: "auto", background: "none", border: `1px solid ${C.orange}`,
              color: C.orange, borderRadius: 6, padding: "2px 10px", cursor: "pointer", fontSize: 12,
            }}>Retry now</button>
          )}
        </div>
      )}

      {/* Train tab */}
      {tab === 0 && (() => {
        if (phase === "idle") {
          const tindeqConnectCard = (
            <div style={{ marginBottom: 12 }}>
              <Card>
                <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between" }}>
                  <div>
                    <div style={{ fontSize: 14, fontWeight: 600 }}>Tindeq Progressor</div>
                    <div style={{ fontSize: 12, color: C.muted }}>
                      {tindeq.connected ? "Connected ✓" : tindeq.reconnecting ? "Reconnecting…" : tindeq.bleError || "Not connected"}
                    </div>
                  </div>
                  <div style={{ display: "flex", gap: 8 }}>
                    {tindeq.connected && (
                      <Btn small onClick={tindeq.tare} color={C.muted}>Tare</Btn>
                    )}
                    <Btn
                      small
                      onClick={tindeq.connect}
                      disabled={tindeq.connected || tindeq.reconnecting}
                      color={tindeq.connected ? C.green : tindeq.reconnecting ? C.orange : C.blue}
                    >
                      {tindeq.connected ? "Connected" : tindeq.reconnecting ? "Reconnecting…" : "Connect BLE"}
                    </Btn>
                  </div>
                </div>
                {tindeq.connected && (
                  <div style={{ marginTop: 8, fontSize: 13, color: C.text }}>
                    Live force: <b style={{ color: C.blue }}>{fmtW(tindeq.force, unit)} {unit}</b>
                    <span style={{ marginLeft: 12, color: C.muted, fontSize: 12 }}>
                      (tap Tare to zero before your session)
                    </span>
                  </div>
                )}
                {tindeq.bleError && (
                  <div style={{ marginTop: 8, fontSize: 12, color: C.red }}>{tindeq.bleError}</div>
                )}
              </Card>
            </div>
          );
          return (
            <SetupView
              config={config}
              setConfig={setConfig}
              onStart={startSession}
              history={history}
              freshMap={freshMap}
              unit={unit}
              onBwSave={saveBW}
              readiness={readiness}
              todaySubj={todaySubj}
              onSubjReadiness={handleSubjReadiness}
              isEstimated={todaySubj == null}
              liveEstimate={liveEstimate}
              gripEstimates={gripEstimates}
              activities={activities}
              onLogActivity={addActivity}
              connectSlot={tindeqConnectCard}
            />
          );
        }

        if (phase === "rep_ready" || phase === "rep_active") {
          // When Tindeq is connected, use touchless auto-detect mode:
          // reps start and end automatically from force threshold crossings.
          // When not connected, fall back to the manual tap flow.
          if (tindeq.connected && phase === "rep_ready") {
            return (
              <AutoRepSessionView
                key={`auto-${activeHand}-${currentSet}-${currentRep}`}
                session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
                onRepDone={handleRepDone}
                onAbort={handleAbort}
                tindeq={tindeq}
                unit={unit}
              />
            );
          }
          return (
            <ActiveSessionView
              key={`${activeHand}-${currentSet}-${currentRep}-${phase}`}
              session={{ config, currentSet, currentRep, fatigue, sessionId, refWeights, activeHand }}
              onRepDone={handleRepDone}
              onAbort={handleAbort}
              tindeq={tindeq}
              autoStart={phase === "rep_active"}
              unit={unit}
            />
          );
        }

        if (phase === "switch_hands") {
          return <SwitchHandsView onReady={() => setPhase("rep_ready")} />;
        }

        if (phase === "alt_switch") {
          // Brief 3-second countdown before the interleaved alt-hand rep
          return (
            <AltSwitchView
              toHand={activeHand}
              onReady={() => setPhase(tindeq.connected ? "rep_ready" : "rep_active")}
            />
          );
        }

        if (phase === "resting") {
          const restSecs = config.altMode && config.hand === "Both" ? altRestTime : config.restTime;
          return (
            <RestView
              lastRep={lastRepResult}
              nextWeight={nextWeight}
              restSeconds={restSecs}
              onRestDone={handleRestDone}
              setNum={currentSet + 1}
              numSets={config.numSets}
              repNum={currentRep}
              repsPerSet={config.repsPerSet}
              unit={unit}
            />
          );
        }

        if (phase === "between_sets") {
          return (
            <BetweenSetsView
              completedSet={currentSet}
              totalSets={config.numSets}
              onNextSet={handleNextSet}
              setRestTime={config.setRestTime}
            />
          );
        }

        if (phase === "done") {
          return (
            <SessionSummaryView
              reps={sessionReps}
              config={config}
              leveledUp={leveledUp}
              newLevel={newLevel}
              onDone={() => setPhase("idle")}
              unit={unit}
            />
          );
        }

        return null;
      })()}

      {tab === 1 && <AnalysisView history={history} unit={unit} bodyWeight={bodyWeight} baseline={baseline} activities={activities} liveEstimate={liveEstimate} gripEstimates={gripEstimates} />}
      {tab === 2 && <BadgesView history={history} liveEstimate={liveEstimate} genesisSnap={genesisSnap} />}
      {tab === 3 && <WorkoutTab unit={unit} onSessionSaved={handleWorkoutSessionSaved} onBwSave={saveBW} trip={trip} />}
      {tab === 4 && <ClimbingTab activities={activities} onLogActivity={addActivity} onDeleteActivity={deleteActivity} />}
      {tab === 5 && <HistoryView history={history} onDownload={() => downloadCSV(history)} unit={unit} bodyWeight={bodyWeight} onDeleteSession={deleteSession} onUpdateSession={updateSession} onDeleteRep={deleteRep} onUpdateRep={updateRep} onAddRep={(rep) => addReps(Array.isArray(rep) ? rep : [rep])} notes={notes} onNoteChange={handleNoteChange} activities={activities} onDeleteActivity={deleteActivity} />}
      {tab === 6 && <TrendsView history={history} unit={unit} activities={activities} />}
      {tab === 7 && (
        <SettingsView
          user={user}
          loginEmail={loginEmail}
          setLoginEmail={setLoginEmail}
          onSendOtp={sendOtp}
          onVerifyOtp={verifyOtp}
          onCancelOtp={cancelOtp}
          otpSent={otpSent}
          otpCode={otpCode}
          setOtpCode={setOtpCode}
          otpBusy={otpBusy}
          otpError={otpError}
          onSignOut={signOut}
          unit={unit}
          onUnitChange={saveUnit}
          bodyWeight={bodyWeight}
          onBWChange={saveBW}
          trip={trip}
          onTripChange={saveTrip}
          onPullFromCloud={pullFromCloud}
          pullStatus={pullStatus}
          lastPulledAt={lastPulledAt}
        />
      )}
    </div>
  );
}
