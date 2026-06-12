// Tests for the SET LADDER in workout-progression.js (June 2026):
// volume-first progression — clean session → +1 set at constant load;
// top-out (template + 2) → step load (plates) or feasibility-gated
// bell jump / rep bridge (KBs). Sibling of the finger density ladder.

import {
  recommendSetCount, recommendSet, epley1RM,
  SET_LADDER_CAP_OVER_TEMPLATE, KB_JUMP_MARGIN,
} from "../workout-progression.js";

// One logged session for a single exercise. setsSpec: array of
// { weight, reps, done } (bilateral shape).
const session = (exId, setsSpec, date = "2026-06-08") => ({
  id: `s-${date}`, date, workout: "A", completedAt: `${date}T20:00:00Z`,
  exercises: { [exId]: { sets: setsSpec } },
});

const bench = { id: "bench", reps: "8", sets: 3, loggable: true };
const kbPress = {
  id: "kb_press", reps: "5", sets: 3, loggable: true,
  availableLoads: [35, 50, 55, 62, 70],
};

describe("epley1RM", () => {
  test("w × (1 + r/30); null on bad input", () => {
    expect(epley1RM(100, 1)).toBeCloseTo(103.3, 1);
    expect(epley1RM(55, 8)).toBeCloseTo(69.7, 1);
    expect(epley1RM(0, 5)).toBeNull();
    expect(epley1RM(100, 0)).toBeNull();
  });
});

describe("recommendSetCount — plates", () => {
  test("no history → seed at template sets", () => {
    const out = recommendSetCount([], bench, 3);
    expect(out.sets).toBe(3);
    expect(out.mode).toBe("seed");
  });

  test("clean session → +1 set, accumulate", () => {
    const log = [session("bench", [
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "9", done: true },
    ])];
    const out = recommendSetCount(log, bench, 3);
    expect(out.mode).toBe("accumulate");
    expect(out.sets).toBe(4);
  });

  test("missed reps → repeat the same prescription", () => {
    const log = [session("bench", [
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "6", done: true },   // miss
      { weight: "135", reps: "8", done: true },
    ])];
    const out = recommendSetCount(log, bench, 3);
    expect(out.mode).toBe("repeat");
    expect(out.sets).toBe(4);
  });

  test("topped out clean → step load, reset to template sets", () => {
    const cap = 3 + SET_LADDER_CAP_OVER_TEMPLATE;
    const log = [session("bench",
      Array.from({ length: cap }, () => ({ weight: "135", reps: "8", done: true }))
    )];
    const out = recommendSetCount(log, bench, 3);
    expect(out.mode).toBe("step_load");
    expect(out.sets).toBe(3);
    // recommendSet under this directive bumps the weight.
    const rec = recommendSet(log, bench, "A", 0, null, out);
    expect(parseFloat(rec.weight)).toBeGreaterThan(135);
  });

  test("accumulate directive holds weight (no more +5% every clean week)", () => {
    const log = [session("bench", [
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
    ])];
    const plan = recommendSetCount(log, bench, 3);
    const rec = recommendSet(log, bench, "A", 0, null, plan);
    expect(rec.weight).toBe("135");
    // The ladder-added 4th set inherits the same weight, not blank.
    const rec4 = recommendSet(log, bench, "A", 3, null, plan);
    expect(rec4.weight).toBe("135");
  });
});

