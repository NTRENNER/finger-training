// Tests for src/model/peakForce.js — peak-force (max-strength) trend.

import { buildPeakForceTrend, PEAK_MAX_PROTOCOL_T, maxTestStaleness, MAX_TEST_STALE_DAYS } from "../peakForce.js";

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

  // ── Provisional grips (June 2026) ───────────────────────────
  // A new grip's cold-start sessions are mid-duration, so it can
  // train for weeks with no max/power day. It now appears as a
  // provisional series (sub-max peaks, no % badge) instead of being
  // invisible — and flips to the qualified series the moment a real
  // max day lands.
  test("grip with only sub-max-protocol peaks shows as provisional, no %", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 170, 7),     // qualified grip
      rep("Prime",   "2026-06-10", 12, 7.6, 35),   // 35s session only → provisional
    ]);
    expect(t.grips).toEqual(["Crusher", "Prime"]);
    expect(t.provisional.Prime).toBe(true);
    expect(t.provisional.Crusher).toBeUndefined();
    expect(t.best.Prime.kg).toBe(7.6);
    expect(t.changePct.Prime).toBeNull();          // % over sub-max pulls is noise
    expect(t.changePct.Crusher).not.toBeNull();
  });

  // ── Smoothed max-day trend (June 2026) ──────────────────────
  // The PR line can only rise or hold; the trend line is the one
  // that can fall — early warning for decline the staircase hides.
  test("trend is a 3-point centered mean over max-day session bests", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 70, 7),
      rep("Crusher", "2026-05-08", 8, 76, 7),
      rep("Crusher", "2026-05-15", 8, 64, 7),
    ]);
    const r1 = t.rows.find(r => r.date === "2026-05-01");
    const r2 = t.rows.find(r => r.date === "2026-05-08");
    const r3 = t.rows.find(r => r.date === "2026-05-15");
    expect(r1.Crusher_trend).toBeCloseTo((70 + 76) / 2, 1);       // 2-pt endpoint
    expect(r2.Crusher_trend).toBeCloseTo((70 + 76 + 64) / 3, 1);  // centered
    expect(r3.Crusher_trend).toBeCloseTo((76 + 64) / 2, 1);
  });

  test("trend can fall while the PR line stays flat (decline visibility)", () => {
    const t = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 80, 7),   // PR set here
      rep("Crusher", "2026-05-08", 8, 72, 7),
      rep("Crusher", "2026-05-15", 8, 66, 7),
      rep("Crusher", "2026-05-22", 8, 61, 7),
    ]);
    const rows = t.rows;
    // PR line: flat at 80 after the first session.
    expect(rows.at(-1).Crusher_pr).toBe(80);
    // Trend: strictly falling across the decline.
    const trends = rows.map(r => r.Crusher_trend);
    expect(trends.at(-1)).toBeLessThan(trends[0]);
    expect(trends.at(-1)).toBeLessThan(rows.at(-1).Crusher_pr);
  });

  test("no trend for provisional grips or fewer than 3 max days", () => {
    const sparse = buildPeakForceTrend([
      rep("Crusher", "2026-05-01", 8, 70, 7),
      rep("Crusher", "2026-05-08", 8, 76, 7),
    ]);
    expect(sparse.rows.every(r => r.Crusher_trend == null)).toBe(true);
    const prov = buildPeakForceTrend([
      rep("Prime", "2026-06-01", 12, 7, 35),
      rep("Prime", "2026-06-05", 12, 7.2, 35),
      rep("Prime", "2026-06-10", 12, 7.6, 35),
    ]);
    expect(prov.provisional.Prime).toBe(true);
    expect(prov.rows.every(r => r.Prime_trend == null)).toBe(true);
  });

  test("first max/power session flips a grip from provisional to qualified", () => {
    const t = buildPeakForceTrend([
      rep("Prime", "2026-06-10", 12, 7.6, 35),     // sub-max era
      rep("Prime", "2026-06-20", 5, 9.1, 5),       // first real max day
    ]);
    expect(t.provisional.Prime).toBeUndefined();
    // The provisional history is dropped — it would understate the
    // baseline the % climbs from.
    expect(t.rows.find(r => r.date === "2026-06-10")).toBeUndefined();
    expect(t.best.Prime.kg).toBe(9.1);
  });
});

describe("maxTestStaleness", () => {
  const R = (date, { peak = 20, target = 3 } = {}) => ({
    grip: "Micro", hand: "L", date, rep_num: 1, set_num: 1,
    target_duration: target, actual_time_s: 3, peak_force_kg: peak, avg_force_kg: 18,
  });

  test("never measured → recommended, staleDays null", () => {
    const r = maxTestStaleness([], "2026-07-04");
    expect(r).toEqual({ staleDays: null, lastDate: null, recommended: true });
  });

  test("fresh reading (< 28d) → not recommended", () => {
    const r = maxTestStaleness([R("2026-06-20")], "2026-07-04");  // 14d
    expect(r.staleDays).toBe(14);
    expect(r.recommended).toBe(false);
  });

  test("stale reading (> 28d) → recommended", () => {
    const r = maxTestStaleness([R("2026-05-20")], "2026-07-04");  // 45d
    expect(r.staleDays).toBe(45);
    expect(r.recommended).toBe(true);
  });

  test("uses the MOST RECENT peak reading", () => {
    const r = maxTestStaleness([R("2026-04-01"), R("2026-06-25")], "2026-07-04");
    expect(r.lastDate).toBe("2026-06-25");
    expect(r.recommended).toBe(false);
  });

  test("peak-only: a short rep WITHOUT a measured peak does not clear it", () => {
    // manual short entry (peak null) — clears shortEndFailureStaleness but
    // NOT the peak-test cadence, which needs a real peak_force_kg reading.
    const manualShort = { grip: "Micro", hand: "L", date: "2026-07-03", rep_num: 1,
      target_duration: 3, actual_time_s: 3, peak_force_kg: null, avg_force_kg: 18 };
    const r = maxTestStaleness([manualShort], "2026-07-04");
    expect(r).toEqual({ staleDays: null, lastDate: null, recommended: true });
  });

  test("endurance rep with a peak is excluded (target beyond max/power)", () => {
    const enduro = R("2026-07-03", { target: 160 });  // has a peak but sub-max intent
    const r = maxTestStaleness([enduro], "2026-07-04");
    expect(r).toEqual({ staleDays: null, lastDate: null, recommended: true });
  });

  test("boundary: exactly 28d is still fresh (> is the gate)", () => {
    const r = maxTestStaleness([R("2026-06-06")], "2026-07-04");  // 28d
    expect(r.staleDays).toBe(28);
    expect(r.recommended).toBe(false);
    expect(MAX_TEST_STALE_DAYS).toBe(28);
  });
});
