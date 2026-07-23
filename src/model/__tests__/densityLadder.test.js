// Tests for src/model/densityLadder.js — next-workout progression and
// load recalibration from the previous session's first and last reps.
//
// Source protocol (June 2026): 40s max / 20s rest / 4 reps; last rep
// ≥ 10s → next session same load, 5 reps (then 6); last rep < 10s →
// repeat. Rep 1 below 95% of target lowers the next session's load.
// 90s strength holds gate at ~22s. Gate = 25% of target T. Top out at
// 6 reps → +5% load, back to 4.

import {
  computeDensityLadder, resolveDensityLadderLoads,
  LADDER_MIN_REPS, LADDER_MAX_REPS,
  LADDER_FIRST_REP_TARGET_FRAC, LADDER_GATE_FRAC,
  LADDER_LOAD_STEP_FRAC, LADDER_RECALIBRATION_STEP_FRAC,
} from "../densityLadder.js";
import { capacityMultiplier } from "../fatigueBeta.js";
import { enduranceCeilingKg } from "../enduranceTail.js";

// Build one session's reps: `times[hand]` is the per-rep hold times in
// rep order; every rep carries the same T, load, session id, and date.
function session({ id, date, T, loadKg, times, cooked = null }) {
  const out = [];
  for (const [hand, arr] of Object.entries(times)) {
    arr.forEach((t, i) => {
      out.push({
        id: `${id}-${hand}-${i + 1}`,
        session_id: id, date, grip: "Crusher", hand,
        target_duration: T, actual_time_s: t,
        prescribed_load_kg: loadKg,
        rep_num: i + 1, set_num: 1, failed: t < T * 0.95,
        session_cooked: cooked,
      });
    });
  }
  return out;
}

