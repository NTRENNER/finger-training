// Demonstrated-capacity FLOOR must count MEASURED (Tindeq) reps only.
// A manual/spring entry records a nominal load the user pulls against
// (and, with a spring, over-pulls), so it never proved a *sustained
// force* — the exact contamination behind the 2026-07-20 Micro bug,
// where a manual 220s entry logged "9.1 kg for 258 s" pinned the 160s
// floor at 9.1 when genuine measured capacity was ~6-7 kg.
import { demonstratedCapacityKg } from "../prescription.js";
import { isMeasuredLoadRep } from "../load.js";

const day = (n) => new Date(Date.now() - n * 86400 * 1000).toISOString().slice(0, 10);
const rep = (over) => ({
  hand: "L", grip: "Micro", rep_num: 1, set_num: 1,
  target_duration: 160, actual_time_s: 188, avg_force_kg: 5.5,
  date: day(5), session_id: "s", ...over,
});

describe("isMeasuredLoadRep", () => {
  test("true only when avg_force_kg is a sane measurement", () => {
    expect(isMeasuredLoadRep({ avg_force_kg: 7.2 })).toBe(true);
    expect(isMeasuredLoadRep({ avg_force_kg: null, manual_load_kg: 9.1 })).toBe(false);
    expect(isMeasuredLoadRep({ manual_load_kg: 9.1 })).toBe(false);
    expect(isMeasuredLoadRep({ avg_force_kg: 0 })).toBe(false);
    expect(isMeasuredLoadRep(null)).toBe(false);
  });
});

describe("demonstrated-capacity floor ignores manual/spring reps", () => {
  test("a manual 258s entry does not pin the 160s floor; the measured hold does", () => {
    const h = [
      rep({ actual_time_s: 258, avg_force_kg: null, manual_load_kg: 9.1, session_id: "spring" }),
      rep({ actual_time_s: 188, avg_force_kg: 5.5, session_id: "tindeq" }),
    ];
    expect(demonstratedCapacityKg(h, "L", "Micro", 160)).toBeCloseTo(5.5, 5);
  });

  test("with only manual reps there is no measured demonstration -> no floor", () => {
    const manualOnly = [rep({ actual_time_s: 258, avg_force_kg: null, manual_load_kg: 9.1, session_id: "spring" })];
    expect(demonstratedCapacityKg(manualOnly, "L", "Micro", 160)).toBeNull();
  });
});
