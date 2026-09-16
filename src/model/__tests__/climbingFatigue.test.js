// Tests for src/model/climbingFatigue.js — session fatigue derived
// from logged climbs.

import {
  computeSessionFatigue,
  sessionFatigueDetail,
  suggestCookedFromClimbs,
  mostRecentClimbDate,
  attemptsOf,
  BOARD_WALL_FACTOR, BOARD_WALL_KEYS, MAX_ATTEMPTS_PER_CLIMB,
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
    // 8 under the old clamp; the ceiling is now reserved for days
    // carrying several times this much work.
    expect(computeSessionFatigue(acts, "2026-05-10")).toBe(8);
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
    const f = computeSessionFatigue(acts, "2026-05-10");
    expect(f).toBeLessThanOrEqual(5);
  });

  test("uses explicit session_rpe override if present", () => {
    const acts = [
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
      { type: "climbing", date: "2026-05-10", rpe: 9, session_rpe: 4 },
    ];
    expect(computeSessionFatigue(acts, "2026-05-10")).toBe(4);
  });
});

// ── The September 2026 rewrite ───────────────────────────────
// Two defects, tested separately because either alone flattens the
// scale: the score saturated, and volume counted rows rather than
// efforts. See the header comment in climbingFatigue.js.

describe("the score never saturates", () => {
  const day = (n, rpe) => Array.from({ length: n }, () => ({
    type: "climbing", date: "2026-05-10", rpe,
  }));
  const exact = acts => sessionFatigueDetail(acts, "2026-05-10").scoreExact;

  test("more work always scores strictly higher, well past the old clamp", () => {
    // Under `clamp(1, 10, round(Σ·0.12 + max·0.4))` every one of these
    // was exactly 10 — 72% of real logged days landed here, which made
    // the number nearly constant on the days it was consulted.
    const ladder = [10, 15, 20, 30, 45].map(n => exact(day(n, 8)));
    for (let i = 1; i < ladder.length; i++) {
      expect(ladder[i]).toBeGreaterThan(ladder[i - 1]);
    }
    // A 45-climb day and a 15-climb day are no longer the same number.
    expect(exact(day(45, 8)) - exact(day(15, 8))).toBeGreaterThan(0.2);
  });

  test("it approaches the ceiling without exceeding it", () => {
    // The curve is asymptotic, so even the largest day in five months
    // of real logging (45 climbs) is still strictly under the ceiling
    // and still has room above it. Past roughly 60 hard climbs the
    // remaining gap falls below float precision and the exact score
    // reaches 10; that is a limit of the representation, not of the
    // ordering, which holds everywhere the gap is representable.
    const biggestReal = sessionFatigueDetail(day(45, 10), "2026-05-10");
    expect(biggestReal.scoreExact).toBeLessThan(10);
    expect(biggestReal.score).toBe(10);
    expect(sessionFatigueDetail(day(200, 10), "2026-05-10").scoreExact)
      .toBeLessThanOrEqual(10);
  });
});

