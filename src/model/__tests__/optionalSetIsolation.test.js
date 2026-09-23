// Optional sets are volume the athlete chose to add. They are evidence
// about tolerance and they must never move a fresh-capacity number.
//
// The first version of this file checked three surfaces. That was not
// enough: probing every prescription-facing output found three more that
// still read optional sets — the density ladder (pinned load fell
// 31 kg → 14 kg and the rung 5 → 4), the peak cap (44 → 99 kg), and the
// endurance ceiling (13.4 → 7.9 kg, and that ceiling BOUNDS long
// prescriptions). The list below is the point of the file: a surface that
// is not in it is a surface nobody is checking.
//
// This cannot be caught by `npm run replay`. No rep in the recorded
// history has set_num > 1, so the real-history harness is blind to the
// whole feature and these assertions are the only guard it has.

import { freshFitReps } from "../load.js";
import {
  prescription, demonstratedCapacityKg, bestAvailablePeakMeasurement,
  recentBestPeakKg, historicalBestPeakKg, loadBounds,
} from "../prescription.js";
import { enduranceCeilingKg, enduranceTailFit } from "../enduranceTail.js";
import { computeDensityLadder } from "../densityLadder.js";
import { coachingRecommendationContinuous } from "../coaching.js";
import { buildThreeExpPriors } from "../threeExp.js";
import { buildGripBaselines } from "../baselines.js";

const REF = "2026-08-01";

// A spread of first sets across the curve, three reps each.
const firstSets = [[5, 42], [30, 31], [70, 23], [115, 18], [160, 14], [220, 11]]
  .flatMap(([target_duration, avg_force_kg], i) => [1, 2, 3].map(rep_num => ({
    id: `first-${i}-${rep_num}`, session_id: `s${i}`, date: `2026-07-${10 + i}`,
    grip: "Crusher", hand: "L", set_num: 1, rep_num,
    target_duration, actual_time_s: rep_num === 1 ? target_duration : target_duration * 0.7,
    avg_force_kg, peak_force_kg: avg_force_kg + 2,
    failure_valid: true, rest_s: 120, load_provenance: "measured_force",
  })));

// Optional sets: deliberately fatigued average force. A second variant
// carries an implausibly high PEAK, because a spike on the opening pull
// of a light set is exactly how a fatigued set can look strong.
const fatiguedOptional = firstSets.map((r, i) => ({
  ...r, id: `opt-${i}`, set_num: 2,
  avg_force_kg: r.avg_force_kg * 0.45, peak_force_kg: r.avg_force_kg * 0.45 + 1,
}));
const highPeakOptional = firstSets.map((r, i) => ({
  ...r, id: `peak-${i}`, set_num: 3,
  avg_force_kg: r.avg_force_kg * 0.45, peak_force_kg: 99,
}));

const BASE = firstSets;
const WITH_OPTIONAL = [...firstSets, ...fatiguedOptional, ...highPeakOptional];

const priors = buildThreeExpPriors(firstSets);

// Every fresh-capacity surface the engine exposes. Each must return the
// same answer whether or not optional sets are present.
const SURFACES = {
  "curve fit basis": h => freshFitReps(h).map(r => r.id),
  "three-exp priors": h => buildThreeExpPriors(h),
  "grip baselines": h => buildGripBaselines(h, buildThreeExpPriors(h))?.Crusher?.amps,
  "prescription @70s": h => prescription(h, "L", "Crusher", 70, { threeExpPriors: priors })?.value,
  "prescription @220s": h => prescription(h, "L", "Crusher", 220, { threeExpPriors: priors })?.value,
  "prescription potential": h => prescription(h, "L", "Crusher", 70, { threeExpPriors: priors })?.potential,
  "capacity floor": h => demonstratedCapacityKg(h, "L", "Crusher", 70, REF),
  "recent best peak": h => recentBestPeakKg(h, "L", "Crusher", REF),
  "historical best peak": h => historicalBestPeakKg(h, "L", "Crusher", REF),
  "best available peak": h => bestAvailablePeakMeasurement(h, "L", "Crusher", REF),
  "endurance tail fit": h => enduranceTailFit(h, "L", "Crusher", REF),
  "endurance ceiling @220s": h => enduranceCeilingKg(h, "L", "Crusher", 220, REF),
  // Value fields only: loadBounds also returns capValue/wasEnduranceCeiled
  // as closures, and two closure instances never compare equal.
  "load bounds @70s": h => {
    const { peakCapKg, peakCapStale, floorKg, endCeilKg } =
      loadBounds(h, "L", "Crusher", 70, { referenceDate: REF });
    return { peakCapKg, peakCapStale, floorKg, endCeilKg };
  },
  "load bounds @220s": h => {
    const { peakCapKg, peakCapStale, floorKg, endCeilKg } =
      loadBounds(h, "L", "Crusher", 220, { referenceDate: REF });
    return { peakCapKg, peakCapStale, floorKg, endCeilKg };
  },
  "coaching recommendation": h =>
    coachingRecommendationContinuous(h, "Crusher", { today: REF, hand: "L" })?.loadKg,
};

