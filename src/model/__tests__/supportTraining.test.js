// Tests for src/model/supportTraining.js — support workout
// recommender + tag-staleness helpers.
//
// Strategy: pin each rule of the decision tree with at least one
// test, plus edge cases (empty history, future-dated entries,
// unknown workoutId). The recommender accepts an explicit `refDate`
// so tests don't depend on wall-clock time.
//
// Layout after the May 2026 rename:
//   A  — Strength Support (big, weekly slot)
//   B  — Athletic Power (frequent)
//   C  — Neural Strength Touch (frequent; was D before the rename)
//   STRETCH — Daily Stretching (was C; pulled out of the picker
//             rotation into a daily-habit pill in WorkoutTab)
//
// Rules (first match wins):
//   1. A overdue → A
//   2. Power stale → B
//   3. C touch stale → C
//   4. Fallback → C
//
// STRETCH is accepted in history (it's a real marker session) but
// the recommender NEVER emits it — that's user-driven via the pill.
// The energyLow opts param was removed (May 2026): the toggle only
// flipped Rule 1's primary from A to C, but the user already gates
// behavior by deciding whether to open the app, and the picker
// override handles the rare case where they want a lighter session.

import {
  workouts,
  recommendNextWorkout,
  daysBetween,
  daysSinceLastOfType,
  computeTagDaysSince,
} from "../supportTraining.js";

// ───────────────────────────────────────────────────────
// Test fixtures
// ───────────────────────────────────────────────────────
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

// ───────────────────────────────────────────────────────
// daysBetween
// ───────────────────────────────────────────────────────

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

// ───────────────────────────────────────────────────────
// daysSinceLastOfType
// ───────────────────────────────────────────────────────

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

  test("accepts legacy sessions with only `workout` (no workoutId)", () => {
    // Older clients (and cloud-pulled sessions before the sync mirror
    // caught up) may carry `workout: "A"` without `workoutId`. They
    // should still count toward the recommender's days-since math —
    // an A session two days ago shouldn't appear as "no A on record"
    // just because a field name drifted.
    const legacyA = {
      id: "legacy-A", workout: "A", date: daysBefore(REF_DATE, 2),
    };
    const legacyB = {
      id: "legacy-B", workout: "B", date: daysBefore(REF_DATE, 1),
    };
    expect(daysSinceLastOfType([legacyA, legacyB], "A", REF_DATE)).toBe(2);
    expect(daysSinceLastOfType([legacyA, legacyB], "B", REF_DATE)).toBe(1);
  });

  test("workoutId wins when both fields are present and differ", () => {
    // If a session somehow has both fields with different values
    // (shouldn't happen, but defensive), workoutId is the authority.
    const weird = {
      id: "weird", workoutId: "A", workout: "B",
      date: daysBefore(REF_DATE, 3),
    };
    expect(daysSinceLastOfType([weird], "A", REF_DATE)).toBe(3);
    expect(daysSinceLastOfType([weird], "B", REF_DATE)).toBe(Infinity);
  });
});

// ───────────────────────────────────────────────────────
// computeTagDaysSince
// ───────────────────────────────────────────────────────
describe("computeTagDaysSince", () => {
  test("workout sessions contribute their template tags", () => {
    // STRETCH tags: positionalCapacity + mobility + restoration.
    // ("hip" is an exercise-level descriptor — it does NOT appear as
    // a workout-level tag, by design: workout-level tags describe the
    // stimulus, not the body parts touched. See note on workouts.A.)
    // After the May 2026 rename, these tags moved off C (which now
    // carries strength/neural) and onto STRETCH (the daily-habit
    // pill), but the underlying tag bookkeeping is unchanged — any
    // session whose template lists a tag contributes it.
    const tagDays = computeTagDaysSince([sess("STRETCH", 4)], REF_DATE);
    expect(tagDays.positionalCapacity).toBe(4);
    expect(tagDays.mobility).toBe(4);
    expect(tagDays.restoration).toBe(4);
    expect(tagDays.hip).toBeUndefined();
  });

  test("post-rename C contributes strength + neural tags", () => {
    // C (was D before the May 2026 rename) is the neural strength
    // touch workout — pull/press/arm/core in ~15 min. Its workout-
    // level tags are strength + neural; it does NOT contribute
    // mobility/positionalCapacity any more (those live on STRETCH).
    const tagDays = computeTagDaysSince([sess("C", 2)], REF_DATE);
    expect(tagDays.strength).toBe(2);
    expect(tagDays.neural).toBe(2);
    expect(tagDays.mobility).toBeUndefined();
    expect(tagDays.positionalCapacity).toBeUndefined();
  });

  test("picks the MINIMUM days when a tag appears in multiple sessions", () => {
    // C tags "strength"; a C 5 days ago and another 2 days ago — the
    // more recent should win.
    const tagDays = computeTagDaysSince([sess("C", 5), sess("C", 2)], REF_DATE);
    expect(tagDays.strength).toBe(2);
  });

  test("future-dated entries are ignored", () => {
    const future = { id: "f", workoutId: "A", date: daysBefore(REF_DATE, -5) };
    const tagDays = computeTagDaysSince([future], REF_DATE);
    expect(tagDays.strength).toBeUndefined();
  });

  test("unknown workoutId is skipped, not crashed", () => {
    const tagDays = computeTagDaysSince(
      [{ id: "x", workoutId: "ZZZ", date: daysBefore(REF_DATE, 2) }],
      REF_DATE,
    );
    expect(tagDays).toEqual({});
  });
});