describe("recommendSetCount — progressionPolicy 'maintain' (June 2026)", () => {
  // Workout C's light-touch lifts opt out of the set ladder entirely:
  // fixed template sets, held load, by design. The policy lives on the
  // exercise definition (or a per-workout spread-copy of it — see the
  // override suite below), and recommendSetCount short-circuits before
  // any history-based ladder math runs.
  const maintainBench = { ...bench, progressionPolicy: "maintain" };

  test("returns fixed template sets + mode 'maintain' regardless of history", () => {
    // A perfectly clean session that the ladder would reward with +1
    // set — maintain must ignore it and stay at template count.
    const log = [session("bench", [
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
    ])];
    const out = recommendSetCount(log, maintainBench, 3);
    expect(out.mode).toBe("maintain");
    expect(out.sets).toBe(3);
    expect(out.reasoning).toMatch(/maintenance/);
    // And with NO history at all, same answer — the policy is static.
    const empty = recommendSetCount([], maintainBench, 3);
    expect(empty.mode).toBe("maintain");
    expect(empty.sets).toBe(3);
  });

  test("recommendSet under the maintain directive holds the weight", () => {
    // Even a topped-out clean history (which would step_load under the
    // ladder, bumping the weight) must hold flat under maintain.
    const cap = 3 + SET_LADDER_CAP_OVER_TEMPLATE;
    const log = [session("bench",
      Array.from({ length: cap }, () => ({ weight: "135", reps: "8", done: true }))
    )];
    const plan = recommendSetCount(log, maintainBench, 3);
    expect(plan.mode).toBe("maintain");
    const rec = recommendSet(log, maintainBench, "C", 0, null, plan);
    expect(rec.weight).toBe("135");
    expect(rec.reasoning).toMatch(/maintenance/);
  });
});

describe("progressionPolicy spread-override — per-workout scoping (June 2026)", () => {
  // Workout C shares exercise definition objects with Workout A, so
  // the policy is applied via spread copies in C's exercises array
  // ({ ...exercises.dips, progressionPolicy: "maintain" }) rather than
  // on the shared definition. Pin the mechanism: the copy maintains
  // while the SAME base definition, untouched, still runs the ladder.
  test("override copy maintains; the unmodified original still ladders", () => {
    const overridden = { ...bench, progressionPolicy: "maintain" };
    const log = [session("bench", [
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
      { weight: "135", reps: "8", done: true },
    ])];
    // Same history, same exercise id — only the policy field differs.
    const viaOverride = recommendSetCount(log, overridden, 3);
    expect(viaOverride.mode).toBe("maintain");
    expect(viaOverride.sets).toBe(3);
    const viaOriginal = recommendSetCount(log, bench, 3);
    expect(viaOriginal.mode).toBe("accumulate");
    expect(viaOriginal.sets).toBe(4);
    // The spread must not have leaked the policy onto the shared base
    // definition — that's the exact bug the per-membership copies in
    // supportTraining.js exist to prevent (freezing A's progression).
    expect(bench.progressionPolicy).toBeUndefined();
  });
});

describe("recommendSetCount — KB feasibility gate", () => {
  const cap = 3 + SET_LADDER_CAP_OVER_TEMPLATE;
  const cleanKbSession = (weight, reps) => session("kb_press",
    Array.from({ length: cap }, () => ({ weight: String(weight), reps: String(reps), done: true }))
  );

  test("top-out with insufficient est. 1RM → bridge, not jump", () => {
    // 5×5 @ 55: est 1RM ≈ 64.2; next bell 62×5 needs ≈ 72.3 — way short.
    const log = [cleanKbSession(55, 5)];
    const out = recommendSetCount(log, kbPress, 3);
    expect(out.mode).toBe("bridge");
    expect(out.nextLoad).toBe(62);
    expect(out.sets).toBe(3);   // bridge runs at template sets
    // Bridge directive: rep-up at the current bell.
    const rec = recommendSet(log, kbPress, "A", 0, null, out);
    expect(rec.weight).toBe("55");
    expect(parseInt(rec.reps, 10)).toBe(6);
  });

  test("top-out with the gate cleared → jump to the next bell", () => {
    // 5 sets @ 55×10: est 1RM ≈ 73.3; 62×5 needs ≈ 72.3 → within margin.
    const log = [cleanKbSession(55, 10)];
    const out = recommendSetCount(log, kbPress, 3);
    expect(out.mode).toBe("jump");
    expect(out.nextLoad).toBe(62);
    expect(out.est1RM).toBeGreaterThanOrEqual(out.requiredRM * KB_JUMP_MARGIN);
    const rec = recommendSet(log, kbPress, "A", 0, null, out);
    expect(rec.weight).toBe("62");
    expect(rec.reps).toBe("5");
  });

  test("top bell, top sets → hold", () => {
    const log = [cleanKbSession(70, 10)];
    const out = recommendSetCount(log, kbPress, 3);
    expect(out.mode).toBe("hold_top");
  });
});
