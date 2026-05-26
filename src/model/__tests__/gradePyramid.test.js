// Tests for src/model/gradePyramid.js — 5-tier outline pyramid
// (apex, -1, -2, -3, base) with fixed targets [1, 4, 7, 10, 13].

import {
  inferProjectGrade,
  buildPyramidPlan,
  TIER_DEFINITIONS,
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

describe("buildPyramidPlan — tier shape", () => {
  test("returns 5 tiers in project → base order", () => {
    const plan = buildPyramidPlan([row("V6", 6, 2)]);
    expect(plan.tiers).toHaveLength(5);
    expect(plan.tiers.map(t => t.tier)).toEqual([0, -1, -2, -3, -4]);
  });

  test("apex target = 1, base target = 13, middle = 4/7/10", () => {
    const plan = buildPyramidPlan([row("V6", 6, 2)]);
    expect(plan.tiers.map(t => t.target)).toEqual([1, 4, 7, 10, 13]);
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
  test("shaded = min(actualCount, target); status = 'partial' below target", () => {
    // V6 project, V5 with 1 send (target 2)
    const rows = [row("V5", 5, 1), row("V6", 6, 1)];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[0]).toMatchObject({ actualCount: 1, shaded: 1, capped: false, status: "complete" });
    expect(plan.tiers[1]).toMatchObject({ actualCount: 1, shaded: 1, capped: false, status: "partial" });
  });

  test("status = 'complete' when actualCount === target, capped = false", () => {
    // V6 project, V4 (tier -2, target 7) with exactly 7 sends
    const rows = [row("V4", 4, 7), row("V6", 6, 1)];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[2]).toMatchObject({ actualCount: 7, shaded: 7, capped: false, status: "complete" });
  });

  test("status = 'complete' AND capped = true when actualCount > target", () => {
    // V6 project, V3 (tier -3, target 10) with 15 sends
    const rows = [row("V3", 3, 15), row("V6", 6, 1)];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[3]).toMatchObject({ actualCount: 15, shaded: 10, capped: true, status: "complete" });
  });

  test("status = 'empty' when no sends at that tier", () => {
    const plan = buildPyramidPlan([row("V6", 6, 1)]);
    // V5/V4/V3/V2 all empty
    for (const t of plan.tiers.slice(1)) {
      expect(t.status).toBe("empty");
      expect(t.shaded).toBe(0);
      expect(t.actualCount).toBe(0);
    }
  });

  test("missing tiers expose grade=null but keep the outline row", () => {
    // Project V6, V4 missing (gap tier)
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
    expect(plan.tiers.map(t => t.target)).toEqual([1, 4, 7, 10, 13]);
    for (const t of plan.tiers) {
      expect(t.grade).toBeNull();
      expect(t.actualCount).toBe(0);
      expect(t.status).toBe("empty");
    }
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
    // Pinned at V6, but V7 has 2 sends and V8 has 1
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
    // Project = V7 (flash V4 + gap 3). User has 0 sends at V7.
    const rows = [
      row("V4", 4, 20),  // tier -3 (target 10 — capped from 20)
      row("V5", 5, 4),   // tier -2 (target 7 — partial)
      row("V6", 6, 2),   // tier -1 (target 4 — partial)
    ];
    const plan = buildPyramidPlan(rows, "V7", { anchorMode: "flash", projectRank: 7 });
    expect(plan.projectGrade).toBe("V7");
    expect(plan.tiers[0]).toMatchObject({ grade: "V7", actualCount: 0, shaded: 0, status: "empty" });
    expect(plan.tiers[1]).toMatchObject({ grade: "V6", actualCount: 2, shaded: 2, status: "partial" });
    expect(plan.tiers[2]).toMatchObject({ grade: "V5", actualCount: 4, shaded: 4, capped: false, status: "partial" });
    expect(plan.tiers[3]).toMatchObject({ grade: "V4", actualCount: 20, shaded: 10, capped: true });
  });

  test("YDS: stepSize 0.25 walks tiers by letter subgrades", () => {
    // Flash 5.12a → project 5.13a (rank 13.0). Tier -4 lands on 5.12a (rank 12.0).
    const rows = [
      { grade: "5.12a", rank: 12.0,  count: 8 },  // tier -4 (target 13 — partial)
      { grade: "5.12b", rank: 12.25, count: 3 },  // tier -3 (target 10 — partial)
      { grade: "5.12c", rank: 12.5,  count: 3 },  // tier -2 (target  7 — partial)
      { grade: "5.12d", rank: 12.75, count: 2 },  // tier -1 (target  4 — partial)
      { grade: "5.13a", rank: 13.0,  count: 0 },  // apex  (target  1 — empty)
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
  // Caller-provided resolver lets empty tiers carry their grade
  // label so the chart can read "V7" on a gap row instead of "—".
  const vResolver = (rank) => {
    if (!Number.isFinite(rank)) return null;
    const n = Math.round(rank);
    return n >= 0 && n <= 13 ? `V${n}` : null;
  };

  test("labels empty tiers with their grade when resolver is provided", () => {
    // Project V8, sends only at V4/V5/V6 — V7 (tier -1) is empty
    const rows = [
      row("V4", 4, 7), row("V5", 5, 6), row("V6", 6, 2), row("V8", 8, 1),
    ];
    const plan = buildPyramidPlan(rows, "V8", {
      anchorMode: "flash", projectRank: 8, rankToGrade: vResolver,
    });
    expect(plan.tiers[0].grade).toBe("V8");                            // apex (had a row)
    expect(plan.tiers[1].grade).toBe("V7");                            // empty tier — resolver fills it
    expect(plan.tiers[1].actualCount).toBe(0);                         // still no sends
    expect(plan.tiers[2].grade).toBe("V6");                            // had a row
    expect(plan.tiers[3].grade).toBe("V5");
    expect(plan.tiers[4].grade).toBe("V4");
  });

  test("row labels still win over resolver output (resolver is a fallback only)", () => {
    // If the resolver returned the "wrong" label, the actual row's
    // grade should still be used. Guards against a stale resolver
    // contradicting authoritative data.
    const wrongResolver = (rank) => `WRONG-${rank}`;
    const plan = buildPyramidPlan(
      [row("V6", 6, 2)],
      null,
      { rankToGrade: wrongResolver },
    );
    expect(plan.tiers[0].grade).toBe("V6");                            // row wins
  });

  test("without resolver, empty tiers still expose grade=null (back-compat)", () => {
    const plan = buildPyramidPlan([row("V8", 8, 1)], "V8", {
      anchorMode: "flash", projectRank: 8,
    });
    // No resolver → empty middle tiers stay null
    expect(plan.tiers[1].grade).toBeNull();
    expect(plan.tiers[4].grade).toBeNull();
  });
});

describe("buildPyramidPlan — climbs metadata pass-through", () => {
  // Caller may attach a per-row `climbs` array; the model should
  // surface it on the matching tier so the chart can show details
  // on tap. Rows without `climbs` get an empty array (not undefined)
  // so the consumer's `.length`/`.map` checks stay safe.
  const climb = (date, ascent, extra = {}) => ({ date, ascent, ...extra });

  test("threads each row's climbs array onto the matching tier", () => {
    const rows = [
      { grade: "V3", rank: 3, count: 2, climbs: [climb("2026-05-01", "flash"), climb("2026-05-02", "redpoint")] },
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint", { route_name: "Apex" })] },
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[0].climbs).toHaveLength(1);                     // V6 apex
    expect(plan.tiers[0].climbs[0].route_name).toBe("Apex");
    expect(plan.tiers[3].climbs).toHaveLength(2);                     // V3 tier -3
    expect(plan.tiers[3].climbs.map(c => c.ascent)).toEqual(["flash", "redpoint"]);
  });

  test("tiers without a matching row get an empty climbs array", () => {
    const rows = [
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint")] },
    ];
    const plan = buildPyramidPlan(rows);
    // Apex has the climb, lower tiers have no rows → empty arrays
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
    // 15 sends at V3 (tier -3, target 10) — all 15 climbs should survive
    // on tier.climbs so the popover can list them, even though only
    // 10 blocks shade in the chart.
    const rows = [
      { grade: "V3", rank: 3, count: 15, climbs: Array.from({ length: 15 }, (_, i) => climb(`2026-05-${10+i}`, "redpoint")) },
      { grade: "V6", rank: 6, count: 1, climbs: [climb("2026-05-20", "redpoint")] },
    ];
    const plan = buildPyramidPlan(rows);
    expect(plan.tiers[3].shaded).toBe(10);                             // blocks capped
    expect(plan.tiers[3].capped).toBe(true);
    expect(plan.tiers[3].climbs).toHaveLength(15);                     // data preserved
  });
});

describe("TIER_DEFINITIONS", () => {
  test("exports the 5 canonical tiers with target widths", () => {
    expect(TIER_DEFINITIONS).toHaveLength(5);
    expect(TIER_DEFINITIONS.map(t => t.target)).toEqual([1, 4, 7, 10, 13]);
    expect(TIER_DEFINITIONS.map(t => t.tier)).toEqual([0, -1, -2, -3, -4]);
  });
});
