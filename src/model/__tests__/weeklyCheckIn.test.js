import { gatherCheckInSignals, assembleCheckIn, buildCheckIn,
         CHECKIN_ZONE_STALE_DAYS } from "../weeklyReview.js";

// Minimal manual rep: load via manual_load_kg, zone via target_duration.
const rep = (date, grip, target, actual, load = 10, extra = {}) => ({
  date, grip, hand: "L", rep_num: 1, session_id: `${date}|${grip}`,
  target_duration: target, actual_time_s: actual, manual_load_kg: load, ...extra,
});

// refDate anchors all windows; pick a Sunday so weekKey math is stable.
const REF = "2026-07-05";

describe("gatherCheckInSignals", () => {
  test("volume + zone coverage per grip, last 7d only", () => {
    const hist = [
      rep("2026-07-01", "Micro", 45, 50),
      rep("2026-07-03", "Micro", 120, 110),
      rep("2026-06-01", "Micro", 45, 44),          // outside 7d
      rep("2026-07-02", "Crusher", 7, 8),
    ];
    const s = gatherCheckInSignals(hist, [], [], { refDate: REF });
    expect(s.volume.Micro.sessions).toBe(2);
    expect(s.volume.Micro.tutS).toBe(160);
    expect(s.volume.Micro.zones).toBe(2);           // power + strength
    expect(s.volume.Crusher.sessions).toBe(1);
  });

  test("zone-level staleness (21d+) per grip", () => {
    const hist = [
      rep("2026-05-01", "Micro", 200, 190),          // endurance, 65d stale
      rep("2026-07-04", "Micro", 45, 46),            // power, fresh
    ];
    const s = gatherCheckInSignals(hist, [], [], { refDate: REF });
    const stale = s.staleZones.find(z => z.grip === "Micro" && z.zone === "endurance");
    expect(stale).toBeTruthy();
    expect(stale.days).toBeGreaterThanOrEqual(CHECKIN_ZONE_STALE_DAYS);
    expect(s.staleZones.some(z => z.zone === "power")).toBe(false);
  });

  test("perf ratio: current vs prior window + overshoot/undershoot counts", () => {
    const hist = [];
    // prior window (29-56d ago): ratio 1.0
    for (let i = 0; i < 5; i++) hist.push(rep(`2026-05-2${i}`, "Micro", 40, 40));
    // current window: ratio 1.5, one big overshoot each
    for (let i = 0; i < 5; i++) hist.push(rep(`2026-06-2${i}`, "Micro", 40, 60));
    const s = gatherCheckInSignals(hist, [], [], { refDate: REF });
    expect(s.perf.ratioNow).toBeCloseTo(1.5, 2);
    expect(s.perf.ratioPrev).toBeCloseTo(1.0, 2);
    expect(s.perf.overshoots).toBe(5);              // 60 ≥ 1.4×40
    expect(s.perf.undershoots).toBe(0);
  });

  test("climbing context + body-weight trend", () => {
    const hist = [rep("2026-07-01", "Micro", 45, 46)];
    const acts = [
      { type: "climbing", date: "2026-07-01", discipline: "boulder", grade: "V6", ascent: "flash", rpe: 7 },
      { type: "climbing", date: "2026-07-03", discipline: "boulder", grade: "V4", ascent: "attempt", rpe: 9 },
    ];
    const bwLog = [{ date: "2026-06-10", kg: 71.0 }, { date: "2026-07-04", kg: 72.4 }];
    const s = gatherCheckInSignals(hist, acts, [], { refDate: REF, bwLog });
    expect(s.climbCtx.sessions).toBe(2);
    expect(s.climbCtx.hardestSend).toBe("V6");      // attempt doesn't count as send
    expect(s.climbCtx.avgRpe).toBeCloseTo(8, 1);
    expect(s.bw.deltaKg).toBeCloseTo(1.4, 2);
  });

  test("data quality: no-load reps, tiny sessions, multi-date session ids", () => {
    const hist = [
      rep("2026-07-01", "Micro", 45, 46),                                  // tiny session (1 rep)
      { date: "2026-07-02", grip: "Micro", hand: "L", rep_num: 1,
        session_id: "span", target_duration: 45, actual_time_s: 40 },      // no load
      { date: "2026-07-03", grip: "Micro", hand: "L", rep_num: 2,
        session_id: "span", target_duration: 45, actual_time_s: 40, manual_load_kg: 8 },
    ];
    const s = gatherCheckInSignals(hist, [], [], { refDate: REF });
    expect(s.dataQuality.noLoad).toBe(1);
    expect(s.dataQuality.noLoadList[0]).toBe("Micro 2026-07-02");
    expect(s.dataQuality.multiDateSessions).toBe(1);
    expect(s.dataQuality.multiDateList[0]).toBe("Micro 2026-07-02 → 2026-07-03");
    expect(s.dataQuality.tinySessions).toBeGreaterThanOrEqual(1);
    expect(s.dataQuality.tinyList.join(" ")).toMatch(/Micro 2026-07-01 \(1 rep\)/);
  });

  test("heads-up lines carry grip + date so sessions are findable", () => {
    const hist = [
      rep("2026-07-01", "Micro", 45, 46),          // tiny session
      rep("2026-06-20", "Crusher", 7, 8),          // tiny session
    ];
    const out = assembleCheckIn(gatherCheckInSignals(hist, [], [], { refDate: REF }));
    const flat = out.sections.headsUp.join(" ");
    expect(flat).toMatch(/Micro 2026-07-01 \(1 rep\)/);
    expect(flat).toMatch(/Crusher 2026-06-20 \(1 rep\)/);
    expect(flat).toMatch(/Delete in History/);
  });
});

