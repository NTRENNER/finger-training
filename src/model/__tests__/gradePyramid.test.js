// Tests for src/model/gradePyramid.js — Power Company Climbing
// pyramid logic (project, consolidate, cleanup, base ATB).

import {
  inferProjectGrade,
  buildPyramidPlan,
  topPyramidRecommendation,
  TIER_DEFINITIONS,
  FLASH_TIER_DEFINITIONS,
} from "../gradePyramid.js";

// Helper: build the row shape ClimbingAnalysisView produces.
const row = (grade, rank, count) => ({ grade, rank, count });

describe("inferProjectGrade", () => {
  test("default ≥1 send: a single redpoint of the hardest grade anchors", () => {
    const rows = [
      row("V3", 3, 4), row("V5", 5, 2), row("V6", 6, 1),
    ];
    // V6 has 1 send — that's enough. Climber who redpointed V6 once
    // calls V6 their project; the auto answer matches.
    expect(inferProjectGrade(rows)).toBe("V6");
  });

  test("respects custom minSends threshold (e.g. ≥2 for stricter inference)", () => {
    const rows = [
      row("V3", 3, 4), row("V5", 5, 2), row("V6", 6, 1),
    ];
    expect(inferProjectGrade(rows, { minSends: 2 })).toBe("V5");
  });

  test("returns null for empty/invalid input", () => {
    expect(inferProjectGrade([])).toBeNull();
    expect(inferProjectGrade(null)).toBeNull();
    expect(inferProjectGrade([{ grade: "V3" }])).toBeNull(); // no rank
  });

  test("ignores zero-count rows", () => {
    const rows = [row("V3", 3, 4), row("V8", 8, 0)];
    expect(inferProjectGrade(rows)).toBe("V3");
  });
});

describe("buildPyramidPlan", () => {
  test("returns 4 tiers in project → base order", () => {
    const plan = buildPyramidPlan([row("V6", 6, 2)]);
    expect(plan).toHaveLength(4);
    expect(plan.map(p => p.tier)).toEqual([0, -1, -2, -3]);
    expect(plan[0].grade).toBe("V6");
    expect(plan[3].rank).toBe(3); // V6 - 3
  });

  test("fills counts from rows by rank", () => {
    const rows = [
      row("V3", 3, 4), row("V4", 4, 6),
      row("V5", 5, 3), row("V6", 6, 2),
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan[0]).toMatchObject({ grade: "V6", actualCount: 2 }); // project
    expect(plan[1]).toMatchObject({ grade: "V5", actualCount: 3 }); // P-1
    expect(plan[2]).toMatchObject({ grade: "V4", actualCount: 6 }); // P-2
    expect(plan[3]).toMatchObject({ grade: "V3", actualCount: 4 }); // P-3
  });

  test("tiers with no sends get count 0 and grade null", () => {
    // Project at V6, but nothing sent at V4 (P-2) — gap tier
    const rows = [
      row("V3", 3, 5), row("V5", 5, 2), row("V6", 6, 2),
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan[2].grade).toBeNull();
    expect(plan[2].actualCount).toBe(0);
    expect(plan[2].status).toBe("missing");
  });

  test("classifies status correctly per tier targets", () => {
    const rows = [
      row("V3", 3, 4),  // base: light (need 10+)
      row("V4", 4, 7),  // P-2: on_track (5-10)
      row("V5", 5, 4),  // P-1: on_track (3-5)
      row("V6", 6, 2),  // project: on_track (1-2)
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan[0].status).toBe("on_track"); // project = 2
    expect(plan[1].status).toBe("on_track"); // P-1 = 4
    expect(plan[2].status).toBe("on_track"); // P-2 = 7
    expect(plan[3].status).toBe("light");    // base = 4 < 10
  });

  test("heavy when actualCount exceeds tier max", () => {
    const rows = [row("V6", 6, 5)]; // project should be 1-2
    const plan = buildPyramidPlan(rows);
    expect(plan[0].status).toBe("heavy");
  });

  test("returns empty-shape tiers when no project grade can be inferred", () => {
    const plan = buildPyramidPlan([]);
    expect(plan).toHaveLength(4);
    for (const t of plan) {
      expect(t.grade).toBeNull();
      expect(t.actualCount).toBe(0);
      expect(t.status).toBe("missing");
    }
  });

  test("respects explicit projectGrade override", () => {
    const rows = [
      row("V3", 3, 4), row("V4", 4, 4),
      row("V5", 5, 3), row("V6", 6, 1),
    ];
    const plan = buildPyramidPlan(rows, "V5");
    expect(plan[0].grade).toBe("V5"); // project = V5, not V6
    expect(plan[1].grade).toBe("V4"); // P-1 = V4
  });
});