// ───────────────────────────────────────────────────────
// recommendNextWorkout — rule-by-rule
// ───────────────────────────────────────────────────────
describe("recommendNextWorkout: A→B→C round-robin", () => {
  test("empty history starts the cycle at A", () => {
    const rec = recommendNextWorkout([], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("A");
    expect(rec.reason).toMatch(/No A\/B\/C on record/);
  });

  test("after A → recommends B", () => {
    const rec = recommendNextWorkout([sess("A", 2)], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("B");
    expect(rec.reason).toMatch(/Last support workout was A/);
  });

  test("after B → recommends C", () => {
    const rec = recommendNextWorkout([sess("B", 2)], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
  });

  test("after C → recommends A (cycle wraps)", () => {
    const rec = recommendNextWorkout([sess("C", 2)], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("A");
  });

  test("Nathan's example: A,B this week, no C — next is C", () => {
    // A 4 days ago, B 2 days ago → most recent is B → next is C
    const history = [sess("A", 4), sess("B", 2)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
  });

  test("Nathan's example: A,B,C,A in one week — next week starts with B", () => {
    // Sequence in a week: A 6d, B 4d, C 2d, A 0d → most recent is A → next is B
    const history = [sess("A", 6), sess("B", 4), sess("C", 2), sess("A", 0)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("B");
  });

  test("STRETCH does NOT advance the rotation", () => {
    // Last A/B/C was C two days ago. A STRETCH yesterday shouldn't
    // bump the rotation off C — next is still A (the letter after C).
    const history = [sess("C", 2), sess("STRETCH", 1)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("A");
  });

  test("REST does NOT advance the rotation", () => {
    // Last A/B/C was A → next is B, regardless of a REST marker after.
    const history = [sess("A", 2), sess("REST", 0)];
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("B");
  });

  test("alternatives expose the other two letters in the rotation", () => {
    // After A, primary=B → alternatives should be A and C (some order)
    const rec = recommendNextWorkout([sess("A", 2)], { refDate: REF_DATE });
    const altIds = rec.alternatives.map(a => a.id).sort();
    expect(altIds).toEqual(["A", "C"]);
  });
});

describe("recommendNextWorkout: same-day tiebreaks", () => {
  // Multiple A/B/C sessions on the same date — the LATEST one should
  // win the rotation pointer. Tiebreak order: completedAt timestamp,
  // then array index.
  test("completedAt tiebreaks same-date sessions (later completedAt wins)", () => {
    const history = [
      { id: "x1", workoutId: "A", date: REF_DATE, completedAt: `${REF_DATE}T08:00:00Z` },
      { id: "x2", workoutId: "B", date: REF_DATE, completedAt: `${REF_DATE}T18:00:00Z` },
    ];
    // Both today, B finished later → next is C
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
  });

  test("array order tiebreaks when completedAt is missing/equal", () => {
    const history = [
      { id: "x1", workoutId: "A", date: REF_DATE },
      { id: "x2", workoutId: "B", date: REF_DATE },
    ];
    // No completedAt → array order wins, B is later → next is C
    const rec = recommendNextWorkout(history, { refDate: REF_DATE });
    expect(rec.primary.id).toBe("C");
  });
});

describe("recommendNextWorkout: legacy field fallback", () => {
  test("legacy session with only `workout` (no workoutId) still advances the rotation", () => {
    // The 5/24 A-session bug: a session missing workoutId but with
    // `workout: "A"` should still count as the most-recent A and
    // make the next recommendation B.
    const legacyA = {
      id: "legacy", workout: "A", date: daysBefore(REF_DATE, 2),
    };
    const rec = recommendNextWorkout([legacyA], { refDate: REF_DATE });
    expect(rec.primary.id).toBe("B");
  });
});

// ───────────────────────────────────────────────────────
// Defensive: malformed input doesn't crash
// ───────────────────────────────────────────────────────
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
});

// ───────────────────────────────────────────────────────
// Workout templates — light sanity
// ───────────────────────────────────────────────────────
describe("workouts (templates)", () => {
  test("all expected workouts exist", () => {
    for (const id of ["A", "B", "C", "STRETCH", "CLIMB", "REST"]) {
      expect(workouts[id]).toBeTruthy();
      expect(workouts[id].id).toBe(id);
    }
  });

  test("no leftover D entry after the May 2026 rename", () => {
    // D was renamed to C; the slot should be gone from the map so a
    // stray workouts.D lookup fails loudly instead of silently
    // resolving to old content.
    expect(workouts.D).toBeUndefined();
  });

  test("A is the only 'big' fatigueClass", () => {
    const big = Object.values(workouts).filter(w => w.fatigueClass === "big");
    expect(big.map(w => w.id)).toEqual(["A"]);
  });

  test("B / C / STRETCH are all 'frequent'", () => {
    expect(workouts.B.fatigueClass).toBe("frequent");
    expect(workouts.C.fatigueClass).toBe("frequent");
    expect(workouts.STRETCH.fatigueClass).toBe("frequent");
  });

  test("CLIMB and REST have no exercises", () => {
    expect(workouts.CLIMB.exercises).toEqual([]);
    expect(workouts.REST.exercises).toEqual([]);
  });

  test("A has 5 exercises (prone ER to C June 2026; bicep curls to B July 2026)", () => {
    expect(workouts.A.exercises).toHaveLength(5);
    const aIds = workouts.A.exercises.map(e => e.id);
    expect(aIds).not.toContain("bicepCurls");
  });

  test("bicep curls live on B (moved off A July 2026), sequenced last, still progressing", () => {
    const bIds = workouts.B.exercises.map(e => e.id);
    expect(bIds).toContain("bicepCurls");
    expect(bIds[bIds.length - 1]).toBe("bicepCurls");           // last, so it can't blunt power work
    const curl = workouts.B.exercises.find(e => e.id === "bicepCurls");
    expect(curl.progressionPolicy).toBeUndefined();             // default ladder = load-building
    expect(workouts.B.tags).toEqual(["power", "explosive"]);    // still a power day at the tag level
  });

  test("STRETCH inherits the 3 mobility exercises from old C", () => {
    // Old C's frog → pancake → pancake leg lifts moved verbatim into
    // STRETCH when the rename pulled mobility out of the picker. Pin
    // the contents so an accidental edit doesn't drop one.
    const ids = workouts.STRETCH.exercises.map(e => e.id);
    expect(ids).toEqual(["supineWeightedFrog", "weightedPancake", "pancakeLegLifts"]);
  });

  test("C presses with bench, A presses with dips (June 2026 swap)", () => {
    // Dip⇄bench swap: bench's barbell blocked the pull-up bar when both
    // were on A, so dips (weighted) became A's press and bench (light)
    // moved to C, which pulls horizontally and has no bar conflict.
    const cIds = workouts.C.exercises.map(e => e.id);
    expect(cIds).toContain("benchPress");
    expect(cIds).not.toContain("dips");
    const aIds = workouts.A.exercises.map(e => e.id);
    expect(aIds).toContain("dips");
    expect(aIds).not.toContain("benchPress");
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
    // Three logging modes are valid for loggable=true:
    //   - logWeight: reps + numeric weight per set (default strength).
    //   - logBand:   reps + band-color per set (banded resistance).
    //   - circlesOnly: no reps/weight, just a clickable circle per set
    //     (habit-style tracking like Ab Wheel).
    // Pin the required fields per mode so a future exercise edit can't
    // accidentally produce a half-typed loggable exercise that crashes
    // the row renderer.
    for (const w of Object.values(workouts)) {
      for (const ex of w.exercises) {
        if (!ex.loggable) continue;
        expect(typeof ex.sets).toBe("number");
        expect(ex.sets).toBeGreaterThan(0);
        expect(["S", "H", "P", "X"]).toContain(ex.type);
        // Exactly one of the three logging-mode flags must be set.
        const modes = [ex.logWeight, ex.logBand, ex.circlesOnly].filter(Boolean);
        expect(modes).toHaveLength(1);
        // logWeight and logBand also require a reps prescription
        // string for the input placeholders. circlesOnly skips reps.
        if (ex.logWeight || ex.logBand) {
          expect(typeof ex.reps).toBe("string");
        }
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

  test("C presses with bench and bench is loggable", () => {
    // C's pressing slot is bench (light/maintain after the June 2026
    // swap); weight tracking enabled so per-set logging carries forward.
    const cBench = workouts.C.exercises.find(ex => ex.id === "benchPress");
    expect(cBench).toBeTruthy();
    expect(cBench.loggable).toBe(true);
    expect(cBench.logWeight).toBe(true);
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
