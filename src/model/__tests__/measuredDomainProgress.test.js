import { buildMeasuredDomainProgress } from "../measuredDomainProgress.js";

const rep = (id, date, target, actual, force, extra = {}) => ({
  id,
  session_id: id,
  date,
  grip: "Micro",
  hand: "L",
  set_num: 1,
  rep_num: 1,
  target_duration: target,
  actual_time_s: actual,
  avg_force_kg: force,
  peak_force_kg: force + 5,
  failure_valid: true,
  load_provenance: "measured_force",
  force_recording: { capacity_eligible: true },
  ...extra,
});

test("reports a fixed-duration comparison when opening times closely match", () => {
  const progress = buildMeasuredDomainProgress([
    rep("old", "2026-06-01", 30, 28, 12),
    rep("new", "2026-07-01", 30, 30, 15),
    rep("end", "2026-07-08", 220, 190, 8),
  ], { grip: "Micro", handView: "L" });

  expect(progress.peak).toMatchObject({
    first: { date: "2026-06-01", forceKg: 17 },
    best: { date: "2026-07-01", forceKg: 20 },
    sessions: 3,
  });
  // None of these holds is a max effort (all > 12 s), so there is no
  // "latest" peak — the 220 s hold's 13 kg must not read as current strength.
  expect(progress.peak.latest).toBeNull();
  expect(progress.domains.find(item => item.key === "power")).toMatchObject({
    sessions: 2,
    first: { date: "2026-06-01", forceKg: 12, durationS: 28 },
    latest: { date: "2026-07-01", forceKg: 15, durationS: 30 },
    comparison: {
      type: "fixed_duration",
      anchorDurationS: 29,
      earlier: { forceKg: 12, durationS: 28 },
      latest: { forceKg: 15, durationS: 30 },
    },
  });
  expect(progress.domains.find(item => item.key === "endurance")).toMatchObject({ sessions: 1 });
});

test("excludes nominal and interrupted rows and honors the selected hand", () => {
  const history = [
    rep("left", "2026-06-01", 70, 72, 10),
    rep("right", "2026-06-02", 70, 74, 20, { hand: "R" }),
    rep("nominal", "2026-06-03", 70, 75, 0, {
      avg_force_kg: null,
      prescribed_load_kg: 30,
      peak_force_kg: null,
      load_provenance: "nominal_setting",
    }),
    rep("bad", "2026-06-04", 70, 76, 40, {
      failure_valid: false,
      force_recording: { capacity_eligible: false },
    }),
  ];
  const left = buildMeasuredDomainProgress(history, { grip: "Micro", handView: "L" });
  const domain = left.domains.find(item => item.key === "power_strength");
  expect(domain).toMatchObject({ sessions: 1, first: { forceKg: 10 }, latest: { forceKg: 10 } });
  expect(left.peak.best.forceKg).toBe(15);
  expect(left.peak.latest).toBeNull();
});

test("peak progress separates the first, best and most recent measured peak", () => {
  const peak = (id, date, kg) => rep(id, date, 7, 7, kg - 5);
  const progress = buildMeasuredDomainProgress([
    peak("a", "2026-06-01", 40),
    peak("b", "2026-07-01", 52),
    peak("c", "2026-10-20", 49),
    rep("endurance", "2026-10-22", 220, 200, 8),
  ], { grip: "Micro", handView: "L" });
  expect(progress.peak).toMatchObject({
    first: { date: "2026-06-01", forceKg: 40 },
    best: { date: "2026-07-01", forceKg: 52 },
    latest: { date: "2026-10-20", forceKg: 49 },
  });
});

test("uses the latest similar-force repeat to compare hold time", () => {
  const progress = buildMeasuredDomainProgress([
    rep("old", "2026-06-01", 70, 62, 10),
    rep("middle", "2026-07-01", 70, 80, 10.2),
    rep("latest", "2026-08-01", 70, 92, 10.4),
  ], { grip: "Micro", handView: "L" });

  expect(progress.domains.find(item => item.key === "power_strength").comparison).toMatchObject({
    type: "fixed_force",
    anchorForceKg: 10.2,
    earlier: { date: "2026-06-01", forceKg: 10, durationS: 62 },
    latest: { date: "2026-08-01", forceKg: 10.4, durationS: 92 },
  });
});

test("does not compare openings when both force and duration materially changed", () => {
  const progress = buildMeasuredDomainProgress([
    rep("old", "2026-06-01", 30, 45, 12),
    rep("latest", "2026-07-01", 30, 3.3, 18),
  ], { grip: "Micro", handView: "L" });

  expect(progress.domains.find(item => item.key === "power").comparison).toBeNull();
});

test("uses a later comparable pair when the first opening never repeats", () => {
  const progress = buildMeasuredDomainProgress([
    rep("unmatched-first", "2026-05-01", 30, 45, 12),
    rep("earlier-match", "2026-06-01", 30, 29, 15),
    rep("latest-match", "2026-07-01", 30, 31, 18),
  ], { grip: "Micro", handView: "L" });

  expect(progress.domains.find(item => item.key === "power").comparison).toMatchObject({
    type: "fixed_duration",
    earlier: { date: "2026-06-01", forceKg: 15, durationS: 29 },
    latest: { date: "2026-07-01", forceKg: 18, durationS: 31 },
  });
});
