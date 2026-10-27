import {
  buildFingerTrainingLoad,
  isFingerTrainingLoadRep,
} from "../fingerTrainingLoad.js";

const rep = (overrides = {}) => ({
  id: "rep",
  date: "2026-10-20",
  session_id: "session-1",
  grip: "Crusher",
  hand: "L",
  actual_time_s: 30,
  avg_force_kg: 20,
  ...overrides,
});

test("training load includes performed work but excludes peak and potentiation measurements", () => {
  const ordinary = rep();
  const earlyEnd = rep({ id: "early", actual_time_s: 12, avg_force_kg: 15 });
  const peak = rep({ id: "peak", force_recording: { session_protocol: { id: "peak_test" } } });
  const potentiation = rep({ id: "potentiation", force_recording: { session_protocol: { id: "warmup_potentiation" } } });

  expect(isFingerTrainingLoadRep(ordinary)).toBe(true);
  expect(isFingerTrainingLoadRep(earlyEnd)).toBe(true);
  expect(isFingerTrainingLoadRep(peak)).toBe(false);
  expect(isFingerTrainingLoadRep(potentiation)).toBe(false);

  const result = buildFingerTrainingLoad([ordinary, earlyEnd, peak, potentiation], {
    weeks: 2,
    throughDate: "2026-10-27",
  });
  expect(result.rows[0]).toMatchObject({ tutS: 42, volumeKgS: 780, sessions: 1 });
  expect(result.rows[1]).toMatchObject({ tutS: 0, volumeKgS: 0, sessions: 0 });
});

test("training load honors grip and hand scope and keeps empty calendar weeks", () => {
  const history = [
    rep({ date: "2026-10-06", session_id: "a", grip: "Crusher", hand: "L", actual_time_s: 10, avg_force_kg: 10 }),
    rep({ date: "2026-10-06", session_id: "a", grip: "Crusher", hand: "R", actual_time_s: 20, avg_force_kg: 10 }),
    rep({ date: "2026-10-20", session_id: "b", grip: "Micro", hand: "L", actual_time_s: 30, avg_force_kg: 5 }),
  ];

  const result = buildFingerTrainingLoad(history, {
    grips: ["Crusher"],
    hand: "L",
    weeks: 4,
    throughDate: "2026-10-27",
  });

  expect(result.rows.map(row => row.week)).toEqual([
    "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26",
  ]);
  expect(result.rows.map(row => row.tutS)).toEqual([10, 0, 0, 0]);
  expect(result.rows[0].volumeKgS).toBe(100);
  expect(result.reference).toMatchObject({ weeks: 3, tutS: 10 / 3, volumeKgS: 100 / 3 });
});
