import { buildRepsVariantSeries } from "../workout-volume.js";

const DEF = { variants: ["Two-arm", "Feet-elevated", "Archer", "One-arm"] };

const sess = (date, sets, workout = "C") => ({
  date, workout, exercises: { trxRow: { sets } },
});
const set = (reps, variant, done = true) => ({ reps, variant, weight: "", done });

describe("buildRepsVariantSeries", () => {
  test("one point per session: total DONE reps + hardest ladder variant", () => {
    const log = [
      sess("2026-06-12", [set("5", "Archer"), set("6", "One-arm"), set("6", "Archer")]),
      sess("2026-06-19", [set("7", "One-arm"), set("7", "One-arm"), set("8-12", "One-arm", false)]),
    ];
    const out = buildRepsVariantSeries(log, "trxRow", DEF);
    expect(out).toHaveLength(2);
    expect(out[0]).toMatchObject({ date: "2026-06-12", reps: 17, variant: "One-arm", variantIdx: 3 });
    // undone set contributes nothing: 7 + 7, not 7 + 7 + 8
    expect(out[1].reps).toBe(14);
  });

  test("sessions with no done sets are skipped (weightless TRX regression)", () => {
    const log = [
      sess("2026-06-19", [set("7", "One-arm", false), set("7", "One-arm", false)]),
      sess("2026-07-02", [set("7", "One-arm"), set("7", "One-arm"), set("7", "One-arm")]),
    ];
    const out = buildRepsVariantSeries(log, "trxRow", DEF);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ date: "2026-07-02", reps: 21, variant: "One-arm" });
  });

  test("off-ladder variant label still surfaces; variantIdx null", () => {
    const out = buildRepsVariantSeries(
      [sess("2026-06-01", [set("8", "Weighted archer thing")])], "trxRow", DEF);
    expect(out[0].variant).toBe("Weighted archer thing");
    expect(out[0].variantIdx).toBeNull();
  });

  test("missing exercise, missing def variants, empty log", () => {
    expect(buildRepsVariantSeries([sess("2026-06-01", [set("8", "Two-arm")])], "nope", DEF)).toEqual([]);
    const out = buildRepsVariantSeries([sess("2026-06-01", [set("8", "Two-arm")])], "trxRow", {});
    expect(out[0]).toMatchObject({ reps: 8, variant: "Two-arm", variantIdx: null });
    expect(buildRepsVariantSeries([], "trxRow", DEF)).toEqual([]);
    expect(buildRepsVariantSeries(null, "trxRow", DEF)).toEqual([]);
  });

  test("sorts by date then completedAt", () => {
    const a = { ...sess("2026-06-12", [set("5", "Two-arm")]), completedAt: "2026-06-12T20:00:00Z" };
    const b = { ...sess("2026-06-12", [set("6", "Archer")]), completedAt: "2026-06-12T08:00:00Z" };
    const out = buildRepsVariantSeries([a, b], "trxRow", DEF);
    expect(out.map(p => p.reps)).toEqual([6, 5]);
  });

  test("unilateral set schema (leftReps/rightReps) counts both sides", () => {
    const uniSet = { done: true, leftReps: "6", rightReps: "7", variant: "Mid-shin" };
    const log = [{ date: "2026-06-20", workout: "B", exercises: { nordic: { sets: [uniSet] } } }];
    const out = buildRepsVariantSeries(log, "nordic", { variants: ["Knee-supported", "Mid-shin", "Ankle-supported"] });
    expect(out[0]).toMatchObject({ reps: 13, variant: "Mid-shin", variantIdx: 1 });
  });

  test("/side reps double per parseRepsCount convention", () => {
    const out = buildRepsVariantSeries([sess("2026-06-01", [set("5/side", "One-arm")])], "trxRow", DEF);
    expect(out[0].reps).toBe(10);
  });
});
