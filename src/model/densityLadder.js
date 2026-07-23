// ─────────────────────────────────────────────────────────────
// DENSITY LADDER — rep-count progression at constant load
// ─────────────────────────────────────────────────────────────
// Progression scheme from device-based training practice (June 2026):
// instead of raising the LOAD every session (the curve-fit default),
// hold the load constant and earn REPS, gated by the LAST rep's
// duration. The last rep is the most fatigued, so its hold time is a
// clean readout of whether the dose was absorbed:
//
//   protocol: T-seconds max hold · short rest · N reps
//   • last rep ≥ gate (25% of T) → next session: same load, N+1 reps
//   • last rep <  gate          → next session: same load, same N
//   • N reaches 6 with the gate passed → add 5% load, reset to 4 reps
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
import { loadBounds, isShortfall } from "./prescription.js";

export const LADDER_MIN_REPS = 4;
export const LADDER_MAX_REPS = 6;
// Last-rep gate as a fraction of the session's target duration.
// 0.25 reproduces the source protocol at both anchor points:
// 10s @ 40s, ~22s @ 90s.
export const LADDER_GATE_FRAC = 0.25;
// Load bump when the ladder tops out (6 reps, gate passed).
export const LADDER_LOAD_STEP_FRAC = 0.05;

const round1 = (v) => Math.round(v * 10) / 10;

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
//     decision,     // "advance" | "repeat" | "step_load"
//     basis: {      // receipts for the Why line
//       date, prevReps, gateSec,
//       lastRepSec,        // worst (min) last-rep time across hands
//       lastRepSecByHand,  // { L?, R? }
//     },
//   }
export function computeDensityLadder(history, grip, zoneKey, opts = {}) {
  const { fatigueModel = null } = opts;
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
  const gateSec = round1(T * LADDER_GATE_FRAC);

  // Last-rep time per hand; the WORST hand gates progression so both
  // hands climb the ladder together (the source protocol prescribes
  // one rep count, not per-hand counts).
  const lastRepSecByHand = {};
  let prevReps = 0;
  for (const [h, reps] of Object.entries(byHand)) {
    const last = reps[reps.length - 1];
    lastRepSecByHand[h] = Number(last.actual_time_s) || 0;
    prevReps = Math.max(prevReps, reps.length);
  }
  const lastRepSec = Math.min(...Object.values(lastRepSecByHand));
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
  // semantics) gets NO pin — the runner falls back to prescription()
  // for that hand, which owns the correction. Both hands short → no
  // ladder at all.
  // The absorption readout is the FIRST set's rep 1 — the only truly
  // fresh rep. A later set's rep 1 runs under cumulative fatigue and
  // may fall short of T even when the load is right, so it must not
  // trip the guard (the pin itself still reads the LAST set's rep 1,
  // unchanged).
  const droppedByHand = {};
  const loadByHand = {};
  for (const [h, reps] of Object.entries(byHand)) {
    const rep1 = reps[0];
    const firstSetNum = Math.min(...byHandSet[h].keys());
    const freshRep1 = [...byHandSet[h].get(firstSetNum)]
      .sort((a, b) => (a.rep_num ?? 1) - (b.rep_num ?? 1))[0];
    if (isShortfall(freshRep1.actual_time_s, T)) {
      droppedByHand[h] = round1(Number(freshRep1.actual_time_s) || 0);
      continue;
    }
    const recorded = effectiveLoad(rep1) || prescribedLoad(rep1);
    if (!(recorded > 0)) continue;
    const thenMult = capacityMultiplier(fatigueModel, grip, rep1.session_cooked ?? 0);
    loadByHand[h] = round1(thenMult > 0 ? recorded / thenMult : recorded);
  }
  if (Object.keys(loadByHand).length === 0) return null;

  // Decision. Rep counts are kept inside [MIN, MAX]: a legacy session
  // with fewer than MIN reps just enters the ladder at MIN rather than
  // skipping rungs, and advance never exceeds MAX.
  let decision, reps;
  if (gatePassed && prevReps >= LADDER_MAX_REPS) {
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
    decision,
    basis: {
      date: sess.date,
      prevReps,
      gateSec,
      lastRepSec: round1(lastRepSec),
      lastRepSecByHand,
      // Hands whose previous rep 1 fell short of T (value = that rep-1
      // time, s): no pin — the runner re-prescribes them via the engine.
      droppedByHand,
      // Hands whose pin was clamped by the engine bounds: { from, to }.
      boundedByHand,
    },
  };
}