describe("optional sets never move a fresh-capacity number", () => {
  test.each(Object.keys(SURFACES))("%s", name => {
    expect(SURFACES[name](WITH_OPTIONAL)).toEqual(SURFACES[name](BASE));
  });

  test("the surfaces above are live, not null on both sides", () => {
    // Without this the whole suite could pass by returning undefined
    // everywhere, which is how an isolation test quietly stops testing.
    // freshFitReps keeps rep 1 of set 1, so six sessions give six points.
    const openers = firstSets.filter(r => r.rep_num === 1).length;
    expect(openers).toBeGreaterThan(0);
    expect(freshFitReps(BASE).length).toBe(openers);
    expect(prescription(BASE, "L", "Crusher", 70, { threeExpPriors: priors })?.value)
      .toBeGreaterThan(0);
    expect(bestAvailablePeakMeasurement(BASE, "L", "Crusher", REF)?.kg).toBeGreaterThan(0);
    expect(loadBounds(BASE, "L", "Crusher", 70, { referenceDate: REF }).peakCapKg)
      .toBeGreaterThan(0);
    expect(enduranceTailFit(BASE, "L", "Crusher", REF)).not.toBeNull();
  });
});

// The density ladder pins the NEXT session's load, rep count, and progression
// decision, so it is the most direct route from an optional set to a fresh
// prescription. Every one of those outputs must come from set 1.
describe("the density ladder ignores optional sets", () => {
  const rep = over => ({
    grip: "Crusher", hand: "L", session_id: "ladder", date: "2026-07-20",
    target_duration: 30, avg_force_kg: 31, peak_force_kg: 33, failure_valid: true,
    rest_s: 120, load_provenance: "measured_force", ...over,
  });
  const set1 = [1, 2, 3, 4].map(n => rep({
    id: `L1-${n}`, set_num: 1, rep_num: n,
    actual_time_s: n === 1 ? 30 : 30 * (1 - 0.18 * (n - 1)),
  }));
  const optionalSet = [1, 2, 3].map(n => rep({
    id: `L2-${n}`, set_num: 2, rep_num: n, avg_force_kg: 14, peak_force_kg: 46,
    actual_time_s: 30 * (0.75 - 0.15 * (n - 1)),
  }));
  const ladder = h => computeDensityLadder(h, "Crusher", "power", { expectedHands: ["L"] });

  test("the pinned load comes from set 1, not from a lighter optional set", () => {
    expect(ladder(set1)?.loadByHand?.L).toBeGreaterThan(0);
    expect(ladder([...set1, ...optionalSet])?.loadByHand?.L)
      .toBe(ladder(set1)?.loadByHand?.L);
  });

  test("the rung comes from set 1, so extra volume cannot cost a rep", () => {
    const base = ladder(set1);
    expect(base?.reps).toBeGreaterThan(0);
    expect(ladder([...set1, ...optionalSet])?.reps).toBe(base?.reps);
  });

  test("a heavier optional set cannot inflate the pin either", () => {
    const heavy = optionalSet.map(r => ({ ...r, avg_force_kg: 60, peak_force_kg: 62 }));
    expect(ladder([...set1, ...heavy])?.loadByHand?.L).toBe(ladder(set1)?.loadByHand?.L);
  });

  test("a collapsed optional set cannot down-step a strong set 1", () => {
    const strongSet1 = [30, 25, 20, 15].map((actual_time_s, i) => rep({
      id: `strong-${i}`, set_num: 1, rep_num: i + 1, actual_time_s,
    }));
    const collapsedOptional = [20, 8, 3].map((actual_time_s, i) => rep({
      id: `collapsed-${i}`, set_num: 2, rep_num: i + 1,
      avg_force_kg: 14, peak_force_kg: 46, actual_time_s,
    }));
    const pick = result => ({
      decision: result?.decision,
      reps: result?.reps,
      loadByHand: result?.loadByHand,
      lastRepSec: result?.basis?.lastRepSec,
      collapseByHand: result?.basis?.collapseByHand,
    });
    const base = ladder(strongSet1);
    expect(base?.decision).toBe("advance");
    expect(pick(ladder([...strongSet1, ...collapsedOptional]))).toEqual(pick(base));
  });

  test("an interrupted optional rep cannot invalidate the set-1 ladder", () => {
    const interrupted = optionalSet.map((r, i) => i === 1
      ? { ...r, failure_valid: false, end_reason: "equipment_interruption" }
      : r);
    expect(ladder([...set1, ...interrupted])).toEqual(ladder(set1));
  });
});

describe("legacy and null set numbers stay first-set evidence", () => {
  test("rows written before set_num existed are not silently discarded", () => {
    const legacy = firstSets.map(({ set_num, ...r }) => ({ ...r, id: `legacy-${r.id}` }));
    expect(freshFitReps(legacy).length).toBe(freshFitReps(firstSets).length);
    expect(prescription(legacy, "L", "Crusher", 70, { threeExpPriors: priors })?.value)
      .toBe(prescription(firstSets, "L", "Crusher", 70, { threeExpPriors: priors })?.value);
  });
});
