import { sessionOverpull, OVERPULL_ALERT_PCT } from "../overpull.js";

const rep = (presc, eff) => ({ prescribed_load_kg: presc, avg_force_kg: eff });

describe("sessionOverpull", () => {
  test("flags a session pulled well over prescribed", () => {
    // ~18% over on every rep.
    const reps = [rep(9, 10.6), rep(9, 10.6), rep(9, 10.6)];
    const op = sessionOverpull(reps);
    expect(op.isOver).toBe(true);
    expect(op.pct).toBeGreaterThanOrEqual(OVERPULL_ALERT_PCT);
  });

  test("does not flag an on-target session", () => {
    const reps = [rep(9, 9), rep(9, 9.1), rep(9, 8.9)];
    expect(sessionOverpull(reps).isOver).toBe(false);
  });

  test("ignores reps with no prescribed load; empty → not over", () => {
    expect(sessionOverpull([]).isOver).toBe(false);
    expect(sessionOverpull([{ avg_force_kg: 20 }]).isOver).toBe(false);
  });
});
