// Tests for src/model/fatigueBeta.js — per-grip β learner that
// replaces the per-zone shrinkage in perceivedFatigueLearning.

import {
  defaultFatigueModel,
  currentBeta,
  capacityMultiplier,
  updateBeta,
  DEFAULT_BETA,
  BETA_MAX,
} from "../fatigueBeta.js";

describe("defaultFatigueModel", () => {
  test("returns expected shape with default grips", () => {
    const m = defaultFatigueModel();
    expect(m.eta).toBeGreaterThan(0);
    expect(m.lambda).toBeGreaterThan(0);
    for (const g of ["Crusher", "Micro"]) {
      expect(m[g]).toBeDefined();
      expect(m[g].beta).toBeCloseTo(DEFAULT_BETA);
      expect(m[g].beta_prior).toBeCloseTo(DEFAULT_BETA);
      expect(m[g].n_obs).toBe(0);
      expect(m[g].last_update).toBeNull();
    }
  });

  test("custom grip list materializes those grips", () => {
    const m = defaultFatigueModel(["FullCrimp"]);
    expect(m.FullCrimp).toBeDefined();
    expect(m.Crusher).toBeUndefined();
  });
});

describe("currentBeta", () => {
  test("returns DEFAULT_BETA on null/undefined inputs", () => {
    expect(currentBeta(null, "Crusher")).toBeCloseTo(DEFAULT_BETA);
    expect(currentBeta({}, "Crusher")).toBeCloseTo(DEFAULT_BETA);
    expect(currentBeta(defaultFatigueModel(), null)).toBeCloseTo(DEFAULT_BETA);
  });

  test("clamps out-of-range β values", () => {
    expect(currentBeta({ Crusher: { beta: -0.5 } }, "Crusher")).toBe(0);
    expect(currentBeta({ Crusher: { beta:  5.0 } }, "Crusher")).toBe(BETA_MAX);
  });
});

describe("capacityMultiplier (cookedness disabled as a load rescaler, July 2026)", () => {
  test("returns 1.0 at cooked = 0 (fresh)", () => {
    const m = defaultFatigueModel();
    expect(capacityMultiplier(m, "Crusher", 0)).toBeCloseTo(1.0);
    expect(capacityMultiplier(m, "Micro",   0)).toBeCloseTo(1.0);
  });

  test("returns 1.0 when cooked is null/undefined", () => {
    const m = defaultFatigueModel();
    expect(capacityMultiplier(m, "Crusher", null)).toBeCloseTo(1.0);
    expect(capacityMultiplier(m, "Crusher", undefined)).toBeCloseTo(1.0);
  });

  test("returns 1.0 for ANY cookedness -- loads are no longer rescaled", () => {
    const m = { Crusher: { beta: 0.10 }, Micro: { beta: 0.5 } };
    for (const c of [0, 2, 4, 6, 8, 10]) {
      expect(capacityMultiplier(m, "Crusher", c)).toBe(1.0);
      expect(capacityMultiplier(m, "Micro",   c)).toBe(1.0);
    }
  });

  test("ignores beta entirely -- even a large beta doesn't move the load", () => {
    expect(capacityMultiplier({ Crusher: { beta: 0.5 } }, "Crusher", 10)).toBe(1.0);
    expect(capacityMultiplier(defaultFatigueModel(), "MysteryGrip", 5)).toBe(1.0);
  });
});

