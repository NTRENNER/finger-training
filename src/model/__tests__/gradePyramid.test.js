// Tests for src/model/gradePyramid.js — 5-tier outline pyramid
// with [3, 5, 7, 9, 11] target widths and apex-fills auto-graduation.

import {
  inferProjectGrade,
  buildPyramidPlan,
  computeGraduation,
  TIER_DEFINITIONS,
} from "../gradePyramid.js";

// Helper: build the row shape ClimbingAnalysisView produces.
const row = (grade, rank, count) => ({ grade, rank, count });

describe("inferProjectGrade", () => {
  test("default ≥1 send: a single redpoint of the hardest grade anchors", () => {
    const rows = [
      row("V3", 3, 4), row("V5", 5, 2), row("V6", 6, 1),
    ];
    expect(inferProjectGrade(rows)).toBe("V6");
  });

  test("respects custom minSends threshold", () => {
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

describe("buildPyramidPlan — tier shape", () => {
  test("returns 5 tiers in project → base order", () => {
    const plan = buildPyramidPlan([row("V6", 6, 2)]);
    expect(plan.tiers).toHaveLength(5);
    expect(plan.tiers.map(t => t.tier)).toEqual([0, -1, -2, -3, -4]);
  });

  test("targets are [3, 5, 7, 9, 11] (+2 per row, wider apex)", () => {
    const plan = buildPyramidPlan([row("V6", 6, 2)]);
    expect(plan.tiers.map(t => t.target)).toEqual([3, 5, 7, 9, 11]);
  });

  test("anchors to the inferred project and walks tiers down by stepSize", () => {
    const plan = buildPyramidPlan([row("V6", 6, 1)]);
    expect(plan.projectGrade).toBe("V6");
    expect(plan.projectRank).toBe(6);
    expect(plan.tiers[0].rank).toBe(6);
    expect(plan.tiers[4].rank).toBe(2);    // V6 − 4
  });

  test("respects explicit projectGrade override over inferred", () => {
    const rows = [
      row("V3", 3, 4), row("V4", 4, 4),
      row("V5", 5, 3), row("V6", 6, 1),
    ];
    const plan = buildPyramidPlan(rows, "V5");
    expect(plan.projectGrade).toBe("V5");
    expect(plan.tiers[0].grade).toBe("V5");
    expect(plan.tiers[1].grade).toBe("V4");
  });
});

describe("buildPyramidPlan — shading & status", () => {
  test("partial: shaded = actualCount when below target", () => {
    // V6 apex (target 3) with 1 send → partial 1/3
    const plan = buildPyramidPlan([row("V6", 6, 1)]);
    expect(plan.tiers[0]).toMatchObject({ actualCount: 1, shaded: 1, capped: false, status: "partial" });
  });

  test("complete: actualCount === target", () => {
    // V6 apex (target 3) with exactly 3 sends → complete 3/3
    const plan = buildPyramidPlan([row("V6", 6, 3)]);
    expect(plan.tiers[0]).toMatchObject({ actualCount: 3, shaded: 3, capped: false, status: "complete" });
  });

  test("capped: actualCount > target shades only `target` blocks", () => {
    // V6 project, V3 (tier -3, target 9) with 15 sends → capped at 9
    const rows = [row("V3", 3, 15), row("V6", 6, 1)];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[3]).toMatchObject({ actualCount: 15, shaded: 9, capped: true, status: "complete" });
  });

  test("empty: no sends at that tier", () => {
    const plan = buildPyramidPlan([row("V6", 6, 1)]);
    for (const t of plan.tiers.slice(1)) {
      expect(t.status).toBe("empty");
      expect(t.shaded).toBe(0);
      expect(t.actualCount).toBe(0);
    }
  });

  test("missing tiers (gap grades) expose grade=null but keep the outline row", () => {
    const rows = [
      row("V3", 3, 5), row("V5", 5, 2), row("V6", 6, 1),
    ];
    const plan = buildPyramidPlan(rows);
    // tier -2 = V4 → no row, grade null, actualCount 0
    expect(plan.tiers[2].grade).toBeNull();
    expect(plan.tiers[2].actualCount).toBe(0);
    expect(plan.tiers[2].status).toBe("empty");
  });

  test("empty rows still return a 5-row outline silhouette", () => {
    const plan = buildPyramidPlan([]);
    expect(plan.tiers).toHaveLength(5);
    expect(plan.tiers.map(t => t.target)).toEqual([3, 5, 7, 9, 11]);
    for (const t of plan.tiers) {
      expect(t.grade).toBeNull();
      expect(t.actualCount).toBe(0);
      expect(t.status).toBe("empty");
    }
  });
});

describe("computeGraduation", () => {
  // Apex target is 3 — graduation fires when the apex grade has
  // ≥ 3 sends. Chains while each successive apex stays full.
  test("returns 0 when the apex isn't full", () => {
    const rows = [row("V8", 8, 2)];        // only 2/3 at the apex
    expect(computeGraduation(rows, 8, 1)).toBe(0);
  });

  test("returns 1 when the apex has been sent 3 times", () => {
    const rows = [row("V8", 8, 3)];        // 3/3 apex → graduate one
    expect(computeGraduation(rows, 8, 1)).toBe(1);
  });

  test("counts ≥ target also graduate (4 sends still triggers)", () => {
    const rows = [row("V8", 8, 4)];
    expect(computeGraduation(rows, 8, 1)).toBe(1);
  });

  test("chains: V8 has 3 AND V9 has 3 → graduate twice", () => {
    const rows = [row("V8", 8, 5), row("V9", 9, 3)];
    expect(computeGraduation(rows, 8, 1)).toBe(2);
  });

  test("chain stops as soon as a tier isn't full", () => {
    const rows = [row("V8", 8, 3), row("V9", 9, 2)];
    expect(computeGraduation(rows, 8, 1)).toBe(1);   // V8 full, V9 partial
  });

  test("YDS stepSize 0.25 walks one letter subgrade per chain step", () => {
    // 5.12c at 3 sends + 5.12d at 3 sends → chain twice → apex moves to 5.13a
    const rows = [
      { grade: "5.12c", rank: 12.5,  count: 3 },
      { grade: "5.12d", rank: 12.75, count: 3 },
    ];
    expect(computeGraduation(rows, 12.5, 0.25)).toBe(2);
  });

  test("invalid input returns 0", () => {
    expect(computeGraduation(null, 8, 1)).toBe(0);
    expect(computeGraduation([], null, 1)).toBe(0);
    expect(computeGraduation([row("V8", 8, 3)], undefined, 1)).toBe(0);
  });

  test("hard cap at MAX_GRADUATION = 5 prevents runaway loops", () => {
    // Pathological: every successive grade is full. Graduation should
    // stop at 5 even if more grades are above.
    const rows = Array.from({ length: 10 }, (_, i) => row(`V${i}`, i, 99));
    expect(computeGraduation(rows, 0, 1)).toBe(5);
  });
});

describe("buildPyramidPlan — overgrew (re-pin signal)", () => {
  test("overgrew = false when no sends above the apex", () => {
    const plan = buildPyramidPlan([
      row("V3", 3, 5), row("V4", 4, 2), row("V6", 6, 1),
    ]);
    expect(plan.overgrew).toBe(false);
    expect(plan.overgrewSends).toBe(0);
    expect(plan.overgrewMaxGrade).toBeNull();
  });

  test("overgrew = true when there are sends above the pinned apex", () => {
    const rows = [
      row("V5", 5, 3), row("V6", 6, 1),
      row("V7", 7, 2), row("V8", 8, 1),
    ];
    const plan = buildPyramidPlan(rows, "V6");
    expect(plan.overgrew).toBe(true);
    expect(plan.overgrewSends).toBe(3);
    expect(plan.overgrewMaxGrade).toBe("V8");
  });

  test("overgrew ignores rows with zero count above the apex", () => {
    const rows = [row("V6", 6, 1), row("V7", 7, 0)];
    const plan = buildPyramidPlan(rows, "V6");
    expect(plan.overgrew).toBe(false);
  });
});

describe("buildPyramidPlan — flash-anchored", () => {
  test("explicit projectRank lets the apex tier exist with 0 sends", () => {
    const rows = [
      row("V4", 4, 20),  // tier -3 (target 9 — capped from 20)
      row("V5", 5, 4),   // tier -2 (target 7 — partial)
      row("V6", 6, 2),   // tier -1 (target 5 — partial)
    ];
    const plan = buildPyramidPlan(rows, "V7", { anchorMode: "flash", projectRank: 7 });
    expect(plan.projectGrade).toBe("V7");
    expect(plan.tiers[0]).toMatchObject({ grade: "V7", actualCount: 0, shaded: 0, status: "empty" });
    expect(plan.tiers[1]).toMatchObject({ grade: "V6", actualCount: 2, shaded: 2, status: "partial" });
    expect(plan.tiers[2]).toMatchObject({ grade: "V5", actualCount: 4, shaded: 4, capped: false, status: "partial" });
    expect(plan.tiers[3]).toMatchObject({ grade: "V4", actualCount: 20, shaded: 9, capped: true });
  });

  test("YDS: stepSize 0.25 walks tiers by letter subgrades", () => {
    const rows = [
      { grade: "5.12a", rank: 12.0,  count: 8 },  // tier -4 (target 11 — partial)
      { grade: "5.12b", rank: 12.25, count: 3 },  // tier -3 (target 9 — partial)
      { grade: "5.12c", rank: 12.5,  count: 3 },  // tier -2 (target 7 — partial)
      { grade: "5.12d", rank: 12.75, count: 2 },  // tier -1 (target 5 — partial)
      { grade: "5.13a", rank: 13.0,  count: 0 },  // apex  (target 3 — empty)
    ];
    const plan = buildPyramidPlan(rows, "5.13a", {
      anchorMode: "flash", projectRank: 13.0, stepSize: 0.25,
    });
    expect(plan.tiers[0]).toMatchObject({ grade: "5.13a", actualCount: 0, status: "empty" });
    expect(plan.tiers[1]).toMatchObject({ grade: "5.12d", actualCount: 2, shaded: 2, status: "partial" });
    expect(plan.tiers[2]).toMatchObject({ grade: "5.12c", actualCount: 3, shaded: 3, status: "partial" });
    expect(plan.tiers[3]).toMatchObject({ grade: "5.12b", actualCount: 3, shaded: 3, status: "partial" });
    expect(plan.tiers[4]).toMatchObject({ grade: "5.12a", actualCount: 8, shaded: 8, capped: false, status: "partial" });
  });
});

describe("buildPyramidPlan — rankToGrade fallback", () => {
  const vResolver = (rank) => {
    if (!Number.isFinite(rank)) return null;
    const n = Math.round(rank);
    return n >= 0 && n <= 13 ? `V${n}` : null;
  };

  test("labels empty tiers with their grade when resolver is provided", () => {
    const rows = [
      row("V4", 4, 7), row("V5", 5, 6), row("V6", 6, 2), row("V8", 8, 1),
    ];
    const plan = buildPyramidPlan(rows, "V8", {
      anchorMode: "flash", projectRank: 8, rankToGrade: vResolver,
    });
    expect(plan.tiers[0].grade).toBe("V8");                            // apex (had a row)
    expect(plan.tiers[1].grade).toBe("V7");                            // empty tier — resolver fills it
    expect(plan.tiers[1].actualCount).toBe(0);
    expect(plan.tiers[2].grade).toBe("V6");
    expect(plan.tiers[3].grade).toBe("V5");
    expect(plan.tiers[4].grade).toBe("V4");
  });

  test("row labels still win over resolver output (resolver is a fallback only)", () => {
    const wrongResolver = (rank) => `WRONG-${rank}`;
    const plan = buildPyramidPlan(
      [row("V6", 6, 2)],
      null,
      { rankToGrade: wrongResolver },
    );
    expect(plan.tiers[0].grade).toBe("V6");
  });

  test("without resolver, empty tiers still expose grade=null (back-compat)", () => {
    const plan = buildPyramidPlan([row("V8", 8, 1)], "V8", {
      anchorMode: "flash", projectRank: 8,
    });
    expect(plan.tiers[1].grade).toBeNull();
    expect(plan.tiers[4].grade).toBeNull();
  });
});

describe("buildPyramidPlan — climbs metadata pass-through", () => {
  const climb = (date, ascent, extra = {}) => ({ date, ascent, ...extra });

  test("threads each row's climbs array onto the matching tier", () => {
    const rows = [
      { grade: "V3", rank: 3, count: 2, climbs: [climb("2026-05-01", "flash"), climb("2026-05-02", "redpoint")] },
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint", { route_name: "Apex" })] },
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[0].climbs).toHaveLength(1);
    expect(plan.tiers[0].climbs[0].route_name).toBe("Apex");
    expect(plan.tiers[3].climbs).toHaveLength(2);
    expect(plan.tiers[3].climbs.map(c => c.ascent)).toEqual(["flash", "redpoint"]);
  });

  test("tiers without a matching row get an empty climbs array", () => {
    const rows = [
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint")] },
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[0].climbs).toHaveLength(1);
    for (const t of plan.tiers.slice(1)) {
      expect(t.climbs).toEqual([]);
    }
  });

  test("rows without climbs default to empty array (back-compat)", () => {
    const plan = buildPyramidPlan([{ grade: "V6", rank: 6, count: 1 }]);
    for (const t of plan.tiers) {
      expect(t.climbs).toEqual([]);
    }
  });

  test("preserves capped extras in climbs (visual cap doesn't drop data)", () => {
    // 15 sends at V3 (tier -3, target 9). Only 9 blocks shade in the
    // chart, but all 15 climbs are preserved on tier.climbs so the
    // detail popover can list them.
    const rows = [
      { grade: "V3", rank: 3, count: 15, climbs: Array.from({ length: 15 }, (_, i) => climb(`2026-05-${10+i}`, "redpoint")) },
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint")] },
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[3].shaded).toBe(9);
    expect(plan.tiers[3].capped).toBe(true);
    expect(plan.tiers[3].climbs).toHaveLength(15);
  });
});

describe("TIER_DEFINITIONS", () => {
  test("exports the 5 canonical tiers with target widths [3,5,7,9,11]", () => {
    expect(TIER_DEFINITIONS).toHaveLength(5);
    expect(TIER_DEFINITIONS.map(t => t.target)).toEqual([3, 5, 7, 9, 11]);
    expect(TIER_DEFINITIONS.map(t => t.tier)).toEqual([0, -1, -2, -3, -4]);
  });
});