describe("computeDensityLadder", () => {
  test("null when the (grip, zone) has never been trained", () => {
    expect(computeDensityLadder([], "Crusher", "power")).toBeNull();
    expect(computeDensityLadder(null, "Crusher", "power")).toBeNull();
    // Endurance history doesn't activate the power ladder.
    const hist = session({ id: "s1", date: "2026-06-01", T: 200, loadKg: 20, times: { L: [200, 150, 80, 40] } });
    expect(computeDensityLadder(hist, "Crusher", "power")).toBeNull();
  });

  test("source protocol: 40s/4 reps, last rep over the 10s gate → advance to 5", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.2, 24.0, 16.5, 12.1] },   // last rep 12.1s ≥ 10s
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out).not.toBeNull();
    expect(out.decision).toBe("advance");
    expect(out.reps).toBe(5);
    expect(out.T).toBe(40);
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);   // same load
    expect(out.basis.gateSec).toBeCloseTo(40 * LADDER_GATE_FRAC, 1);  // 10s
    expect(out.basis.lastRepSec).toBeCloseTo(12.1, 1);
  });

  test("source protocol: last rep under the gate → repeat the same reps", () => {
    // Decay stays conformant with the recovery model (C ≈ 0.79) so the
    // collapse down-step doesn't fire — this test is about the GATE.
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.2, 22.0, 15.0, 9.5] },    // last rep 9.5s < 10s
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.reps).toBe(4);
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
  });

  test("rep 1 shortfall recalibrates NEXT workout even when the last-rep gate passes", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      // The known-too-heavy pattern: rep 1 misses 95% of target, but
      // the final rep still reaches the old 25% progression gate.
      times: { L: [30, 20, 13, 10] },
    });
    const out = computeDensityLadder(hist, "Crusher", "power", {
      expectedHands: ["L"],
    });
    expect(out.decision).toBe("recalibrate");
    expect(out.reps).toBe(4);
    expect(out.basis.firstRepTargetSec).toBe(
      40 * LADDER_FIRST_REP_TARGET_FRAC
    );
    expect(out.basis.shortfallHands).toEqual(["L"]);
    expect(out.previousLoadByHand.L).toBe(60);
    // The old pin is deliberately removed so the updated curve can
    // set the next workout's load.
    expect(out.loadByHand.L).toBeUndefined();
  });

  test("rep 1 at exactly 95% of target remains eligible to advance", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: { L: [38, 24, 16, 10] },
    });
    const out = computeDensityLadder(hist, "Crusher", "power", {
      expectedHands: ["L"],
    });
    expect(out.decision).toBe("advance");
    expect(out.reps).toBe(5);
  });

  test("90s strength holds gate at ~22s (25% of T)", () => {
    const passing = session({
      id: "s1", date: "2026-06-01", T: 90, loadKg: 44,
      times: { L: [91, 60, 40, 25] },           // last rep 25s ≥ 22.5s
    });
    expect(computeDensityLadder(passing, "Crusher", "strength").decision).toBe("advance");
    const failing = session({
      id: "s2", date: "2026-06-01", T: 90, loadKg: 44,
      times: { L: [91, 55, 33, 19] },           // last rep 19s < 22.5s
    });
    expect(computeDensityLadder(failing, "Crusher", "strength").decision).toBe("repeat");
  });

  test("topping out at max reps with the gate passed steps the load and resets reps", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.5, 28, 20, 16, 13, 11] },  // 6 reps, last 11s ≥ 10s
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("step_load");
    expect(out.reps).toBe(LADDER_MIN_REPS);
    expect(out.loadByHand.L).toBeCloseTo(58.8 * (1 + LADDER_LOAD_STEP_FRAC), 1);
  });

  test("rep count never exceeds the max", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.5, 28, 20, 16, 13] },      // 5 reps, gate passed
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.reps).toBe(LADDER_MAX_REPS);      // 5 → 6, capped
  });

  test("the WORST hand gates progression in Both-mode sessions", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: {
        L: [40.2, 24.0, 16.5, 12.1],             // L passes (12.1 ≥ 10)
        R: [38.0, 21.0, 14.5, 9.0],              // R fails  (9.0 < 10), decay conformant
      },
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.basis.lastRepSec).toBeCloseTo(9.0, 1);
    // Both hands keep their own pinned loads.
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
    expect(out.loadByHand.R).toBeCloseTo(58.8, 1);
  });

  test("missing expected hand marks the previous workout incomplete", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.2, 24, 16.5, 12.1] },
    });
    const out = computeDensityLadder(hist, "Crusher", "power", {
      expectedHands: ["L", "R"],
    });
    expect(out.decision).toBe("incomplete");
    expect(out.reps).toBe(4);
    expect(out.basis.missingHands).toEqual(["R"]);
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
    expect(out.loadByHand.R).toBeUndefined();
  });

  test("uneven Both-mode rep counts repeat without advancing", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: {
        L: [40.2, 24, 16.5, 12.1],
        R: [40.1, 25],
      },
    });
    const out = computeDensityLadder(hist, "Crusher", "power", {
      expectedHands: ["L", "R"],
    });
    expect(out.decision).toBe("incomplete");
    expect(out.reps).toBe(4);
    expect(out.basis.unevenRepCounts).toBe(true);
    expect(out.basis.repCountByHand).toEqual({ L: 4, R: 2 });
  });

  test("single-hand plans can advance from a complete single-hand session", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.2, 24, 16.5, 12.1] },
    });
    const out = computeDensityLadder(hist, "Crusher", "power", {
      expectedHands: ["L"],
    });
    expect(out.decision).toBe("advance");
    expect(out.reps).toBe(5);
  });

  test("uses the LATEST session in the zone, not an older one", () => {
    const hist = [
      ...session({ id: "s1", date: "2026-06-01", T: 40, loadKg: 50,
        times: { L: [40, 20, 12, 11] } }),       // older: would advance
      ...session({ id: "s2", date: "2026-06-05", T: 40, loadKg: 58.8,
        times: { L: [40, 21, 15, 9.8] } }),      // newer: fails gate, decay conformant
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
    expect(out.basis.date).toBe("2026-06-05");
  });

  test("cooked sessions pin the FRESH-EQUIVALENT load (no compounding scale-down)", () => {
    // Fixed manual scaling (July 2026): a session recorded at cooked 5
    // ran at fresh × capacityMultiplier(·, ·, 5). The ladder must
    // divide that back out, or consecutive cooked sessions would
    // ratchet the pin downward (each pin inheriting the previous
    // discount, then getting discounted again). Assert against
    // capacityMultiplier itself so the test tracks the fixed rate.
    const fatigueModel = { Crusher: { beta: 0.02 } }; // beta is ignored by the multiplier
    const mult = capacityMultiplier(fatigueModel, "Crusher", 5);
    const fresh = 60;
    const recorded = fresh * mult;
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: recorded,
      times: { L: [40, 24, 16, 12] }, cooked: 5,
    });
    const out = computeDensityLadder(hist, "Crusher", "power", { fatigueModel });
    expect(out.loadByHand.L).toBeCloseTo(fresh, 0);   // de-cooked back to fresh-equivalent
    // Model-less call: the multiplier is model-independent now, so the
    // round-trip must be identical with no fatigueModel at all.
    const raw = computeDensityLadder(hist, "Crusher", "power");
    expect(raw.loadByHand.L).toBeCloseTo(
      recorded / capacityMultiplier(null, "Crusher", 5), 0
    );
  });

  test("a one-hand manual override pins THAT hand's actual load, not the suggestion", () => {
    // June 2026 regression: user overrode the suggested Micro weight
    // upward on the RIGHT hand only and sustained it. "Same weight,
    // more reps" must mean the weight actually held — re-pinning the
    // old suggestion would silently undo the override. Left hand
    // (no override, Tindeq avg ≈ suggestion) pins as before.
    const hist = [
      ...session({ id: "s1", date: "2026-06-10", T: 40, loadKg: 20,
        times: { L: [40.2, 24, 16.5, 12.1] } }),
      ...session({ id: "s1", date: "2026-06-10", T: 40, loadKg: 20,
        times: { R: [40.5, 25, 17, 13] } }).map(r => ({
          ...r, manual_load_kg: 24,        // user-chosen higher weight
          prescribed_load_kg: 20,          // what the card suggested
        })),
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("advance");
    expect(out.loadByHand.L).toBeCloseTo(20, 1);   // suggestion held
    expect(out.loadByHand.R).toBeCloseTo(24, 1);   // override honored
  });

  test("multi-set session ladders on the LAST set, not a pooled rep count", () => {
    // Regression (July 2026): reps were pooled per hand with set_num
    // ignored, so a 2×4 session read as prevReps = 8 (> LADDER_MAX_REPS
    // = 6) and — with the gate passed — emitted a spurious +5%
    // step_load. Correct reading: the last set is 4 reps on the ladder,
    // gate passed → advance to 5 at the SAME load.
    const set = (setNum, times) => session({
      id: "s1", date: "2026-06-20", T: 40, loadKg: 50,
      times: { L: times },
    }).map(r => ({ ...r, id: `${r.id}-set${setNum}`, set_num: setNum }));
    const hist = [
      ...set(1, [40, 26, 18, 13]),
      ...set(2, [38, 24, 16, 12]),   // last set: rep 4 = 12s ≥ 10s gate
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.basis.prevReps).toBe(4);          // not 8
    expect(out.decision).toBe("advance");        // not step_load
    expect(out.reps).toBe(5);
    expect(out.loadByHand.L).toBeCloseTo(50, 1); // no +5% bump
  });

  test("the gate reads the LAST set's final rep, not a rep_num tie-break", () => {
    // With set_num ignored, both sets' rep-4s tied in the sort and
    // "the last rep" fell to insertion order — here set 1's 12s
    // (passes) instead of set 2's 8s (fails). The second set is the
    // most fatigued readout: it failed the gate, so the ladder must
    // repeat, not advance (and certainly not step the load off a
    // pooled prevReps of 8).
    const set = (setNum, times) => session({
      id: "s1", date: "2026-06-21", T: 40, loadKg: 50,
      times: { L: times },
    }).map(r => ({ ...r, id: `${r.id}-set${setNum}`, set_num: setNum }));
    const hist = [
      ...set(2, [36, 20, 14, 9]),    // last set FAILS the 10s gate…
      ...set(1, [40, 26, 18, 12]),   // …listed after set 1 passed it
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.basis.lastRepSec).toBeCloseTo(9, 1);
    expect(out.decision).toBe("repeat");
    expect(out.reps).toBe(4);
    expect(out.loadByHand.L).toBeCloseTo(50, 1);
  });

  test("legacy rows without set_num still ladder as one set", () => {
    const hist = session({
      id: "s1", date: "2026-06-22", T: 40, loadKg: 50,
      times: { L: [40, 24, 16, 12] },
    }).map(({ set_num, ...r }) => r);   // strip set_num entirely
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.basis.prevReps).toBe(4);
    expect(out.decision).toBe("advance");
  });

  test("gate fraction reproduces both source anchors", () => {
    expect(40 * LADDER_GATE_FRAC).toBeCloseTo(10, 5);
    expect(Math.round(90 * LADDER_GATE_FRAC)).toBeGreaterThanOrEqual(20);
  });
});

