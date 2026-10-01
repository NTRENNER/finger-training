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

  test("fatigue reports never manufacture fresh force", () => {
    const cooked = buildFreshLoadMap([rep({ session_cooked: 10 })]).get(repKey(rep())).fresh;
    expect(cooked).toBe(20);
    expect(cooked).toBeLessThanOrEqual(20 * 3);          // MAX_FRESH_INFLATION guard
    expect(cooked).toBeLessThanOrEqual(SANE_MAX_KG);
  });

  test("a normal fresh rep is unchanged (cap doesn't bind)", () => {
    const h = [rep({ session_cooked: 0 })];
    expect(buildFreshLoadMap(h).get(repKey(h[0])).fresh).toBeCloseTo(20, 1);
  });
});
