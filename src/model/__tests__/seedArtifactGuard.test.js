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
