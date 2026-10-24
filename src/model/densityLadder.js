import { firstTrainingSessionRows } from "./firstSessionEvidence.js";
import { isPeakTestRep } from './peakForce.js';
import { isMixedDomainRep } from './mixedDomain.js';
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
// count. Only the first session per grip/hand/day can change this ladder.
// The curve learns from that session's opener; later reps judge the earned
// rung. The curve supplies loads for new (grip, zone) combinations.
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
// A reduced session retains its explicit base plan, when saved, without
// claiming the reduction measured a physiological capacity loss. Measured
// force is never divided by the cooked multiplier and discounted work does
// not advance a fresh-load rung. Legacy rows retain their actual measured load.

import { isCapacityEvidenceRep } from "./forceRecording.js";
import { zoneOf } from "./zones.js";
import { prescribedLoad, effectiveLoad, isFirstSetRep } from "./load.js";
import { recordedAdjustment } from "./cookedScaling.js";
// Engine bounds + shortfall test (July 2026 — see the RE-PIN GUARD
// comment below). prescription.js does not import this module, so the
// dependency is acyclic.
import { loadBounds, isShortfall, SHORTFALL_TOL } from "./prescription.js";
import { progressionSetEvidence, recordedSessionPrescription } from "./progressionEvidence.js";

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

// ── OVERSHOOT RECALIBRATION (October 2026, per Nathan) ───────
// The mirror of the re-pin guard. A fresh rep 1 that ran well past T
// shows the load was too light for this target, so the next workout does
// NOT re-pin it ("same weight, more reps" would hold a known-too-light
// load until the rung topped out). It takes the curve's load at T, which
// is already anchored to that rep 1, never below the load just held and
// at most +20% per session so one big day can't overshoot the other way.
// The rung is kept. It applies to softened (adjusted) sessions too: the
// held load is measured, so running long on it is direct evidence whatever
// the day's rating was.
//
// Backtest (2026-10-24, opening holds 2026-06 → 10-23): pinned loads
// overshot 1.25× T in 43% of sessions (36% within 0.8–1.25×), curve
// loads in 0% (65% within); in every pinned session where the curve was
// heavier, rep 1 overshot.
export const LADDER_OVERSHOOT_FRAC = 1.25;
export const LADDER_OVERSHOOT_MAX_STEP_FRAC = 0.20;

// (Collapse down-step removed October 2026, per Nathan. From July it cut
// a hand's load 10% and held the rung when reps 2+ averaged under 0.75×
// the personal recovery model's forecast. The forecast drifts optimistic
// with rep position: within a session, actual/forecast relative to rep 2
// fell to ×0.87, 0.84, 0.79 and 0.71 at reps 3–6, so 45% of 6-rep sessions
// "collapsed" against 5–18% at 4–5 reps, and the top rung cut load instead
// of stepping it. Refitting the model's depletion speed and weights left
// that drift in place. Judged against the athlete's own residuals per grip,
// zone and rep, a flagged session no longer predicted trouble at the same
// load (next C 0.92, 56% healthy, vs 0.98 and 64% unflagged; next rep 1
// reached T 56% vs 69%). The July evidence for the cut, a repeat collapse
// at the same load, was that bias carrying into the next session. Load now
// follows rep 1 (re-pin guard, overshoot) and the last-rep gate decides
// progress; after gate-passing sessions a +3–8% step held rep 1 in 10 of 11.)

const round1 = (v) => Math.round(v * 10) / 10;

