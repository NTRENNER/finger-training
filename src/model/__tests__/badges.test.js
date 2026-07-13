import { deriveBadges, badgeEmoji, BADGE_TIERS } from "../badges.js";

const rep = (date, sid, load) => ({
  hand: "L", grip: "Micro", target_duration: 160, actual_time_s: 160,
  avg_force_kg: load, rep_num: 1, date, session_id: sid,
});

describe("deriveBadges", () => {
  test("empty history → no badges", () => {
    expect(deriveBadges([])).toEqual([]);
    expect(deriveBadges(null)).toEqual([]);
  });

  test("a grip/zone that improved earns a level >= 2 badge", () => {
    // Baseline session at 20 kg, later session at 22 kg (+10% ≈ 2 levels).
    const history = [rep("2026-01-01", "s1", 20), rep("2026-02-01", "s2", 22)];
    const badges = deriveBadges(history);
    const micro = badges.find(b => b.grip === "Micro" && b.zone === "strength_endurance");
    expect(micro).toBeDefined();
    expect(micro.level).toBe(2);
    expect(micro.emoji).toBe(badgeEmoji(2));
  });

  test("emoji tier clamps at the top of the ladder", () => {
    expect(badgeEmoji(1)).toBe(BADGE_TIERS[0]);
    expect(badgeEmoji(999)).toBe(BADGE_TIERS[BADGE_TIERS.length - 1]);
  });
});
