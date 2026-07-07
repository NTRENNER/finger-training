import { isSeedArtifactRep } from "../load.js";
import { demonstratedCapacityKg } from "../prescription.js";

describe("isSeedArtifactRep", () => {
  test("flags avg==peak seeded rows", () => {
    expect(isSeedArtifactRep({ avg_force_kg: 14.3, peak_force_kg: 14.3 })).toBe(true);
  });
  test("real measured hold (peak>avg) is not flagged", () => {
    expect(isSeedArtifactRep({ avg_force_kg: 6.5, peak_force_kg: 7.9 })).toBe(false);
  });
  test("manual rep (avg null, load in manual) is not flagged", () => {
    expect(isSeedArtifactRep({ avg_force_kg: null, manual_load_kg: 5.7, peak_force_kg: null })).toBe(false);
  });
  test("zeros are not flagged", () => {
    expect(isSeedArtifactRep({ avg_force_kg: 0, peak_force_kg: 0 })).toBe(false);
  });
});

describe("floor excludes seeded twins", () => {
  const base = { hand: "L", grip: "Micro", rep_num: 1, target_duration: 160 };
  test("a phantom avg==peak twin can't raise the demonstrated-capacity floor", () => {
    const real    = { ...base, session_id: "real", date: "2026-05-20", actual_time_s: 129, avg_force_kg: 6.5, peak_force_kg: 7.9 };
    const phantom = { ...base, session_id: "seed", date: "2026-05-20", actual_time_s: 129, avg_force_kg: 14.3, peak_force_kg: 14.3 };
    const floor = demonstratedCapacityKg([real, phantom], "L", "Micro", 115, "2026-07-04");
    expect(floor).toBeCloseTo(6.5, 3);
  });
});

// July 2026 extension: the guard now also covers the shared fit basis
// and every peak reader — a seeded twin mirrors its inflated load into
// peak_force_kg too, so peak-derived surfaces need the same exclusion.
import { freshFitReps } from "../load.js";
import { recentBestPeakKg } from "../prescription.js";
import { buildPeakForceTrend, maxTestStaleness } from "../peakForce.js";

const real    = { hand: "L", grip: "Micro", rep_num: 1, session_id: "real", date: "2026-05-20",
                  target_duration: 10, actual_time_s: 9, avg_force_kg: 6.5, peak_force_kg: 7.9 };
const phantom = { hand: "L", grip: "Micro", rep_num: 1, session_id: "seed", date: "2026-05-20",
                  target_duration: 10, actual_time_s: 9, avg_force_kg: 14.3, peak_force_kg: 14.3 };

describe("freshFitReps excludes seeded twins (shared fit basis)", () => {
  test("phantom avg==peak rep is dropped; real + manual reps survive", () => {
    const manual = { hand: "L", grip: "Micro", rep_num: 1, date: "2026-05-21",
                     target_duration: 60, actual_time_s: 55, avg_force_kg: null, manual_load_kg: 5.7 };
    const out = freshFitReps([real, phantom, manual]);
    expect(out).toHaveLength(2);
    expect(out.some(r => r.avg_force_kg === 14.3)).toBe(false);
    expect(out.some(r => r.manual_load_kg === 5.7)).toBe(true);
  });
});

describe("peak readers exclude seeded twins", () => {
  test("recentBestPeakKg: phantom peak can't set the ceiling", () => {
    expect(recentBestPeakKg([real, phantom], "L", "Micro", "2026-07-04")).toBeCloseTo(7.9, 3);
  });
  test("buildPeakForceTrend: phantom peak can't set a PR or session best", () => {
    const trend = buildPeakForceTrend([real, phantom]);
    expect(trend.best.Micro.kg).toBeCloseTo(7.9, 3);
  });
  test("buildPeakForceTrend: phantom-only history has no peak data", () => {
    expect(buildPeakForceTrend([phantom])).toBeNull();
  });
  test("maxTestStaleness: a fake peak doesn't clear the cadence", () => {
    const st = maxTestStaleness([phantom], "2026-07-07");
    expect(st.staleDays).toBeNull();
    expect(st.recommended).toBe(true);
  });
  test("maxTestStaleness: a real measured peak still clears it", () => {
    const st = maxTestStaleness([real], "2026-05-25");
    expect(st.staleDays).toBe(5);
    expect(st.recommended).toBe(false);
  });
});
