// ─────────────────────────────────────────────────────────────
// DENSITY LADDER — rep-count progression at constant load
// ─────────────────────────────────────────────────────────────
// Progression scheme from device-based training practice (June 2026):
// instead of raising the LOAD every session (the curve-fit default),
// hold the load constant and earn REPS, gated by the FIRST and LAST
// reps of the previous completed session. The first rep checks whether
// the load was calibrated to the target at all; the last rep is the
// most fatigued and shows whether the dose was absorbed:
//
//   protocol: T-seconds max hold · short rest · N reps
//   • first rep < 95% of T       → next session: lower load, same N
//   • first rep hits T and last rep ≥ 25% of T
//                                → next session: same load, N+1 reps
//   • first rep hits T and last rep < 25% of T
//                                → next session: same load, same N
//   • N reaches 6 with both gates passed
//                                → add 5% load, reset to 4 reps
//   • missing/uneven expected hands → next session: repeat, no advance
//
// Examples from practice: 40s max / 20s rest / 4 reps with a 10s gate
// (10 = 0.25 × 40); 90s strength holds gate at ~22s (≈ 0.25 × 90 —
// described as "20s" in the source protocol).
//
// Integration contract (see SessionPlanCard): the ladder activates
// when the user repeats a (grip, zone) they've trained before — it
// pins the previous session's T and load and prescribes the rep
// count. The curve fit keeps learning from every rep regardless, and
// takes over again for new (grip, zone) combos or after resets.
//
// July 2026 hardening (the 7/20 + 7/22 endurance misses were pins,
// not engine output):
//   • RE-PIN GUARD — a hand only re-pins if its previous rep 1
//     actually reached the target (isShortfall's 95% tolerance).
//     A failed rep 1 means the load was NOT absorbed; that hand falls
//     back to prescription(), which owns the correction. This also
//     kills the over-pull ratchet (pinning a failing rep's inflated
//     avg force as the next session's load).
//   • ENGINE BOUNDS — surviving pins are clamped by loadBounds()
//     (peak-force ceiling + endurance-tail ceiling), so the pin path
//     can never exceed the physics the engine enforces.
//
// COOKEDNESS NORMALIZATION: recorded prescribed loads are post-
// cooked-scale-down (the runner multiplies exp(-β·cooked) before
// stamping). Pinning that raw value would compound the scale-down
// across consecutive cooked sessions (each pin inherits the previous
// discount, then gets discounted again). So the ladder returns the
// FRESH-EQUIVALENT load — recorded ÷ exp(-β·cooked_then) — and the
// display/runner applies TODAY'S multiplier on top, same as every
// other load surface.

import { zoneOf } from "./zones.js";
import { prescribedLoad, effectiveLoad } from "./load.js";
import { capacityMultiplier } from "./fatigueBeta.js";
// Engine bounds + shortfall test (July 2026 — see the RE-PIN GUARD
// comment below). prescription.js does not import this module, so the
// dependency is acyclic.
import { loadBounds, isShortfall, SHORTFALL_TOL } from "./prescription.js";
// Personal recovery-model forecast (July 2026 — see the COLLAPSE
// DOWN-STEP comment below). repCurveData imports fatigue/recoveryFit/
// zones only, so this dependency is acyclic too.
import { buildPhysModel, buildForecastSeries } from "./repCurveData.js";

export const LADDER_MIN_REPS = 4;
export const LADDER_MAX_REPS = 6;
// Rep 1 must reach 95% of T before the ladder can hold or advance the
// load. A shortfall means the NEXT session recalibrates downward; the
// workout already underway is never changed.
export const LADDER_FIRST_REP_TARGET_FRAC = SHORTFALL_TOL;
// Last-rep gate as a fraction of the session's target duration.
// 0.25 reproduces the source protocol at both anchor points:
// 10s @ 40s, ~22s @ 90s.
export const LADDER_GATE_FRAC = 0.25;
// Load bump when the ladder tops out (6 reps, gate passed).
export const LADDER_LOAD_STEP_FRAC = 0.05;
// If the updated curve does not move a missed hand down by itself,
// guarantee a modest reduction rather than repeating the known-high
// load indefinitely.
export const LADDER_RECALIBRATION_STEP_FRAC = 0.05;

