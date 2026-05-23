// Tests for the small pure helpers in src/lib/storage.js — the pin
// key builder and the legacy-pin migrator. The rest of storage.js is
// a thin wrapper around localStorage and not worth unit-testing here.

import { pyramidPinKey, migrateLegacyPyramidPins } from "../storage.js";

describe("pyramidPinKey", () => {
  test("boulder + indoor + commercial → full composite key", () => {
    expect(pyramidPinKey("boulder", "indoor", "commercial")).toBe("boulder|indoor|commercial");
  });

  test("boulder + indoor + moonboard distinct from commercial", () => {
    expect(pyramidPinKey("boulder", "indoor", "moonboard")).toBe("boulder|indoor|moonboard");
  });

  test("boulder + outdoor forces wall to 'all' (wall doesn't apply outdoors)", () => {
    expect(pyramidPinKey("boulder", "outdoor", "commercial")).toBe("boulder|outdoor|all");
  });

  test("rope discipline forces wall to 'all' (wall doesn't apply to ropes)", () => {
    expect(pyramidPinKey("top_rope", "indoor", "commercial")).toBe("top_rope|indoor|all");
    expect(pyramidPinKey("lead",     "outdoor", "moonboard")).toBe("lead|outdoor|all");
  });

  test("'all venues' boulder keeps the wall slot", () => {
    expect(pyramidPinKey("boulder", "all", "commercial")).toBe("boulder|all|commercial");
  });

  test("falsy inputs fall back to defaults", () => {
    expect(pyramidPinKey()).toBe("boulder|all|all");
    expect(pyramidPinKey("boulder")).toBe("boulder|all|all");
    expect(pyramidPinKey("boulder", "indoor")).toBe("boulder|indoor|all");
  });
});

describe("migrateLegacyPyramidPins", () => {
  test("converts legacy discipline-keyed pins to composite keys", () => {
    const legacy = { boulder: "V6", lead: "5.13a" };
    expect(migrateLegacyPyramidPins(legacy)).toEqual({
      "boulder|all|all": "V6",
      "lead|all|all":    "5.13a",
    });
  });

  test("passes through already-migrated composite keys", () => {
    const current = {
      "boulder|indoor|commercial": "V7",
      "boulder|outdoor|all":       "V6",
    };
    expect(migrateLegacyPyramidPins(current)).toEqual(current);
  });

  test("mixed legacy + composite is normalized", () => {
    const mixed = {
      "boulder":                   "V5", // legacy
      "boulder|indoor|moonboard":  "V4", // already migrated
    };
    expect(migrateLegacyPyramidPins(mixed)).toEqual({
      "boulder|all|all":           "V5",
      "boulder|indoor|moonboard":  "V4",
    });
  });

  test("drops falsy values and bad keys", () => {
    const bad = { boulder: "V6", "": "junk", "lead|all|all": null };
    expect(migrateLegacyPyramidPins(bad)).toEqual({ "boulder|all|all": "V6" });
  });

  test("returns {} for empty / null / non-object", () => {
    expect(migrateLegacyPyramidPins(null)).toEqual({});
    expect(migrateLegacyPyramidPins(undefined)).toEqual({});
    expect(migrateLegacyPyramidPins("string")).toEqual({});
    expect(migrateLegacyPyramidPins({})).toEqual({});
  });
});
