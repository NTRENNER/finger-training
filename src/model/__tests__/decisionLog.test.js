import { buildSessionDecision, DECISION_LOG_VERSION } from "../decisionLog.js";
import { coachingRecommendationContinuous } from "../coaching.js";
import { buildThreeExpPriors, CURVE_MODEL_VERSION, THREE_EXP_TAUS } from "../threeExp.js";
import { RECOMMENDER_VERSION } from "../coaching.js";
import { PROGRESSION_VERSION } from "../densityLadder.js";

const F = T => 30 * Math.exp(-T / 10) + 12 * Math.exp(-T / 30) + 6 * Math.exp(-T / 480);
const history = Array.from({ length: 8 }, (_, day) => {
  const date = `2026-07-${String(day + 1).padStart(2, "0")}`;
  const T = [30, 70, 115, 160][day % 4];
  return ["L", "R"].map(hand => ({
    id: `${date}-${hand}`, session_id: date, session_started_at: `${date}T08:00:00Z`, created_at: `${date}T08:05:00Z`,
    date, grip: "Crusher", hand, set_num: 1, rep_num: 1, target_duration: T, actual_time_s: T,
    avg_force_kg: F(T) * (hand === "L" ? 1 : 0.95), failure_valid: true,
  }));
}).flat();
const threeExpPriors = buildThreeExpPriors(history);
const rec = coachingRecommendationContinuous(history, "Crusher", { threeExpPriors, today: "2026-07-10" });

test("the engine reports every domain and hand's best candidate without changing its pick", () => {
  expect(rec.candidates.length).toBeGreaterThan(4);
  expect(rec.candidates[0]).toMatchObject({ zone: rec.zone, hand: rec.hand });
  expect(new Set(rec.candidates.map(c => `${c.zone}|${c.hand}`)).size).toBe(rec.candidates.length);
});

test("a decision records the recommendation, alternatives, selection and curve", () => {
  const ladder = { decision: "advance", reps: 5, basis: { overshootHands: [], shortfallHands: [], boundedByHand: {}, incomplete: false } };
  const decision = buildSessionDecision({
    grip: "Crusher", history, threeExpPriors, rec, overridden: true, source: "ladder", ladder,
    selected: { zone: "strength", t_s: 115, reps: 5, rest_s: 20, sets: 1, load_by_hand: { L: 20.04, R: 19.96 } },
  });
  expect(decision).toMatchObject({
    version: DECISION_LOG_VERSION,
    versions: { curve: CURVE_MODEL_VERSION, recommender: RECOMMENDER_VERSION, progression: PROGRESSION_VERSION },
    grip: "Crusher", overridden: true, plan_source: "ladder",
    evidence_cutoff: { date: "2026-07-08", created_at: "2026-07-08T08:05:00Z", grip_reps: 16 },
    recommended: { zone: rec.zone, t_s: rec.T, hand: rec.hand },
    selected: { zone: "strength", t_s: 115, load_by_hand: { L: 20, R: 20 } },
    constraints: { ladder_decision: "advance", ladder_reps: 5 },
    curve: { taus: [...THREE_EXP_TAUS] },
  });
  // One alternative per other domain: that domain's best candidate.
  const otherZones = new Set(rec.candidates.map(c => c.zone).filter(z => z !== rec.zone));
  expect(decision.alternatives.map(a => a.zone).sort()).toEqual([...otherZones].sort());
  for (const alt of decision.alternatives) {
    expect(alt.score).toBe(Math.max(...rec.candidates.filter(c => c.zone === alt.zone).map(c => Math.round(c.score * 1000) / 1000)));
  }
  expect(decision.pilot).toBeNull();
  expect(decision.recommended.terms).toEqual(expect.objectContaining({ residual: expect.any(Number), coverage: expect.any(Number) }));
  for (const hand of ["L", "R"]) {
    expect(decision.curve.by_hand[hand]).toMatchObject({ amps: expect.any(Array), curve_load_kg: expect.any(Number),
      bounds: expect.objectContaining({ peak_capped: expect.any(Boolean) }) });
  }
  // Stored on every rep: keep it small and plain.
  const json = JSON.stringify(decision);
  expect(JSON.parse(json)).toEqual(decision);
  expect(json.length).toBeLessThan(4000);
});

test("a decision without an engine recommendation still records the selection", () => {
  const decision = buildSessionDecision({ grip: "Micro", history: [], source: "curve",
    selected: { zone: "power", t_s: 30, reps: 4, rest_s: 20, sets: 1, load_by_hand: null } });
  expect(decision).toMatchObject({ recommended: null, alternatives: [], evidence_cutoff: null,
    selected: { zone: "power", load_by_hand: null }, constraints: {} });
});

test("under the emphasis pilot the decision keeps the engine's pick and records the step", () => {
  const pilot = { pilotId: "emphasis-2026-11", version: 1, block: "B", emphasis: "long", blockDay: 3,
    blockDays: 28, primary: false, sessionsBefore: 1, step: 2, cycleLength: 4, zone: "strength_endurance" };
  const decision = buildSessionDecision({ grip: "Crusher", history, threeExpPriors, rec, pilot, source: "curve",
    selected: { zone: "strength_endurance", t_s: 160, reps: 3, rest_s: 20, sets: 1, load_by_hand: null } });
  expect(decision.recommended).toMatchObject({ zone: rec.zone, t_s: rec.T });
  expect(decision.pilot).toEqual({ id: "emphasis-2026-11", version: 1, block: "B", emphasis: "long",
    block_day: 3, step: 2, cycle_length: 4, zone: "strength_endurance", sessions_before: 1 });
  expect(decision.overridden).toBe(false);
});
