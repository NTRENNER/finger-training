// Tests for src/model/deload.js — cross-grip fatigue / deload detector.
// Covers liftingVolumeByDate parsing and computeDeload's trigger logic:
// fires only on sustained CROSS-GRIP recovery decline (single-grip dips
// are treated as zone artifacts), severity boosted by a lifting-volume
// spike, with a detraining guard and an insufficient-data guard.

import {
  computeDeload, liftingVolumeByDate,
  fingerSessionsThisWeek, deloadPlan, buildDeloadGuidance,
  deloadStatus, recoveryStatusDates,
  DELOAD_STALE_DAYS,
} from "../deload.js";

// ── Session builder ──────────────────────────────────
// Two reps (rep 1 + rep 2) for one (grip, hand, date). t1/t2 are the
// rep hold times; rest is large so the model predicts strong recovery,
// making a low t2/t1 read as a clear negative gap. Exactly 2 reps keeps
// computePersonalRecoveryTaus from engaging (needs ≥3/set), so the gap
// uses deterministic population taus.
let _id = 0;
const sess = (grip, hand, date, t1, t2, rest = 120) => [
  { id: `r${_id++}`, grip, hand, date, session_id: `${grip}-${hand}-${date}`,
    rep_num: 1, set_num: 1, actual_time_s: t1, avg_force_kg: 30, target_duration: 30, rest_s: rest },
  { id: `r${_id++}`, grip, hand, date, session_id: `${grip}-${hand}-${date}`,
    rep_num: 2, set_num: 1, actual_time_s: t2, avg_force_kg: 30, target_duration: 30, rest_s: rest },
];

const D = ["2026-05-02", "2026-05-06", "2026-05-10", "2026-05-14", "2026-05-17", "2026-05-20"];
const TODAY = "2026-05-20";

// Fine recovery: t2 ≈ t1 (ratio ~0.93, matches the model → gap ~0).
const fine = (grip) => D.flatMap(d => sess(grip, "L", d, 30, 28));
// Fatigued recent: last two sessions collapse (t2/t1 ~0.33 → gap ~ -0.6).
const fatiguedRecent = (grip) => [
  ...D.slice(0, 4).flatMap(d => sess(grip, "L", d, 30, 28)),
  ...D.slice(4).flatMap(d => sess(grip, "L", d, 30, 10)),
];

// Lifting with a clear acute spike (≥12 acute sets, acute rate ≫ chronic).
const liftSpike = [
  { date: TODAY, workout: "A", exercises: { v: { sets: Array.from({ length: 20 }, () => ({ done: true })) } } },
  { date: "2026-04-28", workout: "B", exercises: { v: { sets: Array.from({ length: 8 }, () => ({ done: true })) } } },
];

describe("liftingVolumeByDate", () => {
  test("counts done sets, skips markers + non-set entries + undone sets", () => {
    const vol = liftingVolumeByDate([
      { date: "2026-05-20", workout: "A", exercises: {
        rdl: { sets: [{ done: true }, { done: false }, { done: true }] },
        dips: { sets: [{ done: true }] },
        stretch: { done: true },           // no sets array → ignored
      } },
      { date: "2026-05-20", workout: "__rotation_pin", exercises: { __pinTo: "B" } },
      { date: "2026-05-21", workout: "STRETCH", exercises: {} },
    ]);
    expect(vol["2026-05-20"]).toBe(3);   // 2 rdl + 1 dips
    expect(vol["2026-05-21"]).toBeUndefined();
  });

  test("handles empty / missing input", () => {
    expect(liftingVolumeByDate([])).toEqual({});
    expect(liftingVolumeByDate(null)).toEqual({});
  });
});

describe("recoveryStatusDates", () => {
  test("starts when two grips have enough recovery sessions and appends Now", () => {
    const history = [...fine("Crusher"), ...fine("Micro")];
    expect(recoveryStatusDates(history, { today: "2026-05-23" })).toEqual([
      ...D.slice(1),
      "2026-05-23",
    ]);
  });

  test("stays empty while recovery is measurable for only one grip", () => {
    expect(recoveryStatusDates(fine("Crusher"), { today: TODAY })).toEqual([]);
  });
});

describe("computeDeload", () => {
  test("no history → no deload", () => {
    expect(computeDeload([]).deload).toBe(false);
    expect(computeDeload(null).deload).toBe(false);
  });

  test("normal recovery across grips → no deload", () => {
    const history = [...fine("Crusher"), ...fine("Micro")];
    const r = computeDeload(history, [], { today: TODAY });
    expect(r.deload).toBe(false);
    expect(r.severity).toBe("none");
  });

  test("single grip down → treated as artifact, no deload", () => {
    const history = [...fatiguedRecent("Crusher"), ...fine("Micro")];
    const r = computeDeload(history, [], { today: TODAY });
    expect(r.deload).toBe(false);
    expect(r.signals.downGrips).toEqual(["Crusher"]);
    expect(r.why).toMatch(/grip-specific|artifact/i);
  });

  test("both grips down, no lifting spike → MILD deload", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const r = computeDeload(history, [], { today: TODAY });
    expect(r.deload).toBe(true);
    expect(r.severity).toBe("mild");
    expect(r.signals.crossGripDown).toBe(true);
  });

  test("both grips down + lifting spike → STRONG deload", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const r = computeDeload(history, liftSpike, { today: TODAY });
    expect(r.deload).toBe(true);
    expect(r.severity).toBe("strong");
    expect(r.signals.lifting.spike).toBe(true);
    expect(r.why).toMatch(/lifting/i);
  });

  test("detraining guard: stale history → no deload", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const stale = `2026-07-01`; // ~6 weeks after last session
    const r = computeDeload(history, [], { today: stale });
    expect(r.deload).toBe(false);
    expect(r.why).toMatch(/rested/i);
  });

  test("only one grip trained → insufficient cross-grip data", () => {
    const r = computeDeload(fatiguedRecent("Crusher"), [], { today: TODAY });
    expect(r.deload).toBe(false);
    expect(r.why).toMatch(/cross-grip/i);
  });

  test("stale-day constant is sane", () => {
    expect(DELOAD_STALE_DAYS).toBeGreaterThan(0);
  });
});

