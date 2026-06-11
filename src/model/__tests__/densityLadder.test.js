// Tests for src/model/densityLadder.js — rep-count progression at
// constant load, gated by the previous session's last-rep duration.
//
// Source protocol (June 2026): 40s max / 20s rest / 4 reps; last rep
// ≥ 10s → next session same load, 5 reps (then 6); last rep < 10s →
// repeat. 90s strength holds gate at ~22s. Gate = 25% of target T.
// Top out at 6 reps → +5% load, back to 4.

import {
  computeDensityLadder,
  LADDER_MIN_REPS, LADDER_MAX_REPS,
  LADDER_GATE_FRAC, LADDER_LOAD_STEP_FRAC,
} from "../densityLadder.js";
import { capacityMultiplier } from "../fatigueBeta.js";

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
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: 58.8,
      times: { L: [40.2, 22.0, 12.3, 7.4] },    // last rep 7.4s < 10s
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.reps).toBe(4);
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
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
        R: [38.0, 20.0, 12.0, 8.2],              // R fails  (8.2 < 10)
      },
    });
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.basis.lastRepSec).toBeCloseTo(8.2, 1);
    // Both hands keep their own pinned loads.
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
    expect(out.loadByHand.R).toBeCloseTo(58.8, 1);
  });

  test("uses the LATEST session in the zone, not an older one", () => {
    const hist = [
      ...session({ id: "s1", date: "2026-06-01", T: 40, loadKg: 50,
        times: { L: [40, 20, 12, 11] } }),       // older: would advance
      ...session({ id: "s2", date: "2026-06-05", T: 40, loadKg: 58.8,
        times: { L: [40, 18, 10, 6] } }),        // newer: fails gate
    ];
    const out = computeDensityLadder(hist, "Crusher", "power");
    expect(out.decision).toBe("repeat");
    expect(out.loadByHand.L).toBeCloseTo(58.8, 1);
    expect(out.basis.date).toBe("2026-06-05");
  });

  test("cooked sessions pin the FRESH-EQUIVALENT load (no compounding scale-down)", () => {
    // β = 0.02, cooked 5 → recorded load was fresh × exp(-0.1) ≈ 0.905×.
    // The ladder must divide that back out, or consecutive cooked
    // sessions would ratchet the pin downward.
    const beta = 0.02;
    const fatigueModel = { Crusher: { beta } };
    const fresh = 60;
    const recorded = fresh * Math.exp(-beta * 5);
    const hist = session({
      id: "s1", date: "2026-06-01", T: 40, loadKg: recorded,
      times: { L: [40, 24, 16, 12] }, cooked: 5,
    });
    const out = computeDensityLadder(hist, "Crusher", "power", { fatigueModel });
    expect(out.loadByHand.L).toBeCloseTo(fresh, 0);
    // Without a model, capacityMultiplier falls back to DEFAULT_BETA —
    // the ladder de-cooks with the same default the scale-down side
    // uses, keeping the round-trip symmetric. Assert against the
    // function itself so the test tracks the fallback.
    const raw = computeDensityLadder(hist, "Crusher", "power");
    expect(raw.loadByHand.L).toBeCloseTo(
      recorded / capacityMultiplier(null, "Crusher", 5), 0
    );
  });

  test("gate fraction reproduces both source anchors", () => {
    expect(40 * LADDER_GATE_FRAC).toBeCloseTo(10, 5);
    expect(Math.round(90 * LADDER_GATE_FRAC)).toBeGreaterThanOrEqual(20);
  });
});
