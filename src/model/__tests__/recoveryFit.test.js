// Tests for src/model/recoveryFit.js — personal recovery tau fit
// with Bayesian shrinkage toward the population prior.

import {
  computePersonalRecoveryTausForGrip,
  computePersonalRecoveryTaus,
  fatParamsFromTauR,
} from "../recoveryFit.js";
import { PHYS_MODEL_DEFAULT } from "../fatigue.js";

const POP = PHYS_MODEL_DEFAULT.tauR;

// Helper: simulate a within-set rep-time sequence using the same model
// recoveryFit fits against. Lets tests inject a known "true" tau and
// verify the fit recovers it (within shrinkage).
function simulateSet({ firstT, nReps, restS, tauR, sessionId, hand = "L", grip = "Crusher" }) {
  const W = PHYS_MODEL_DEFAULT.weights;
  const D = PHYS_MODEL_DEFAULT.tauD;
  const comps = [
    { w: W.fast,   tD: D.fast,   tR: tauR.fast,   avail: 1.0 },
    { w: W.medium, tD: D.medium, tR: tauR.medium, avail: 1.0 },
    { w: W.slow,   tD: D.slow,   tR: tauR.slow,   avail: 1.0 },
  ];
  const reps = [];
  for (let i = 0; i < nReps; i++) {
    const cap = comps.reduce((s, c) => s + c.w * c.avail, 0);
    const t = Math.max(0.01, firstT * cap);
    reps.push({
      session_id: sessionId,
      hand, grip,
      rep_num: i + 1,
      actual_time_s: t,
      avg_force_kg: 25,
      rest_s: restS,
    });
    for (const c of comps) c.avail = Math.max(0, c.avail * Math.exp(-t / c.tD));
    if (i < nReps - 1) {
      for (const c of comps) {
        const rec = 1 - Math.exp(-restS / c.tR);
        c.avail = Math.min(1, c.avail + (1 - c.avail) * rec);
      }
    }
  }
  return reps;
}

describe("computePersonalRecoveryTausForGrip", () => {
  test("empty / null history returns null", () => {
    expect(computePersonalRecoveryTausForGrip([], "Crusher")).toBeNull();
    expect(computePersonalRecoveryTausForGrip(null, "Crusher")).toBeNull();
  });

  test("history with no qualifying sets (≥3 reps) returns null", () => {
    const history = [
      { session_id: "s1", hand: "L", grip: "Crusher", rep_num: 1, actual_time_s: 8, avg_force_kg: 25, rest_s: 20 },
      { session_id: "s1", hand: "L", grip: "Crusher", rep_num: 2, actual_time_s: 6, avg_force_kg: 25, rest_s: 20 },
      // only 2 reps — needs 3 to count (rep 1 anchor + 2 to score)
    ];
    expect(computePersonalRecoveryTausForGrip(history, "Crusher")).toBeNull();
  });

  test("ignores reps with hand='B' (legacy corruption)", () => {
    // Build 5 sets of B-hand reps — none should count toward the fit.
    const history = [];
    for (let s = 0; s < 5; s++) {
      for (let r = 0; r < 4; r++) {
        history.push({
          session_id: `s${s}`, hand: "B", grip: "Crusher",
          rep_num: r + 1, actual_time_s: 5, avg_force_kg: 25, rest_s: 20,
        });
      }
    }
    expect(computePersonalRecoveryTausForGrip(history, "Crusher")).toBeNull();
  });

  test("with no data, slow tau pinned to population (always)", () => {
    // Even when there IS qualifying data, slow stays at population —
    // short sets can't constrain it. Build many sets with crazy tauR_slow
    // and verify the fit still returns POP.slow.
    const history = [];
    for (let s = 0; s < 30; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 5, restS: 20,
        tauR: { fast: 10, medium: 60, slow: 99999 },  // absurd slow
        sessionId: `s${s}`,
      });
      history.push(...reps);
    }
    const taus = computePersonalRecoveryTausForGrip(history, "Crusher");
    expect(taus).not.toBeNull();
    expect(taus.slow).toBe(POP.slow);
  });

  test("recovers a known fast tauR within shrinkage tolerance", () => {
    // Build 30 sets with a known fast tauR significantly different from
    // the population (8 vs population 15). With 30 sets and PRIOR_WEIGHT=5,
    // the shrunk fit should be ~(5*15 + 30*8)/35 ≈ 9.0. Allow a window.
    const history = [];
    for (let s = 0; s < 30; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 5, restS: 20,
        tauR: { fast: 8, medium: POP.medium, slow: POP.slow },
        sessionId: `s${s}`,
      });
      history.push(...reps);
    }
    const taus = computePersonalRecoveryTausForGrip(history, "Crusher");
    expect(taus).not.toBeNull();
    // Shrunk toward population — should land between 8 (true) and 15 (pop).
    expect(taus.fast).toBeGreaterThan(8);
    expect(taus.fast).toBeLessThan(15);
    // n=30, prior=5 → ~85% personal weight, so should be close to 8
    expect(taus.fast).toBeLessThan(11);
  });

  test("shrinkage: 2 observations stay close to population", () => {
    // Few sets → shrinkage dominates → fit stays near pop value.
    const history = [];
    for (let s = 0; s < 2; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 5, restS: 20,
        tauR: { fast: 4, medium: POP.medium, slow: POP.slow },  // very different from pop
        sessionId: `s${s}`,
      });
      history.push(...reps);
    }
    const taus = computePersonalRecoveryTausForGrip(history, "Crusher");
    expect(taus).not.toBeNull();
    // n=2, prior=5 → ~70% weight on pop, so should be much closer to 15 than 4.
    // Expected: (5*15 + 2*4) / 7 ≈ 11.9
    expect(taus.fast).toBeGreaterThan(9);
    expect(taus.fast).toBeLessThan(15);
  });

  test("nSets is exposed for downstream calibration indicators", () => {
    const history = [];
    for (let s = 0; s < 7; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 4, restS: 20,
        tauR: { fast: 10, medium: 60, slow: POP.slow },
        sessionId: `s${s}`,
      });
      history.push(...reps);
    }
    const taus = computePersonalRecoveryTausForGrip(history, "Crusher");
    expect(taus.nSets).toBe(7);
  });

  // Regression: setsForGrip used to group only by (session_id, hand).
  // rep_num restarts per set, so a multi-set session interleaved as
  // ONE pseudo-set [s1r1, s2r1, s1r2, s2r2, ...] and was scored as a
  // single continuous decay — corrupting the fit.
  describe("multi-set sessions (set_num grouping)", () => {
    const trueTau = { fast: 8, medium: POP.medium, slow: POP.slow };

    test("two sets in one session count as two sets, not one merged blob", () => {
      const set1 = simulateSet({ firstT: 8, nReps: 4, restS: 20, tauR: trueTau, sessionId: "s1" })
        .map(r => ({ ...r, set_num: 1 }));
      const set2 = simulateSet({ firstT: 8, nReps: 4, restS: 20, tauR: trueTau, sessionId: "s1" })
        .map(r => ({ ...r, set_num: 2 }));
      const taus = computePersonalRecoveryTausForGrip([...set1, ...set2], "Crusher");
      expect(taus).not.toBeNull();
      expect(taus.nSets).toBe(2);
    });

    test("one session with two sets fits identically to two single-set sessions", () => {
      const mk = (sid, setNum) => simulateSet({
        firstT: 8, nReps: 5, restS: 20, tauR: trueTau, sessionId: sid,
      }).map(r => (setNum != null ? { ...r, set_num: setNum } : r));

      // 15 two-set sessions vs 30 single-set sessions with identical decay data.
      const oneSessionPer2Sets = [];
      const twoSessions = [];
      for (let s = 0; s < 15; s++) {
        oneSessionPer2Sets.push(...mk(`m${s}`, 1), ...mk(`m${s}`, 2));
        twoSessions.push(...mk(`a${s}`), ...mk(`b${s}`));
      }
      const tausMulti  = computePersonalRecoveryTausForGrip(oneSessionPer2Sets, "Crusher");
      const tausSingle = computePersonalRecoveryTausForGrip(twoSessions, "Crusher");
      expect(tausMulti.nSets).toBe(tausSingle.nSets);
      expect(tausMulti.fast).toBeCloseTo(tausSingle.fast, 6);
      expect(tausMulti.medium).toBeCloseTo(tausSingle.medium, 6);
    });
  });
});

