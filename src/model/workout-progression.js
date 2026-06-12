// ─────────────────────────────────────────────────────────────
// WORKOUT PROGRESSION RECOMMENDER
// ─────────────────────────────────────────────────────────────
// Given the user's workout history and an exercise definition,
// returns a recommended { weight, reps, reasoning } for each set
// of the next session — so startSession can pre-fill the inputs
// with a sensible target instead of just copying the previous
// session's numbers verbatim.
//
// Two progression strategies:
//
//   1. Plate (single progression). Default for any exercise
//      WITHOUT an availableLoads list. After a clean session
//      (all target reps hit), bump weight by ~5%, snapping to a
//      2.5 lb increment. After a missed-reps session, hold the
//      weight and aim for the same target reps. Backs off only
//      on catastrophic misses (≤50% of target).
//
//   2. Double progression (rep-up). For exercises WITH an
//      availableLoads list — typically kettlebells with discrete
//      weight ladders (35, 50, 55, 62, 70 lbs etc.). Instead of
//      bumping the weight every time (which would mean +10–15%
//      per jump for KBs), we add a rep at the current weight
//      until reps reach the top of the range, then jump to the
//      next available load and reset reps to the target.
//
// Unilateral exercises run both strategies per side, because
// hands are often asymmetric.
//
// Pure JS, no React. The startSession path consumes this; the
// SessionExRow display can also call recommendSet to render the
// "↑ +5 lbs (clean session)" hint underneath each input.

import { isBodyweightAdditive, parseRepsCount } from "./workout-volume.js";

// Parse a reps string like "5", "8", "8–12", "8-12", "6/side" into
// { targetReps, topReps }. targetReps is the lower bound (or only
// number); topReps is the upper bound — explicit if a range was
// given, otherwise computed as round(targetReps × 1.6) so we have
// room for double-progression on KB exercises whose template only
// names a single rep target.
//
// "/side" suffixes have already been stripped from current
// DEFAULT_WORKOUTS entries (the unilateral schema replaces them);
// parseRepsCount handles any legacy strings that still carry one.
export function parseRepRange(repsStr) {
  if (!repsStr) return { targetReps: 0, topReps: 0 };
  const s = String(repsStr);
  // Match "8–12" or "8-12" with either dash. The first number is the
  // target/lower bound, the second is the top of the range.
  const m = s.match(/^(\d+)\s*[–-]\s*(\d+)/);
  if (m) {
    const lo = parseInt(m[1], 10);
    const hi = parseInt(m[2], 10);
    if (isFinite(lo) && isFinite(hi) && lo > 0 && hi >= lo) {
      return { targetReps: lo, topReps: hi };
    }
  }
  const target = parseRepsCount(s);
  if (target <= 0) return { targetReps: 0, topReps: 0 };
  // Default top = target × 1.6 (e.g., target=5 → top=8; target=8 → top=13).
  // Wide enough that you spend a few sessions repping up before
  // jumping to the next KB; tight enough that the rep-up phase
  // doesn't turn into endless conditioning work.
  return { targetReps: target, topReps: Math.round(target * 1.6) };
}

// Round a weight to the nearest 2.5 lb increment, with a floor on
// the bump size so a 1% calculation still nudges by something
// usable. Used for plate exercises where the user has 2.5 / 5 lb
// plates available.
function roundToPlateIncrement(weight) {
  return Math.round(weight / 2.5) * 2.5;
}

// Pick the next-larger available load from a sorted ladder, or null
// if already at the top. availableLoads is an array of numbers (in
// display unit, since per-set weights are stored in display unit).
function nextAvailableLoad(currentWeight, availableLoads) {
  if (!Array.isArray(availableLoads) || availableLoads.length === 0) return null;
  const sorted = [...availableLoads].sort((a, b) => a - b);
  for (const load of sorted) {
    if (load > currentWeight + 0.001) return load; // small epsilon for fp safety
  }
  return null; // already at top
}

