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

test("reports first and latest measured opening holds in each prescribed domain", () => {
  const progress = buildMeasuredDomainProgress([
    rep("old", "2026-06-01", 30, 28, 12),
    rep("new", "2026-07-01", 30, 36, 15),
    rep("end", "2026-07-08", 220, 190, 8),
  ], { grip: "Micro", handView: "L" });

  expect(progress.peak).toMatchObject({
    first: { date: "2026-06-01", forceKg: 17 },
    latest: { date: "2026-07-01", forceKg: 20 },
    sessions: 3,
  });
  expect(progress.domains.find(item => item.key === "power")).toMatchObject({
    sessions: 2,
    first: { date: "2026-06-01", forceKg: 12, durationS: 28 },
    latest: { date: "2026-07-01", forceKg: 15, durationS: 36 },
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
  expect(left.peak.latest.forceKg).toBe(15);
});
