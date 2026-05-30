// Tests for src/lib/climbing-grades.js — focused on afaVSum, the
// YDS → V-equivalent conversion that powers the route v-sum chart.

import { afaVSum, AFA_VSUM_BY_YDS, YDS_GRADES } from "../climbing-grades.js";

describe("afaVSum (YDS → afa v-sum)", () => {
  test("matches the conversion chart at key anchors", () => {
    expect(afaVSum("5.6")).toBe(0);
    expect(afaVSum("5.8")).toBe(0);
    expect(afaVSum("5.9")).toBe(0.5);
    expect(afaVSum("5.10a")).toBe(0.5);
    expect(afaVSum("5.10b")).toBe(1);
    expect(afaVSum("5.11d")).toBe(4);
    expect(afaVSum("5.12c")).toBe(6);
    expect(afaVSum("5.13a")).toBe(7.5);
    expect(afaVSum("5.14d")).toBe(12);
  });

  test("monotonically non-decreasing across the YDS scale", () => {
    let prev = -Infinity;
    for (const g of YDS_GRADES) {
      const v = afaVSum(g);
      expect(v).not.toBeNull();
      expect(v).toBeGreaterThanOrEqual(prev);
      prev = v;
    }
  });

  test("normalizes case (chart shows some uppercase subgrades)", () => {
    expect(afaVSum("5.12D")).toBe(afaVSum("5.12d"));
  });

  test("returns null for non-route / unknown grades", () => {
    expect(afaVSum("V5")).toBeNull();    // boulder grade → not a route
    expect(afaVSum("")).toBeNull();
    expect(afaVSum(null)).toBeNull();
    expect(afaVSum("5.15a")).toBeNull(); // off the chart
  });

  test("covers every YDS grade the app can log", () => {
    for (const g of YDS_GRADES) {
      expect(g in AFA_VSUM_BY_YDS).toBe(true);
    }
  });
});