// ── COLLAPSE DOWN-STEP (July 2026, per Nathan) ────────────────
// The re-pin guard catches OPENER failures; this catches the other
// failure mode: rep 1 lands fine (often over-pulled) but reps 2+
// decay far below what the user's own recovery model predicts —
// the June 2026 pattern where intended strength/endurance sessions
// ground down into 15-30s efforts at loads too heavy to recover
// between short rests, and "same weight, more reps" re-pinned the
// grind forever.
//
// Conformance C = mean(actual_i / forecast_i) over reps 2+, where the
// forecast is the personal recovery model seeded by the session's OWN
// rep 1 — so C asks "given how rep 1 went, did the rest decay as your
// physiology says it should?", which is duration- and rest-aware (a
// 220s session naturally decays to ~25% of target; a 45s session
// holds ~75-90%). A fixed actual/target threshold can't do this.
//
// Backtested on the full history (2026-07-23, leak-free per-date
// fits): after a session with C < 0.75, the next same-(grip, zone)
// session at the same-or-higher load repeated the collapse (mean next
// C 0.69, 14% healthy, n=14), while a lower load restored conformance
// (mean next C 1.02, 38% fully healthy, n=8); after conforming
// sessions (C ≥ 0.85), holding or raising load was fine (next C 1.09,
// n=66). Deterministic response: pin at last load × (1 −
// LADDER_COLLAPSE_STEP_FRAC) and DON'T advance the rung — absorb the
// lighter dose first. Repeats until conformance recovers (each
// collapsed session triggers its own step).
export const LADDER_COLLAPSE_TOL = 0.75;      // C below this = collapsed
export const LADDER_COLLAPSE_STEP_FRAC = 0.10; // −10% per collapsed session
// Need rep 1 + at least this many later reps for a stable C estimate.
export const LADDER_COLLAPSE_MIN_LATER_REPS = 2;

const round1 = (v) => Math.round(v * 10) / 10;

// Decay conformance of one hand's rep sequence vs the personal
// recovery model, seeded by the sequence's own rep 1 (see the
// COLLAPSE DOWN-STEP block above). historyBefore = reps strictly
// before the session, so the model can't be fit on the session it's
// judging. Returns C (mean actual/forecast over reps 2+) or null when
// there's too little data / no model to judge with.
function sessionConformance(historyBefore, hand, grip, reps) {
  if (!reps || reps.length < 1 + LADDER_COLLAPSE_MIN_LATER_REPS) return null;
  const rep1 = reps[0];
  if (!(Number(rep1.actual_time_s) > 0)) return null;
  let physModel = null;
  try { physModel = buildPhysModel(historyBefore, hand, grip); } catch (e) { physModel = null; }
  if (!physModel) return null;
  const rest = Number(rep1.rest_s) > 0 ? Number(rep1.rest_s) : 20;
  const fc = buildForecastSeries({
    numReps: reps.length,
    firstRepTime: Number(rep1.actual_time_s),
    restSeconds: rest,
    physModel,
  });
  if (!fc || fc.length !== reps.length) return null;
  const ratios = [];
  for (let i = 1; i < reps.length; i++) {
    const f = fc[i] ? fc[i].t : 0;
    const a = Number(reps[i].actual_time_s);
    if (f > 0 && a > 0) ratios.push(a / f);
  }
  if (ratios.length < LADDER_COLLAPSE_MIN_LATER_REPS) return null;
  return ratios.reduce((s, x) => s + x, 0) / ratios.length;
}

// Most recent session for (grip, zone): groups grip-matching reps by
// session_id (fallback date), keeps the group whose target_duration
// classifies into zoneKey, picks the latest by date (then by
// session_started_at for multi-session days).
function latestSessionInZone(history, grip, zoneKey) {
  const groups = new Map();
  for (const r of history || []) {
    if (!r || r.grip !== grip) continue;
    if (!(r.actual_time_s > 0)) continue;
    if (!r.target_duration || zoneOf(r.target_duration) !== zoneKey) continue;
    const key = r.session_id || r.date || "unknown";
    if (!groups.has(key)) groups.set(key, []);
    groups.get(key).push(r);
  }
  let best = null;
  for (const reps of groups.values()) {
    const date = reps.reduce((m, r) => (r.date > m ? r.date : m), "");
    const started = reps.reduce(
      (m, r) => (r.session_started_at && r.session_started_at > m ? r.session_started_at : m), ""
    );
    if (!best
        || date > best.date
        || (date === best.date && started > best.started)) {
      best = { reps, date, started };
    }
  }
  return best;
}