// ── Re-pin guard + engine bounds (July 2026) ──────────────────
// The 2026-07-20 and 07-22 endurance misses were ladder pins, not
// engine output: the pin re-played a failed session's rep-1 load
// (which, via effectiveLoad, was the over-pulled avg force — so the
// pin RATCHETED UP across four consecutive failed Micro 160s
// sessions) and bypassed every bound prescription() enforces,
// including the PR #41 endurance-tail ceiling. See
// finger-training-density-ladder-pin project memory.
describe("re-pin guard + engine bounds", () => {
  test("a session whose rep 1 fell short recalibrates the next workout", () => {
    // Micro-7/20-shaped: 160s target, rep 1 died at 32s. "Same
    // weight, more reps" has no basis — the weight was never absorbed.
    const hist = session({
      id: "s1", date: "2026-07-20", T: 160, loadKg: 10.6,
      times: { L: [32.2, 21.5, 20.3, 13.4] },
    });
    const out = computeDensityLadder(hist, "Crusher", "strength_endurance");
    expect(out.decision).toBe("recalibrate");
    expect(out.reps).toBe(4);
    expect(out.loadByHand.L).toBeUndefined();
    expect(out.previousLoadByHand.L).toBeCloseTo(10.6, 1);
  });

  test("per-hand: the short hand is dropped (engine takes it), the passing hand still pins", () => {
    const hist = session({
      id: "s1", date: "2026-07-20", T: 40, loadKg: 50,
      times: {
        L: [40.2, 24, 16.5, 12.1],   // absorbed → pin
        R: [20.0, 15, 10, 8],        // rep 1 short → engine
      },
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out).not.toBeNull();
    expect(out.decision).toBe("recalibrate");
    expect(out.loadByHand.L).toBeCloseTo(50, 1);
    expect(out.loadByHand.R).toBeUndefined();
    expect(out.basis.droppedByHand.R).toBeCloseTo(20, 1);
    expect(out.basis.droppedByHand.L).toBeUndefined();
  });

  test("the guard reads the FIRST set's rep 1 (fresh), not a later set's fatigued rep 1", () => {
    const set = (setNum, times) => session({
      id: "s1", date: "2026-06-21", T: 40, loadKg: 50,
      times: { L: times },
    }).map(r => ({ ...r, id: `${r.id}-set${setNum}`, set_num: setNum }));
    const hist = [
      ...set(1, [40, 26, 18, 12]),   // fresh rep 1 absorbed the load…
      ...set(2, [30, 20, 12, 8]),    // …set 2's rep 1 is fatigued, not a failure signal
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out).not.toBeNull();
    expect(out.loadByHand.L).toBeCloseTo(50, 1);
  });

  test("a surviving pin is clamped by the endurance-tail ceiling it used to bypass", () => {
    // Crusher-7/22-shaped: a manual/spring rep-1 "success" carries a
    // nominal load that is not a measured force — it neither sets the
    // capacity floor nor enters the tail fit, so the measured tail
    // must cap the pin. Measured fresh failures (rep 1, avg_force):
    const measured = [
      { T: 40, F: 40 }, { T: 60, F: 35 }, { T: 90, F: 30 },
      { T: 120, F: 26 }, { T: 160, F: 22 },
    ].map((p, i) => ({
      id: `m${i}`, session_id: `m${i}`, date: `2026-06-0${i + 1}`,
      grip: "Crusher", hand: "L", target_duration: p.T,
      actual_time_s: p.T, avg_force_kg: p.F, prescribed_load_kg: p.F,
      rep_num: 1, set_num: 1, failed: true, session_cooked: null,
    }));
    // Latest endurance-zone session: manual 30 kg nominal, rep 1 held
    // 203s of 200 → passes the re-pin guard; 30 kg is the pin input.
    const manual = {
      id: "man1", session_id: "man1", date: "2026-06-20",
      grip: "Crusher", hand: "L", target_duration: 200,
      actual_time_s: 203, manual_load_kg: 30, prescribed_load_kg: 22,
      rep_num: 1, set_num: 1, failed: false, session_cooked: null,
    };
    const hist = [...measured, manual];
    const out = computeDensityLadder(hist, "Crusher", "endurance");
    expect(out).not.toBeNull();
    const ceil = enduranceCeilingKg(hist, "L", "Crusher", 200);
    expect(ceil).not.toBeNull();
    expect(ceil).toBeLessThan(30);                       // the bound is real
    expect(out.loadByHand.L).toBeCloseTo(ceil, 1);       // pin clamped to it
    expect(out.basis.boundedByHand.L.from).toBeCloseTo(30, 1);
    expect(out.basis.boundedByHand.L.to).toBeCloseTo(ceil, 1);
  });

  test("an absorbed measured pin at its own demonstrated load is NOT clamped", () => {
    // A measured success IS demonstrated capacity: the floor rises to
    // meet it, the floor raises the endurance ceiling, and the pin
    // passes through unchanged — clamping here would argue with the
    // athlete's own logged hold.
    const measured = [
      { T: 40, F: 40 }, { T: 60, F: 35 }, { T: 90, F: 30 },
      { T: 120, F: 26 }, { T: 160, F: 22 },
    ].map((p, i) => ({
      id: `m${i}`, session_id: `m${i}`, date: `2026-06-0${i + 1}`,
      grip: "Crusher", hand: "L", target_duration: p.T,
      actual_time_s: p.T, avg_force_kg: p.F, prescribed_load_kg: p.F,
      rep_num: 1, set_num: 1, failed: true, session_cooked: null,
    }));
    const success = {
      id: "ok1", session_id: "ok1", date: "2026-06-20",
      grip: "Crusher", hand: "L", target_duration: 200,
      actual_time_s: 203, avg_force_kg: 24, prescribed_load_kg: 24,
      rep_num: 1, set_num: 1, failed: false, session_cooked: null,
    };
    const hist = [...measured, success];
    const out = computeDensityLadder(hist, "Crusher", "endurance");
    expect(out).not.toBeNull();
    expect(out.loadByHand.L).toBeCloseTo(24, 1);
    expect(out.basis.boundedByHand.L).toBeUndefined();
  });

  // ── COLLAPSE DOWN-STEP (July 2026) ──────────────────────
  // Reps 2+ decaying far below the personal recovery model's forecast
  // (given the session's own opener) = the load was too heavy to
  // recover between rests, even though rep 1 looked fine. Backtested:
  // re-pinning that load repeats the collapse; −10% restores decay
  // conformance. See densityLadder.js for the numbers.

  test("a collapsed session (reps 2+ far below forecast) pins 10% lighter and holds the rung", () => {
    // Opener over target (46s @ 40s) — passes the re-pin guard — but
    // later reps crater to ~35% of the model's forecast (C ≈ 0.35).
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: { L: [46, 10, 7, 5] },
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("down_step");
    expect(out.reps).toBe(4);                          // rung held, not advanced
    expect(out.loadByHand.L).toBeCloseTo(54, 1);       // 60 × 0.9
    expect(out.basis.collapseByHand.L.from).toBeCloseTo(60, 1);
    expect(out.basis.collapseByHand.L.to).toBeCloseTo(54, 1);
    expect(out.basis.collapseByHand.L.C).toBeLessThan(0.75);
  });

  test("a collapse overrides step_load — no +5% off a session that wasn't absorbed", () => {
    // Six reps with the last over the gate (would top out → +5%), but
    // the middle reps crater far below forecast.
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: { L: [46, 10, 6, 5, 5, 11] },   // last 11s ≥ 10s gate, C ≪ 0.75
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("down_step");
    expect(out.loadByHand.L).toBeCloseTo(54, 1);       // −10%, not +5%
  });

  test("only the collapsed hand steps down; a conforming hand keeps its pin", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: {
        L: [46, 10, 7, 5],            // collapsed (C ≈ 0.35)
        R: [40.2, 24, 16.5, 12.1],    // conformant (C ≈ 0.90)
      },
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("down_step");
    expect(out.loadByHand.L).toBeCloseTo(54, 1);
    expect(out.loadByHand.R).toBeCloseTo(60, 1);
    expect(out.basis.collapseByHand.R).toBeUndefined();
  });

  test("opener shortfall still wins: a dropped hand recalibrates, not down-steps", () => {
    // Rep 1 fails the target → the re-pin guard hands it back to the
    // engine; the collapse rule must not resurrect a pin for it.
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: { L: [20, 8, 5, 4] },    // opener 20s ≪ 40s target
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("recalibrate");
    expect(out.loadByHand.L).toBeUndefined();
  });

  test("too few later reps → no conformance judgment, no down-step", () => {
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 60,
      times: { L: [46, 5] },          // one later rep — below MIN_LATER_REPS
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).not.toBe("down_step");
    expect(out.loadByHand.L).toBeCloseTo(60, 1);
  });
});

