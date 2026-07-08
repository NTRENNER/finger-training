import {
  volumeByDate, adherenceNote, volumeRampNote, trendNote,
  buildCoachNotes, decisiveWhy,
  ADHERENCE_RATIO, ADHERENCE_SLACK_DAYS, TREND_SESSIONS,
} from "../coachNotes.js";

// Helper: one rep of `vol` kg·s on a date (load 10 kg × vol/10 s).
const rep = (date, vol = 100) => ({
  date, hand: "L", grip: "Micro", rep_num: 1,
  manual_load_kg: 10, actual_time_s: vol / 10,
});

describe("volumeByDate", () => {
  test("sums load×time per date, skips unusable reps", () => {
    const v = volumeByDate([
      rep("2026-07-01", 100), rep("2026-07-01", 50),
      { date: "2026-07-01", actual_time_s: 10 },          // no load
      { date: null, manual_load_kg: 10, actual_time_s: 10 }, // no date
      rep("2026-07-03", 80),
    ]);
    expect(v.get("2026-07-01")).toBeCloseTo(150, 3);
    expect(v.get("2026-07-03")).toBeCloseTo(80, 3);
    expect(v.size).toBe(2);
  });
});

describe("adherenceNote", () => {
  // Every-3-days cadence: 07-01, 04, 07, 10, 13.
  const steady = ["2026-07-01", "2026-07-04", "2026-07-07", "2026-07-10", "2026-07-13"].map(d => rep(d));
  test("on-schedule user gets no note", () => {
    expect(adherenceNote(steady, "2026-07-15")).toBeNull();
  });
  test("long gap vs own cadence triggers", () => {
    const n = adherenceNote(steady, "2026-07-22");   // 9 days > 3×1.75 and ≥ 3+3
    expect(n).not.toBeNull();
    expect(n.key).toBe("adherence");
    expect(n.text).toMatch(/9 days/);
    expect(n.text).toMatch(/~3/);
  });
  test("too little history → null (no cadence known)", () => {
    expect(adherenceNote([rep("2026-07-01"), rep("2026-07-04")], "2026-07-22")).toBeNull();
  });
  test("thresholds are AND-ed: fast cadence needs the additive slack too", () => {
    // median gap 1d: 2 days later fails ratio? 2 > 1.75 but 2 < 1+3 → no nag.
    const daily = ["2026-07-01", "2026-07-02", "2026-07-03", "2026-07-04", "2026-07-05"].map(d => rep(d));
    expect(adherenceNote(daily, "2026-07-07")).toBeNull();
    expect(ADHERENCE_RATIO).toBeGreaterThan(1);
    expect(ADHERENCE_SLACK_DAYS).toBeGreaterThan(0);
  });
});

describe("volumeRampNote", () => {
  // Chronic base: 2 sessions/week × 4 weeks at 100 kg·s.
  const base = [
    "2026-06-10", "2026-06-13", "2026-06-17", "2026-06-20",
    "2026-06-24", "2026-06-27", "2026-07-01", "2026-07-04",
  ].map(d => rep(d, 100));
  test("steady volume → null", () => {
    expect(volumeRampNote(base, "2026-07-06")).toBeNull();
  });
  test("acute spike flags", () => {
    const spiked = [...base, rep("2026-07-05", 300), rep("2026-07-06", 300)];
    const n = volumeRampNote(spiked, "2026-07-07");
    expect(n?.key).toBe("ramp-spike");
    expect(n.tone).toBe("warn");
  });
  test("quiet week flags a drop", () => {
    const n = volumeRampNote(base, "2026-07-12");   // last session 8d ago → acute 0
    expect(n?.key).toBe("ramp-drop");
    expect(n.tone).toBe("info");
  });
  test("sparse history → null", () => {
    expect(volumeRampNote(base.slice(0, 4), "2026-07-06")).toBeNull();
  });
});

describe("trendNote", () => {
  const dates = ["2026-07-01", "2026-07-03", "2026-07-05", "2026-07-07"];
  test("regression flags", () => {
    const scores = { "2026-07-01": 100, "2026-07-07": 92 };
    const n = trendNote(dates, d => scores[d] ?? null);
    expect(n?.key).toBe("trend-down");
    expect(n.text).toMatch(/8%/);
  });
  test("progress praises", () => {
    const scores = { "2026-07-01": 100, "2026-07-07": 106 };
    expect(trendNote(dates, d => scores[d] ?? null)?.key).toBe("trend-up");
  });
  test("flat → null; short history → null", () => {
    const scores = { "2026-07-01": 100, "2026-07-07": 101 };
    expect(trendNote(dates, d => scores[d] ?? null)).toBeNull();
    expect(trendNote(dates.slice(0, TREND_SESSIONS), () => 100)).toBeNull();
  });
});

describe("buildCoachNotes", () => {
  const base = [
    "2026-06-10", "2026-06-13", "2026-06-17", "2026-06-20",
    "2026-06-24", "2026-06-27", "2026-07-01", "2026-07-04",
  ].map(d => rep(d, 100));
  test("adherence suppresses the redundant drop note", () => {
    const notes = buildCoachNotes(base, { todayStr: "2026-07-16" });
    expect(notes.some(n => n.key === "adherence")).toBe(true);
    expect(notes.some(n => n.key === "ramp-drop")).toBe(false);
  });
  test("caps at two, worst first", () => {
    const spiked = [...base, rep("2026-07-05", 300), rep("2026-07-06", 300)];
    const dates = ["2026-07-01", "2026-07-04", "2026-07-05", "2026-07-06"];
    const scores = { "2026-07-01": 100, "2026-07-06": 90 };
    const notes = buildCoachNotes(spiked, {
      todayStr: "2026-07-07", gripDates: dates, fitScoreAt: d => scores[d] ?? null,
    });
    expect(notes).toHaveLength(2);
    expect(notes[0].key).toBe("trend-down");
    expect(notes[1].key).toBe("ramp-spike");
  });
  test("nothing to say → empty array", () => {
    expect(buildCoachNotes(base, { todayStr: "2026-07-06" })).toEqual([]);
  });
});

describe("decisiveWhy", () => {
  test("ladder text wins outright", () => {
    expect(decisiveWhy({ adaptBoost: 2 }, { ladderText: "ladder: 5 reps, same load" }))
      .toBe("ladder: 5 reps, same load");
  });
  test("below-curve residual is the decisive factor", () => {
    const s = decisiveWhy({ adaptBoost: 1.3, room: 0.12, T: 160, staleStatus: "stale", zone: "endurance" });
    expect(s).toMatch(/12% below/);
    expect(s).toMatch(/160s/);
  });
  test("coverage snap suppresses the residual (measured at old T)", () => {
    const s = decisiveWhy({ adaptBoost: 1.3, room: 0.12, coverageSnap: true, staleStatus: "ok", zone: "strength" });
    expect(s).toMatch(/centered in the zone/);
  });
  test("never → anchor; stale → longest-unvisited; default → calibrated", () => {
    expect(decisiveWhy({ staleStatus: "never" })).toMatch(/anchors the curve/);
    expect(decisiveWhy({ staleStatus: "stale", zone: "str_endurance" })).toMatch(/str endurance is your longest-unvisited/);
    expect(decisiveWhy({ staleStatus: "ok" })).toMatch(/well-calibrated/);
  });
  test("cold start explains seeding", () => {
    expect(decisiveWhy({ coldStart: true, adaptBoost: 2 })).toMatch(/new grip/);
  });
});
