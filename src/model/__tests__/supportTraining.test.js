// Tests for src/model/supportTraining.js — support workout
// recommender + tag-staleness helpers.
//
// Strategy: pin each rule of the 7-rule decision tree with at least
// one test, plus edge cases (empty history, future-dated entries,
// unknown workoutId). The recommender accepts an explicit `refDate`
// so tests don't depend on wall-clock time.

import {
  workouts,
  recommendNextWorkout,
  daysBetween,
  daysSinceLastOfType,
  computeTagDaysSince,
  recentClimbDayCount,
} from "../supportTraining.js";

// ─────────────────────────────────────────────────────────────
// Test fixtures
// ─────────────────────────────────────────────────────────────
// Anchor every test to a fixed reference date so day arithmetic is
// deterministic. Tests build sessions as "N days before refDate".

const REF_DATE = "2026-05-21";

function daysBefore(refDate, n) {
  const d = new Date(refDate + "T00:00:00Z");
  d.setUTCDate(d.getUTCDate() - n);
  return d.toISOString().slice(0, 10);
}

function sess(workoutId, daysAgo) {
  return {
    id: `${workoutId}-${daysAgo}`,
    workoutId,
    date: daysBefore(REF_DATE, daysAgo),
  };
}

function climb(daysAgo) {
  return {
    id: `c-${daysAgo}`,
    type: "climb",
    date: daysBefore(REF_DATE, daysAgo),
  };
}

// ─────────────────────────────────────────────────────────────
// daysBetween
// ─────────────────────────────────────────────────────────────

describe("daysBetween", () => {
  test("returns positive count when b is later", () => {
    expect(daysBetween("2026-05-21", "2026-05-28")).toBe(7);
  });
  test("returns negative when b is earlier", () => {
    expect(daysBetween("2026-05-28", "2026-05-21")).toBe(-7);
  });
  test("returns 0 for same date", () => {
    expect(daysBetween("2026-05-21", "2026-05-21")).toBe(0);
  });
  test("returns NaN for invalid input", () => {
    expect(Number.isNaN(daysBetween("not-a-date", "2026-05-21"))).toBe(true);
    expect(Number.isNaN(daysBetween(null, "2026-05-21"))).toBe(true);
    expect(Number.isNaN(daysBetween("2026-05-21", undefined))).toBe(true);
  });
});

// ─────────────────────────────────────────────────────────────
// daysSinceLastOfType
// ─────────────────────────────────────────────────────────────

describe("daysSinceLastOfType", () => {
  test("returns Infinity when no matching session exists", () => {
    const history = [sess("B", 3)];
    expect(daysSinceLastOfType(history, "A", REF_DATE)).toBe(Infinity);
  });

  test("returns Infinity for empty history", () => {
    expect(daysSinceLastOfType([], "A", REF_DATE)).toBe(Infinity);
    expect(daysSinceLastOfType(null, "A", REF_DATE)).toBe(Infinity);
  });

  test("returns days since the most recent matching session", () => {
    const history = [sess("A", 10), sess("A", 3), sess("A", 14)];
    expect(daysSinceLastOfType(history, "A", REF_DATE)).toBe(3);
  });

  test("doesn't confuse different workoutIds", () => {
    const history = [sess("A", 5), sess("B", 1), sess("C", 8)];
    expect(daysSinceLastOfType(history, "A", REF_DATE)).toBe(5);
    expect(daysSinceLastOfType(history, "B", REF_DATE)).toBe(1);
    expect(daysSinceLastOfType(history, "C", REF_DATE)).toBe(8);
    expect(daysSinceLastOfType(history, "D", REF_DATE)).toBe(Infinity);
  });
});

// ─────────────────────────────────────────────────────────────
// computeTagDaysSince
// ─────────────────────────────────────────────────────────────

