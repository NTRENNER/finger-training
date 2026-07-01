// Tests for src/model/weeklyReview.js.
// assembleReview (pure ranking/voice) is tested exhaustively here.
// gatherSignals' own detectors (grade PR, staleness, week window) are
// tested with light fixtures; the heavy model integrations it calls
// (curve fit, ladder, deload) are covered by those modules' own suites
// and validated on real data.

import { assembleReview, gatherSignals, buildWeeklyReview, formatWeeklyReview } from "../weeklyReview.js";

const REF = "2026-06-30";               // Tuesday → weekStart (Mon) = 2026-06-29
function addDays(ymd, n) {
  const d = new Date(`${ymd}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

function makeSignals(over = {}) {
  return {
    range: { weekStart: "2026-06-29", weekEnd: REF },
    finger: { daysThisWeek: 3, daysPerWeekBaseline: 3, curveByGrip: {}, ladderBumps: [], staleGrips: [], ...(over.finger || {}) },
    climbing: { daysThisWeek: 1, daysPerWeekBaseline: 2, prs: [], countThisWeek: 5, ...(over.climbing || {}) },
    support: { daysThisWeek: 1, staleWorkouts: [], ...(over.support || {}) },
    recovery: { level: "green", label: "Fresh — absorbing your load well", guidanceAction: null, ...(over.recovery || {}) },
    totalActivity: over.totalActivity != null ? over.totalActivity : 5,
  };
}

describe("assembleReview", () => {
  test("no signals → invites logging", () => {
    const r = assembleReview({ empty: true });
    expect(r.points).toEqual([]);
    expect(r.headline).toMatch(/No training logged/i);
  });

  test("low-sample week hedges", () => {
    const r = assembleReview(makeSignals({ totalActivity: 1, finger: { daysThisWeek: 1, daysPerWeekBaseline: 3 }, climbing: { daysThisWeek: 0, daysPerWeekBaseline: 2, prs: [] }, support: { daysThisWeek: 0, staleWorkouts: [] } }));
    expect(r.headline).toMatch(/Quiet week/i);
    expect(r.headline).toMatch(/lightly/i);
  });

  test("climbing PR is a win and drives the headline", () => {
    const r = assembleReview(makeSignals({ climbing: { daysThisWeek: 1, daysPerWeekBaseline: 2, prs: [{ discipline: "boulder", grade: "V6", prevGrade: "V5" }] } }));
    const win = r.points.find(p => p.kind === "win");
    expect(win).toBeTruthy();
    expect(win.text).toMatch(/V6/);
    expect(win.text).toMatch(/past best was V5/);
    expect(r.headline).toMatch(/Strong week|Big week/i);
  });

  test("red recovery → deload headline + guidance concern (when no wins)", () => {
    const r = assembleReview(makeSignals({ recovery: { level: "red", label: "Deload recommended", guidanceAction: "This week: limit finger training to 1 session." } }));
    expect(r.headline).toMatch(/back off|deload/i);
    const c = r.points.find(p => p.kind === "concern");
    expect(c.text).toMatch(/Deload recommended/);
    expect(c.text).toMatch(/limit finger training/);
  });

  test("yellow recovery → softening headline", () => {
    const r = assembleReview(makeSignals({ recovery: { level: "yellow", label: "Recovery softening — ease up soon", guidanceAction: null } }));
    expect(r.headline).toMatch(/eye on recovery/i);
    expect(r.points.find(p => p.kind === "concern").text).toMatch(/softening/i);
  });

  test("stale grip surfaces as a concern", () => {
    const r = assembleReview(makeSignals({ finger: { daysThisWeek: 3, daysPerWeekBaseline: 3, staleGrips: [{ grip: "Prime", days: 20 }] } }));
    const c = r.points.find(p => /Prime has gone quiet/i.test(p.text));
    expect(c).toBeTruthy();
    expect(c.text).toMatch(/20 days/);
  });

  test("a lighter but recovered week is framed as good rest, not a concern", () => {
    const r = assembleReview(makeSignals({ finger: { daysThisWeek: 1, daysPerWeekBaseline: 4 }, recovery: { level: "green", label: "Fresh" } }));
    const infoLine = r.points.find(p => p.kind === "info");
    expect(infoLine.text).toMatch(/good rest/i);
    expect(r.points.some(p => p.kind === "concern")).toBe(false);
  });

  test("steady week with nothing notable says so", () => {
    const r = assembleReview(makeSignals());
    expect(r.headline).toMatch(/Steady/i);
    expect(r.points.filter(p => p.kind === "concern")).toHaveLength(0);
  });

  test("wins lead, concerns middle, one info; order preserved", () => {
    const r = assembleReview(makeSignals({
      climbing: { daysThisWeek: 2, daysPerWeekBaseline: 2, prs: [{ discipline: "boulder", grade: "V7", prevGrade: "V6" }] },
      finger: { daysThisWeek: 3, daysPerWeekBaseline: 3, staleGrips: [{ grip: "Prime", days: 15 }] },
    }));
    const kinds = r.points.map(p => p.kind);
    expect(kinds[0]).toBe("win");
    expect(kinds.indexOf("concern")).toBeGreaterThan(kinds.indexOf("win"));
    expect(kinds.filter(k => k === "info")).toHaveLength(1);
  });

  test("formatWeeklyReview renders headline + marked bullets", () => {
    const txt = formatWeeklyReview(assembleReview(makeSignals({ climbing: { daysThisWeek: 1, daysPerWeekBaseline: 2, prs: [{ discipline: "rope", grade: "5.12a", prevGrade: "5.11d" }] } })));
    expect(txt).toMatch(/✅/);
    expect(txt).toMatch(/5\.12a/);
  });
});

describe("gatherSignals detectors", () => {
  const climb = (daysAgo, grade, over = {}) => ({ date: addDays(REF, -daysAgo), type: "climbing", discipline: "boulder", grade, ascent: "redpoint", ...over });

  test("grade PR per discipline, gated by ascent style", () => {
    const acts = [
      climb(0, "V6"),                       // this week (06-30), sent
      climb(10, "V5"),                      // prior best sent
      climb(0, "V7", { ascent: "attempt" }),// this week but NOT sent → ignored
    ];
    const s = gatherSignals([], acts, [], { refDate: REF });
    const pr = s.climbing.prs.find(p => p.discipline === "boulder");
    expect(pr).toBeTruthy();
    expect(pr.grade).toBe("V6");
    expect(pr.prevGrade).toBe("V5");
  });

  test("no PR when this week's best doesn't beat prior", () => {
    const acts = [climb(0, "V4"), climb(10, "V6")];
    const s = gatherSignals([], acts, [], { refDate: REF });
    expect(s.climbing.prs).toHaveLength(0);
  });

  test("boulder and rope PRs are tracked independently", () => {
    const acts = [
      climb(0, "V6"), climb(12, "V5"),
      { date: addDays(REF, 0), type: "climbing", discipline: "sport", grade: "5.12a", ascent: "redpoint" },
      { date: addDays(REF, -12), type: "climbing", discipline: "sport", grade: "5.11c", ascent: "redpoint" },
    ];
    const s = gatherSignals([], acts, [], { refDate: REF });
    expect(s.climbing.prs.map(p => p.discipline).sort()).toEqual(["boulder", "rope"]);
  });

  test("staleness: a grip untrained ≥12 days is flagged", () => {
    const hist = [
      { date: addDays(REF, -15), grip: "Prime", hand: "L", actual_time_s: 10, target_duration: 12 },
      { date: addDays(REF, -1), grip: "Micro", hand: "L", actual_time_s: 20, target_duration: 20 },
    ];
    const s = gatherSignals(hist, [], [], { refDate: REF });
    expect(s.finger.staleGrips.find(g => g.grip === "Prime").days).toBe(15);
    expect(s.finger.staleGrips.find(g => g.grip === "Micro")).toBeFalsy();
  });

  test("week window anchors to Monday via weekKey", () => {
    const s = gatherSignals([], [climb(0, "V3")], [], { refDate: REF });
    expect(s.range.weekStart).toBe("2026-06-29"); // Monday of REF's week
    expect(s.range.weekEnd).toBe(REF);
  });

  test("buildWeeklyReview wires gather → assemble", () => {
    const r = buildWeeklyReview([], [{ date: REF, type: "climbing", discipline: "boulder", grade: "V6", ascent: "flash" }], [], { refDate: REF });
    expect(r.headline).toBeTruthy();
    expect(Array.isArray(r.points)).toBe(true);
  });
});
