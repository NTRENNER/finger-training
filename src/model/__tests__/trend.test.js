import { linearTrendline } from "../trend.js";

describe("linearTrendline", () => {
  test("recovers an exact line", () => {
    const t = linearTrendline([2, 4, 6, 8]); // y = 2 + 2x
    expect(t).toEqual([2, 4, 6, 8]);
  });

  test("fits an upward trend through noise (positive slope)", () => {
    const t = linearTrendline([1, 5, 2, 8, 4, 11]);
    expect(t[t.length - 1]).toBeGreaterThan(t[0]);
  });

  test("returns null with fewer than 2 usable points", () => {
    expect(linearTrendline([])).toBeNull();
    expect(linearTrendline([5])).toBeNull();
    expect(linearTrendline([NaN, undefined])).toBeNull();
  });

  test("ignores non-finite gaps but still returns full-length output", () => {
    const t = linearTrendline([0, null, 2, null, 4]); // fits on 0,2,4 → slope 1
    expect(t).toHaveLength(5);
    expect(t[4]).toBeCloseTo(4, 6);
  });
});
