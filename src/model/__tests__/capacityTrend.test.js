import { buildCapacityChanges } from "../capacityTrend.js";

describe("buildCapacityChanges", () => {
  test("compares capacity ratios rather than baseline percentage points", () => {
    const rows = [
      { date: "2026-06-01", Crusher_pct: 20 },
      { date: "2026-06-29", Crusher_pct: 25 },
    ];

    expect(buildCapacityChanges(rows, ["Crusher"])).toEqual([{
      grip: "Crusher",
      changePct: 4.2,
      fromDate: "2026-06-01",
      toDate: "2026-06-29",
    }]);
  });

  test("uses the last known state on or before the 28-day cutoff", () => {
    const rows = [
      { date: "2026-05-20", Micro_pct: 10 },
      { date: "2026-06-02", Micro_pct: 15 },
      { date: "2026-07-01", Micro_pct: 5 },
    ];

    expect(buildCapacityChanges(rows, ["Micro"])[0]).toMatchObject({
      changePct: -8.7,
      fromDate: "2026-06-02",
      toDate: "2026-07-01",
    });
  });

  test("omits grips without a full comparison window", () => {
    const rows = [
      { date: "2026-06-20", Crusher_pct: 0, Micro_pct: 0 },
      { date: "2026-07-01", Crusher_pct: 4, Micro_pct: 2 },
    ];

    expect(buildCapacityChanges(rows, ["Crusher", "Micro"])).toEqual([]);
  });

  test("does not present an old training block as the current 28-day trend", () => {
    const rows = [
      { date: "2026-04-01", Crusher_pct: 0 },
      { date: "2026-05-01", Crusher_pct: 10 },
    ];

    expect(buildCapacityChanges(rows, ["Crusher"], 28, "2026-07-23")).toEqual([]);
  });

  test("handles multiple grips independently", () => {
    const rows = [
      { date: "2026-06-01", Crusher_pct: 0, Micro_pct: null },
      { date: "2026-06-03", Crusher_pct: null, Micro_pct: 10 },
      { date: "2026-06-08", Crusher_pct: 3, Micro_pct: null },
      { date: "2026-07-01", Crusher_pct: null, Micro_pct: 21 },
      { date: "2026-07-06", Crusher_pct: 8, Micro_pct: null },
    ];

    expect(buildCapacityChanges(rows, ["Crusher", "Micro"])).toEqual([
      expect.objectContaining({ grip: "Crusher", changePct: 4.9, fromDate: "2026-06-08" }),
      expect.objectContaining({ grip: "Micro", changePct: 10 }),
    ]);
  });
});
