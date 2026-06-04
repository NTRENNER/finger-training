// Tests for src/model/peakForce.js — peak-force (max-strength) trend.

import { buildPeakForceTrend, PEAK_MAX_PROTOCOL_T } from "../peakForce.js";

const rep = (grip, date, t, peak, target = 7) => ({
  grip, hand: "L", date, rep_num: 1, target_duration: target,
  actual_time_s: t, peak_force_kg: peak, avg_force_kg: peak * 0.9,
});

describe("buildPeakForceTrend", () => {
  test("null on empty / no peak data", () => {
    expect(buildPeakForceTrend([])).toBeNull();
    expect(buildPeakForceTrend([{ grip: "Crusher", date: "2026-05-01", actual_time_s: 8 }])).toBeNull();
  });

  test("takes the best peak per grip per session", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 55),
      rep("Crusher", "2026-05-01", 7, 60),   // same day, higher peak wins
      rep("Crusher", "2026-05-08", 6, 64),
    ]);
    expect(t.grips).toEqual(["Crusher"]);
    expect(t.rows.find(r => r.date === "2026-05-01").Crusher).toBe(60);
    expect(t.best.Crusher.kg).toBe(64);
    expect(t.latest.Crusher.kg).toBe(64);
  });

  test("rep duration does NOT gate the peak (peak is instantaneous)", () => {
    // A long-DURATION rep from a max/power protocol still counts — peak
    // force is neuromuscular, not duration-bound. Only the protocol (a
    // long target_duration) excludes a session.
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 60, 7),    // max protocol
      rep("Crusher", "2026-05-08", 22, 64, 10),  // held 22s but max protocol → counts
    ]);
    expect(t.rows.find(r => r.date === "2026-05-08").Crusher).toBe(64);
    expect(t.best.Crusher.kg).toBe(64);
  });

  test("running PR line is monotonic non-decreasing", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 60),
      rep("Crusher", "2026-05-08", 8, 55),   // worse day — PR holds at 60
      rep("Crusher", "2026-05-15", 8, 66),   // new PR
    ]);
    const prs = t.rows.map(r => r.Crusher_pr);
    expect(prs).toEqual([60, 60, 66]);
  });

  test("tracks multiple grips independently", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 60),
      rep("Micro", "2026-05-01", 8, 22),
    ]);
    expect(t.grips).toEqual(["Crusher", "Micro"]);
    expect(t.best.Crusher.kg).toBe(60);
    expect(t.best.Micro.kg).toBe(22);
  });

  test("changePct = best-ever vs first session; per-grip zoom domain", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-04-27", 8, 66),   // first
      rep("Crusher", "2026-05-24", 11, 77),  // best → +17%
      rep("Micro", "2026-04-27", 8, 23),     // first
      rep("Micro", "2026-04-29", 8, 23),     // flat → 0%
    ]);
    expect(t.changePct.Crusher).toBe(17);
    expect(t.changePct.Micro).toBe(0);
    expect(t.domain.Crusher).toEqual({ min: 66, max: 77 });
  });

  test("excludes endurance protocols (sub-max load, not a max attempt)", () => {
    expect(PEAK_MAX_PROTOCOL_T).toBeGreaterThan(0);
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 170, 7),    // max protocol → counts
      rep("Crusher", "2026-05-08", 11, 95, 160),  // endurance session → excluded
    ]);
    const may8 = t.rows.find(r => r.date === "2026-05-08");
    expect(may8).toBeUndefined();                 // no max sample that session
    expect(t.best.Crusher.kg).toBe(170);          // the 95 lb endurance peak is gone
  });

  test("keeps reps with missing target_duration (legacy/manual rows)", () => {
    const t = buildPeakForceTrend([
      { grip: "Micro", hand: "L", date: "2026-05-01", rep_num: 1, actual_time_s: 8, peak_force_kg: 24 },
    ]);
    expect(t.best.Micro.kg).toBe(24);
  });
});
