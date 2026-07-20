// Opt-in zone-scoped amplitude anchor (prescription opts.zoneAnchor).
// The curve SHAPE is always fit cross-zone; only the amplitude anchor is
// optionally scoped to the requested zone. Backtest + rationale for it
// staying opt-in: scripts/anchor-backtest.md.
import { prescription } from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";

describe("prescription zoneAnchor flag", () => {
  // referenceDate pins the 30-day anchor lookback to a fixed date (not
  // Date.now()) so the tests are clock-independent. Seeds (March) sit
  // before the lookback window — they feed the curve fit but can't win
  // the anchor sort; the April reps are the anchor candidates.
  const REF = "2026-04-15";
  const seed = [[5, 55], [15, 42], [45, 26], [120, 12], [200, 7]].map(([T, F], i) => ({
    hand: "L", grip: "Crusher", target_duration: T, rep_num: 1,
    actual_time_s: T, avg_force_kg: F, failed: true,
    date: `2026-03-0${i + 1}`, session_id: `seed${i}`,
  }));
  const priorsFor = (h) => buildThreeExpPriors(h.filter(r => r.date < REF));

  test("newer cross-zone rep vs older same-zone rep: zone anchor picks same-zone", () => {
    const sameZoneOld = { hand: "L", grip: "Crusher", target_duration: 5, rep_num: 1,
      actual_time_s: 5, avg_force_kg: 60, failed: true, date: "2026-04-02", session_id: "sz" };
    const crossZoneNew = { hand: "L", grip: "Crusher", target_duration: 200, rep_num: 1,
      actual_time_s: 200, avg_force_kg: 8, failed: true, date: "2026-04-10", session_id: "cz" };
    const history = [...seed, sameZoneOld, crossZoneNew];
    const priors = priorsFor(history);
    const cross = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors, referenceDate: REF });
    const zoned = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors, referenceDate: REF, zoneAnchor: true });
    expect(cross.anchor.date).toBe("2026-04-10");        // default: newest rep, any zone
    expect(zoned.anchor.date).toBe("2026-04-02");        // zone: older same-zone rep
    expect(zoned.anchor.T).toBe(5);
  });

  test("no same-zone history: zone anchor falls back to newest cross-zone", () => {
    const crossOnly = { hand: "L", grip: "Crusher", target_duration: 200, rep_num: 1,
      actual_time_s: 200, avg_force_kg: 8, failed: true, date: "2026-04-10", session_id: "cz" };
    const history = [...seed.filter(r => r.target_duration !== 5), crossOnly];
    const priors = priorsFor(history);
    const zoned = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors, referenceDate: REF, zoneAnchor: true });
    const cross = prescription(history, "L", "Crusher", 5, { threeExpPriors: priors, referenceDate: REF });
    expect(zoned.anchor).not.toBeNull();
    expect(zoned.anchor.date).toBe(cross.anchor.date);
  });

  test("retrospective: zone anchor uses the latest same-zone rep BEFORE referenceDate", () => {
    const history = [
      ...seed,
      { hand: "L", grip: "Crusher", target_duration: 5, rep_num: 1, actual_time_s: 5,
        avg_force_kg: 58, failed: true, date: "2026-04-02", session_id: "szPast" },
      { hand: "L", grip: "Crusher", target_duration: 5, rep_num: 1, actual_time_s: 5,
        avg_force_kg: 70, failed: true, date: "2026-05-01", session_id: "szFuture" },
    ];
    const priors = priorsFor(history);
    const zoned = prescription(history, "L", "Crusher", 5,
      { threeExpPriors: priors, referenceDate: REF, zoneAnchor: true });
    expect(zoned.anchor.date).toBe("2026-04-02");        // future 2026-05-01 excluded
    expect(zoned.anchor.date < REF).toBe(true);
  });
});