// Recommend a single side's load + reps based on what was done last
// time at this set index. Returns { weight, reps, reasoning } where
// reasoning is a short human-readable string ("↑ +5 lbs (clean)" /
// "= hold (missed reps)" / "→ next KB · 35 → 50, reset reps") that
// the UI surfaces under the input so the user understands the
// suggestion.
function recommendSide(prev, exDef, repRange, ladder = null) {
  const { targetReps, topReps } = repRange;
  const usesAvailableLoads = Array.isArray(exDef?.availableLoads) && exDef.availableLoads.length > 0;

  // No prior data — use the template's target reps and let the
  // user fill in the weight (they know their own equipment best
  // for the very first session).
  if (!prev || (!prev.weight && !prev.reps)) {
    return {
      weight: prev?.weight ?? "",
      reps:   String(targetReps || exDef?.reps || ""),
      reasoning: "",
    };
  }

  const prevWeight = parseFloat(prev.weight);
  const prevReps   = parseRepsCount(prev.reps);
  const prevDone   = !!prev.done;
  const hasWeight  = isFinite(prevWeight) && prevWeight > 0;
  const hasReps    = prevReps > 0;
  const hitTarget  = hasReps && targetReps > 0 && prevReps >= targetReps;
  const cleanLast  = prevDone && hitTarget;
  const badMiss    = prevDone && hasReps && targetReps > 0 && prevReps <= targetReps * 0.5;

  // Set-ladder directives (June 2026): when the caller passes a
  // ladder plan, it owns the LOAD policy — weight holds while sets
  // accumulate, steps/jumps only at top-out, and KB rep-up runs only
  // in bridge mode. Without a ladder (legacy callers, tests), the
  // original per-set strategies below apply unchanged.
  if (ladder && hasWeight && !badMiss) {   // catastrophic miss → legacy back-off below
    if (ladder.mode === "accumulate" || ladder.mode === "repeat") {
      return {
        weight: String(prevWeight),
        reps:   String(targetReps || prevReps),
        reasoning: ladder.mode === "accumulate"
          ? "= hold (ladder: building sets)"
          : "= hold (ladder: repeat)",
      };
    }
    if (ladder.mode === "step_load" && cleanLast) {
      const raw = prevWeight * 1.05;
      const bumped = roundToPlateIncrement(Math.max(raw, prevWeight + 2.5));
      return {
        weight: String(bumped),
        reps:   String(targetReps || prevReps),
        reasoning: `↑ +${(bumped - prevWeight).toFixed(1).replace(/\.0$/, "")} lbs (ladder top-out)`,
      };
    }
    if (ladder.mode === "jump" && ladder.nextLoad != null) {
      return {
        weight: String(ladder.nextLoad),
        reps:   String(targetReps),
        reasoning: `→ next KB · ${prevWeight} → ${ladder.nextLoad} (gate cleared), reset reps`,
      };
    }
    if (ladder.mode === "maintain" || ladder.mode === "quality") {
      return {
        weight: String(prevWeight),
        reps:   String(targetReps || prevReps),
        reasoning: ladder.mode === "maintain" ? "= hold (maintenance)" : "= hold (quality work)",
      };
    }
    if (ladder.mode === "double") {
      // Rep-up at constant load; at top of range, advise the next
      // implement (med balls are discrete — user enters the new ball).
      if (cleanLast && prevReps < topReps) {
        return {
          weight: String(prevWeight),
          reps:   String(prevReps + 1),
          reasoning: "↑ +1 fast rep (same ball)",
        };
      }
      if (cleanLast) {
        return {
          weight: String(prevWeight),
          reps:   String(targetReps),
          reasoning: "top reps at full speed — grab the next ball, reset reps",
        };
      }
      return {
        weight: String(prevWeight),
        reps:   String(targetReps || prevReps),
        reasoning: "= hold (keep every rep fast)",
      };
    }
    if (ladder.mode === "bridge") {
      const nextReps = cleanLast
        ? Math.min(topReps || prevReps + 1, prevReps + 1)
        : (targetReps || prevReps);
      return {
        weight: String(prevWeight),
        reps:   String(nextReps),
        reasoning: cleanLast
          ? `↑ +1 rep (bridging toward ${ladder.nextLoad ?? "next bell"})`
          : "= hold (bridge: retry reps)",
      };
    }
    // "seed" / "hold_top" fall through to the legacy strategies.
  }

  // Strategy 1: KB-style double progression — rep up at the
  // current weight, jump to the next load when at top of range.
  if (usesAvailableLoads && hasWeight) {
    if (cleanLast && prevReps >= topReps) {
      const nextLoad = nextAvailableLoad(prevWeight, exDef.availableLoads);
      if (nextLoad != null) {
        return {
          weight: String(nextLoad),
          reps:   String(targetReps),
          reasoning: `→ next KB · ${prevWeight} → ${nextLoad}, reset reps`,
        };
      }
      // Already at top KB AND top of rep range — stay flat,
      // there's nowhere higher to go without different equipment.
      return {
        weight: String(prevWeight),
        reps:   String(prevReps),
        reasoning: "= hold (top KB, top reps)",
      };
    }
    if (cleanLast) {
      return {
        weight: String(prevWeight),
        reps:   String(prevReps + 1),
        reasoning: `↑ +1 rep (rep-up at ${prevWeight} lbs)`,
      };
    }
    // Missed reps last time at the current KB — try to hit the
    // same target before progressing further.
    return {
      weight: String(prevWeight),
      reps:   String(targetReps || prevReps),
      reasoning: hasReps ? `= hold (missed ${targetReps - prevReps} rep${targetReps - prevReps !== 1 ? "s" : ""})` : "= hold (incomplete)",
    };
  }

  // Strategy 2: Plate single progression — bump weight ~5% on
  // a clean session, snap to 2.5 lb increments. Ensure at least
  // a 2.5 lb bump so the recommendation actually moves.
  if (hasWeight) {
    if (cleanLast) {
      const raw = prevWeight * 1.05;
      const bumped = roundToPlateIncrement(Math.max(raw, prevWeight + 2.5));
      return {
        weight: String(bumped),
        reps:   String(targetReps || prevReps),
        reasoning: `↑ +${(bumped - prevWeight).toFixed(1).replace(/\.0$/, "")} lbs (clean last session)`,
      };
    }
    if (badMiss) {
      const raw = prevWeight * 0.92;
      const dropped = roundToPlateIncrement(Math.max(raw, prevWeight - 5));
      return {
        weight: String(dropped),
        reps:   String(targetReps || prevReps),
        reasoning: `↓ -${(prevWeight - dropped).toFixed(1).replace(/\.0$/, "")} lbs (back off, missed badly)`,
      };
    }
    // Mild miss — hold the weight, retry the target.
    return {
      weight: String(prevWeight),
      reps:   String(targetReps || prevReps),
      reasoning: hasReps && targetReps > prevReps
        ? `= hold (missed ${targetReps - prevReps} rep${targetReps - prevReps !== 1 ? "s" : ""})`
        : "= hold",
    };
  }

  // Bodyweight-only or no-weight exercise — just suggest the rep
  // target and let the user log what they actually did.
  return {
    weight: String(prev.weight ?? ""),
    reps:   String(prev.reps ?? targetReps ?? ""),
    reasoning: "",
  };
}

