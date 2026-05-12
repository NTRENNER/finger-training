// Tests for src/model/climbingFatigue.js — session fatigue derivation
// from per-climb RPEs.

import {
  computeSessionFatigue,
  mostRecentClimbDate,
  fatigueToModifier,
} from "../climbingFatigue.js";

describe("computeSessionFatigue", () => {
  test("returns null with no activities or no date", () => {
    expect(computeSessionFatigue([], "2026-05-10")).toBeNull();
    expect(computeSessionFatigue(null, "2026-05-10")).toBeNull();
    expect(computeSessionFatigue([{ type: "climbing", date: "2026-05-10", rpe: 7 }], null)).toBeNull();
  });

  test("returns null when there are no climbs on the target date", () => {
    const acts = [{ type: "climbing", date: "2026-05-09", rpe: 7 }];
    expect(computeSessionFatigue(acts, "2026-05-10")).toBeNull();
  });

  test("one RPE 9 attempt scores around 5 (single max effort)", () => {
    const acts = [{ type: "climbing", date: "2026-05-10", rpe: 9 }];
    const f = computeSessionFatigue(acts, "2026-05-10");
    expect(f).toBeGreaterThanOrEqual(4);
    expect(f).toBeLessThanOrEqual(6);
  });

  test("eight RPE 7 climbs scores high (volume slogfest)", () => {
    const acts = Array.from({ length: 8 }, () => ({
      type: "climbing", date: "2026-05-10", rpe: 7,
    }));
    const f = computeSessionFatigue(acts, "2026-05-10");
    expect(f).toBeGreaterThanOrEqual(9);
  });

  test("volume session beats single max effort in fatigue", () => {
    const onAttempt = [{ type: "climbing", date: "2026-05-10", rpe: 9 }];
    const volume = Array.from({ length: 8 }, () => ({
      type: "climbing", date: "2026-05-10", rpe: 7,
    }));
    expect(computeSessionFatigue(volume, "2026-05-10"))
      .toBeGreaterThan(computeSessionFatigue(onAttempt, "2026-05-10"));
  });

  test("warmup-only day scores low", () => {
    const acts = [
      { type: "climbing", date: "2026-05-10", rpe: 3 },
      { type: "climbing", date: "2026-05-10", rpe: 3 },
    ];
    expect(computeSessionFatigue(acts, "2026-05-10")).toBeLessThanOrEqual(3);
  });

  test("clamps to 1-10 range", () => {
    const many = Array.from({ length: 20 }, () => ({
      type: "climbing", date: "2026-05-10", rpe: 10,
    }));
    expect(computeSessionFatigue(many, "2026-05-10")).toBe(10);
  });

  test("ignores non-climbing rows", () => {
    const acts = [
      { type: "climbing", date: "2026-05-10", rpe: 7 },
      { type: "rest",     date: "2026-05-10", rpe: 10 },
    ];
    // Just the climbing rpe 7 → low session fatigue
    const f = computeSessionFatigue(acts, "2026-05-10");
    expect(f).toBeLessThanOrEqual(5);
  });

  test("uses explicit session_rpe override if present (Phase B)", () => {
    const acts = [
      // Per-climb RPEs would derive a high score, but session_rpe override
      // says 4 — that's what we use.
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
    ];
    expect(computeSessionFatigue(acts, "2026-05-10")).toBe(4);
  });
});

describe("mostRecentClimbDate", () => {
  test("returns null with no activities", () => {
    expect(mostRecentClimbDate([], new Date("2026-05-11"))).toBeNull();
    expect(mostRecentClimbDate(null, new Date("2026-05-11"))).toBeNull();
  });

  test("finds most recent within window", () => {
    const acts = [
      { type: "climbing", date: "2026-05-09", rpe: 7 },
      { type: "climbing", date: "2026-05-10", rpe: 8 },
      { type: "climbing", date: "2026-05-08", rpe: 6 },
    ];
    expect(mostRecentClimbDate(acts, new Date("2026-05-11"), 7))
      .toBe("2026-05-10");
  });

  test("returns null when no climbs within window", () => {
    const acts = [{ type: "climbing", date: "2026-04-01", rpe: 7 }];
    expect(mostRecentClimbDate(acts, new Date("2026-05-11"), 3)).toBeNull();
  });

  test("ignores future-dated climbs", () => {
    const acts = [{ type: "climbing", date: "2026-05-20", rpe: 7 }];
    expect(mostRecentClimbDate(acts, new Date("2026-05-11"), 30)).toBeNull();
  });
});

describe("fatigueToModifier", () => {
  test("returns 1.0 with null fatigue", () => {
    expect(fatigueToModifier("power", null, 12)).toBe(1.0);
  });

  test("returns 1.0 outside 48h window", () => {
    expect(fatigueToModifier("power", 10, 60)).toBe(1.0);
    expect(fatigueToModifier("power", 10, -1)).toBe(1.0);
  });

  test("higher fatigue → smaller modifier (more suppression)", () => {
    const low  = fatigueToModifier("power", 3, 12);
    const high = fatigueToModifier("power", 10, 12);
    expect(high).toBeLessThan(low);
  });

  test("modifier decays as hours-ago grows", () => {
    const fresh = fatigueToModifier("power", 10, 0);
    const stale = fatigueToModifier("power", 10, 36);
    expect(stale).toBeGreaterThan(fresh);
  });

  test("power suppresses harder than endurance at same fatigue", () => {
    const powerMod = fatigueToModifier("power", 9, 6);
    const endMod   = fatigueToModifier("endurance", 9, 6);
    expect(powerMod).toBeLessThan(endMod);
  });

  test("at 48h, modifier returns to 1.0", () => {
    expect(fatigueToModifier("power", 10, 48)).toBe(1.0);
  });
});