// Compute the ladder prescription for (grip, zoneKey) from history.
// Returns null when the user has never trained this (grip, zone) —
// caller falls back to the curve-fit default. Otherwise:
//   {
//     T,            // pinned target duration (the previous session's)
//     reps,         // rep count to prescribe next
//     loadByHand,   // { L?, R? } fresh-equivalent kg (see header)
//     decision,     // "advance" | "repeat" | "step_load" | "down_step"
//                   //   | "recalibrate" | "incomplete"
//     previousLoadByHand, // all prior fresh-equivalent loads
//     basis: {      // receipts for the Why line
//       date, prevReps, gateSec, firstRepTargetSec,
//       firstRepSec, firstRepSecByHand,
//       lastRepSec,        // worst (min) last-rep time across hands
//       lastRepSecByHand,  // { L?, R? }
//       expectedHands, missingHands, shortfallHands,
//       repCountByHand, unevenRepCounts
//     },
//   }
export function computeDensityLadder(history, grip, zoneKey, opts = {}) {
  const { fatigueModel = null, expectedHands = null } = opts;
  if (!grip || !zoneKey) return null;
  const sess = latestSessionInZone(history, grip, zoneKey);
  if (!sess) return null;

  // Per-hand rep sequences from the session's LAST set, sorted by rep
  // number. set_num MUST be part of the grouping (July 2026 — same bug
  // class the recovery fit fixed): rep_num restarts per set, so pooling
  // all of a hand's reps made a 2×4 session read as prevReps = 8
  // (> LADDER_MAX_REPS) with an interleaved [r1,r1,r2,r2,…] order whose
  // “last rep” was an arbitrary tie-break — the gate could read the
  // wrong rep and the ladder could emit a spurious +5% step_load. We
  // ladder on the LAST set (max set_num; null → 1 for legacy rows):
  // it sits under the most cumulative fatigue, so its final rep is the
  // honest dose-absorbed readout the protocol gates on, and its rep
  // count is the rung the user most recently performed. (Max per-set
  // count was considered and rejected: gating on the last set's final
  // rep while counting a different set's reps would let the gate and
  // the rung disagree about which set they describe.)
  const byHandSet = {};
  for (const r of sess.reps) {
    const h = r.hand === "R" ? "R" : "L";
    const setNum = r.set_num ?? 1;
    const sets = (byHandSet[h] = byHandSet[h] || new Map());
    if (!sets.has(setNum)) sets.set(setNum, []);
    sets.get(setNum).push(r);
  }
  const byHand = {};
  for (const [h, sets] of Object.entries(byHandSet)) {
    const lastSetNum = Math.max(...sets.keys());
    byHand[h] = sets.get(lastSetNum)
      .sort((a, b) => (a.rep_num ?? 1) - (b.rep_num ?? 1));
  }

  // The session's protocol T — every rep shares it; read off rep 1.
  const T = Number(sess.reps[0].target_duration) || 0;
  if (!(T > 0)) return null;
  const firstRepTargetSec = round1(T * LADDER_FIRST_REP_TARGET_FRAC);
  const gateSec = round1(T * LADDER_GATE_FRAC);

  // Evaluate only the hands the upcoming session expects. When the
  // caller does not specify them (legacy callers/tests), infer them
  // from the latest session to preserve single-hand behavior.
  const inferredHands = Object.keys(byHand).sort();
  const requiredHands = Array.isArray(expectedHands) && expectedHands.length > 0
    ? [...new Set(expectedHands.filter(h => h === "L" || h === "R"))]
    : inferredHands;
  if (requiredHands.length === 0) return null;

  // First/last rep receipts plus completeness. Both-mode progression
  // requires both hands and equal rep counts; a lost/aborted hand is
  // an incomplete session, never evidence to advance.
  const firstRepSecByHand = {};
  const lastRepSecByHand = {};
  const repCountByHand = {};
  const missingHands = [];
  for (const h of requiredHands) {
    const reps = byHand[h] || [];
    repCountByHand[h] = reps.length;
    if (reps.length === 0) {
      missingHands.push(h);
      continue;
    }
    const firstSetNum = Math.min(...byHandSet[h].keys());
    const first = [...byHandSet[h].get(firstSetNum)]
      .sort((a, b) => (a.rep_num ?? 1) - (b.rep_num ?? 1))[0];
    const last = reps[reps.length - 1];
    firstRepSecByHand[h] = Number(first.actual_time_s) || 0;
    lastRepSecByHand[h] = Number(last.actual_time_s) || 0;
  }
  const presentCounts = Object.values(repCountByHand).filter(n => n > 0);
  const prevReps = presentCounts.length > 0 ? Math.max(...presentCounts) : 0;
  const unevenRepCounts = new Set(presentCounts).size > 1;
  const incomplete = missingHands.length > 0 || unevenRepCounts;
  const shortfallHands = requiredHands.filter(h =>
    firstRepSecByHand[h] != null && isShortfall(firstRepSecByHand[h], T)
  );
  const firstRepSecValues = Object.values(firstRepSecByHand);
  const firstRepSec = firstRepSecValues.length > 0
    ? Math.min(...firstRepSecValues)
    : 0;
  const lastRepSecValues = Object.values(lastRepSecByHand);
  const lastRepSec = lastRepSecValues.length > 0
    ? Math.min(...lastRepSecValues)
    : 0;
  const gatePassed = lastRepSec >= gateSec;

  // Fresh-equivalent pinned load per hand (see header). ACTUAL load
  // first (effectiveLoad: Tindeq-measured ?? manual override ??
  // prescribed) — "same weight" means the weight the user actually
  // held, not the one the card proposed. June 2026: a user who
  // overrides the suggestion upward and sustains it would otherwise
  // get the OLD lower weight re-pinned next session, silently
  // undoing the override. Prescribed remains the fallback for rows
  // with no recorded actual. De-cooked by the capacity multiplier
  // that was active when the rep was stamped (session_cooked; 1.0
  // when absent or no β model).
  // RE-PIN GUARD (July 2026). "Same weight, more reps" presupposes the
  // weight was ABSORBED — rep 1 (the fresh rep) actually reached its
  // target. Without this guard the ladder re-pinned a failed session's
  // load forever ("repeat" never lowers it), and because the pin reads
  // the ACTUAL held load, an over-pulled failing rep RAISED the next
  // pin: Micro 160s walked 5.5 → 9.0 → 10.6 → 10.5 kg across four
  // consecutive failed sessions (2026-07-03 → 07-22), and Crusher 220s
  // replayed a 3-week-old failed rep-1 load (23.4 kg incl. a nominal
  // manual/spring entry) that lasted 101 of 220 s. A hand whose rep 1
  // fell short (isShortfall, same 95% tolerance as the engine's failure
  // semantics) gets NO pin. SessionPlanCard re-prescribes that hand
  // for the NEXT workout and guarantees that the result is lower than
  // this known-too-high load.
  // The absorption readout is the FIRST set's rep 1 — the only truly
  // fresh rep. A later set's rep 1 runs under cumulative fatigue and
  // may fall short of T even when the load is right, so it must not
  // trip the guard (the pin itself still reads the LAST set's rep 1,
  // unchanged).
  const droppedByHand = {};
  const previousLoadByHand = {};
  for (const h of requiredHands) {
    const reps = byHand[h] || [];
    if (reps.length === 0) continue;
    const rep1 = reps[0];
    const firstSetNum = Math.min(...byHandSet[h].keys());
    const freshRep1 = [...byHandSet[h].get(firstSetNum)]
      .sort((a, b) => (a.rep_num ?? 1) - (b.rep_num ?? 1))[0];
    const recorded = effectiveLoad(rep1) || prescribedLoad(rep1);
    if (!(recorded > 0)) continue;
    const thenMult = capacityMultiplier(fatigueModel, grip, rep1.session_cooked ?? 0);
    previousLoadByHand[h] = round1(thenMult > 0 ? recorded / thenMult : recorded);
    if (isShortfall(freshRep1.actual_time_s, T)) {
      droppedByHand[h] = round1(Number(freshRep1.actual_time_s) || 0);
    }
  }
  const loadByHand = { ...previousLoadByHand };
  for (const h of shortfallHands) delete loadByHand[h];

  // COLLAPSE DOWN-STEP (see the constants block for rationale +
  // backtest). Runs only on hands that SURVIVED the re-pin guard —
  // opener failures are the guard's job; this judges the decay of a
  // session whose opener was fine. The model is fit on history
  // strictly before the judged session (leak-free, same as the
  // backtest), and a collapsed hand pins 10% lighter.
  const historyBefore = (history || []).filter(r => r && r.date && r.date < sess.date);
  const collapseByHand = {};
  for (const h of Object.keys(loadByHand)) {
    const C = sessionConformance(historyBefore, h, grip, byHand[h]);
    if (C != null && C < LADDER_COLLAPSE_TOL) {
      const from = loadByHand[h];
      const to = round1(from * (1 - LADDER_COLLAPSE_STEP_FRAC));
      loadByHand[h] = to;
      collapseByHand[h] = { C: Math.round(C * 100) / 100, from, to };
    }
  }
  const collapsed = Object.keys(collapseByHand).length > 0;

  // Decision. Rep counts are kept inside [MIN, MAX]: a legacy session
  // with fewer than MIN reps just enters the ladder at MIN rather than
  // skipping rungs, and advance never exceeds MAX. A collapse
  // overrides advance/step_load — the lighter dose gets absorbed at
  // the CURRENT rung before the ladder climbs again (and definitely
  // before any +5% step).
  let decision, reps;
  if (shortfallHands.length > 0) {
    decision = "recalibrate";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (incomplete) {
    decision = "incomplete";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (collapsed) {
    decision = "down_step";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (gatePassed && prevReps >= LADDER_MAX_REPS) {
    decision = "step_load";
    reps = LADDER_MIN_REPS;
    for (const h of Object.keys(loadByHand)) {
      loadByHand[h] = round1(loadByHand[h] * (1 + LADDER_LOAD_STEP_FRAC));
    }
  } else if (gatePassed) {
    decision = "advance";
    reps = Math.min(LADDER_MAX_REPS, Math.max(LADDER_MIN_REPS, prevReps + 1));
  } else {
    decision = "repeat";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  }

  // ENGINE BOUNDS (July 2026). The pin path bypasses prescription()
  // by design ("same weight, more reps" must not drift with the
  // curve), but it must still respect the same PHYSICS the engine
  // enforces: the peak-force ceiling and the long-hold endurance-tail
  // ceiling (PR #41 — which the pin path silently escaped). Ceilings
  // only: the demonstrated-capacity floor is NOT applied as a lift,
  // because pinning deliberately holds the user's last actual load
  // even when they've demonstrated more (the engine's floor still
  // raises the endurance ceiling before it clamps, same as capValue).
  const boundedByHand = {};
  for (const [h, kg] of Object.entries(loadByHand)) {
    const b = loadBounds(history, h, grip, T);
    let bounded = kg;
    if (b.peakCapKg != null && bounded > b.peakCapKg) bounded = b.peakCapKg;
    if (b.endCeilKg != null) {
      const ec = b.floorKg != null ? Math.max(b.endCeilKg, b.floorKg) : b.endCeilKg;
      if (bounded > ec) bounded = ec;
    }
    bounded = round1(bounded);
    if (bounded !== kg) boundedByHand[h] = { from: kg, to: bounded };
    loadByHand[h] = bounded;
  }

  return {
    T,
    reps,
    loadByHand,
    previousLoadByHand,
    decision,
    basis: {
      date: sess.date,
      prevReps,
      gateSec,
      firstRepTargetSec,
      firstRepSec: round1(firstRepSec),
      firstRepSecByHand,
      lastRepSec: round1(lastRepSec),
      lastRepSecByHand,
      // Hands whose previous rep 1 fell short of T (value = that rep-1
      // time, s): no pin — the next workout resolves a lower load.
      droppedByHand,
      // Hands whose previous session's reps 2+ decayed below the
      // personal recovery model's forecast (C < LADDER_COLLAPSE_TOL):
      // { C, from, to } — pin stepped down 10%, rung not advanced.
      collapseByHand,
      // Hands whose pin was clamped by the engine bounds: { from, to }.
      boundedByHand,
      expectedHands: requiredHands,
      missingHands,
      shortfallHands,
      repCountByHand,
      unevenRepCounts,
    },
  };
}

// Resolve the actual fresh-equivalent loads for the next session.
// Normal ladder hands keep their pins. Recalibrating hands use the
// newly-fitted curve at the pinned T, with a guaranteed 5% reduction
// if that fit would otherwise repeat or raise the known-too-high load.
// Missing hands in an incomplete Both-mode session use their curve
// prescription without forcing a reduction (there was no failed load
// on that hand to calibrate from).
export function resolveDensityLadderLoads(ladder, curveLoadByHand = {}) {
  if (!ladder) return null;
  const out = {};
  const hands = new Set([
    ...Object.keys(ladder.previousLoadByHand || {}),
    ...Object.keys(ladder.loadByHand || {}),
    ...Object.keys(curveLoadByHand || {}),
    ...(ladder.basis?.expectedHands || []),
  ]);
  const shortfallHands = new Set(ladder.basis?.shortfallHands || []);

  for (const h of hands) {
    const pinned = Number(ladder.loadByHand?.[h]);
    if (pinned > 0) {
      out[h] = round1(pinned);
      continue;
    }

    const curve = Number(curveLoadByHand?.[h]);
    const previous = Number(ladder.previousLoadByHand?.[h]);
    if (shortfallHands.has(h) && previous > 0) {
      const ceiling = previous * (1 - LADDER_RECALIBRATION_STEP_FRAC);
      out[h] = round1(curve > 0 ? Math.min(curve, ceiling) : ceiling);
    } else if (curve > 0) {
      out[h] = round1(curve);
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}