// ─────────────────────────────────────────────────────────────
// SET LADDER (June 2026) — volume-first progression
// ─────────────────────────────────────────────────────────────
// Sibling of the finger density ladder: hold the LOAD constant and
// earn SETS. Clean session (every done set hit target reps) → +1 set
// next time, same weight. Topped out (template + 2 sets, clean) →
// step the load and reset to the template's set count — which makes
// the first week at the new load LESS total work, a built-in
// mini-deload exactly when intensity rises (accumulate → intensify).
// Miss → repeat the same prescription (no auto-retreat; the existing
// catastrophic-miss backoff in recommendSide still applies).
//
// KB / discrete-load exercises share the ladder, with a FEASIBILITY
// GATE at the top: jumps between bells are big and unequal (35→50 is
// +43%), and adding sets doesn't build the per-set strength a jump
// needs. So at top-out we estimate 1RM (Epley, best recent set) and
// jump only when the next bell × target reps is within KB_JUMP_MARGIN
// of it; otherwise BRIDGE — back to template sets, repping up (the
// old double progression) until the estimate clears, then jump.
export const SET_LADDER_CAP_OVER_TEMPLATE = 2;
// Jump when est. 1RM ≥ margin × the 1RM the next bell's target set
// requires. 0.95 ≈ last rep around RPE 9.5 on the first new-bell
// session, cushioned by the set-count reset.
export const KB_JUMP_MARGIN = 0.95;

