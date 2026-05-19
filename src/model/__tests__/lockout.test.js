// Tests for src/model/lockout.js — zone staleness + boost multipliers.

import {
  stalenessBoost,
  getLastZoneTrainedDates,
  getZoneStaleness,
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

  test("returns 2.0 for stale", () => {
    expect(stalenessBoost("power", { power: { status: "stale" } })).toBe(2.0);
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
});

describe("getZoneStaleness", () => {
  test("status='never' when no training data exists for zone", () => {
    const out = getZoneStaleness([], new Date("2026-05-17"));
    expect(out.power.status).toBe("never");
    expect(out.power.lastDate).toBeNull();
  });

  test("status='ok' for recent training", () => {
    const out = getZoneStaleness(
      [{ grip: "Crusher", date: "2026-05-15", actual_time_s: 30 }],
      new Date("2026-05-17"),
    );
    expect(out.power.status).toBe("ok");
    expect(out.power.days).toBe(2);
  });

  test("status='stale' when days_since exceeds lockout window", () => {
    // Power lockout window is 21d — train > 21d ago → stale.
    const out = getZoneStaleness(
      [{ grip: "Crusher", date: "2026-04-01", actual_time_s: 30 }],
      new Date("2026-05-17"),
    );
    expect(out.power.status).toBe("stale");
  });
});