describe("computePersonalRecoveryTaus (per-grip map)", () => {
  test("returns empty map for empty history", () => {
    const map = computePersonalRecoveryTaus([]);
    expect(map.size).toBe(0);
  });

  test("fits each grip independently", () => {
    const history = [];
    // Crusher: tauR_fast = 10
    for (let s = 0; s < 10; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 4, restS: 20,
        tauR: { fast: 10, medium: 60, slow: POP.slow },
        sessionId: `crusher-${s}`, grip: "Crusher",
      });
      history.push(...reps);
    }
    // Micro: tauR_fast = 30 (very slow)
    for (let s = 0; s < 10; s++) {
      const reps = simulateSet({
        firstT: 8, nReps: 4, restS: 20,
        tauR: { fast: 30, medium: 60, slow: POP.slow },
        sessionId: `micro-${s}`, grip: "Micro",
      });
      history.push(...reps);
    }
    const map = computePersonalRecoveryTaus(history);
    expect(map.has("Crusher")).toBe(true);
    expect(map.has("Micro")).toBe(true);
    // Crusher should land below population (true=10, pop=15)
    expect(map.get("Crusher").fast).toBeLessThan(15);
    // Micro should land above population (true=30, pop=15)
    expect(map.get("Micro").fast).toBeGreaterThan(15);
    // Per-grip independence — Micro fit should be substantially higher than Crusher
    expect(map.get("Micro").fast).toBeGreaterThan(map.get("Crusher").fast + 5);
  });
});

describe("fatParamsFromTauR", () => {
  test("converts tauR triple to legacy {A1,tau1,...} fatParams shape", () => {
    const taus = { fast: 12, medium: 80, slow: 500 };
    const fp = fatParamsFromTauR(taus);
    const W = PHYS_MODEL_DEFAULT.weights;
    expect(fp).toEqual({
      A1: W.fast,   tau1: 12,
      A2: W.medium, tau2: 80,
      A3: W.slow,   tau3: 500,
    });
  });

  test("accepts custom weights", () => {
    const taus = { fast: 10, medium: 60, slow: 400 };
    const w = { fast: 0.4, medium: 0.4, slow: 0.2 };
    const fp = fatParamsFromTauR(taus, w);
    expect(fp.A1).toBe(0.4);
    expect(fp.A2).toBe(0.4);
    expect(fp.A3).toBe(0.2);
  });
});