describe("topPyramidRecommendation", () => {
  test("flags base first when it's light", () => {
    const rows = [
      row("V3", 3, 2),  // base: light (need 10)
      row("V4", 4, 7),  // P-2: on_track
      row("V5", 5, 4),  // P-1: on_track
      row("V6", 6, 2),  // project: on_track
    ];
    const rec = topPyramidRecommendation(buildPyramidPlan(rows));
    expect(rec).toBeTruthy();
    expect(rec.tier).toBe(-3);
    expect(rec.message).toMatch(/V3/);
  });

  test("missing tier gets a 'build it' message", () => {
    const rows = [row("V6", 6, 2)];
    const rec = topPyramidRecommendation(buildPyramidPlan(rows));
    expect(rec.message).toMatch(/start sending/i);
  });

  test("balanced pyramid suggests pushing the project", () => {
    const rows = [
      row("V3", 3, 12), row("V4", 4, 7),
      row("V5", 5, 4),  row("V6", 6, 2),
    ];
    const rec = topPyramidRecommendation(buildPyramidPlan(rows));
    expect(rec.tier).toBe(0);
    expect(rec.message).toMatch(/push the project|shifting the pyramid/i);
  });

  test("heavy project tier suggests shifting up a grade", () => {
    const rows = [
      row("V3", 3, 12), row("V4", 4, 7),
      row("V5", 5, 4),  row("V6", 6, 5), // project way over band
    ];
    const rec = topPyramidRecommendation(buildPyramidPlan(rows));
    expect(rec.message).toMatch(/shifting the pyramid up/i);
  });

  test("returns null for empty plan", () => {
    expect(topPyramidRecommendation([])).toBeNull();
    expect(topPyramidRecommendation(null)).toBeNull();
  });
});

describe("TIER_DEFINITIONS", () => {
  test("exports 4 tiers with min/max/advice", () => {
    expect(TIER_DEFINITIONS).toHaveLength(4);
    for (const t of TIER_DEFINITIONS) {
      expect(typeof t.label).toBe("string");
      expect(typeof t.min).toBe("number");
      expect(typeof t.max).toBe("number");
      expect(typeof t.advice).toBe("string");
    }
  });

  test("flash-anchored tiers also export 4 entries with min/max/advice", () => {
    expect(FLASH_TIER_DEFINITIONS).toHaveLength(4);
    for (const t of FLASH_TIER_DEFINITIONS) {
      expect(typeof t.label).toBe("string");
      expect(typeof t.min).toBe("number");
      expect(typeof t.max).toBe("number");
      expect(typeof t.advice).toBe("string");
    }
    // Project tier may have 0 sends (it's forward-looking).
    expect(FLASH_TIER_DEFINITIONS[0].min).toBe(0);
  });
});

describe("buildPyramidPlan — flash-anchored", () => {
  test("uses flash-anchored tier labels and bands", () => {
    // Project = V7 (flash V4 + gap 3). User has 0 sends at V7.
    const rows = [
      row("V4", 4, 20),  // volume (ATB): 10+ on track
      row("V5", 5, 4),   // consolidate (flash+1): 3-5 on track
      row("V6", 6, 2),   // push (flash+2): 1-3 on track
    ];
    const plan = buildPyramidPlan(rows, "V7", { anchorMode: "flash", projectRank: 7 });
    expect(plan[0]).toMatchObject({ label: "Project",     grade: "V7", actualCount: 0, targetMin: 0 });
    expect(plan[1]).toMatchObject({ label: "Push",        grade: "V6", actualCount: 2 });
    expect(plan[2]).toMatchObject({ label: "Consolidate", grade: "V5", actualCount: 4 });
    expect(plan[3]).toMatchObject({ label: "Volume (ATB)", grade: "V4", actualCount: 20 });
  });

  test("project with 0 sends is on_track (band min is 0), not missing", () => {
    const rows = [row("V4", 4, 20)];
    const plan = buildPyramidPlan(rows, "V7", { anchorMode: "flash", projectRank: 7 });
    expect(plan[0].actualCount).toBe(0);
    expect(plan[0].status).toBe("on_track");
  });

  test("project tier still gets a grade label even with no rows at that rank", () => {
    const rows = [row("V4", 4, 5)];
    const plan = buildPyramidPlan(rows, "V7", { anchorMode: "flash", projectRank: 7 });
    expect(plan[0].grade).toBe("V7"); // forward-looking label
  });

  test("YDS: stepSize 0.25 walks tiers by single letter subgrades", () => {
    // Flash 5.12a (rank 12.0) → project 5.13a (rank 13.0).
    // Tier -1 at rank 12.75 = 5.12d, -2 at 12.5 = 5.12c, -3 at 12.25 = 5.12b.
    const rows = [
      { grade: "5.12b", rank: 12.25, count: 12 }, // volume
      { grade: "5.12c", rank: 12.5,  count: 4 },  // consolidate
      { grade: "5.12d", rank: 12.75, count: 2 },  // push
      { grade: "5.13a", rank: 13.0,  count: 0 },  // project (no sends yet)
    ];
    const plan = buildPyramidPlan(rows, "5.13a", {
      anchorMode: "flash", projectRank: 13.0, stepSize: 0.25,
    });
    expect(plan[0]).toMatchObject({ label: "Project",      grade: "5.13a", actualCount: 0 });
    expect(plan[1]).toMatchObject({ label: "Push",         grade: "5.12d", actualCount: 2 });
    expect(plan[2]).toMatchObject({ label: "Consolidate",  grade: "5.12c", actualCount: 4 });
    expect(plan[3]).toMatchObject({ label: "Volume (ATB)", grade: "5.12b", actualCount: 12 });
  });
});
