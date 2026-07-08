import {
  decayWindowDays, sessionValue, exerciseSupportRisk,
  RISK_WINDOW_POWER_D, RISK_WINDOW_STRENGTH_D, RISK_WINDOW_CONNECTIVE_D,
} from "../supportRisk.js";
import { exercises as EX } from "../supportTraining.js";

const REF = "2026-07-05";
const sess = (date, workout, exMap) => ({ date, workout, exercises: exMap });
const doneSets = (n, extra = {}) => ({ sets: Array.from({ length: n }, () => ({ done: true, reps: 5, ...extra })) });

describe("decayWindowDays", () => {
  test("power/explosive tags → fastest window", () => {
    expect(decayWindowDays(EX.medBallThrows)).toBe(RISK_WINDOW_POWER_D);
  });
  test("strength default; strength+connective mixes stay strength", () => {
    expect(decayWindowDays({ tags: ["strength", "neural"] })).toBe(RISK_WINDOW_STRENGTH_D);
    expect(decayWindowDays({ tags: ["strength", "connective"] })).toBe(RISK_WINDOW_STRENGTH_D);
  });
  test("pure connective → slowest window", () => {
    expect(decayWindowDays({ tags: ["shoulder", "connective"] })).toBe(RISK_WINDOW_CONNECTIVE_D);
  });
});

describe("sessionValue", () => {
  test("weight exercise → top done-set weight", () => {
    const v = sessionValue({ logWeight: true }, { sets: [
      { done: true, weight: 20, reps: 5 }, { done: true, weight: 25, reps: 3 }, { done: false, weight: 30 },
    ]});
    expect(v).toEqual({ metric: "weight", value: 25 });
  });
  test("weightless → total done reps, unilateral sides summed", () => {
    const v = sessionValue({ logWeight: false }, { sets: [
      { done: true, leftReps: 6, rightReps: 6 }, { done: true, reps: 8 },
    ]});
    expect(v).toEqual({ metric: "reps", value: 20 });
  });
  test("nothing done → null; simple done-toggle counts", () => {
    expect(sessionValue({}, { sets: [{ done: false }] })).toBeNull();
    expect(sessionValue({}, { done: true })).toEqual({ metric: "done", value: 1 });
  });
});

describe("exerciseSupportRisk", () => {
  test("stale power exercise outranks equally-stale strength exercise", () => {
    const wlog = [
      sess("2026-06-23", "B", { medBallThrows: doneSets(3) }),   // power, 12d idle → ratio 1.2
      sess("2026-06-23", "A", { weightedPullup: doneSets(3) }),  // strength, 12d idle → ratio ~0.86 (below 1, dropped)
      sess("2026-06-19", "A", { dips: doneSets(3) }),            // strength, 16d idle → ratio ~1.14
    ];
    const out = exerciseSupportRisk(wlog, REF);
    expect(out[0].id).toBe("medBallThrows");
    expect(out.some(r => r.id === "weightedPullup")).toBe(false);  // not yet at risk
    expect(out.some(r => r.id === "dips")).toBe(true);
  });

  test("regression (two consecutive declines) jumps the queue even when fresh", () => {
    const w = (date, weight) => sess(date, "A", { dips: { sets: [{ done: true, weight, reps: 5 }] } });
    const wlog = [w("2026-06-20", 30), w("2026-06-27", 27), w("2026-07-04", 24),
      sess("2026-06-24", "B", { medBallThrows: doneSets(3) })];   // 11d idle power, ratio 1.1
    const out = exerciseSupportRisk(wlog, REF);
    expect(out[0].id).toBe("dips");
    expect(out[0].regressing).toBe(true);
    expect(out[0].daysSince).toBe(1);              // fresh but declining
  });

  test("single down session is noise, not regression", () => {
    const w = (date, weight) => sess(date, "A", { dips: { sets: [{ done: true, weight, reps: 5 }] } });
    const out = exerciseSupportRisk([w("2026-06-20", 30), w("2026-06-27", 32), w("2026-07-04", 29)], REF);
    expect(out.some(r => r.id === "dips" && r.regressing)).toBe(false);
  });

  test("never-logged exercises are skipped", () => {
    const out = exerciseSupportRisk([sess("2026-06-01", "A", { dips: doneSets(2) })], REF);
    expect(out.every(r => r.id === "dips")).toBe(true);
  });
});