// Epley estimated 1RM: w × (1 + r/30). Unit-agnostic.
export function epley1RM(weight, reps) {
  const w = Number(weight);
  const r = Number(reps);
  if (!(w > 0) || !(r > 0)) return null;
  return w * (1 + r / 30);
}

// Per-set rep check for clean-session evaluation, handling both
// bilateral and unilateral set shapes. Unilateral: BOTH sides must
// hit target (the weaker side gates, same as the finger ladder).
function setHitTarget(set, unilateral, targetReps) {
  if (!set || !set.done || !(targetReps > 0)) return false;
  if (unilateral) {
    return parseRepsCount(set.leftReps) >= targetReps
        && parseRepsCount(set.rightReps) >= targetReps;
  }
  return parseRepsCount(set.reps) >= targetReps;
}

// Decide next session's SET COUNT (and load directive) for one
// exercise. Pure derivation from the workout log — no stored ladder
// state, same philosophy as the finger ladder. Returns:
//   {
//     sets,        // set count to prescribe
//     mode,        // "seed" | "accumulate" | "repeat" | "step_load"
//                  //   | "bridge" | "jump" | "hold_top"
//     nextLoad,    // KB jump target (jump mode only)
//     est1RM, requiredRM,   // KB gate receipts (bridge/jump modes)
//     reasoning,   // human-readable receipt for the UI
//   }
export function recommendSetCount(history, exDef, templateSets) {
  const base = Math.max(1, Number(templateSets) || 1);

  // Per-exercise progression policy (June 2026): the set ladder's
  // "clean session = advance" gate assumes near-failure rep targets.
  // Power and maintenance work pass that gate by DESIGN, so laddering
  // them escalates volume forever — degrading the power stimulus and
  // turning the light-touch day into a second strength day.
  //   "double"   — fixed sets; rep-up at constant load (fast reps
  //                only, user-judged), advance load at top of range.
  //   "maintain" — fixed sets, held load: a capped dose by design.
  //   "quality"  — fixed sets/reps; progression is execution quality.
  // Default (unset) = "ladder", the volume-first scheme below.
  const policy = exDef?.progressionPolicy;
  if (policy === "double" || policy === "maintain" || policy === "quality") {
    return {
      sets: base,
      mode: policy,
      reasoning: policy === "maintain"
        ? "maintenance dose — sets and load held by design"
        : policy === "double"
          ? "fixed sets — build fast reps, then step the load"
          : "fixed sets — progress execution quality, not volume",
    };
  }

  const cap = base + SET_LADDER_CAP_OVER_TEMPLATE;
  const { targetReps, topReps } = parseRepRange(exDef?.reps);
  const lastSession = findLastSession(history, null, exDef?.id);
  const doneSets = (lastSession?.exercises?.[exDef?.id]?.sets || [])
    .filter(s => !!(s && s.done));
  if (doneSets.length === 0 || !(targetReps > 0)) {
    return { sets: base, mode: "seed", reasoning: "" };
  }
  const prevCount = doneSets.length;
  const clean = doneSets.every(s => setHitTarget(s, exDef?.unilateral, targetReps));
  const usesKB = Array.isArray(exDef?.availableLoads) && exDef.availableLoads.length > 0;

  if (!clean) {
    return {
      sets: Math.min(cap, Math.max(base, prevCount)),
      mode: "repeat",
      reasoning: `ladder: missed reps — repeat ${Math.max(base, prevCount)} sets at the same load`,
    };
  }
  if (prevCount < cap) {
    const next = Math.max(base, prevCount) + 1;
    return {
      sets: Math.min(cap, next),
      mode: "accumulate",
      reasoning: `ladder: clean ${prevCount}×${targetReps} → ${Math.min(cap, next)} sets, same load`,
    };
  }

  // Topped out, clean. Plates: step the load, reset sets.
  if (!usesKB) {
    return {
      sets: base,
      mode: "step_load",
      reasoning: `ladder: topped out ${cap} sets → step load, back to ${base} sets`,
    };
  }

  // KB top-out: feasibility gate.
  const sideEst = (weightKey, repsKey) => {
    let best = null;
    for (const s of doneSets) {
      const e = epley1RM(parseFloat(s[weightKey]), parseRepsCount(s[repsKey]));
      if (e != null && (best == null || e > best)) best = e;
    }
    return best;
  };
  const est1RM = exDef?.unilateral
    ? (() => {
        const l = sideEst("leftWeight", "leftReps");
        const r = sideEst("rightWeight", "rightReps");
        if (l == null || r == null) return l ?? r;
        return Math.min(l, r);   // weaker side gates the jump
      })()
    : sideEst("weight", "reps");
  const curWeight = Math.max(...doneSets.map(s =>
    parseFloat(exDef?.unilateral ? s.leftWeight : s.weight) || 0));
  const nextLoad = nextAvailableLoad(curWeight, exDef.availableLoads);
  if (nextLoad == null) {
    return {
      sets: cap, mode: "hold_top",
      reasoning: "ladder: top bell, top sets — nowhere higher without heavier equipment",
    };
  }
  const requiredRM = epley1RM(nextLoad, targetReps);
  const feasible = est1RM != null && requiredRM != null
    && est1RM >= requiredRM * KB_JUMP_MARGIN;
  if (feasible) {
    return {
      sets: base, mode: "jump", nextLoad, est1RM, requiredRM,
      reasoning: `ladder: topped out — ${nextLoad} reachable (est 1RM ${Math.round(est1RM)} vs ${Math.round(requiredRM)} needed), jumping · back to ${base} sets`,
    };
  }
  return {
    sets: base, mode: "bridge", nextLoad, est1RM, requiredRM,
    reasoning: `ladder: ${nextLoad} not reachable yet (est 1RM ${Math.round(est1RM ?? 0)}, need ~${Math.round((requiredRM ?? 0) * KB_JUMP_MARGIN)}) — building reps at the current bell, ${base} sets`,
  };
}