describe("computeTagDaysSince", () => {
  test("workout sessions contribute their template tags", () => {
    // C tags: positionalCapacity + mobility + restoration. ("hip" is
    // an exercise-level descriptor — it does NOT appear as a workout-
    // level tag, by design: workout-level tags describe the stimulus,
    // not the body parts touched. See note on workouts.A.)
    const tagDays = computeTagDaysSince([sess("C", 4)], [], REF_DATE);
    expect(tagDays.positionalCapacity).toBe(4);
    expect(tagDays.mobility).toBe(4);
    expect(tagDays.restoration).toBe(4);
    expect(tagDays.hip).toBeUndefined();
  });

  test("climbing activities contribute the CLIMB tag bundle", () => {
    const tagDays = computeTagDaysSince([], [climb(2)], REF_DATE);
    // CLIMB.tags: ["climbing", "finger", "neural", "connective"]
    expect(tagDays.climbing).toBe(2);
    expect(tagDays.finger).toBe(2);
    expect(tagDays.neural).toBe(2);
    expect(tagDays.connective).toBe(2);
  });

  test("picks the MINIMUM days across all sources for shared tags", () => {
    // Both A (10 days ago) and a hard climb (2 days ago) tag "neural".
    // The recent climb should win.
    const tagDays = computeTagDaysSince(
      [sess("A", 10)],
      [climb(2)],
      REF_DATE,
    );
    expect(tagDays.neural).toBe(2);
  });

  test("future-dated entries are ignored", () => {
    const future = { id: "f", workoutId: "A", date: daysBefore(REF_DATE, -5) };
    const tagDays = computeTagDaysSince([future], [], REF_DATE);
    expect(tagDays.strength).toBeUndefined();
  });

  test("unknown workoutId is skipped, not crashed", () => {
    const tagDays = computeTagDaysSince(
      [{ id: "x", workoutId: "ZZZ", date: daysBefore(REF_DATE, 2) }],
      [],
      REF_DATE,
    );
    expect(tagDays).toEqual({});
  });

  test("non-climb activities are ignored", () => {
    const tagDays = computeTagDaysSince(
      [],
      [{ id: "r", type: "rpe", date: daysBefore(REF_DATE, 1) }],
      REF_DATE,
    );
    expect(tagDays).toEqual({});
  });
});

// ─────────────────────────────────────────────────────────────
// recentClimbDayCount
// ─────────────────────────────────────────────────────────────

