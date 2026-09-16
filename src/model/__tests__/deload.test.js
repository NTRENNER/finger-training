import { measuredRecoveryFields } from "../../testHelpers/recovery.js";
// Tests for src/model/deload.js — cross-grip fatigue / deload detector.
// Covers liftingVolumeByDate parsing and computeDeload's trigger logic:
// fires only on sustained CROSS-GRIP recovery decline (single-grip dips
// are treated as zone artifacts), severity boosted by a lifting-volume
// spike, with a detraining guard and an insufficient-data guard.

import {
  computeDeload, liftingVolumeByDate,
  fingerSessionsThisWeek, deloadPlan, buildDeloadGuidance,
  deloadStatus, recoveryStatusDates, recentGapHeldOut,
  gripIsDown, gripPressure, climbingLoadByDate,
  DELOAD_STALE_DAYS, DELOAD_GAP_TRIGGER, DELOAD_GAP_TRIGGER_SD,
  DELOAD_BASELINE_MIN_SESSIONS, DELOAD_BASELINE_MIN_SD,
} from "../deload.js";

// ── Session builder ──────────────────────────────────
// Two reps (rep 1 + rep 2) for one (grip, hand, date). t1/t2 are the
// rep hold times; rest is large so the model predicts strong recovery,
// making a low t2/t1 read as a clear negative gap. Exactly 2 reps keeps
// computePersonalRecoveryTaus from engaging (needs ≥3/set), so the gap
// uses deterministic population taus.
let _id = 0;
const sess = (grip, hand, date, t1, t2, rest = 120) => [
  { ...measuredRecoveryFields(rest), id: `r${_id++}`, grip, hand, date, session_id: `${grip}-${hand}-${date}`,
    rep_num: 1, set_num: 1, actual_time_s: t1, avg_force_kg: 30, target_duration: 30, rest_s: rest },
  { ...measuredRecoveryFields(rest), id: `r${_id++}`, grip, hand, date, session_id: `${grip}-${hand}-${date}`,
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

  test("offers history for one measured grip", () => {
    expect(recoveryStatusDates(fine("Crusher"), { today: TODAY })).toEqual(D.slice(1));
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
    expect(r.state).toBe("insufficient");
  });

  test("only one grip trained → insufficient cross-grip data", () => {
    const r = computeDeload(fatiguedRecent("Crusher"), [], { today: TODAY });
    expect(r.deload).toBe(false);
    expect(r.state).toBe("local_concern");
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

  test("insufficient data → neutral, flagged no signal", () => {
    const s = deloadStatus([], [], { today: TODAY });
    expect(s.level).toBe("unknown");
    expect(s.haveSignal).toBe(false);
  });
});

describe("recentGapHeldOut (no look-ahead leakage)", () => {
  const { recentGapHeldOut } = require("../deload.js");
  const set = (grip, date, times, rest = 20) => times.map((t, i) => ({
    ...measuredRecoveryFields(rest), id: `${grip}-${date}-${i}`, grip, hand: "L", date, session_id: `${grip}-${date}`,
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

test('stale healthy grip cannot veto current declines', () => {
 const current = [...fatiguedRecent('Micro'), ...fatiguedRecent('Crusher')];
 const stale = ['2026-01-01','2026-01-05'].flatMap(d => sess('Prime','L',d,30,28));
 expect(computeDeload([...current,...stale],[],{today:TODAY}).severity).toBe('mild');
 expect(computeDeload([...current,...stale],[],{today:TODAY}).signals.gripGaps.Prime).toBeUndefined();
});
test.each(['2026-05-07', '2026-05-05', '2026-04-29', '2026-01-01'])(
  'a grip trained today stays current regardless of prior session date %s', prior => {
    const h = [prior, TODAY].flatMap(d => sess('Crusher', 'L', d, 30, 10));
    expect(recentGapHeldOut(h, 'Crusher', TODAY, 2)).toMatchObject({n:2, lastDate:TODAY});
  }
);
test('yesterday remains recent even when the prior session was weeks earlier', () => {
  const h = ['2026-04-30', '2026-05-19'].flatMap(d => sess('Crusher', 'L', d, 30, 10));
  expect(recentGapHeldOut(h, 'Crusher', TODAY, 2)).toMatchObject({lastDate:'2026-05-19'});
});
test.each([['2026-05-06', true], ['2026-05-05', false]])(
  'latest qualifying session %s controls the 14-day boundary', (last, current) => {
    const h = ['2026-04-01', last].flatMap(d => sess('Crusher', 'L', d, 30, 10));
    expect(Boolean(recentGapHeldOut(h, 'Crusher', TODAY, 2))).toBe(current);
  }
);
test('a future session cannot make old evidence current', () => {
  const h = ['2026-04-01', '2026-04-22', '2026-05-21'].flatMap(d => sess('Crusher', 'L', d, 30, 10));
  expect(recentGapHeldOut(h, 'Crusher', TODAY, 2)).toBeNull();
});
test('less-frequent declining grips still contribute to systemic concern and a strong deload', () => {
  const h = [...fatiguedRecent('Micro'),
    ...['2026-04-08', '2026-04-29', TODAY].flatMap(d => sess('Crusher', 'L', d, 30, 10))];
  const result = computeDeload(h, liftSpike, {today:TODAY});
  expect(result).toMatchObject({deload:true, severity:'strong', state:'systemic_concern'});
  expect(result.signals.crossGripDown).toBe(true);
  expect(result.signals.gripGaps.Crusher.lastDate).toBe(TODAY);
  expect(deloadStatus(h, liftSpike, {today:TODAY}).level).toBe('red');
});
test('one trained grip has a useful local concern without a systemic claim', () => {
 const r=deloadStatus(fatiguedRecent('Micro'),[],{today:TODAY});
 expect(r.state).toBe('local_concern'); expect(r.level).toBe('yellow');
 expect(r.deload.deload).toBe(false);
});

// ─────────────────────────────────────────────────────────────
// SELF-REFERENCED TRIGGER (September 2026)
// ─────────────────────────────────────────────────────────────
// The gate used to compare each grip's recent recovery gap to an absolute
// -0.15. On the real history that sat ~2 sd below every grip's own median,
// so the deload recommendation could not fire and never did. It now reads
// each grip against its own out-of-sample baseline. See the long comment
// on DELOAD_GAP_TRIGGER_SD.
describe("gripIsDown / gripPressure: judged against the grip's own normal", () => {
  const withBaseline = (mean, median, sd) => ({ mean, baseline: { median, sd, n: 10 }, z: (mean - median) / sd });

  test("a grip well above the old absolute threshold is still DOWN if it is down for itself", () => {
    // mean +0.05 — nowhere near -0.15 — but this grip normally runs +0.35
    // with a spread of 0.15, so this is two sd below its own typical.
    const g = withBaseline(0.05, 0.35, 0.15);
    expect(g.mean).toBeGreaterThan(-DELOAD_GAP_TRIGGER);   // old gate: not down
    expect(gripIsDown(g)).toBe(true);                       // new gate: down
    expect(gripPressure(g)).toBe(1);
  });

  test("a grip below the old absolute threshold is NOT down if that is normal for it", () => {
    // This grip habitually reads negative; -0.20 is its median.
    const g = withBaseline(-0.20, -0.20, 0.10);
    expect(g.mean).toBeLessThan(-DELOAD_GAP_TRIGGER);       // old gate: down
    expect(gripIsDown(g)).toBe(false);                      // new gate: unremarkable
    expect(gripPressure(g)).toBe(0);
  });

  test("pressure is the fraction of the runway to the trigger, clamped", () => {
    expect(gripPressure(withBaseline(0.2, 0.2, 0.2))).toBeCloseTo(0, 6);
    expect(gripPressure(withBaseline(0.1, 0.2, 0.2))).toBeCloseTo(0.5, 6);
    expect(gripPressure(withBaseline(-0.2, 0.2, 0.2))).toBe(1);   // 2 sd down, clamped
    expect(gripPressure(withBaseline(0.6, 0.2, 0.2))).toBe(0);    // better than normal
  });

  test("without a baseline it falls back to the absolute threshold, not to 'fine'", () => {
    const thin = { mean: -0.30, baseline: null, z: null };
    expect(gripIsDown(thin)).toBe(true);
    expect(gripIsDown({ mean: 0.05, baseline: null, z: null })).toBe(false);
    expect(gripPressure(thin)).toBe(1);
    expect(gripIsDown(null)).toBe(false);
    expect(gripPressure(null)).toBe(0);
  });
});

describe("climbing load feeds severity, never the gate", () => {
  const climbs = (dates, rpe = 8, attempts = 1) => dates.map((date, i) => ({
    id: `c${i}`, type: "climbing", date, rpe, attempts,
  }));
  // Dense recent climbing against a quiet earlier month → acute ≫ chronic.
  const spikeDays = ["2026-05-14", "2026-05-15", "2026-05-16", "2026-05-17",
    "2026-05-18", "2026-05-19", "2026-05-20"];

  test("climbingLoadByDate scores each day and counts attempts", () => {
    const one = climbingLoadByDate(climbs(["2026-05-20"]));
    const eight = climbingLoadByDate(climbs(["2026-05-20"], 8, 8));
    expect(one["2026-05-20"]).toBeGreaterThan(0);
    expect(eight["2026-05-20"]).toBeGreaterThan(one["2026-05-20"]);
    expect(climbingLoadByDate(null)).toEqual({});
    expect(climbingLoadByDate([{ type: "rest", date: "2026-05-20" }])).toEqual({});
  });

  test("a climbing spike escalates a mild deload to strong", () => {
    const hist = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const mild = computeDeload(hist, [], { today: TODAY });
    expect(mild).toMatchObject({ deload: true, severity: "mild" });

    const strong = computeDeload(hist, [], { today: TODAY, activities: climbs(spikeDays) });
    expect(strong.signals.climbing.spike).toBe(true);
    expect(strong.severity).toBe("strong");
    expect(strong.why).toMatch(/climbing/i);
  });

  test("a climbing spike alone cannot recommend a deload", () => {
    // Recovery is fine on both grips; only the outside load is elevated.
    const hist = [...fine("Crusher"), ...fine("Micro")];
    const r = computeDeload(hist, [], { today: TODAY, activities: climbs(spikeDays) });
    expect(r.signals.climbing.spike).toBe(true);
    expect(r.deload).toBe(false);
    expect(r.severity).toBe("none");
  });

  test("no climb log at all leaves the verdict unchanged", () => {
    const hist = [...fatiguedRecent("Crusher"), ...fatiguedRecent("Micro")];
    const without = computeDeload(hist, [], { today: TODAY });
    const withEmpty = computeDeload(hist, [], { today: TODAY, activities: [] });
    expect(withEmpty.severity).toBe(without.severity);
    expect(withEmpty.signals.climbing.spike).toBe(false);
  });
});

describe("the self-referenced baseline", () => {
  // A long, steady history so the grip has enough pre-window sessions to
  // be judged against itself at all.
  // Deterministic session-to-session variation: a real athlete's recovery
  // scatters, and a baseline needs a spread to mean anything. A perfectly
  // uniform history has none, which the DELOAD_BASELINE_MIN_SD floor
  // handles but which makes a poor fixture for the baseline itself.
  const many = (grip, n) => Array.from({ length: n }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 5) + i * 4 * 86400000).toISOString().slice(0, 10);
    return sess(grip, "L", d, 30, 26 + (i % 5));
  }).flat();

  test("a short history has no baseline, and says so rather than guessing", () => {
    const rg = recentGapHeldOut(many("Crusher", 6), "Crusher", "2026-01-25", 2);
    expect(rg).toBeTruthy();
    expect(rg.baseline).toBeNull();
    expect(rg.z).toBeNull();
  });

  test("a long history earns a baseline drawn from BEFORE the judged window", () => {
    const hist = many("Crusher", 30);
    const last = hist[hist.length - 1].date;
    const rg = recentGapHeldOut(hist, "Crusher", last, 2);
    expect(rg.baseline).toMatchObject({ n: expect.any(Number) });
    expect(rg.baseline.n).toBeGreaterThanOrEqual(DELOAD_BASELINE_MIN_SESSIONS);
    // Split-half: the baseline is scored on roughly the newer half of the
    // pre-window sessions, never on the window itself.
    expect(rg.baseline.n).toBeLessThan(30 - 2);
    expect(rg.baseline.sd).toBeGreaterThan(0);
    expect(rg.z).toBeCloseTo((rg.mean - rg.baseline.median) / rg.baseline.sd, 9);
  });

  test("a steady athlete sits near their own median, not near zero", () => {
    // The point of the rewrite: what matters is distance from this
    // athlete's normal, wherever that happens to sit.
    const hist = many("Crusher", 30);
    const last = hist[hist.length - 1].date;
    const rg = recentGapHeldOut(hist, "Crusher", last, 2);
    expect(Math.abs(rg.z)).toBeLessThan(DELOAD_GAP_TRIGGER_SD);
    expect(gripIsDown(rg)).toBe(false);
  });
});

test("a degenerate baseline cannot manufacture an alarm", () => {
  // Every session identical → zero spread. Without the floor, any
  // deviation at all would read as an enormous z.
  const flat = Array.from({ length: 30 }, (_, i) => {
    const d = new Date(Date.UTC(2026, 0, 5) + i * 4 * 86400000).toISOString().slice(0, 10);
    return sess("Crusher", "L", d, 30, 28);
  }).flat();
  const rg = recentGapHeldOut(flat, "Crusher", flat[flat.length - 1].date, 2);
  expect(rg).toBeTruthy();
  if (rg.baseline) expect(rg.baseline.sd).toBeGreaterThanOrEqual(DELOAD_BASELINE_MIN_SD);
  expect(gripIsDown(rg)).toBe(false);
});
