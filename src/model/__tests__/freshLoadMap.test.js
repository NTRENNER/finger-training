// Tests for the fresh-equivalent load cap in buildFreshLoadMap.
// See MAX_FRESH_INFLATION in prescription.js — closes the runaway where a
// maximally-cooked session blew a single rep's fresh-equivalent load (and
// thus the F-D curve fit / chart axis) up to ~20,000 kg (July 2026).
import { buildFreshLoadMap, repKey } from "../prescription.js";
import { SANE_MAX_KG } from "../load.js";

const rep = (over = {}) => ({
  id: "r1", session_id: "s1", grip: "Micro", hand: "L",
  set_num: 1, rep_num: 1, target_duration: 20, actual_time_s: 20,
  avg_force_kg: 20, rest_s: 0, ...over,
});

describe("buildFreshLoadMap fresh-equivalent cap", () => {
  const model = { Micro: { beta: 0.5 } }; // strong cookedness sensitivity

  test("a maximally-cooked rep can't produce a runaway fresh-equivalent", () => {
    // Uncapped: 20 / exp(-0.5*10) = 20 / 0.0067 ≈ 2985 kg.
    const h = [rep({ session_cooked: 10 })];
    const fresh = buildFreshLoadMap(h, { fatigueModel: model }).get(repKey(h[0])).fresh;
    expect(fresh).toBeLessThanOrEqual(20 * 3 + 1e-9); // ≤ 3× measured load
    expect(fresh).toBeLessThanOrEqual(SANE_MAX_KG);
    expect(fresh).toBeGreaterThan(20);                // still de-cooked upward, just bounded
  });

  test("a normal fresh rep is unchanged (cap doesn't bind)", () => {
    const h = [rep({ session_cooked: 0 })];
    expect(buildFreshLoadMap(h, { fatigueModel: model }).get(repKey(h[0])).fresh).toBeCloseTo(20, 1);
  });
});
