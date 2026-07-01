// Tests for src/model/load.js — sanity guard + load fallback chain.
import { sane, SANE_MAX_KG, effectiveLoad, prescribedLoad } from "../load.js";

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
