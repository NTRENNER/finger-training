// Anti-collapse extrapolation floor (July 2026). The three-exp F-D curve
// has no non-zero asymptote, so extrapolating it far past the longest
// hold the user has logged can decay to implausibly light loads (a 220s
// Micro target once collapsed to 2.5 kg). The floor caps how far the
// curve is trusted beyond the data. Kept in its own file so we don't
// churn the 900-line prescription.test.js.
import { prescription, EXTRAP_FLOOR_MULT } from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";

// Curve-supporting failures out to 120s (mirrors prescription.test.js's
// buildCurveHistory). Old dates -> unanchored-curve path, scale 1.
const buildCurveHistory = () => {
  const Ts = [7, 10, 30, 45, 60, 90, 120];
  const amps = [30, 12, 6], tau = [10, 30, 180];
  return Ts.map((T, i) => ({
    id: `r${i}`, hand: "L", grip: "Crusher", target_duration: T, rep_num: 1,
    actual_time_s: T, failed: true,
    avg_force_kg:
      amps[0] * Math.exp(-T / tau[0]) +
      amps[1] * Math.exp(-T / tau[1]) +
      amps[2] * Math.exp(-T / tau[2]),
    date: "2026-04-01", session_id: `s${i}`,
  }));
};

describe("anti-collapse extrapolation floor", () => {
  test("far extrapolation can't decay without bound", () => {
    const history = buildCurveHistory();
    const priors = buildThreeExpPriors(history);
    const near = prescription(history, "L", "Crusher", 300, { threeExpPriors: priors });
    const far  = prescription(history, "L", "Crusher", 600, { threeExpPriors: priors });
    // Longest hold is 120s -> cap at 1.5x = 180s; both 300s and 600s are
    // past it, so both floor at the SAME capped-duration load. Without
    // the floor, 600s would prescribe strictly less than 300s.
    expect(near.extrapFloored).toBe(true);
    expect(far.extrapFloored).toBe(true);
    expect(near.extrapolationBoundaryS).toBe(180);
    expect(far.value).toBe(near.value);
    expect(far.value).toBeGreaterThan(0);
  });

  test("stays inactive for in-range targets", () => {
    const history = buildCurveHistory();
    const priors = buildThreeExpPriors(history);
    const inRange = prescription(history, "L", "Crusher", 120, { threeExpPriors: priors });
    expect(inRange.extrapFloored).toBe(false); // 120s <= 1.5x longest hold
  });

  test("EXTRAP_FLOOR_MULT is exported and > 1", () => {
    expect(EXTRAP_FLOOR_MULT).toBeGreaterThan(1);
  });
});