// Most recent session for (grip, zone): groups grip-matching reps by
// session_id (fallback date), keeps the group whose target_duration
// classifies into zoneKey, picks the latest by date (then by
// session_started_at for multi-session days).
function latestSessionInZone(history, grip, zoneKey) {
  const groups = new Map();
  for (const r of history || []) {
    if (!r || r.grip !== grip || (isMixedDomainRep(r) || isPeakTestRep(r))) continue;
    // The density ladder prescribes the next fresh set. Optional sets are
    // volume-tolerance evidence only: they cannot invalidate, down-step, or
    // otherwise change the next set-1 prescription.
    if (!isFirstSetRep(r)) continue;
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
//     loadByHand,   // { L?, R? } observed or explicitly retained base targets
//     decision,     // "advance" | "repeat" | "step_load"
//                   //   | "recalibrate" | "recalibrate_up" | "incomplete"
//     previousLoadByHand, // prior targets before a ladder change
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
  const { expectedHands = null } = opts;
  if (!grip || !zoneKey) return null;
  const sess = latestSessionInZone(firstTrainingSessionRows(history), grip, zoneKey);
  if (!sess) return null;

  // Every progression receipt comes from the same first set. Optional sets
  // were removed by latestSessionInZone; they cannot replace a missing opener
  // or mask an interrupted first-set slot.
  const byHand = {};
  for (const r of sess.reps) {
    const h = r.hand === "R" ? "R" : "L";
    (byHand[h] ||= []).push(r);
  }
  for (const reps of Object.values(byHand)) {
    reps.sort((a, b) => (a.rep_num ?? 1) - (b.rep_num ?? 1));
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
    const first = reps[0];
    const last = reps[reps.length - 1];
    firstRepSecByHand[h] = Number(first.actual_time_s) || 0;
    lastRepSecByHand[h] = Number(last.actual_time_s) || 0;
  }
  const presentCounts = Object.values(repCountByHand).filter(n => n > 0);
  const evidenceByHand = Object.fromEntries(requiredHands.map(h => {
    const reps = byHand[h] || [];
    const plan = reps.map(recordedSessionPrescription).find(Boolean);
    return [h, progressionSetEvidence(reps, { expectedCount: plan?.reps_per_set ?? Math.max(LADDER_MIN_REPS, reps.length) })];
  }));
  const unevenRepCounts = new Set(presentCounts).size > 1;
  const incomplete = missingHands.length > 0 || unevenRepCounts
    || requiredHands.some(h => !evidenceByHand[h].complete);
  const historyBefore = (history || []).filter(r => r && r.date && r.date < sess.date);
  // An incomplete attempt consumes its turn but cannot re-award the prior
  // success or erase its rung. New rows freeze the attempted count; for old
  // partial rows the prior earned prescription is the best available receipt.
  const priorLadder = incomplete ? computeDensityLadder(historyBefore, grip, zoneKey, opts) : null;
  const plannedCounts = sess.reps.map(recordedSessionPrescription).filter(Boolean).map(p => p.reps_per_set);
  const prevReps = plannedCounts.length ? Math.max(...plannedCounts)
    : Math.max(0, ...presentCounts, ...(incomplete && priorLadder ? [priorLadder.reps] : []));
  const adjustedSession = sess.reps.some(r => recordedAdjustment(r).multiplier < 1);
  const restoredPlanByHand = {};
  // A later interrupted rep blocks advancement, not a valid opener's load
  // correction. Never substitute rep 2, a duplicate opener, or an estimate.
  const shortfallHands = adjustedSession ? [] : requiredHands.filter(h => {
    const openers = (byHand[h] || []).filter(r => Number(r.rep_num ?? 1) === 1);
    const opener = openers[0];
    return openers.length === 1 && isCapacityEvidenceRep(opener)
      && Number(opener.actual_time_s) > 0 && effectiveLoad(opener) > 0
      && isShortfall(opener.actual_time_s, T);
  });
  // Overshoot recalibration (see the constants block): a fresh rep 1 well
  // past T gets no pin; the next workout resolves a heavier curve load.
  // Unlike a shortfall, a softened session still counts: running long on a
  // lighter load is stronger evidence, not weaker. An incomplete session does
  // not: lowering a failed opener's load is the safe direction, raising one
  // needs the complete set, and an incomplete session's retained target is
  // not necessarily the load actually held.
  const overshootHands = incomplete ? [] : requiredHands.filter(h => {
    const openers = (byHand[h] || []).filter(r => Number(r.rep_num ?? 1) === 1);
    const opener = openers[0];
    return openers.length === 1 && isCapacityEvidenceRep(opener)
      && effectiveLoad(opener) > 0
      && Number(opener.actual_time_s) > T * LADDER_OVERSHOOT_FRAC;
  });
  const firstRepSecValues = Object.values(firstRepSecByHand);
  const firstRepSec = firstRepSecValues.length > 0
    ? Math.min(...firstRepSecValues)
    : 0;
  const lastRepSecValues = Object.values(lastRepSecByHand);
  const lastRepSec = lastRepSecValues.length > 0
    ? Math.min(...lastRepSecValues)
    : 0;
  const gatePassed = lastRepSec >= gateSec;

  // Observed pinned load per hand (see header). ACTUAL load
  // first (effectiveLoad: Tindeq-measured ?? manual override ??
  // prescribed) — "same weight" means the weight the user actually
  // held, not the one the card proposed. June 2026: a user who
  // overrides the suggestion upward and sustains it would otherwise
  // get the OLD lower weight re-pinned next session, silently
  // undoing the override. Prescribed remains the fallback for rows
  // with no recorded actual. An explicitly saved base plan can be restored
  // after a discounted session, without claiming unmeasured extra capacity.
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
  // trip the guard or any other next-session progression decision.
  const droppedByHand = {};
  const previousLoadByHand = {};
  for (const h of requiredHands) {
    const reps = byHand[h] || [];
    if (reps.length === 0) continue;
    const freshRep1 = reps[0];
    // Pin set 1's load. This used to read the LAST set's opener, which was
    // the same rep whenever every set shared a prescribed load — and a
    // different, lighter one the moment optional sets existed.
    const recorded = effectiveLoad(freshRep1) || prescribedLoad(freshRep1);
    if (!(recorded > 0)) continue;
    // Keep observations separate from a known pre-adjustment plan.
    const plan = reps.map(recordedSessionPrescription).find(Boolean);
    const base = plan?.base_load_kg;
    const canRestore = adjustedSession && Number.isFinite(base) && base > 0 && base < 200;
    const retained = incomplete
      ? (canRestore ? base : plan?.load_kg) ?? priorLadder?.loadByHand?.[h]
        ?? priorLadder?.previousLoadByHand?.[h] ?? prescribedLoad(freshRep1) ?? recorded
      : canRestore ? base : recorded;
    previousLoadByHand[h] = round1(retained > 0 ? retained : recorded);
    if (canRestore) restoredPlanByHand[h] = base;
    if (shortfallHands.includes(h)) {
      droppedByHand[h] = round1(Number(freshRep1.actual_time_s) || 0);
    }
  }
  const loadByHand = { ...previousLoadByHand };
  for (const h of shortfallHands) delete loadByHand[h];
  for (const h of overshootHands) delete loadByHand[h];

  // Missing hands keep an established prior target when available.
  for (const h of missingHands) {
    const retained = priorLadder?.loadByHand?.[h] ?? priorLadder?.previousLoadByHand?.[h];
    if (retained > 0) { previousLoadByHand[h] = retained; loadByHand[h] = retained; }
  }

  // Decision. Rep counts are kept inside [MIN, MAX]: a legacy session
  // with fewer than MIN reps just enters the ladder at MIN rather than
  // skipping rungs, and advance never exceeds MAX.
  let decision, reps;
  if (shortfallHands.length > 0) {
    decision = "recalibrate";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (incomplete) {
    decision = "incomplete";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (overshootHands.length > 0) {
    // The load catches up first; the rung holds until it is absorbed.
    decision = "recalibrate_up";
    reps = Math.max(LADDER_MIN_REPS, Math.min(LADDER_MAX_REPS, prevReps));
  } else if (adjustedSession) {
    // An easier chosen target is not proof of the same gain at the base load.
    decision = "repeat";
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
      // Hands whose previous rep 1 ran past LADDER_OVERSHOOT_FRAC × T: no
      // pin — the next workout resolves a heavier curve load.
      overshootHands,
      // Hands whose pin was clamped by the engine bounds: { from, to }.
      boundedByHand,
      expectedHands: requiredHands,
      missingHands,
      shortfallHands,
      repCountByHand,
      unevenRepCounts,
      incomplete,
      evidenceByHand: Object.fromEntries(requiredHands.map(h => [h, {
        reason: evidenceByHand[h].reason, restBasis: evidenceByHand[h].restBasis,
      }])),
      adjustedSession,
      restoredPlanByHand,
    },
  };
}

// Resolve the base targets for the next session (before today's elective reduction).
// Normal ladder hands keep their pins. Recalibrating hands use the
// newly-fitted curve at the pinned T, with a guaranteed 5% reduction
// if that fit would otherwise repeat or raise the known-too-high load.
// Overshooting hands use the curve too, between the load just held and
// a +20% step.
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
  const overshootHands = new Set(ladder.basis?.overshootHands || []);

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
    } else if (overshootHands.has(h) && previous > 0) {
      // Never lighter than the load just held; at most one capped step up.
      const ceiling = previous * (1 + LADDER_OVERSHOOT_MAX_STEP_FRAC);
      out[h] = round1(curve > 0 ? Math.min(Math.max(curve, previous), ceiling) : previous);
    } else if (curve > 0) {
      out[h] = round1(curve);
    }
  }

  return Object.keys(out).length > 0 ? out : null;
}

// Overshooting hands whose resolved load is above the load just held. The
// curve can sit at or below it (bounds, an older anchor), and then the load
// holds and nothing should say it rises.
export function overshootRaisedHands(ladder, resolvedLoadByHand) {
  return (ladder?.basis?.overshootHands || []).filter(h =>
    Number(resolvedLoadByHand?.[h]) > Number(ladder.previousLoadByHand?.[h]));
}
