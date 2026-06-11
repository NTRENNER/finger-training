// Tests for src/model/climbingFatigue.js — session fatigue derivation
// from per-climb RPEs.

import {
  computeSessionFatigue,
  suggestCookedFromClimbs,
  mostRecentClimbDate,
  fatigueToModifier,
  BOARD_WALL_FACTOR, BOARD_WALL_KEYS,
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

describe("board-wall tax", () => {
  const climb = (wall, rpe) => ({ type: "climbing", date: "2026-06-10", wall, rpe });

  test("constants: both board walls taxed, factor > 1", () => {
    expect(BOARD_WALL_KEYS.has("moonboard")).toBe(true);
    expect(BOARD_WALL_KEYS.has("kilter")).toBe(true);
    expect(BOARD_WALL_KEYS.has("commercial")).toBe(false);
    expect(BOARD_WALL_FACTOR).toBeGreaterThan(1);
  });

  test("a board session scores higher than the same session on a commercial set", () => {
    const board = [climb("moonboard", 8), climb("moonboard", 8), climb("moonboard", 9)];
    const gym   = [climb("commercial", 8), climb("commercial", 8), climb("commercial", 9)];
    expect(computeSessionFatigue(board, "2026-06-10"))
      .toBeGreaterThan(computeSessionFatigue(gym, "2026-06-10"));
  });

  test("regression: short-but-fierce board session no longer reads as mild", () => {
    // Three hard MoonBoard problems — the kind of brief savaging that
    // was scoring like a casual gym hour (June 2026).
    const fierce = [climb("moonboard", 8), climb("moonboard", 9), climb("moonboard", 8)];
    expect(computeSessionFatigue(fierce, "2026-06-10")).toBeGreaterThanOrEqual(8);
  });

  test("climbs without a wall (outdoor, rope, legacy) are untaxed", () => {
    const noWall = [
      { type: "climbing", date: "2026-06-10", rpe: 7 },
      { type: "climbing", date: "2026-06-10", rpe: 7 },
    ];
    const commercial = [climb("commercial", 7), climb("commercial", 7)];
    expect(computeSessionFatigue(noWall, "2026-06-10"))
      .toBe(computeSessionFatigue(commercial, "2026-06-10"));
  });

  test("explicit session_rpe override is NOT board-taxed", () => {
    const acts = [{ ...climb("moonboard", 9), session_rpe: 6 }];
    expect(computeSessionFatigue(acts, "2026-06-10")).toBe(6);
  });
});

describe("suggestCookedFromClimbs", () => {
  const climb = (date, rpe) => ({ type: "climbing", date, rpe });

  test("null with no signal (no climbs today or yesterday)", () => {
    expect(suggestCookedFromClimbs([], "2026-06-08")).toBeNull();
    expect(suggestCookedFromClimbs(null, "2026-06-08")).toBeNull();
    // Climbs two days ago don't count.
    expect(suggestCookedFromClimbs([climb("2026-06-06", 8)], "2026-06-08")).toBeNull();
  });

  test("same-day climbs drive the suggestion (today's session fatigue)", () => {
    // 4 × RPE 8 → sessionFatigue 7 (sum 32×0.12 + 8×0.4 ≈ 7).
    const acts = Array.from({ length: 4 }, () => climb("2026-06-08", 8));
    const out = suggestCookedFromClimbs(acts, "2026-06-08");
    expect(out).not.toBeNull();
    expect(out.cooked).toBe(computeSessionFatigue(acts, "2026-06-08"));
    expect(out.todayFatigue).toBe(7);
    expect(out.yesterdayFatigue).toBeNull();
    expect(out.nClimbsToday).toBe(4);
  });

  test("yesterday-only carries over at a decayed weight", () => {
    const acts = Array.from({ length: 4 }, () => climb("2026-06-07", 8));
    const out = suggestCookedFromClimbs(acts, "2026-06-08");
    expect(out).not.toBeNull();
    expect(out.todayFatigue).toBeNull();
    expect(out.yesterdayFatigue).toBe(7);
    // 0.4 × 7 = 2.8 → 3. Carryover is real but much smaller than same-day.
    expect(out.cooked).toBe(3);
    expect(out.nClimbsToday).toBe(0);
  });

  test("today + yesterday stack and clamp at 10", () => {
    const acts = [
      ...Array.from({ length: 8 }, () => climb("2026-06-08", 7)),  // today: fatigue 10
      ...Array.from({ length: 4 }, () => climb("2026-06-07", 8)),  // yesterday: fatigue 7
    ];
    const out = suggestCookedFromClimbs(acts, "2026-06-08");
    expect(out.cooked).toBe(10);  // 10 + 2.8 clamped
  });

  test("regression: the 2026-06-05 inversion — hard same-day bouldering must not suggest 0", () => {
    // Shaped like the real June 5 log: a dozen problems, RPEs 2–8,
    // V8 attempts at RPE 8. The user logged cooked = 0 that day.
    const rpes = [7, 3, 7, 2, 8, 5, 8, 5, 8, 6, 7, 7];
    const acts = rpes.map(r => climb("2026-06-05", r));
    const out = suggestCookedFromClimbs(acts, "2026-06-05");
    expect(out.cooked).toBeGreaterThanOrEqual(5);
  });

  test("non-climbing activities are ignored", () => {
    const acts = [{ type: "oneRM", date: "2026-06-08", rpe: 9 }];
    expect(suggestCookedFromClimbs(acts, "2026-06-08")).toBeNull();
  });
});