describe("assembleCheckIn", () => {
  test("empty history + explicit refDate → still writes the check-in (spec: acknowledge the gap)", () => {
    const out = buildCheckIn([], [], [], { refDate: REF });
    expect(out.sections).not.toBeNull();
    expect(out.sections.did[0]).toMatch(/No finger or climbing sessions/);
    expect(out.sections.headsUp[0]).toMatch(/looks clean/);
  });

  test("truly empty (no data, no refDate) → headline only, no sections", () => {
    const out = buildCheckIn([], [], [], {});
    expect(out.sections).toBeNull();
    expect(out.headline).toMatch(/No training logged/);
  });

  test("five sections populate; focus ≤3; heads-up falls back to all-clear", () => {
    const hist = [
      rep("2026-04-01", "Micro", 200, 190),          // stale endurance zone → focus
      rep("2026-07-01", "Micro", 45, 50),
      rep("2026-07-01", "Micro", 45, 48, 10, { rep_num: 2 }),
      rep("2026-07-03", "Micro", 120, 110),
      rep("2026-07-03", "Micro", 120, 100, 10, { rep_num: 2 }),
    ];
    const out = buildCheckIn(hist, [], [], { refDate: REF });
    expect(out.sections.did.length).toBeGreaterThan(0);
    expect(out.sections.did[0]).toMatch(/Micro: 2 sessions/);
    expect(out.sections.focus.length).toBeGreaterThan(0);
    expect(out.sections.focus.length).toBeLessThanOrEqual(3);
    expect(out.sections.focus.join(" ")).toMatch(/endurance/);
    expect(out.sections.headsUp.length).toBeGreaterThan(0);
    // compact digest points still present for the collapsed card
    expect(Array.isArray(out.points)).toBe(true);
  });

  test("behavior notes (volume ramp / adherence) land in stuck", () => {
    // Chronic base: one 45s×10kg rep (~450 kg·s) twice a week for four
    // weeks, then two 3×-load days inside the last week → acute spike.
    const dates = ["2026-06-10", "2026-06-13", "2026-06-17", "2026-06-20",
                   "2026-06-24", "2026-06-27", "2026-07-01", "2026-07-03"];
    const hist = dates.map(d => rep(d, "Micro", 45, 45, 10));
    hist.push(rep("2026-07-04", "Micro", 45, 45, 30));
    hist.push(rep("2026-07-05", "Micro", 45, 45, 30));
    const out = buildCheckIn(hist, [], [], { refDate: REF });
    expect(out.sections.stuck.join(" ")).toMatch(/monthly average|tendons/);
  });

  test("support work shows at the exercise level; stale workout gets partial credit", () => {
    const hist = [rep("2026-07-01", "Micro", 45, 46)];
    const wlog = [
      // Old full Workout B — makes B stale (>14d before REF).
      { date: "2026-06-18", workout: "B",
        exercises: { medBallThrows: { sets: [{ done: true, reps: 8 }] } } },
      // This week: A-labeled session that ALSO touches B's med ball slams.
      { date: "2026-07-02", workout: "A",
        exercises: {
          weightedPullup: { sets: [{ done: true, reps: 5 }] },
          medBallThrows:  { sets: [{ done: true, reps: 10 }] },
          dips:           { sets: [{ done: false }] },          // not done → not counted
        } },
    ];
    const out = buildCheckIn(hist, [], wlog, { refDate: REF });
    const didFlat = out.sections.did.join(" ");
    expect(didFlat).toMatch(/Support work: 2 exercises across 1 day/);
    expect(didFlat).toMatch(/Med Ball Slams/);
    expect(didFlat).not.toMatch(/Dips/);
    const stuckFlat = out.sections.stuck.join(" ");
    expect(stuckFlat).toMatch(/No full Workout B in 1[0-9] days — but you touched 1 of its exercise/);
    expect(stuckFlat).not.toMatch(/Support workout B hasn't come up/);
  });

  test("busy-week nudge: partial support week acknowledges + prescribes at-risk exercises", () => {
    const hist = [rep("2026-07-01", "Micro", 45, 46)];
    const wlog = [
      // History: slams trained regularly, but last touch 12d before REF
      // (power window 10d → at risk). Dips 16d back (strength 14d → at risk).
      { date: "2026-06-16", workout: "B", exercises: { medBallThrows: { sets: [{ done: true, reps: 8 }] } } },
      { date: "2026-06-23", workout: "B", exercises: { medBallThrows: { sets: [{ done: true, reps: 8 }] } } },
      { date: "2026-06-19", workout: "A", exercises: { dips: { sets: [{ done: true, weight: 20, reps: 5 }] } } },
      // This week: pieces only — one exercise, nowhere near a full session.
      { date: "2026-07-02", workout: "A", exercises: { weightedPullup: { sets: [{ done: true, reps: 5 }] } } },
    ];
    const out = buildCheckIn(hist, [], wlog, { refDate: REF });
    const nudge = out.sections.focus.find(t => /No full A\/B\/C workout this week/.test(t));
    expect(nudge).toBeTruthy();
    expect(nudge).toMatch(/busy stretch\?/);
    expect(nudge).toMatch(/Next week, try to get:/);
    expect(nudge).toMatch(/Med Ball Slams \(12d idle\)/);
    expect(nudge).toMatch(/Power qualities fade fastest/);
    expect(out.sections.focus.length).toBeLessThanOrEqual(3);
  });

  test("busy-week nudge stays silent when a full workout happened", () => {
    const hist = [rep("2026-07-01", "Micro", 45, 46)];
    const fullA = { date: "2026-07-02", workout: "A", exercises: {
      weightedPullup: { sets: [{ done: true, reps: 5 }] },
      dips:           { sets: [{ done: true, reps: 5 }] },
      heelHookPull:   { sets: [{ done: true, reps: 5 }] },
      bandedLatPull:  { sets: [{ done: true, reps: 5 }] },
    } };
    const stale = { date: "2026-06-16", workout: "B", exercises: { medBallThrows: { sets: [{ done: true, reps: 8 }] } } };
    const out = buildCheckIn(hist, [], [fullA, stale], { refDate: REF });
    expect(out.sections.focus.some(t => /No full A\/B\/C workout/.test(t))).toBe(false);
  });

  test("no week activity → plain acknowledgment in did", () => {
    const hist = [rep("2026-05-01", "Micro", 45, 46)];
    const out = buildCheckIn(hist, [], [], { refDate: REF });
    expect(out.sections.did[0]).toMatch(/No finger or climbing sessions/);
  });
});