describe("attempts count as work", () => {
  const climb = (rpe, attempts, over = {}) => ({
    type: "climbing", date: "2026-05-10", rpe, attempts, ...over,
  });

  test("attemptsOf defaults to 1 and rejects nonsense", () => {
    expect(attemptsOf({})).toBe(1);                       // pre-migration row
    expect(attemptsOf({ attempts: null })).toBe(1);
    expect(attemptsOf({ attempts: 0 })).toBe(1);
    expect(attemptsOf({ attempts: -4 })).toBe(1);
    expect(attemptsOf({ attempts: "seven" })).toBe(1);
    expect(attemptsOf({ attempts: 8 })).toBe(8);
    expect(attemptsOf({ attempts: 3.6 })).toBe(4);        // rounded
    expect(attemptsOf({ attempts: 10000 })).toBe(MAX_ATTEMPTS_PER_CLIMB);
  });

  test("one row with eight attempts equals eight rows of one", () => {
    const asOneRow = [climb(8, 8)];
    const asEightRows = Array.from({ length: 8 }, () => climb(8, 1));
    expect(sessionFatigueDetail(asOneRow, "2026-05-10").scoreExact)
      .toBeCloseTo(sessionFatigueDetail(asEightRows, "2026-05-10").scoreExact, 10);
  });

  test("peak intensity is per-attempt, not multiplied by the count", () => {
    // Eight burns on one problem is more VOLUME than one burn, but it
    // is not a harder single effort — the peak term must not inflate.
    expect(sessionFatigueDetail([climb(8, 8)], "2026-05-10").peak).toBe(8);
    expect(sessionFatigueDetail([climb(8, 8)], "2026-05-10").volume).toBe(64);
  });

  test("nAttempts is reported alongside nClimbs", () => {
    const d = sessionFatigueDetail([climb(8, 8), climb(5, 1), climb(5, 1)], "2026-05-10");
    expect(d.nClimbs).toBe(3);
    expect(d.nAttempts).toBe(10);
  });

  test("regression: a projecting session no longer scores below a moderate day", () => {
    // Nathan's case — eight burns on a V7, sent on the eighth, plus two
    // warm-ups. Logged honestly it is THREE rows, so the row-counting
    // formula scored it 6, below a ten-climb moderate day at 8: the
    // scale was ordered backwards exactly where it mattered most,
    // because the hardest sessions have the fewest rows per unit work.
    const projecting = [climb(8, 8), climb(5, 1), climb(5, 1)];
    const moderate = Array.from({ length: 10 }, () => climb(5, 1, { rpe: 5 }))
      .concat([climb(6, 1)]);

    expect(computeSessionFatigue(projecting, "2026-05-10"))
      .toBeGreaterThan(computeSessionFatigue(moderate, "2026-05-10"));

    // And the inversion is exactly what the attempts column fixes: drop
    // the count and the same session falls back below the moderate day.
    const unattributed = projecting.map(({ attempts, ...c }) => c);
    expect(computeSessionFatigue(unattributed, "2026-05-10"))
      .toBeLessThan(computeSessionFatigue(moderate, "2026-05-10"));
  });

  test("history without the column keeps the meaning it always had", () => {
    // Every pre-migration row meant one attempt, which is what the old
    // formula assumed, so no backfill is needed and none is implied.
    const legacy = [
      { type: "climbing", date: "2026-05-10", rpe: 7 },
      { type: "climbing", date: "2026-05-10", rpe: 5 },
    ];
    const explicit = legacy.map(c => ({ ...c, attempts: 1 }));
    expect(sessionFatigueDetail(legacy, "2026-05-10").scoreExact)
      .toBeCloseTo(sessionFatigueDetail(explicit, "2026-05-10").scoreExact, 10);
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

  test("the tax applies per attempt", () => {
    const one = sessionFatigueDetail([{ ...climb("moonboard", 8), attempts: 4 }], "2026-06-10");
    expect(one.volume).toBeCloseTo(4 * 8 * BOARD_WALL_FACTOR, 10);
  });

  test("explicit session_rpe override is NOT board-taxed", () => {
    const acts = [{ ...climb("moonboard", 9), session_rpe: 6 }];
    expect(computeSessionFatigue(acts, "2026-06-10")).toBe(6);
  });
});

describe("suggestCookedFromClimbs", () => {
  const climb = (date, rpe, over = {}) => ({ type: "climbing", date, rpe, ...over });

  test("null with no signal (no climbs today or yesterday)", () => {
    expect(suggestCookedFromClimbs([], "2026-06-08")).toBeNull();
    expect(suggestCookedFromClimbs(null, "2026-06-08")).toBeNull();
    // Climbs two days ago don't count.
    expect(suggestCookedFromClimbs([climb("2026-06-06", 8)], "2026-06-08")).toBeNull();
  });

  test("same-day climbs drive the suggestion (today's session fatigue)", () => {
    const acts = Array.from({ length: 4 }, () => climb("2026-06-08", 8));
    const out = suggestCookedFromClimbs(acts, "2026-06-08");
    expect(out).not.toBeNull();
    expect(out.cooked).toBe(computeSessionFatigue(acts, "2026-06-08"));
    expect(out.todayFatigue).toBe(7);
    expect(out.yesterdayFatigue).toBeNull();
    expect(out.nClimbsToday).toBe(4);
    expect(out.nAttemptsToday).toBe(4);
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
      ...Array.from({ length: 8 }, () => climb("2026-06-08", 7)),  // today: 8
      ...Array.from({ length: 4 }, () => climb("2026-06-07", 8)),  // yesterday: 7
    ];
    expect(suggestCookedFromClimbs(acts, "2026-06-08").cooked).toBe(10);
  });

  test("attempts reach the suggestion", () => {
    const light = [climb("2026-06-08", 8, { attempts: 1 })];
    const projecting = [climb("2026-06-08", 8, { attempts: 8 })];
    expect(suggestCookedFromClimbs(projecting, "2026-06-08").cooked)
      .toBeGreaterThan(suggestCookedFromClimbs(light, "2026-06-08").cooked);
    expect(suggestCookedFromClimbs(projecting, "2026-06-08").nAttemptsToday).toBe(8);
  });

  test("regression: the 2026-06-05 inversion — hard same-day bouldering must not suggest 0", () => {
    const rpes = [7, 3, 7, 2, 8, 5, 8, 5, 8, 6, 7, 7];
    const acts = rpes.map(r => climb("2026-06-05", r));
    expect(suggestCookedFromClimbs(acts, "2026-06-05").cooked).toBeGreaterThanOrEqual(5);
  });

  test("non-climbing activities are ignored", () => {
    const acts = [{ type: "oneRM", date: "2026-06-08", rpe: 9 }];
    expect(suggestCookedFromClimbs(acts, "2026-06-08")).toBeNull();
  });
});
