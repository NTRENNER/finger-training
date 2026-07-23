import {
  climbingPrContext,
  deriveClimbingPrBadges,
  newClimbingPrForEntry,
} from "../climbingPrBadges.js";

const climb = (grade, over = {}) => ({
  date: "2026-07-20",
  type: "climbing",
  discipline: "boulder",
  venue: "indoor",
  wall: "commercial",
  grade,
  ascent: "redpoint",
  ...over,
});

describe("climbing PR badge contexts", () => {
  test("separates commercial, board, outdoor, and route venue progressions", () => {
    const badges = deriveClimbingPrBadges([
      climb("V7"),
      climb("V5", { wall: "moonboard" }),
      climb("V6", { wall: "kilter" }),
      climb("V8", { venue: "outdoor", wall: undefined }),
      climb("5.11d", { discipline: "top_rope", grade: "5.11d", wall: undefined }),
      climb("5.12a", { discipline: "lead", venue: "outdoor", grade: "5.12a", wall: undefined }),
    ]);

    expect(badges.map(badge => [badge.key, badge.grade])).toEqual([
      ["boulder_indoor_commercial", "V7"],
      ["boulder_indoor_moonboard", "V5"],
      ["boulder_indoor_kilter", "V6"],
      ["boulder_outdoor", "V8"],
      ["route_indoor", "5.11d"],
      ["route_outdoor", "5.12a"],
    ]);
  });

  test("combines lead and top rope within each route venue", () => {
    const badges = deriveClimbingPrBadges([
      climb("5.11a", { discipline: "lead", grade: "5.11a", wall: undefined }),
      climb("5.11c", { discipline: "top_rope", grade: "5.11c", wall: undefined }),
    ]);

    expect(badges).toHaveLength(1);
    expect(badges[0]).toMatchObject({
      key: "route_indoor",
      grade: "5.11c",
      sourceDiscipline: "top_rope",
    });
  });

  test("legacy indoor boulders without wall or venue count as commercial", () => {
    const legacy = climb("V4", { venue: undefined, wall: undefined });
    expect(climbingPrContext(legacy).key).toBe("boulder_indoor_commercial");
    expect(deriveClimbingPrBadges([legacy])[0].grade).toBe("V4");
  });

  test.each(["repeat", "rest", "attempt"])("%s does not earn or upgrade a badge", ascent => {
    const existing = [climb("V4")];
    const entry = climb("V6", { ascent });

    expect(deriveClimbingPrBadges([entry])).toHaveLength(0);
    expect(newClimbingPrForEntry(existing, entry)).toBeNull();
  });

  test("a first V0 clean send earns a badge and a higher clean send upgrades it", () => {
    const first = newClimbingPrForEntry([], climb("V0"));
    const upgrade = newClimbingPrForEntry([climb("V3")], climb("V4"));

    expect(first).toMatchObject({ grade: "V0", previousGrade: null });
    expect(upgrade).toMatchObject({ grade: "V4", previousGrade: "V3" });
    expect(newClimbingPrForEntry([climb("V4")], climb("V4"))).toBeNull();
  });

  test("badge date is when the current grade was first earned", () => {
    const badge = deriveClimbingPrBadges([
      climb("V6", { date: "2026-07-22", ascent: "flash" }),
      climb("V6", { date: "2026-07-10", ascent: "redpoint" }),
    ])[0];

    expect(badge.date).toBe("2026-07-10");
  });
});