// Find the most recent USABLE session matching the given predicate.
// Sorts candidates by date DESC (then completedAt DESC as tiebreaker)
// rather than walking the array backward, because the array's
// insertion order can drift from chronological order — a tombstone
// reconcile, an out-of-order cloud sync, or a manual edit can leave
// an older session sitting at a higher index than a newer one. Picking
// by array position let those older sessions shadow newer ones (e.g.,
// an empty-weight 04-16 dips entry was returned instead of a clean
// 04-21 dips entry, leaving the recommender with no weight to work with).
//
// "Usable" still means at least one set was marked done. Non-empty
// weight/reps alone aren't enough because startSession pre-fills both
// from the recommendation — an aborted session looks just like a
// partially-typed real one and would otherwise shadow real prior data.
function findLastSessionWhere(history, exId, predicate) {
  const candidates = [];
  for (const s of history) {
    if (!predicate(s)) continue;
    const sets = s?.exercises?.[exId]?.sets;
    if (!Array.isArray(sets) || sets.length === 0) continue;
    if (!sets.some(set => !!(set && set.done))) continue;
    candidates.push(s);
  }
  if (candidates.length === 0) return null;
  candidates.sort((a, b) => {
    const ad = a?.date || "";
    const bd = b?.date || "";
    if (ad !== bd) return bd.localeCompare(ad); // newer date first
    const ac = a?.completedAt || "";
    const bc = b?.completedAt || "";
    return bc.localeCompare(ac); // newer completion first
  });
  return candidates[0];
}

