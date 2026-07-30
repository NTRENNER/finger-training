import { repCurveYMax } from "../RepCurveChart.jsx";

describe("repCurveYMax", () => {
  test("keeps a prescribed target above all results inside the visible domain", () => {
    const merged = [
      { rep: 1, forecasted: 130.3, actual: 130.3, prev: 107.3 },
      { rep: 2, forecasted: 44, actual: 40, prev: 52 },
    ];

    expect(repCurveYMax(merged, 160)).toBeCloseTo(176, 6);
  });

  test("still uses the highest observed value when it exceeds the target", () => {
    const merged = [
      { rep: 1, forecasted: 170, actual: 180, prev: 150 },
    ];

    expect(repCurveYMax(merged, 160)).toBeCloseTo(198, 6);
  });
});
