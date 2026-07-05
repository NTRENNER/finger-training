import { perZoneBaselineAmps, improvementForAmps, SUPPORT_MIN_HOLD_FRAC } from "../baselines.js";
import { ZONE_REF_T } from "../zones.js";

describe("perZoneBaselineAmps", () => {
  const A = [10, 8, 6];       // placeholder amps (identity not important here)
  const dates = ["2026-05-01", "2026-05-20", "2026-06-10"];
  const ampsByDate = new Map([["2026-05-01", A], ["2026-05-20", A], ["2026-06-10", A]]);

  test("anchors an unbaselined zone to the earliest date that reached it", () => {
    // baseline reached only 85s; endurance refT=220 (need 132s), str-end 160 (need 96s).
    const maxHoldByDate = new Map([
      ["2026-05-01", 85],    // reaches neither
      ["2026-05-20", 170],   // first to reach str-end (96) AND endurance (132)
      ["2026-06-10", 230],
    ]);
    const out = perZoneBaselineAmps(dates, ampsByDate, maxHoldByDate, 85);
    expect(out.strength_endurance).toBe(A);   // earliest reaching = 2026-05-20
    expect(out.endurance).toBe(A);
    expect(out.max_strength).toBeUndefined(); // pooled baseline (85s) already covers short zones
  });

  test("omits a zone no date ever reached", () => {
    const maxHoldByDate = new Map([["2026-05-01", 85], ["2026-05-20", 100], ["2026-06-10", 100]]);
    const out = perZoneBaselineAmps(dates, ampsByDate, maxHoldByDate, 85);
    expect(out.strength_endurance).toBe(A);   // 100 >= 96
    expect(out.endurance).toBeUndefined();    // never reached 132
  });
});

describe("improvementForAmps with zoneRefAmps", () => {
  const cur = [12, 9, 7], base = [10, 8, 6], zref = [11, 8.5, 6.5];
  const smallBaseline = ZONE_REF_T.strength_endurance * SUPPORT_MIN_HOLD_FRAC - 1; // baseline can't reach str-end/end

  test("fills a previously-new zone from its own baseline; total ignores it", () => {
    const withRef = improvementForAmps(cur, base, smallBaseline, { endurance: zref });
    const without = improvementForAmps(cur, base, smallBaseline, null);
    expect(without.endurance).toBeNull();
    expect(typeof withRef.endurance).toBe("number");
    expect(withRef.total).toBe(without.total);   // per-zone gain not folded into headline
  });
});