describe("weekly deload plan", () => {
  test("fingerSessionsThisWeek counts distinct days in the trailing week", () => {
    const hist = [
      ...sess("Crusher", "L", "2026-05-20", 30, 28),
      ...sess("Crusher", "L", "2026-05-18", 30, 28),
      ...sess("Crusher", "L", "2026-05-18", 30, 28), // same day → still 1
      ...sess("Crusher", "L", "2026-05-05", 30, 28), // >7d before → excluded
    ];
    expect(fingerSessionsThisWeek(hist, "2026-05-20")).toBe(2);
  });

  test("deloadPlan: strong = 1 session + skip A + 2 climb days; mild = cap 2", () => {
    expect(deloadPlan("strong")).toMatchObject({ fingerCap: 1, skipWorkout: "A", climbDays: 2 });
    expect(deloadPlan("mild")).toMatchObject({ fingerCap: 2, skipWorkout: null });
    expect(deloadPlan("none")).toBeNull();
  });

  test("buildDeloadGuidance: strong names skip-A + climb cut + session count", () => {
    const hist = sess("Crusher", "L", "2026-05-20", 30, 28);
    const g = buildDeloadGuidance("strong", hist, { today: "2026-05-20" });
    expect(g.severity).toBe("strong");
    expect(g.fingerDoneThisWeek).toBe(1);
    expect(g.action).toMatch(/skip Workout A/i);
    expect(g.action).toMatch(/climbing days/i);
    expect(g.action).toMatch(/cut volume, not intensity/i);
  });

  test("buildDeloadGuidance: null severity → null", () => {
    expect(buildDeloadGuidance("none", [], {})).toBeNull();
  });
});

describe("deloadStatus (green/yellow/red gauge)", () => {
  test("historical evaluation rewinds before a later recovery decline", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    expect(deloadStatus(history, [], { today: D[3] }).level).toBe("green");
    expect(deloadStatus(history, [], { today: TODAY }).level).toBe("yellow");
  });

  test("healthy recovery across grips → green", () => {
    const history = [...fine("Crusher"), ...fine("Micro")];
    const s = deloadStatus(history, [], { today: TODAY });
    expect(s.level).toBe("green");
    expect(s.pressure).toBeLessThan(0.35);
  });

  test("both grips down + lifting spike → red (matches strong deload)", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const s = deloadStatus(history, liftSpike, { today: TODAY });
    expect(s.level).toBe("red");
    expect(s.deload.severity).toBe("strong");
    expect(s.pressure).toBeGreaterThan(0.5);
  });

  test("both grips down, no lifting spike → yellow (mild), not red", () => {
    const history = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const s = deloadStatus(history, [], { today: TODAY });
    expect(s.level).toBe("yellow");
  });

  test("single grip down → not red (conservative; stays calm)", () => {
    const history = [...fatiguedRecent("Crusher"), ...fine("Micro")];
    const s = deloadStatus(history, liftSpike, { today: TODAY });
    expect(s.level).not.toBe("red");
  });

  test("insufficient data → green, flagged no signal", () => {
    const s = deloadStatus(fine("Crusher"), [], { today: TODAY });
    expect(s.level).toBe("green");
    expect(s.haveSignal).toBe(false);
  });
});

describe("recentGapHeldOut (no look-ahead leakage)", () => {
  const { recentGapHeldOut } = require("../deload.js");
  const set = (grip, date, times, rest = 20) => times.map((t, i) => ({
    id: `${grip}-${date}-${i}`, grip, hand: "L", date, session_id: `${grip}-${date}`,
    set_num: 1, rep_num: i + 1, actual_time_s: t, target_duration: 30, rest_s: rest,
  }));

  test("returns null with fewer than n gap-bearing sessions", () => {
    const hist = set("Micro", "2026-05-01", [30, 20]);
    expect(recentGapHeldOut(hist, "Micro", "2026-05-01", 2)).toBeNull();
  });

  test("surfaces a genuine recent dip (recent window is held out of its own fit)", () => {
    // Healthy baseline (3-rep sets so personal taus can engage), then two
    // collapsed recent sessions. The dip must read clearly negative — the
    // recent sessions can't pull the baseline toward slower recovery.
    const hist = [
      ...["2026-05-01","2026-05-03","2026-05-05","2026-05-07","2026-05-09","2026-05-11"]
        .flatMap(d => set("Micro", d, [40, 37, 34])),
      ...set("Micro", "2026-05-14", [40, 12, 8]),
      ...set("Micro", "2026-05-16", [40, 11, 9]),
    ];
    const rg = recentGapHeldOut(hist, "Micro", "2026-05-16", 2);
    expect(rg).toBeTruthy();
    expect(rg.mean).toBeLessThan(-0.15);   // clear beyond-noise dip
    expect(rg.lastDate).toBe("2026-05-16");
  });
});
