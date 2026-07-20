// Tests for src/model/lockout.js — zone staleness + boost multipliers.

import {
  stalenessBoost,
  STALE_BOOST_MAX,
  getLastZoneTrainedDates,
  getZoneStaleness,
  getRollingSessionPace,
} from "../lockout.js";

describe("stalenessBoost", () => {
  test("returns 1.0 for missing zone", () => {
    expect(stalenessBoost("power", null)).toBe(1.0);
    expect(stalenessBoost("power", {})).toBe(1.0);
  });

  test("returns 1.0 for ok", () => {
    expect(stalenessBoost("power", { power: { status: "ok" } })).toBe(1.0);
  });

  test("returns 1.4 for warning", () => {
    expect(stalenessBoost("power", { power: { status: "warning" } })).toBe(1.4);
  });

  test("returns 2.0 for a bare stale probe (no days/window available)", () => {
    // Fallback when the entry lacks a days field — preserves the
    // historical flat 2.0x for callers passing a status-only stub.
    expect(stalenessBoost("power", { power: { status: "stale" } })).toBe(2.0);
  });

  test("escalates the stale boost with how far past the window it is", () => {
    // strength window = 30d. Anchor at 2.0x when days == window, then
    // grow linearly with the overdue ratio (2.0 * days/window).
    const at = (days) => stalenessBoost("strength", { strength: { status: "stale", days } });
    expect(at(30)).toBeCloseTo(2.0, 5);            // exactly at the window
    expect(at(33)).toBeCloseTo(2.0 * 33 / 30, 5);  // ~2.2, below the cap
    expect(at(37.5)).toBeCloseTo(2.5, 5);          // 2.0 * 37.5/30 == cap
    // Strictly increasing until the cap.
    expect(at(35)).toBeGreaterThan(at(31));
  });

  test("stale boost is capped at STALE_BOOST_MAX, strictly below the never boost", () => {
    const huge = stalenessBoost("strength", { strength: { status: "stale", days: 999 } });
    expect(huge).toBe(STALE_BOOST_MAX);
    expect(STALE_BOOST_MAX).toBe(2.5);
    // Never-sampled zones stay the top coverage priority: even a wildly-
    // overdue stale zone cannot reach the 3.0 never boost.
    expect(huge).toBeLessThan(
      stalenessBoost("strength", { strength: { status: "never" } })
    );
  });

  test("returns 3.0 for never — stronger than stale", () => {
    // Never-sampled zones get the highest boost so the engine
    // prioritizes coverage before falling back to adaptation-gain.
    // Calibrated to outscore typical adaptBoost values (~1.5–2.5)
    // at neutral residual.
    expect(stalenessBoost("power", { power: { status: "never" } })).toBe(3.0);
    // Sanity: strictly greater than stale.
    expect(stalenessBoost("power", { power: { status: "never" } }))
      .toBeGreaterThan(stalenessBoost("power", { power: { status: "stale" } }));
  });
});

describe("getLastZoneTrainedDates", () => {
  test("returns nulls for every zone with empty history", () => {
    const out = getLastZoneTrainedDates([]);
    for (const v of Object.values(out)) {
      expect(v).toBeNull();
    }
  });

  test("buckets by actual_time_s when present", () => {
    const out = getLastZoneTrainedDates([
      // Targeted strength_endurance (140s) but only held 60s →
      // body trained power_strength, not strength_endurance.
      { grip: "Crusher", date: "2026-05-11", target_duration: 140, actual_time_s: 60 },
    ]);
    expect(out.power_strength).toBe("2026-05-11");
    expect(out.strength_endurance).toBeNull();
  });

  test("falls back to target_duration when actual_time_s missing", () => {
    const out = getLastZoneTrainedDates([
      { grip: "Crusher", date: "2026-05-11", target_duration: 30 },
    ]);
    expect(out.power).toBe("2026-05-11");
  });

  test("fresh efforts only: fatigued within-set reps don't credit short zones", () => {
    // One Strength set to failure: rep 1 is a fresh 120s hold (Strength);
    // reps 2-4 are fatigued and die at progressively shorter durations.
    // Only Strength should be credited — the depleted reps are NOT fresh
    // training of Power·Strength / Power / Max.
    const out = getLastZoneTrainedDates([
      { grip: "Crusher", date: "2026-05-15", rep_num: 1, actual_time_s: 120 }, // strength
      { grip: "Crusher", date: "2026-05-15", rep_num: 2, actual_time_s: 60 },  // power_strength (fatigued)
      { grip: "Crusher", date: "2026-05-15", rep_num: 3, actual_time_s: 30 },  // power (fatigued)
      { grip: "Crusher", date: "2026-05-15", rep_num: 4, actual_time_s: 8 },   // max_strength (fatigued)
    ]);
    expect(out.strength).toBe("2026-05-15");
    expect(out.power_strength).toBeNull();
    expect(out.power).toBeNull();
    expect(out.max_strength).toBeNull();
  });

  test("a fresh rep 1 that fails short still counts for the zone it reached", () => {
    const out = getLastZoneTrainedDates([
      { grip: "Crusher", date: "2026-05-15", rep_num: 1, target_duration: 160, actual_time_s: 30 },
    ]);
    expect(out.power).toBe("2026-05-15");          // real fresh test of Power
    expect(out.strength_endurance).toBeNull();
  });

  test("rows without rep_num (legacy/manual) are treated as fresh", () => {
    const out = getLastZoneTrainedDates([
      { grip: "Crusher", date: "2026-05-15", actual_time_s: 30 },
    ]);
    expect(out.power).toBe("2026-05-15");
  });
});

describe("getZoneStaleness", () => {
  test("status='never' when no training data exists for zone", () => {
    const out = getZoneStaleness([], new Date(2026, 4, 17));
    expect(out.power.status).toBe("never");
    expect(out.power.lastDate).toBeNull();
  });

  test("status='ok' for recent training", () => {
    const out = getZoneStaleness(
      [{ grip: "Crusher", date: "2026-05-15", actual_time_s: 30 }],
      new Date(2026, 4, 17),
    );
    expect(out.power.status).toBe("ok");
    expect(out.power.days).toBe(2);
  });

  test("status='stale' when days_since exceeds lockout window", () => {
    // Power lockout window is 21d — train > 21d ago → stale.
    const out = getZoneStaleness(
      [{ grip: "Crusher", date: "2026-04-01", actual_time_s: 30 }],
      new Date(2026, 4, 17),
    );
    expect(out.power.status).toBe("stale");
  });

  test("a session dated today stays zero days old in the local evening", () => {
    const out = getZoneStaleness(
      [{ grip: "Crusher", date: "2026-07-20", actual_time_s: 30 }],
      new Date(2026, 6, 20, 20, 0, 0),
    );
    expect(out.power.days).toBe(0);
    expect(out.power.status).toBe("ok");
  });
});

describe("getRollingSessionPace", () => {
  test("counts a same-day evening session inside the rolling window", () => {
    const out = getRollingSessionPace(
      [{ date: "2026-07-20", session_id: "today" }],
      new Date(2026, 6, 20, 20, 0, 0),
    );
    expect(out.current).toBe(1);
  });
});