describe("resolveDensityLadderLoads", () => {
  const recalibrate = {
    decision: "recalibrate",
    loadByHand: { R: 55 },
    previousLoadByHand: { L: 60, R: 55 },
    basis: {
      expectedHands: ["L", "R"],
      shortfallHands: ["L"],
    },
  };

  test("uses the lower curve result for a missed hand", () => {
    const out = resolveDensityLadderLoads(recalibrate, { L: 50 });
    expect(out).toEqual({ L: 50, R: 55 });
  });

  test("guarantees a reduction when the updated curve stays too high", () => {
    const out = resolveDensityLadderLoads(recalibrate, { L: 62 });
    expect(out.L).toBeCloseTo(
      60 * (1 - LADDER_RECALIBRATION_STEP_FRAC),
      1
    );
    expect(out.R).toBe(55);
  });

  test("falls back to the guaranteed reduction when the curve has no load", () => {
    const out = resolveDensityLadderLoads(recalibrate, {});
    expect(out.L).toBeCloseTo(
      60 * (1 - LADDER_RECALIBRATION_STEP_FRAC),
      1
    );
  });

  test("fills a missing incomplete hand from its curve without reducing it", () => {
    const incomplete = {
      decision: "incomplete",
      loadByHand: { L: 58.8 },
      previousLoadByHand: { L: 58.8 },
      basis: {
        expectedHands: ["L", "R"],
        shortfallHands: [],
      },
    };
    expect(resolveDensityLadderLoads(incomplete, { R: 54 }))
      .toEqual({ L: 58.8, R: 54 });
  });
});
