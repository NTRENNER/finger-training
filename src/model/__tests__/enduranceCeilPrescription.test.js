// The endurance ceiling caps long-target prescriptions at the power-law
// tail, but leaves short/mid targets and demonstrated capacity intact.
// Fixture: strong SHORT reps (5-45s) inflate the three-exp amplitude across
// all durations (they're in the fit), while the endurance tail is fit on
// T>=30 long holds only — so a 160s target is pushed above the tail and the
// ceiling trims it back. This is the 2026-07-20 Micro failure mode in
// miniature.
import { prescription } from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";
import { CEIL_MIN_T } from "../enduranceTail.js";

const mk = (o) => ({ hand: "R", grip: "Micro", rep_num: 1, set_num: 1,
  target_duration: 120, date: "2026-06-01", session_id: "s", ...o });
const longs = [
  mk({ actual_time_s: 120, avg_force_kg: 7.5, date: "2026-05-01", session_id: "a" }),
  mk({ actual_time_s: 160, avg_force_kg: 6.2, date: "2026-05-08", session_id: "b" }),
  mk({ actual_time_s: 200, avg_force_kg: 5.3, date: "2026-05-15", session_id: "c" }),
  mk({ actual_time_s: 160, avg_force_kg: 6.0, date: "2026-05-22", session_id: "d" }),
  mk({ actual_time_s: 190, avg_force_kg: 5.5, date: "2026-05-29", session_id: "f" }),
];
const shorts = [
  mk({ actual_time_s: 5,  avg_force_kg: 34, date: "2026-06-02", session_id: "s1" }),
  mk({ actual_time_s: 7,  avg_force_kg: 30, date: "2026-06-05", session_id: "s2" }),
  mk({ actual_time_s: 10, avg_force_kg: 27, date: "2026-06-08", session_id: "s3" }),
  mk({ actual_time_s: 45, avg_force_kg: 17, date: "2026-06-10", session_id: "s4" }),
];
const history = [...longs, ...shorts];
const priors = buildThreeExpPriors(history);
const REF = "2026-06-12";
const at = (T, h = history) => prescription(h, "R", "Micro", T, { threeExpPriors: buildThreeExpPriors(h), referenceDate: REF });

test("caps a long (160s) target at the endurance tail, below the inflated curve value", () => {
  const p = at(160);
  expect(p.enduranceCeilKg).toBeGreaterThan(0);
  expect(p.enduranceCeiled).toBe(true);
  expect(p.value).toBeLessThanOrEqual(p.enduranceCeilKg + 1e-9);
  // capped strictly below the raw curve x anchor product it would have shown
  expect(p.value).toBeLessThan(Math.round(p.potential * p.scale * 10) / 10 + 1e-9);
  expect(p.value).toBeGreaterThan(5);   // still a real endurance load
});

test("does NOT touch short/mid targets (no ceiling below CEIL_MIN_T)", () => {
  for (const T of [5, 45, 90, CEIL_MIN_T - 1]) {
    const p = at(T);
    expect(p.enduranceCeilKg == null).toBe(true);
    expect(p.enduranceCeiled).toBeFalsy();
  }
});

test("continuity: no big jump when the ceiling turns on at the boundary", () => {
  const below = at(CEIL_MIN_T - 1).value;
  const above = at(CEIL_MIN_T + 1).value;
  expect(above).toBeLessThanOrEqual(below + 1e-9);   // longer hold never asks more load
  expect(below - above).toBeLessThan(below * 0.25);  // small step, no discontinuity
});

test("demonstrated capacity still wins: the floor overrides a lower ceiling", () => {
  const withBigHold = [...history,
    mk({ actual_time_s: 175, avg_force_kg: 9.0, date: "2026-06-09", session_id: "big" })];
  const p = at(160, withBigHold);
  expect(p.value).toBeGreaterThanOrEqual(9.0 - 1e-9);   // floor beat the ceiling
});
