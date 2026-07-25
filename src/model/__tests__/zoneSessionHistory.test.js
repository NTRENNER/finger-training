import { buildZoneSessionHistory } from "../zoneSessionHistory.js";

const rep = (sessionId, date, target, actual, load, over = {}) => ({
  session_id: sessionId,
  date,
  grip: "Crusher",
  hand: "L",
  set_num: 1,
  rep_num: 1,
  target_duration: target,
  actual_time_s: actual,
  avg_force_kg: load,
  ...over,
});

test("groups prescribed-zone sessions and reports workout-to-workout changes", () => {
  const history = [
    rep("old", "2026-06-01", 220, 190, 10),
    rep("old", "2026-06-01", 220, 170, 10, { rep_num: 2 }),
    rep("new", "2026-07-24", 220, 230, 11),
    rep("new", "2026-07-24", 220, 210, 11, { rep_num: 2 }),
    rep("strength", "2026-07-10", 115, 120, 20),
  ];

  const sessions = buildZoneSessionHistory(history, {
    grip: "Crusher",
    zoneKey: "endurance",
  });

  expect(sessions).toHaveLength(2);
  expect(sessions[0]).toMatchObject({
    sessionId: "new",
    date: "2026-07-24",
    targetS: 220,
    openingActualS: 230,
    openingLoadKg: 11,
    repCount: 2,
    tutS: 440,
    outcomeZoneKey: "endurance",
  });
  expect(sessions[0].loadDeltaKg).toBeCloseTo(1);
  expect(sessions[0].ratioDelta).toBeCloseTo((230 - 190) / 220);
  expect(sessions[1].loadDeltaKg).toBeNull();
});

test("keeps an under-hit workout in its prescribed zone and reports the actual landing", () => {
  const sessions = buildZoneSessionHistory([
    rep("end", "2026-07-24", 220, 165, 12),
  ], {
    grip: "Crusher",
    zoneKey: "endurance",
  });

  expect(sessions).toHaveLength(1);
  expect(sessions[0].zoneKey).toBe("endurance");
  expect(sessions[0].outcomeZoneKey).toBe("strength_endurance");
});

test("filters to the selected hand and slider cutoff date", () => {
  const history = [
    rep("both", "2026-07-01", 160, 170, 10),
    rep("both", "2026-07-01", 160, 150, 9, { hand: "R" }),
    rep("future", "2026-07-24", 160, 180, 11),
  ];

  const left = buildZoneSessionHistory(history, {
    grip: "Crusher",
    zoneKey: "strength_endurance",
    handView: "L",
    throughDate: "2026-07-10",
  });
  const right = buildZoneSessionHistory(history, {
    grip: "Crusher",
    zoneKey: "strength_endurance",
    handView: "R",
    throughDate: "2026-07-10",
  });

  expect(left).toHaveLength(1);
  expect(left[0]).toMatchObject({ openingActualS: 170, openingLoadKg: 10, hands: ["L"] });
  expect(right).toHaveLength(1);
  expect(right[0]).toMatchObject({ openingActualS: 150, openingLoadKg: 9, hands: ["R"] });
});

test("keeps same session id on different dates as separate workouts", () => {
  const sessions = buildZoneSessionHistory([
    rep("overnight", "2026-07-23", 30, 31, 20),
    rep("overnight", "2026-07-24", 30, 32, 21),
  ], {
    grip: "Crusher",
    zoneKey: "power",
  });

  expect(sessions.map(session => session.date)).toEqual(["2026-07-24", "2026-07-23"]);
});

test("orders same-day workouts by their session start time", () => {
  const sessions = buildZoneSessionHistory([
    rep("morning", "2026-07-24", 30, 31, 20, {
      session_started_at: "2026-07-24T08:00:00.000Z",
    }),
    rep("evening", "2026-07-24", 30, 32, 21, {
      session_started_at: "2026-07-24T18:00:00.000Z",
    }),
  ], {
    grip: "Crusher",
    zoneKey: "power",
  });

  expect(sessions.map(session => session.sessionId)).toEqual(["evening", "morning"]);
});
