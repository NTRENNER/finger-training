// ─────────────────────────────────────────────────────
// ENDURANCE TAIL  (long-duration prescription ceiling)
// ─────────────────────────────────────────────────────
// A power-law model of the force–duration TAIL, used only to CAP the
// prescription at long target durations. It is deliberately NOT a new
// governing curve — the three-exp fit still shapes every prescription.
//
// Why this exists (July 2026). The three-exp curve has no non-zero
// asymptote and the prescription is curve_shape(T) × a single amplitude
// anchor taken from the most-recent rep 1 at ANY duration. When that
// recent rep is a short, strong effort (e.g. a 45 s max-ish hang), its
// amplitude rescales the WHOLE curve upward, including the long-endurance
// tail the anchor says nothing about. On 2026-07-20 that prescribed
// ~10 kg for a 160 s Micro hold whose genuine sustainable load was ~7 kg;
// the hold failed at 46 s.
//
// The fix is a physical upper bound, not a model swap. A forward-chained
// backtest on real history (scripts/endurance-tail-backtest.md) compared,
// on long holds (T ≥ 140 s):
//   current engine            median 0.33  mean 1.23
//   critical force CF+W'/T     median 0.24  mean 0.61   (unstable tail)
//   power law a·T^-b           median 0.24  mean 0.50   ← best endurance model
//   robust multi-session anchor median 0.40 mean 0.75   (also hurt the all-zone median)
// The power law won; CF (the classic Monod hyperbola) fit the sparse long
// end badly. Using the power law only as a CEILING (min with the engine
// value) left the all-zone median untouched at 0.133 — it never engages
// on short/mid targets — while cutting the long-hold mean 1.23 → 0.63.
// That surgical property is why it beat re-anchoring, which reshapes every
// zone globally.
//
// The tail is fit on MEASURED (Tindeq) fresh failures only — a manual /
// spring load was never a sustained force (see isMeasuredLoadRep) — and
// only on T ≥ TAIL_MIN_T, because sub-30 s max-strength efforts follow a
// different (recruitment-limited) mechanism and steepen the fit. The
// exponent is shrunk toward a population prior so a grip with few long
// holds can't produce a wild slope.

import { sane, effectiveLoad, isSeedArtifactRep, isMeasuredLoadRep } from "./load.js";
import { STRENGTH_MAX } from "./zones.js";

// Population exponent prior (median per-grip/hand b across the real
// histories the backtest ran on: Micro ~0.40, Crusher ~0.57–0.71).
export const TAIL_B_PRIOR = 0.45;
// Fit only the power/endurance region — short max reps bias the slope.
export const TAIL_MIN_T = 30;
// Ridge weight (× n) pulling the exponent toward TAIL_B_PRIOR.
export const TAIL_SHRINK = 0.4;
// A tail needs at least this many measured fresh failures over at least
// this many distinct durations, or we don't fit (returns null → no ceiling).
export const TAIL_MIN_PTS = 5;
export const TAIL_MIN_DURS = 2;
// The ceiling only engages at genuinely long targets — the strength_endurance
// and endurance zones (T ≥ STRENGTH_MAX = 140 s). Below this the power tail
// underpredicts (Crusher's strong short holds pull it down) and must not bind;
// the backtest confirmed zero mid-zone engagements at this threshold.
export const CEIL_MIN_T = STRENGTH_MAX;
// Progression headroom: cap at tail × margin, so the ceiling only trims a
// prescription that sits clearly above the modeled endurance tail rather
// than pinning it exactly — you can still be asked for a little more than
// the model's best guess on a strong day.
export const CEIL_MARGIN = 1.10;

// Fit F = a · T^(-b) by ridge least squares on (ln T, ln F), the ridge
// pulling the slope toward -TAIL_B_PRIOR. points: [{ T, F }]. Returns
// { a, b, n } or null when there isn't enough spread to fit.
export function fitEnduranceTail(points) {
  const p = (points || []).filter(q => q && q.T >= TAIL_MIN_T && q.F > 0);
  if (p.length < TAIL_MIN_PTS) return null;
  const durs = new Set(p.map(q => Math.round(q.T)));
  if (durs.size < TAIL_MIN_DURS) return null;
  const x = p.map(q => Math.log(q.T));
  const y = p.map(q => Math.log(q.F));
  const n = x.length;
  let sx = 0, sy = 0, sxx = 0, sxy = 0;
  for (let i = 0; i < n; i++) { sx += x[i]; sy += y[i]; sxx += x[i] * x[i]; sxy += x[i] * y[i]; }
  const lam = TAIL_SHRINK * n;
  // Normal equations for [lnA, slope] minimizing Σ(y − lnA − slope·x)²
  // + lam·(slope + TAIL_B_PRIOR)². Only the slope is regularized.
  const A00 = n,  A01 = sx;
  const A10 = sx, A11 = sxx + lam;
  const b0 = sy,  b1 = sxy - lam * TAIL_B_PRIOR;
  const det = A00 * A11 - A01 * A10;
  if (!(Math.abs(det) > 1e-9)) return null;
  const lnA = (b0 * A11 - A01 * b1) / det;
  const slope = (A00 * b1 - b0 * A10) / det;
  const a = Math.exp(lnA);
  const b = -slope;
  if (!(a > 0) || !Number.isFinite(b)) return null;
  return { a, b, n };
}

// Gather this (hand, grip)'s measured fresh failures (T ≥ TAIL_MIN_T) and
// fit the tail. Retrospective semantics mirror prescription(): with a
// referenceDate, only reps strictly before it are used. Returns { a, b, n }
// or null.
export function enduranceTailFit(history, hand, grip, referenceDate = null) {
  if (!history) return null;
  const pts = [];
  for (const r of history) {
    if (!r || r.hand !== hand || r.grip !== grip) continue;
    if (!(r.rep_num == null || r.rep_num === 1)) continue;   // fresh efforts only
    if (isSeedArtifactRep(r)) continue;
    if (!isMeasuredLoadRep(r)) continue;                     // a spring/manual load was never a sustained force
    if (referenceDate && (!r.date || r.date >= referenceDate)) continue;
    const T = Number(r.actual_time_s);
    const F = sane(effectiveLoad(r));
    if (T >= TAIL_MIN_T && F != null) pts.push({ T, F });
  }
  return fitEnduranceTail(pts);
}

// The endurance ceiling (kg) for a long target, or null when it doesn't
// apply (short/mid target, or no fittable tail). = tail(T) × CEIL_MARGIN.
export function enduranceCeilingKg(history, hand, grip, targetDuration, referenceDate = null) {
  if (!(targetDuration >= CEIL_MIN_T)) return null;
  const fit = enduranceTailFit(history, hand, grip, referenceDate);
  if (!fit) return null;
  const tail = fit.a * Math.pow(targetDuration, -fit.b);
  return tail > 0 ? Math.round(tail * CEIL_MARGIN * 10) / 10 : null;
}