describe("recentClimbDayCount", () => {
  test("counts distinct dates within window", () => {
    const climbs = [climb(0), climb(1), climb(3), climb(4)];
    expect(recentClimbDayCount(climbs, REF_DATE, 5)).toBe(4);
  });

  test("dedupes multiple climbs on the same date", () => {
    const climbs = [climb(2), climb(2), climb(2)];
    expect(recentClimbDayCount(climbs, REF_DATE, 5)).toBe(1);
  });

  test("respects the window boundary (exclusive)", () => {
    // window of 5 → days 0,1,2,3,4 count; day 5 does not.
    const climbs = [climb(4), climb(5)];
    expect(recentClimbDayCount(climbs, REF_DATE, 5)).toBe(1);
  });

  test("ignores non-climb activities", () => {
    const mixed = [climb(1), { id: "r", type: "rpe", date: daysBefore(REF_DATE, 0) }];
    expect(recentClimbDayCount(mixed, REF_DATE, 5)).toBe(1);
  });

  test("returns 0 for empty input", () => {
    expect(recentClimbDayCount([], REF_DATE, 5)).toBe(0);
    expect(recentClimbDayCount(null, REF_DATE, 5)).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// recommendNextWorkout — rule-by-rule
// ─────────────────────────────────────────────────────────────

describe("recommendNextWorkout: Rule 1 (A overdue + energyLow → D)", () => {
  test("blocks A and recommends D with caution when energy is low", () => {
    const history = [sess("A", 10)]; // A overdue
    const rec = recommendNextWorkout(history, {
      energyLow: true,
      refDate: REF_DATE,
    });
    expect(rec.primary.id).toBe("D");
    expect(rec.caution).toBeTruthy();
    expect(rec.alternatives.map(w => w.id)).toContain("REST");
  });

  test("doesn't block A when energyLow is false", () => {
    const history = [sess("A", 10)];
    const rec = recommendNextWorkout(history, {
      energyLow: false,
      refDate: REF_DATE,
    });
    expect(rec.primary.id).toBe("A");
  });
});

describe("recommendNextWorkout: Rule 2 (A overdue + energy OK → A)", () => {
  test("recommends A when last A was 7+ days ago", () => {
    const history = [sess("A", 7)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("A");
    expect(rec.reason).toMatch(/7 days ago/);
  });

  test("recommends A when no A has ever been done", () => {
    const rec = recommendNextWorkout([], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("A");
    expect(rec.reason).toMatch(/No A on record/);
  });

  test("does NOT recommend A when last A was 6 days ago", () => {
    const history = [sess("A", 6)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).not.toBe("A");
  });
});

describe("recommendNextWorkout: Rule 3 (hip stale → C)", () => {
  test("recommends C when hip work is 8 days old and A is fresh", () => {
    // A recently done (so rule 1/2 don't fire), C 8 days ago.
    const history = [sess("A", 2), sess("C", 8)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
  });

  test("recommends C when hip has NEVER been touched", () => {
    // A recent, nothing else. positionalCapacity = Infinity = stale.
    const history = [sess("A", 2)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
    expect(rec.reason).toMatch(/hasn't been touched yet/);
  });
});

describe("recommendNextWorkout: Rule 4 (power stale → B)", () => {
  test("recommends B when power is 10+ days old and other rules don't fire", () => {
    // A fresh, C fresh (so hip not stale), B old.
    const history = [
      sess("A", 2),
      sess("C", 3),
      sess("B", 11),
    ];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("B");
  });

  test("does NOT fire when power is only 9 days old", () => {
    const history = [
      sess("A", 2),
      sess("C", 3),
      sess("B", 9),
    ];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).not.toBe("B");
  });
});

describe("recommendNextWorkout: Rule 5 (D touch stale → D)", () => {
  test("recommends D when last D was 4+ days ago and nothing else is overdue", () => {
    // A fresh, C fresh, B fresh, D 5 days ago.
    const history = [
      sess("A", 2),
      sess("C", 3),
      sess("B", 3),
      sess("D", 5),
    ];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("D");
  });
});

describe("recommendNextWorkout: REST is never recommended", () => {
  // The user signals their own rest needs — the engine doesn't
  // prompt REST. Pin the invariant: even high climbing density
  // (which the previous Rule 6 used to fire on) doesn't produce
  // a REST recommendation.
  test("does NOT recommend REST even at high climbing density", () => {
    const history = [
      sess("A", 2),
      sess("C", 3),
      sess("B", 3),
      sess("D", 1),
    ];
    const climbing = [climb(0), climb(1), climb(2), climb(3)];
    const rec = recommendNextWorkout(history, {
      climbingHistory: climbing,
      refDate: REF_DATE,
    });
    expect(rec.primary.id).not.toBe("REST");
  });
});

describe("recommendNextWorkout: Rule 6 (fallback → C)", () => {
  test("recommends C when nothing is strictly overdue", () => {
    // A fresh, C fresh, B fresh, D fresh, low climbing.
    const history = [
      sess("A", 2),
      sess("C", 2),
      sess("B", 3),
      sess("D", 2),
    ];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
    expect(rec.reason).toMatch(/safe useful default/);
  });

  test("falls back to C even at high climbing density", () => {
    // Previously this case fired Rule 6 (REST). Now falls
    // through to the C default. Mobility work is a reasonable
    // recommendation on a heavy-climbing day — it's restorative
    // adjacent and won't tax recovery.
    const history = [
      sess("A", 2),
      sess("C", 2),
      sess("B", 3),
      sess("D", 2),
    ];
    const climbing = [climb(0), climb(1), climb(2), climb(3)];
    const rec = recommendNextWorkout(history, {
      climbingHistory: climbing,
      refDate: REF_DATE,
    });
    expect(rec.primary.id).toBe("C");
  });
});

// ─────────────────────────────────────────────────────────────
// recommendNextWorkout — interaction with climbing as a stimulus source
// ─────────────────────────────────────────────────────────────

describe("recommendNextWorkout: climbing tag inheritance", () => {
  test("recent CLIMB inhibits Rule 4 (power) via shared 'neural' tag? no — power tags are separate", () => {
    // Power tags are power/explosive, NOT neural. A recent climb
    // contributes neural/connective/climbing/finger but should NOT
    // make B look fresh. Pin the separation.
    const history = [
      sess("A", 2),
      sess("C", 3),
      sess("B", 12), // B is overdue
    ];
    const climbing = [climb(0), climb(1)]; // recent neural load
    const rec = recommendNextWorkout(history, {
      climbingHistory: climbing,
      refDate: REF_DATE,
    });
    expect(rec.primary.id).toBe("B"); // still recommends B
  });
});

// ─────────────────────────────────────────────────────────────
// Defensive: malformed input doesn't crash
// ─────────────────────────────────────────────────────────────

describe("recommendNextWorkout: defensive input handling", () => {
  test("handles undefined workoutHistory", () => {
    const rec = recommendNextWorkout(undefined, { refDate: REF_DATE });
    expect(rec.primary).toBeTruthy();
    expect(rec.reason).toBeTruthy();
  });

  test("skips history entries with unknown workoutId", () => {
    const history = [
      { id: "x", workoutId: "ZZZ", date: daysBefore(REF_DATE, 1) },
      sess("A", 2),
    ];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    // A is fresh, falls through to other rules — shouldn't crash.
    expect(rec.primary).toBeTruthy();
  });

  test("skips climbing entries that are not type=climb", () => {
    const rec = recommendNextWorkout([sess("A", 2)], {
      climbingHistory: [
        { id: "r", type: "rpe", date: daysBefore(REF_DATE, 1) },
      ],
      refDate: REF_DATE,
    });
    expect(rec.primary).toBeTruthy();
  });
});

// ─────────────────────────────────────────────────────────────
// Workout templates — light sanity
// ─────────────────────────────────────────────────────────────

describe("workouts (templates)", () => {
  test("all expected workouts exist", () => {
    for (const id of ["A", "B", "C", "D", "CLIMB", "REST"]) {
      expect(workouts[id]).toBeTruthy();
      expect(workouts[id].id).toBe(id);
    }
  });

  test("A is the only 'big' fatigueClass", () => {
    const big = Object.values(workouts).filter(w => w.fatigueClass === "big");
    expect(big.map(w => w.id)).toEqual(["A"]);
  });

  test("B / C / D are all 'frequent'", () => {
    expect(workouts.B.fatigueClass).toBe("frequent");
    expect(workouts.C.fatigueClass).toBe("frequent");
    expect(workouts.D.fatigueClass).toBe("frequent");
  });

  test("CLIMB and REST have no exercises", () => {
    expect(workouts.CLIMB.exercises).toEqual([]);
    expect(workouts.REST.exercises).toEqual([]);
  });

  test("A has 7 exercises (post-decomp)", () => {
    expect(workouts.A.exercises).toHaveLength(7);
  });

  test("C has 3 exercises (rope flow + Zone 2 dropped)", () => {
    expect(workouts.C.exercises).toHaveLength(3);
  });

  test("D presses with dips, not bench (locked post-decomp)", () => {
    const ids = workouts.D.exercises.map(e => e.id);
    expect(ids).toContain("dips");
    expect(ids).not.toContain("benchPress");
  });

  test("every exercise carries an id, tags, prescription, intent", () => {
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        expect(ex.id).toBeTruthy();
        expect(Array.isArray(ex.tags)).toBe(true);
        expect(ex.tags.length).toBeGreaterThan(0);
        expect(ex.prescription).toBeTruthy();
        expect(ex.intent).toBeTruthy();
      }
    }
  });

  test("every exercise declares a loggable flag", () => {
    // Pin the invariant — every exercise has to declare loggable
    // explicitly so the WorkoutTab UI knows which renderer to use.
    // A missing flag would be ambiguous (false vs undefined).
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        expect(typeof ex.loggable).toBe("boolean");
      }
    }
  });

  test("loggable exercises carry the per-set tracking schema", () => {
    // When loggable=true, the SessionExRow rendering path needs
    // sets/reps/type/logWeight to work. Pin the required fields so
    // a future exercise edit can't accidentally produce a half-typed
    // loggable exercise that crashes the row renderer.
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        if (!ex.loggable) continue;
        expect(typeof ex.sets).toBe("number");
        expect(ex.sets).toBeGreaterThan(0);
        expect(typeof ex.reps).toBe("string");
        expect(typeof ex.logWeight).toBe("boolean");
        expect(["S", "H", "P", "X"]).toContain(ex.type);
      }
    }
  });

  test("non-loggable exercises still declare a type for the badge", () => {
    // SessionExRow's color/badge logic reads `type` regardless of
    // logging mode. Keep it present even on the simple-tile path
    // so badge styling is consistent across both renderers.
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        if (ex.loggable) continue;
        expect(["S", "H", "P", "X"]).toContain(ex.type);
      }
    }
  });

  test("at least one loggable exercise exists on A", () => {
    // Smoke check: A is the big strength day, must contain
    // numeric-load lifts so the per-set tracking has a real home.
    const aLoggable = workouts.A.exercises.filter(ex => ex.loggable);
    expect(aLoggable.length).toBeGreaterThanOrEqual(3);
  });

  test("D presses with dips and dips is loggable", () => {
    // D's pressing slot is dips post-decomp; we want weight tracking
    // on it so progression carries forward like the legacy schema.
    const dDips = workouts.D.exercises.find(ex => ex.id === "dips");
    expect(dDips).toBeTruthy();
    expect(dDips.loggable).toBe(true);
    expect(dDips.logWeight).toBe(true);
  });

  test("novel exercises carry a videoUrl pointing at a real video host", () => {
    // For movements where a 90-second demo beats reading form cues.
    // Standard lifts (bench, pullup, dips) intentionally don't carry
    // one — a demo link there would feel condescending.
    const exercisesWithVideo = ["hardStyleSitup", "bandedRotationalWork",
      "supineWeightedFrog", "weightedPancake", "pancakeLegLifts",
      "proneExternalRotation"];
    const videoHostPattern = /^https:\/\/(www\.)?(youtube\.com|youtu\.be)/;
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        if (!exercisesWithVideo.includes(ex.id)) continue;
        expect(typeof ex.videoUrl).toBe("string");
        expect(ex.videoUrl).toMatch(videoHostPattern);
      }
    }
  });
});