describe("updateBeta", () => {
  test("undershoot at high cooked raises β (engine wasn't aggressive enough)", () => {
    const m = defaultFatigueModel();
    // Prescribed 60s target, only held 30s, cooked = 8 → e = ln(0.5) < 0
    const m2 = updateBeta(m, "Crusher", 8, 30, 60);
    expect(m2.Crusher.beta).toBeGreaterThan(m.Crusher.beta);
  });

  test("overshoot at high cooked lowers β (engine over-corrected)", () => {
    const m = defaultFatigueModel();
    // Held 90s on a 60s target, cooked = 8 → e = ln(1.5) > 0
    const m2 = updateBeta(m, "Crusher", 8, 90, 60);
    expect(m2.Crusher.beta).toBeLessThan(m.Crusher.beta);
  });

  test("hitting target exactly leaves β at prior (only L2 step)", () => {
    const m = defaultFatigueModel();          // β = β_prior = 0.05
    const m2 = updateBeta(m, "Crusher", 6, 60, 60); // e = 0
    // β starts at prior, no SGD step, L2 step is also zero → unchanged
    expect(m2.Crusher.beta).toBeCloseTo(0.05, 6);
  });

  test("L2 anchor pulls β back toward prior with no SGD step", () => {
    const m = { eta: 0.02, lambda: 0.1, Crusher: { beta: 0.20, beta_prior: 0.05, n_obs: 5 } };
    // cooked = 0 means SGD step is zero (e * 0 = 0). Only L2 fires.
    const m2 = updateBeta(m, "Crusher", 0, 60, 60);
    expect(m2.Crusher.beta).toBeLessThan(0.20);
    expect(m2.Crusher.beta).toBeGreaterThan(0.05);
  });

  test("β is clamped to [0, BETA_MAX] under extreme residual", () => {
    // Build a model where a single huge negative residual would push β > 1
    const m = { eta: 10, lambda: 0, Crusher: { beta: 0.40, beta_prior: 0.05, n_obs: 0 } };
    // actual=1s vs target=600s, cooked=10 → e ≈ -6.4, sgd step = 10·(-6.4)·10 = -640 → β += 640
    const m2 = updateBeta(m, "Crusher", 10, 1, 600);
    expect(m2.Crusher.beta).toBeLessThanOrEqual(BETA_MAX);
    expect(m2.Crusher.beta).toBeGreaterThanOrEqual(0);
  });

  test("n_obs increments and last_update is set when inputs valid", () => {
    const m = defaultFatigueModel();
    const before = Date.now();
    const m2 = updateBeta(m, "Crusher", 5, 30, 45);
    const after = Date.now();
    expect(m2.Crusher.n_obs).toBe(1);
    const t = Date.parse(m2.Crusher.last_update);
    expect(t).toBeGreaterThanOrEqual(before - 10);
    expect(t).toBeLessThanOrEqual(after + 10);
  });

  test("invalid inputs are a no-op (β unchanged, no_obs unchanged)", () => {
    const m = defaultFatigueModel();
    expect(updateBeta(m, "Crusher", null, 30, 60).Crusher.beta).toBe(m.Crusher.beta);
    expect(updateBeta(m, "Crusher", 5,    0,  60).Crusher.beta).toBe(m.Crusher.beta);
    expect(updateBeta(m, "Crusher", 5,    30, 0 ).Crusher.beta).toBe(m.Crusher.beta);
    expect(updateBeta(m, "Crusher", -1,   30, 60).Crusher.beta).toBe(m.Crusher.beta);
    expect(updateBeta(m, "Crusher", 11,   30, 60).Crusher.beta).toBe(m.Crusher.beta);
    expect(updateBeta(m, null,      5,    30, 60).Crusher.beta).toBe(m.Crusher.beta);
  });

  test("update on one grip does not touch another grip", () => {
    const m = defaultFatigueModel();
    const m2 = updateBeta(m, "Crusher", 7, 20, 60);
    expect(m2.Micro.beta).toBe(m.Micro.beta);
    expect(m2.Micro.n_obs).toBe(m.Micro.n_obs);
  });

  test("repeated undershoots at the same cooked converge β upward", () => {
    let m = defaultFatigueModel();
    for (let i = 0; i < 20; i++) {
      m = updateBeta(m, "Micro", 6, 20, 40); // e = ln(0.5) each time
    }
    // β should have risen from 0.05 toward something larger
    expect(m.Micro.beta).toBeGreaterThan(0.05);
    expect(m.Micro.beta).toBeLessThanOrEqual(BETA_MAX);
    expect(m.Micro.n_obs).toBe(20);
  });
});