// Find the most recent usable session containing `exId`, REGARDLESS
// of which workout key it was logged under. For exercises that appear
// in multiple workouts (dips lives in both A and B; pull-ups in both;
// curls when they show up across rotations), progression should track
// the most recent time the user actually did the lift — not the most
// recent time they did it in this specific workout slot. Otherwise
// Workout A's dips drift from yesterday's Workout B dips and you end
// up recommending stale weights.
//
// `workoutKey` is still passed in so the caller can detect when the
// returned session came from a different workout (we annotate the
// reasoning with "[from <workout>]" in that case for transparency).
function findLastSession(history, workoutKey, exId) {
  if (!Array.isArray(history)) return null;
  return findLastSessionWhere(history, exId, s => !!s);
}

// Public API: recommend a single set's pre-fill given history,
// the exercise definition, the active workout key, and which set
// index we're computing for. Returns either a bilateral
// { weight, reps, reasoning } or a unilateral
// { leftWeight, leftReps, leftReasoning, rightWeight, rightReps, rightReasoning }
// shape based on exDef.unilateral. Either shape is consumed
// directly by the UI's input pre-fill + reasoning annotation.
//
// `bw` is the user's bodyweight at the (intended) session date in
// display units — used to resolve effective load on bodyweight-
// additive exercises. Currently only fed to the bodyweight-additive
// detector for conditional reasoning text; the recommender does
// NOT add bodyweight to the recorded weight (the user types added
// weight, the volume math folds bodyweight in separately).
export function recommendSet(history, exDef, workoutKey, setIdx, bw = null, ladder = null) {
  const repRange = parseRepRange(exDef?.reps);
  const lastSession = findLastSession(history, workoutKey, exDef.id);
  const prevSets = lastSession?.exercises?.[exDef.id]?.sets;
  // Ladder-added sets have no positional precedent in the previous
  // session (setIdx beyond its count) — inherit the last set's values
  // so the new set seeds at the same weight instead of blank.
  const lastSet = prevSets?.[setIdx] ?? (ladder ? prevSets?.[prevSets.length - 1] : undefined);

  // If we fell back across workouts, prepend a small hint to the
  // reasoning so the user understands why the suggestion exists when
  // the current workout has no history for this exercise.
  const fromOtherWorkout = lastSession && lastSession.workout && lastSession.workout !== workoutKey
    ? lastSession.workout
    : null;
  const decorate = (rec) => {
    if (!fromOtherWorkout) return rec;
    const hint = `[from ${fromOtherWorkout}]`;
    const r = rec?.reasoning;
    return { ...rec, reasoning: r ? `${hint} ${r}` : hint };
  };

  if (exDef?.unilateral) {
    // Per-side history: prefer L/R fields if the prior session was
    // unilateral, fall back to the bilateral weight/reps fields
    // mirrored to both sides for legacy data.
    const leftPrev = lastSet ? {
      weight: lastSet.leftWeight ?? lastSet.weight ?? "",
      reps:   lastSet.leftReps   ?? lastSet.reps   ?? "",
      done:   !!lastSet.done,
    } : null;
    const rightPrev = lastSet ? {
      weight: lastSet.rightWeight ?? lastSet.weight ?? "",
      reps:   lastSet.rightReps   ?? lastSet.reps   ?? "",
      done:   !!lastSet.done,
    } : null;
    const left  = decorate(recommendSide(leftPrev,  exDef, repRange, ladder));
    const right = decorate(recommendSide(rightPrev, exDef, repRange, ladder));
    return {
      leftWeight:    left.weight,
      leftReps:      left.reps,
      leftReasoning: left.reasoning,
      rightWeight:    right.weight,
      rightReps:      right.reps,
      rightReasoning: right.reasoning,
    };
  }

  const prev = lastSet ? {
    weight: lastSet.weight ?? lastSet.leftWeight ?? "",
    reps:   lastSet.reps   ?? lastSet.leftReps   ?? "",
    done:   !!lastSet.done,
  } : null;
  // Inform the bodyweight-additive check via the exDef so it can
  // shape future reasoning text (kept for parity even though the
  // current logic doesn't branch on it).
  void isBodyweightAdditive(exDef);
  void bw;
  return decorate(recommendSide(prev, exDef, repRange, ladder));
}
