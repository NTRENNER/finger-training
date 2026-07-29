import {
  buildStretchPlan,
  DEFAULT_STRETCH_PREFERENCES,
  sanitizeStretchPreferences,
  STRETCH_EXERCISES,
  toggleStretchEquipment,
  toggleStretchPriority,
  weeklyStretchCoverage,
} from "../stretching.js";

describe("stretching session planner", () => {
  test("the default ten-minute plan covers priorities, hip rotation, forearms, and one deficit", () => {
    const plan = buildStretchPlan(DEFAULT_STRETCH_PREFERENCES);
    expect(plan.targetMinutes).toBe(10);
    expect(plan.items.reduce((sum, item) => sum + item.minutes, 0)).toBe(10);
    expect(plan.items.map(item => item.category)).toEqual([
      "hamstrings",
      "highStep",
      "hipRotation",
      "forearms",
      "hipExtension",
    ]);
  });

  test("every movement category retains an equipment-free option", () => {
    const categories = new Set(STRETCH_EXERCISES.map(exercise => exercise.mobilityCategory));
    for (const category of categories) {
      expect(
        STRETCH_EXERCISES.some(exercise =>
          exercise.mobilityCategory === category
          && exercise.equipment.length === 0
        )
      ).toBe(true);
    }
  });

  test("every mobility movement has a direct video demonstration", () => {
    for (const exercise of STRETCH_EXERCISES) {
      expect(exercise.videoUrl).toMatch(
        /^https:\/\/www\.youtube\.com\/(?:watch\?v=|shorts\/)[A-Za-z0-9_-]+/
      );
    }
  });

  test("available equipment promotes the equipped variation without removing alternatives", () => {
    const plan = buildStretchPlan({
      targetMinutes: 10,
      priorities: ["overhead", "hamstrings"],
      equipment: ["band", "weight"],
    });
    const overhead = plan.items.find(item => item.category === "overhead");
    const hamstrings = plan.items.find(item => item.category === "hamstrings");
    expect(overhead.exercise.id).toBe("bandedLatStretch");
    expect(overhead.options.some(option => option.equipment.length === 0)).toBe(true);
    expect(hamstrings.exercise.id).toBe("weightedPancake");
  });

  test("five-minute plans keep both priorities and choose the less-covered core category", () => {
    const plan = buildStretchPlan({
      targetMinutes: 5,
      priorities: ["hamstrings", "highStep"],
      equipment: [],
      coverage: { hipRotation: 8, forearms: 0 },
    });
    expect(plan.items.map(item => item.category)).toEqual([
      "hamstrings",
      "highStep",
      "forearms",
    ]);
    expect(plan.items.reduce((sum, item) => sum + item.minutes, 0)).toBe(5);
  });

  test("weekly coverage reads timed stretch exercises from synced session shape", () => {
    const sessions = [
      {
        workout: "STRETCH",
        date: "2026-07-28",
        exercises: {
          shinBoxes: { done: true, category: "hipRotation", minutes: 2 },
          wristRockbacks: { done: true, category: "forearms", minutes: 3 },
        },
      },
      {
        workoutId: "STRETCH",
        date: "2026-07-22",
        exercises: {
          elephantWalks: { done: true, category: "hamstrings", minutes: 4 },
        },
      },
      {
        workout: "STRETCH",
        date: "2026-07-21",
        exercises: {
          couchStretch: { done: true, category: "hipExtension", minutes: 9 },
        },
      },
    ];
    const coverage = weeklyStretchCoverage(sessions, "2026-07-28");
    expect(coverage.hipRotation).toBe(2);
    expect(coverage.forearms).toBe(3);
    expect(coverage.hamstrings).toBe(4);
    expect(coverage.hipExtension).toBe(0);
  });

  test("preference helpers cap priorities and toggle equipment", () => {
    expect(toggleStretchPriority(["hamstrings", "highStep"], "overhead"))
      .toEqual(["highStep", "overhead"]);
    expect(toggleStretchPriority(["hamstrings"], "hamstrings")).toEqual([]);
    expect(toggleStretchEquipment(["band"], "weight")).toEqual(["band", "weight"]);
    expect(toggleStretchEquipment(["band", "weight"], "band")).toEqual(["weight"]);
    expect(sanitizeStretchPreferences({
      targetMinutes: 12,
      priorities: ["bogus", "forearms", "chest", "overhead"],
      equipment: ["box", "rope"],
    })).toEqual({
      targetMinutes: 10,
      priorities: ["forearms", "chest"],
      equipment: ["box"],
    });
  });
});
