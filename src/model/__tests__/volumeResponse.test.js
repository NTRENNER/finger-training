import { buildVolumeResponse, VOLUME_RESPONSE_POLICY } from "../volumeResponse.js";

const DAY_MS = 86400000;
const date = days => new Date(Date.parse("2026-01-05T00:00:00Z") + days * DAY_MS).toISOString().slice(0, 10);
const rep = (week, dose, overrides = {}) => ({
  id: `rep-${week}`,
  date: date(week * 7),
  session_id: `session-${week}`,
  grip: "Crusher",
  hand: "L",
  actual_time_s: dose,
  avg_force_kg: 10,
  ...overrides,
});
const observation = (week, offset, deviation, overrides = {}) => ({
  id: `observation-${week}-${offset}`,
  date: date(week * 7 + offset),
  grip: "Crusher",
  hand: "L",
  deviation,
  context: "first_recorded",
  extrapolated: false,
  ...overrides,
});

test("detects an acute dip and delayed rebound after repeated higher-volume weeks", () => {
  const history = [], observations = [];
  for (let week = 0; week < 24; week += 1) {
    if (week % 4 === 0) history.push(rep(week, 60));
    const phase = week % 4;
    observations.push(observation(week, 1, phase === 1 ? -6 : phase >= 2 ? 8 : 0));
  }
  const result = buildVolumeResponse(history, observations, {
    grips: ["Crusher"], hand: "L", mode: "time", throughDate: date(24 * 7 + 28),
  });

  expect(result.summary).toBe("Higher-load weeks were followed by a short dip and later rebound.");
  expect(result.windows.map(window => window.status)).toEqual(["ready", "ready"]);
  expect(result.windows.find(window => window.id === "acute")).toMatchObject({ direction: "down" });
  expect(result.windows.find(window => window.id === "delayed")).toMatchObject({ direction: "up", effect: 7 });
});

test("stays hidden until repeated weeks and outcome dates meet the evidence gate", () => {
  const count = VOLUME_RESPONSE_POLICY.minimumPairs - 1;
  const history = Array.from({ length: count }, (_, week) => rep(week, week % 2 ? 60 : 20));
  const observations = Array.from({ length: count }, (_, week) => observation(week, 8, week % 2 ? -5 : 2));
  expect(buildVolumeResponse(history, observations, {
    grips: ["Crusher"], hand: "L", mode: "time", throughDate: date(count * 7 + 28),
  })).toBeNull();
});

test("excludes known later same-day sessions, extrapolated holds, and out-of-scope observations", () => {
  const history = [], observations = [];
  for (let week = 0; week < 12; week += 1) {
    const high = week % 2 === 1;
    history.push(rep(week, high ? 60 : 20));
    observations.push(observation(week, 8, high ? -5 : 3));
    observations.push(observation(week, 8, 99, { id: `later-${week}`, context: "after_training" }));
    observations.push(observation(week, 8, 99, { id: `extra-${week}`, extrapolated: true }));
    observations.push(observation(week, 8, 99, { id: `micro-${week}`, grip: "Micro" }));
    observations.push(observation(week, 8, 99, { id: `right-${week}`, hand: "R" }));
  }
  const result = buildVolumeResponse(history, observations, {
    grips: ["Crusher"], hand: "L", mode: "time", throughDate: date(12 * 7 + 28),
  });
  const acute = result.windows.find(window => window.id === "acute");
  expect(acute.direction).toBe("down");
  expect(acute.effect).toBe(-8);
});

test("reports no consistent pattern when higher and lower weeks have similar later performance", () => {
  const history = [], observations = [];
  for (let week = 0; week < 14; week += 1) {
    history.push(rep(week, week % 2 ? 60 : 20));
    observations.push(observation(week, 8, week % 3 - 1));
    observations.push(observation(week, 15, (week + 1) % 3 - 1));
  }
  const result = buildVolumeResponse(history, observations, {
    grips: ["Crusher"], hand: "L", mode: "volume", throughDate: date(14 * 7 + 28),
  });
  expect(result.summary).toBe("Training load and later performance are not consistent enough yet to guide training.");
  expect(result.windows.every(window => window.direction === "neutral")).toBe(true);
});

test("time and load-duration volume can reveal different dose patterns", () => {
  const history = [], observations = [];
  for (let week = 0; week < 14; week += 1) {
    const high = week % 2 === 1;
    history.push(rep(week, 30, { avg_force_kg: high ? 15 : 5 }));
    observations.push(observation(week, 8, high ? 6 : -2));
  }
  const options = { grips: ["Crusher"], hand: "L", throughDate: date(14 * 7 + 28) };
  expect(buildVolumeResponse(history, observations, { ...options, mode: "time" })).toBeNull();
  expect(buildVolumeResponse(history, observations, { ...options, mode: "volume" })
    .windows.find(window => window.id === "acute").direction).toBe("up");
});
