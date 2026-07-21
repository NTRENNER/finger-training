import {
  fitEnduranceTail, enduranceTailFit, enduranceCeilingKg,
  TAIL_B_PRIOR, TAIL_MIN_T, CEIL_MIN_T, CEIL_MARGIN,
} from "../enduranceTail.js";

const mk = (over) => ({
  hand: "L", grip: "Micro", rep_num: 1, set_num: 1,
  actual_time_s: 160, avg_force_kg: 6, date: "2026-06-01", ...over,
});

describe("fitEnduranceTail", () => {
  test("recovers a clean power law a·T^-b", () => {
    const a = 50, b = 0.4;
    const pts = [30, 45, 60, 90, 120, 160, 220].map(T => ({ T, F: a * T ** (-b) }));
    const f = fitEnduranceTail(pts);
    // Exact power-law data → shrinkage barely moves it (prior is close too).
    expect(f.b).toBeGreaterThan(0.35);
    expect(f.b).toBeLessThan(0.45);
    expect(f.a * 160 ** (-f.b)).toBeCloseTo(a * 160 ** (-b), 0);
  });

  test("shrinks the exponent toward the prior when data is sparse/steep", () => {
    // Two points implying a very steep slope; shrinkage pulls b toward 0.45.
    const pts = [{ T: 40, F: 20 }, { T: 45, F: 6 }, { T: 50, F: 5 }, { T: 60, F: 4.8 }, { T: 200, F: 4 }];
    const f = fitEnduranceTail(pts);
    expect(f.b).toBeGreaterThan(0.2);
    expect(f.b).toBeLessThan(1.2);
  });

  test("returns null without enough points or duration spread", () => {
    expect(fitEnduranceTail([{ T: 60, F: 8 }])).toBeNull();
    expect(fitEnduranceTail([50, 55, 60, 65, 70].map(T => ({ T: 60, F: 8 })))).toBeNull(); // one duration
  });
});

describe("enduranceTailFit — data hygiene", () => {
  const base = [
    mk({ actual_time_s: 45, avg_force_kg: 12, date: "2026-05-01" }),
    mk({ actual_time_s: 60, avg_force_kg: 10, date: "2026-05-05" }),
    mk({ actual_time_s: 120, avg_force_kg: 7, date: "2026-05-10" }),
    mk({ actual_time_s: 160, avg_force_kg: 6, date: "2026-05-15" }),
    mk({ actual_time_s: 200, avg_force_kg: 5.5, date: "2026-05-20" }),
  ];
  test("fits from measured fresh failures", () => {
    expect(enduranceTailFit(base, "L", "Micro")).not.toBeNull();
  });
  test("ignores manual/spring reps (no avg_force)", () => {
    const withManual = [...base,
      mk({ actual_time_s: 250, avg_force_kg: null, manual_load_kg: 12, date: "2026-05-22" })];
    const f1 = enduranceTailFit(base, "L", "Micro");
    const f2 = enduranceTailFit(withManual, "L", "Micro");
    expect(f2.a).toBeCloseTo(f1.a, 6);   // manual rep did not enter the fit
    expect(f2.b).toBeCloseTo(f1.b, 6);
  });
  test("excludes short (<30s) reps and respects referenceDate", () => {
    const withShort = [...base, mk({ actual_time_s: 5, avg_force_kg: 30, date: "2026-05-02" })];
    const f = enduranceTailFit(withShort, "L", "Micro");
    const fBase = enduranceTailFit(base, "L", "Micro");
    expect(f.n).toBe(fBase.n); // the 5s rep is not counted
    // referenceDate excludes reps on/after it — dropping the 05-15 + 05-20
    // holds leaves only 3 measured tail points, too few to fit → null.
    expect(enduranceTailFit(base, "L", "Micro", "2026-05-11")).toBeNull();
  });
});

describe("enduranceCeilingKg", () => {
  const hist = [
    mk({ actual_time_s: 45, avg_force_kg: 12, date: "2026-05-01" }),
    mk({ actual_time_s: 90, avg_force_kg: 8.5, date: "2026-05-05" }),
    mk({ actual_time_s: 120, avg_force_kg: 7.2, date: "2026-05-10" }),
    mk({ actual_time_s: 160, avg_force_kg: 6.3, date: "2026-05-15" }),
    mk({ actual_time_s: 210, avg_force_kg: 5.6, date: "2026-05-20" }),
  ];
  test("null below CEIL_MIN_T (short/mid targets untouched)", () => {
    expect(enduranceCeilingKg(hist, "L", "Micro", 30)).toBeNull();
    expect(enduranceCeilingKg(hist, "L", "Micro", CEIL_MIN_T - 1)).toBeNull();
  });
  test("returns tail × margin at a long target, near demonstrated capacity", () => {
    const c = enduranceCeilingKg(hist, "L", "Micro", 160);
    expect(c).toBeGreaterThan(5);
    expect(c).toBeLessThan(9);   // not the inflated ~10 the anchor would give
  });
  test("null when the tail can't be fit", () => {
    expect(enduranceCeilingKg([hist[0]], "L", "Micro", 160)).toBeNull();
  });
});
