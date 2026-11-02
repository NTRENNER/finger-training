import {
  EMPHASIS_CYCLES, activePilot, pilotBlockOn, pilotEnrollment, pilotLabel, pilotRecommendation,
  pilotStep, validPilotEnrollment,
} from "../emphasisPilot.js";

const joined = pilotEnrollment("emphasis-2026-11", "active", new Date("2026-11-02T20:00:00Z"));
const rep = (date, grip, extra = {}) => ({ date, grip, hand: "L", set_num: 1, rep_num: 1,
  target_duration: 115, actual_time_s: 110, avg_force_kg: 20, ...extra });

test("enrollment is validated and only an active one turns the pilot on", () => {
  expect(validPilotEnrollment(joined)).toEqual(joined);
  expect(activePilot(joined)?.id).toBe("emphasis-2026-11");
  expect(activePilot(pilotEnrollment("emphasis-2026-11", "left"))).toBeNull();
  expect(validPilotEnrollment({ ...joined, pilot_id: "unknown" })).toBeNull();
  expect(validPilotEnrollment({ ...joined, status: "paused" })).toBeNull();
  expect(validPilotEnrollment(null)).toBeNull();
});

test("blocks follow the pre-registered calendar", () => {
  const pilot = activePilot(joined);
  expect(pilotBlockOn(pilot, "2026-11-01")).toBeNull();
  expect(pilotBlockOn(pilot, "2026-11-02")).toMatchObject({ label: "B", emphasis: "long", day: 1, days: 28 });
  expect(pilotBlockOn(pilot, "2026-11-29")).toMatchObject({ label: "B", day: 28 });
  expect(pilotBlockOn(pilot, "2026-11-30")).toMatchObject({ label: "A", emphasis: "short", day: 1, days: 28 });
  expect(pilotBlockOn(pilot, "2026-12-27")).toMatchObject({ label: "A", day: 28 });
  expect(pilotBlockOn(pilot, "2026-12-28")).toBeNull();
});

test("each grip starts its cycle on the first day of a block", () => {
  expect(pilotStep(joined, [], "Micro", "2026-11-02")).toMatchObject({
    block: "B", emphasis: "long", blockDay: 1, primary: true, step: 1, cycleLength: 8, zone: "strength",
  });
  expect(pilotStep(joined, [], "Crusher", "2026-11-02")).toMatchObject({ primary: false, cycleLength: 4, zone: "strength" });
  expect(pilotStep(joined, [], "Micro", "2026-11-30")).toMatchObject({ block: "A", zone: "max_strength" });
  expect(pilotLabel(pilotStep(joined, [], "Micro", "2026-11-06"))).toBe("Pilot · Long end · day 5 of 28");
});

test("only earlier training days in the block advance the step", () => {
  const history = [
    rep("2026-11-01", "Micro"),                                   // before the block
    rep("2026-11-03", "Micro"), rep("2026-11-03", "Micro", { hand: "R" }),
    rep("2026-11-04", "Micro"),                                   // consecutive days count
    rep("2026-11-05", "Micro", { force_recording: { session_protocol: { id: "peak_test", version: 2 } } }),
    rep("2026-11-05", "Crusher"),
  ];
  expect(pilotStep(joined, history, "Micro", "2026-11-05")).toMatchObject({ sessionsBefore: 2, step: 3, zone: "endurance" });
  // Today's own session leaves today's step unchanged.
  expect(pilotStep(joined, [...history, rep("2026-11-05", "Micro")], "Micro", "2026-11-05").step).toBe(3);
  expect(pilotStep(joined, history, "Crusher", "2026-11-06")).toMatchObject({ sessionsBefore: 1, zone: "strength_endurance" });
});

test("the cycle repeats once it is used up", () => {
  const history = ["2026-11-03", "2026-11-04", "2026-11-05", "2026-11-06"].map(d => rep(d, "Prime"));
  expect(pilotStep(joined, history, "Prime", "2026-11-07")).toMatchObject({ sessionsBefore: 4, step: 1, zone: "strength" });
  expect(EMPHASIS_CYCLES.long.other).toEqual(EMPHASIS_CYCLES.long.primary.slice(0, 4));
  expect(EMPHASIS_CYCLES.short.other).toEqual(EMPHASIS_CYCLES.short.primary.slice(0, 4));
});

test("no pilot step when not enrolled, outside the blocks, or on another grip", () => {
  expect(pilotStep(null, [], "Micro", "2026-11-05")).toBeNull();
  expect(pilotStep(joined, [], "Micro", "2026-11-01")).toBeNull();
  expect(pilotStep(joined, [], "Edge", "2026-11-05")).toBeNull();
});

test("the shown recommendation is the step's domain; cold-start grips keep the engine plan", () => {
  const engineRec = { zone: "power", T: 30, hand: "L", candidates: [{ zone: "power" }] };
  const step = pilotStep(joined, [], "Micro", "2026-11-03");
  const shown = pilotRecommendation(step, engineRec, { history: [], grip: "Micro" });
  expect(shown).toMatchObject({ zone: "strength", T: 115, pilot: step });
  expect(shown.peakTest).toBeUndefined();
  expect(pilotRecommendation(null, engineRec, { history: [], grip: "Micro" })).toBe(engineRec);
  const coldStart = { ...engineRec, coldStartStage: "upper", peakTest: true };
  expect(pilotRecommendation(step, coldStart, { history: [], grip: "Micro" })).toBe(coldStart);
});
