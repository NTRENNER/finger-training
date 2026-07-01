// Tests for capLoad — the prescription's physical-ceiling backstop.
// See src/model/prescription.js. capLoad closes the "no recent peak →
// uncapped short-T extrapolation" hole that let a 974 kg load be written.
import { capLoad } from "../prescription.js";
import { SANE_MAX_KG } from "../load.js";

describe("capLoad", () => {
  test("with a recent measured peak, that peak is the ceiling", () => {
    expect(capLoad(300, 76.9)).toBe(76.9);
    expect(capLoad(50, 76.9)).toBe(50);        // under the cap → unchanged
  });
  test("with NO recent peak, falls back to SANE_MAX_KG (closes the 974 kg hole)", () => {
    expect(capLoad(974.2, null)).toBe(SANE_MAX_KG);
    expect(capLoad(284.3, null)).toBe(SANE_MAX_KG);
    expect(capLoad(45, null)).toBe(45);        // normal value → unchanged
  });
  test("explicit absMax override is honoured", () => {
    expect(capLoad(120, null, 100)).toBe(100);
  });
});
