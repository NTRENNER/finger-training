// Durable baseline: a PINNED baseline locks WHICH window is the baseline
// (its start date), but the amps must always be RE-FIT under the current
// model — never trusted from storage. A stored fit is only valid under the
// model version that produced it; once the model changes (e.g. the F-D
// slow-tau 180->480s change, or the cookedness-rescale removal) a frozen
// fit is compared against a "now" curve built under DIFFERENT assumptions,
// manufacturing phantom per-zone regressions. This is the bug Nathan hit:
// his Micro pin, fit at tau=180, read ~50% too strong at 115s once
// evaluated at tau=480, so real gains showed as -19%.
import { renderHook } from "@testing-library/react";
import { useGripFits } from "../useGripFits.js";
import { buildGripBaselines } from "../../model/baselines.js";
import { buildThreeExpPriors } from "../../model/threeExp.js";

const rep = (date, T, t, F) => ({
  grip: "Micro", hand: "L", date, rep_num: 1, set_num: 1,
  target_duration: T, actual_time_s: t, avg_force_kg: F,
});

// Baseline seed window: earliest 5 fresh reps across 3 distinct target
// durations; longest hold in the window is 85s -> maxHoldS should be 85.
// 85 gates strength_endurance(160) and endurance(220) but supports the
// shorter zones (85 >= 0.6*115). Later dates supply a distinct "now".
const D0 = "2026-04-20", D1 = "2026-04-23", D2 = "2026-06-01";
const history = [
  rep(D0, 10, 9, 18), rep(D0, 10, 8, 17), rep(D0, 40, 42, 12),
  rep(D0, 40, 40, 11), rep(D0, 85, 85, 7),          // 5th rep closes the window
  rep(D1, 40, 44, 12),
  rep(D2, 10, 10, 20), rep(D2, 40, 46, 13), rep(D2, 85, 88, 8),
];
const grips = ["Micro"];
const priors = buildThreeExpPriors(history);
const candidateAmps = buildGripBaselines(history, priors).Micro.amps;

// Legacy pin: DELIBERATELY wrong amps (as if fit under an old model), no
// maxHoldS. The date is valid so the window is rebuildable from history.
const legacyPin = { Micro: { date: D0, amps: [999, 999, 999] } };

const run = (pinned, hist = history) =>
  renderHook(() =>
    useGripFits({
      history: hist, threeExpPriors: priors, grips,
      fatigueModel: null,
      pinnedGripBaselines: pinned, onSavePinnedGripBaselines: () => {},
      pinnedPerHandBaselines: null, onSavePinnedPerHandBaselines: () => {},
      allowAutoPin: false,   // don't let auto-pin mutate; test the merge path
    })
  ).result.current;

describe("useGripFits — durable baseline re-fit", () => {
  it("ignores stored amps and re-fits the frozen window under the current model", () => {
    const { gripBaselines } = run(legacyPin);
    expect(gripBaselines.Micro.date).toBe(D0);          // window still locked to the pin
    expect(gripBaselines.Micro.amps).toEqual(candidateAmps); // re-fit, NOT [999,999,999]
    expect(gripBaselines.Micro.maxHoldS).toBe(85);      // derived from the re-fit window
  });

  it("gates unbaselined long zones to null (maxHoldS now reaches the gate)", () => {
    const imp = run(legacyPin).gripImprovement.Micro;
    expect(imp).toBeTruthy();
    expect(imp.strength_endurance).toBeNull();  // past the 85s reach -> "new"
    expect(imp.endurance).toBeNull();
    expect(typeof imp.strength).toBe("number"); // within reach -> a real number
  });

  it("falls back to the stored pin when the window can't be rebuilt", () => {
    // History lacking the seed window (only the pin's start date, <5 reps):
    // refit returns null, so the stored pin is preserved (best effort).
    const thin = [rep(D0, 10, 9, 18)];
    const { gripBaselines } = run({ Micro: { date: D0, amps: [12, 5, 3], maxHoldS: 77 } }, thin);
    expect(gripBaselines.Micro.amps).toEqual([12, 5, 3]);
    expect(gripBaselines.Micro.maxHoldS).toBe(77);
  });
});
