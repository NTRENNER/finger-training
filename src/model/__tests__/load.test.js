// Tests for src/model/load.js — sanity guard + load fallback chain.
import { sane, SANE_MAX_KG, effectiveLoad, prescribedLoad, freshFitReps } from "../load.js";

describe("sane", () => {
  test("accepts plausible finger forces/loads", () => {
    expect(sane(0.5)).toBe(0.5);
    expect(sane(76.9)).toBe(76.9);
    expect(sane(150)).toBe(150);
  });
  test("rejects non-positive, non-numeric, and impossible values", () => {
    expect(sane(0)).toBeNull();
    expect(sane(-5)).toBeNull();
    expect(sane("x")).toBeNull();
    expect(sane(null)).toBeNull();
    expect(sane(NaN)).toBeNull();
  });
  test("rejects corrupt loads at/above the ceiling (the 974/284 kg glitch)", () => {
    expect(SANE_MAX_KG).toBe(200);
    expect(sane(200)).toBeNull();
    expect(sane(284.3)).toBeNull();
    expect(sane(974.2)).toBeNull();
  });
  test("effectiveLoad ignores a corrupt weight and falls back to a sane force", () => {
    // Corrupt weight/prescribed, but real avg force present → uses the force.
    expect(effectiveLoad({ avg_force_kg: 24.7, weight_kg: 974.2, prescribed_load_kg: 974.2 })).toBe(24.7);
    // No sane field at all → 0 (not the garbage).
    expect(effectiveLoad({ weight_kg: 974.2, prescribed_load_kg: 284.3 })).toBe(0);
    expect(prescribedLoad({ prescribed_load_kg: 284.3, weight_kg: 974.2 })).toBe(0);
  });
});

// ─────────────────────────────────────────────────────────────
// freshFitReps — de-dup key strictness
// ─────────────────────────────────────────────────────────────
// (Core freshFitReps behavior is covered in baselines.test.js; these
// pin the July 2026 key widening.) The old key omitted set_num and
// manual_load_kg, so two REAL rep-1s from different sets/sessions on
// the same day with equal target/actual and null avg_force_kg —
// typical manual-timer entries — collapsed to one fit point even when
// their manual loads differed, thinning exactly the small baseline
// windows the dedup exists to protect.
describe("freshFitReps de-dup key (set_num + manual_load_kg)", () => {
  const base = {
    date: "2026-06-15", hand: "L", grip: "Crusher",
    rep_num: 1, target_duration: 10, actual_time_s: 12,
    avg_force_kg: null,   // manual timer — no Tindeq reading
  };

  test("distinct manual loads on otherwise identical rep-1s both survive", () => {
    const out = freshFitReps([
      { ...base, manual_load_kg: 20 },
      { ...base, manual_load_kg: 24 },   // heavier second session, same times
    ]);
    expect(out.length).toBe(2);
  });

  test("rep-1s from different sets both survive", () => {
    const out = freshFitReps([
      { ...base, set_num: 1, manual_load_kg: 20 },
      { ...base, set_num: 2, manual_load_kg: 20 },
    ]);
    expect(out.length).toBe(2);
  });

  test("fully identical rows (the double-logging bug) still collapse", () => {
    const row = { ...base, set_num: 1, manual_load_kg: 20 };
    expect(freshFitReps([{ ...row }, { ...row }]).length).toBe(1);
  });
});
