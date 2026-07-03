// Regression: a legacy PINNED baseline (frozen before maxHoldS existed,
// or by the old auto-pin that only stored {date, amps}) must have its
// maxHoldS BACKFILLED from the freshly-computed candidate. Without the
// backfill, gripBaselines[grip].maxHoldS is undefined, the Curve-
// Improvement gate (improvementForAmps) never fires for any pinned grip,
// and unbaselined long zones (Str-End/End past the baseline's reach)
// render real — often negative — deltas instead of "new". This is the
// bug Nathan hit: his Micro pin predated the field, so endurance read
// as a regression on a curve he'd never actually baselined.
import { renderHook } from "@testing-library/react";
import { useGripFits } from "../useGripFits.js";
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

// Legacy pin: no maxHoldS (what the old auto-pin persisted).
const legacyPin = { Micro: { date: D0, amps: [12, 5, 3] } };

const run = (pinned) =>
  renderHook(() =>
    useGripFits({
      history, threeExpPriors: priors, grips,
      fatigueModel: null,
      pinnedGripBaselines: pinned, onSavePinnedGripBaselines: () => {},
      pinnedPerHandBaselines: null, onSavePinnedPerHandBaselines: () => {},
      allowAutoPin: false,   // don't let auto-pin mutate; test the merge path
    })
  ).result.current;

describe("useGripFits — legacy pin maxHoldS backfill", () => {
  it("backfills maxHoldS onto a pinned baseline that lacks it", () => {
    const { gripBaselines } = run(legacyPin);
    // The pin's amps/date are preserved (pinned still wins the frame)...
    expect(gripBaselines.Micro.date).toBe(D0);
    expect(gripBaselines.Micro.amps).toEqual([12, 5, 3]);
    // ...but maxHoldS is now populated from the candidate window (85s).
    expect(gripBaselines.Micro.maxHoldS).toBe(85);
  });

  it("gates unbaselined long zones to null once maxHoldS is present", () => {
    const { gripImprovement } = run(legacyPin);
    const imp = gripImprovement.Micro;
    expect(imp).toBeTruthy();
    // Past the baseline's 85s reach -> "new" (null), not a real delta.
    expect(imp.strength_endurance).toBeNull();
    expect(imp.endurance).toBeNull();
    // Within reach -> a real number.
    expect(typeof imp.strength).toBe("number");
  });

  it("respects a pin that already carries maxHoldS (no clobber)", () => {
    const { gripBaselines } = run({ Micro: { date: D0, amps: [12, 5, 3], maxHoldS: 300 } });
    expect(gripBaselines.Micro.maxHoldS).toBe(300);
  });
});
