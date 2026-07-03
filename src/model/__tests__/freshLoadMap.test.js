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

  test("cookedness no longer rescales the fresh-equivalent load (July 2026)", () => {
    // Cookedness disabled as a load rescaler: a maximally-cooked rep is
    // treated identically to a fresh one (its logged load, no de-cook).
    const cooked = buildFreshLoadMap([rep({ session_cooked: 10 })], { fatigueModel: model }).get(repKey(rep())).fresh;
    expect(cooked).toBeCloseTo(20, 1);
    expect(cooked).toBeLessThanOrEqual(SANE_MAX_KG);
  });

  test("a normal fresh rep is unchanged (cap doesn't bind)", () => {
    const h = [rep({ session_cooked: 0 })];
    expect(buildFreshLoadMap(h, { fatigueModel: model }).get(repKey(h[0])).fresh).toBeCloseTo(20, 1);
  });
});
