import { AUDIT_TERMS, auditRecommendations } from "../recommendationAudit.js";

// Ten training days on one grip and two hands, rotating through durations,
// for two accounts identified only by user_id.
const F = T => 30 * Math.exp(-T / 10) + 12 * Math.exp(-T / 30) + 6 * Math.exp(-T / 480);
const DURATIONS = [30, 70, 115, 160, 220];
const history = (userId, scale) => Array.from({ length: 10 }, (_, day) => {
  const date = `2026-07-${String(day + 1).padStart(2, "0")}`;
  const T = DURATIONS[day % DURATIONS.length];
  return ["L", "R"].map(hand => ({
    id: `${userId}-${date}-${hand}`, user_id: userId, session_id: `${userId}-${date}`,
    session_started_at: `${date}T08:00:00Z`, date, grip: "Crusher", hand,
    set_num: 1, rep_num: 1, target_duration: T, actual_time_s: T,
    avg_force_kg: F(T) * scale * (hand === "L" ? 1 : 0.95), failure_valid: true,
  }));
}).flat();

test("replays each account by pseudonym and accounts for every pick", () => {
  const report = auditRecommendations([...history("acct-secret-1", 1), ...history("acct-secret-2", 1.2)], { minPriorFresh: 4 });
  expect(Object.keys(report.athletes)).toEqual(["athlete 1", "athlete 2"]);
  expect(JSON.stringify(report)).not.toMatch(/acct-secret/);
  for (const a of Object.values(report.athletes)) {
    expect(a.picks).toBeGreaterThan(0);
    expect(Object.values(a.status).reduce((s, n) => s + n, 0)).toBe(a.picks);
    for (const term of AUDIT_TERMS) expect(a.decisive[term]).toBeLessThanOrEqual(a.picks);
    expect(Object.values(a.byMonth).reduce((s, m) => s + m.picks, 0)).toBe(a.picks);
  }
});

test("rejects input that is not a rep array", () => {
  expect(() => auditRecommendations({})).toThrow("Expected a JSON array");
});
