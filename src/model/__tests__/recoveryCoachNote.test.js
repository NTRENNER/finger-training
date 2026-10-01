import { measuredRecoveryFields } from "../../testHelpers/recovery.js";
// Coverage for the per-grip recovery coaching signal (Aug 2026):
// recoveryCoachSignals (the compact per-grip read) + recoveryNote (the
// early-warn / reassure copy) + its buildCoachNotes priority.
import { recoveryCoachSignals } from "../recoveryDynamics.js";
import {
  recoveryNote, buildCoachNotes,
  RECOVERY_BAND_PP, RECOVERY_DECLINE_PP,
} from "../coachNotes.js";

// ── recoveryCoachSignals ──────────────────
describe("recoveryCoachSignals", () => {
  const sess = (id, date, t1, frac) => ([
    { ...measuredRecoveryFields(), session_id: id, date, grip: "Micro", hand: "L", set_num: 1, rep_num: 1, actual_time_s: t1, rest_s: 20 },
    { ...measuredRecoveryFields(), session_id: id, date, grip: "Micro", hand: "L", set_num: 1, rep_num: 2, actual_time_s: Math.round(t1 * frac), rest_s: 20 },
  ]);

  test("too few sessions → no signal for the grip", () => {
    const hist = [...sess("s1", "2026-06-01", 30, 0.8), ...sess("s2", "2026-06-03", 30, 0.8)];
    expect(recoveryCoachSignals(hist)).toEqual([]);
  });

  test("emits a compact per-grip signal once there's enough data", () => {
    const hist = [
      ...sess("s1", "2026-06-01", 30, 0.9),
      ...sess("s2", "2026-06-03", 30, 0.85),
      ...sess("s3", "2026-06-05", 30, 0.6),
      ...sess("s4", "2026-06-07", 30, 0.55),
      ...sess("s5", "2026-06-09", 30, 0.5),
    ];
    const micro = recoveryCoachSignals(hist).find(s => s.grip === "Micro");
    expect(micro).toBeTruthy();
    expect(micro.nPoints).toBeGreaterThanOrEqual(4);
    expect(micro.recoveryDeltaPct).toBeLessThan(0); // recovery fell across the block
  });

  test("empty / bad input → []", () => {
    expect(recoveryCoachSignals([])).toEqual([]);
    expect(recoveryCoachSignals(null)).toEqual([]);
  });

  test("later depleted sessions and extra sets cannot change the sustained coaching signal", () => {
    const hist = ['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-07', '2026-06-09']
      .flatMap(date => sess(`${date}-am`, date, 30, 0.9)
        .map(r => ({ ...r, session_started_at: `${date}T08:00:00Z` })));
    const extra = hist.filter(r => r.rep_num === 1).flatMap(r => [
      ...sess(`${r.date}-pm`, r.date, 30, 0.1)
        .map(rep => ({ ...rep, session_started_at: `${r.date}T18:00:00Z` })),
      ...sess(r.session_id, r.date, 30, 0.1)
        .map(rep => ({ ...rep, session_started_at: r.session_started_at, set_num: 2 })),
    ]);
    const before = recoveryCoachSignals(hist, { todayStr: '2026-06-09' });
    expect(before).toHaveLength(1);
    expect(recoveryCoachSignals([...hist, ...extra], { todayStr: '2026-06-09' })).toEqual(before);
  });

  test("requires the complete smoothed evidence window to remain current", () => {
    const hist = ['2026-06-01', '2026-06-03', '2026-06-05', '2026-06-07', '2026-06-09']
      .flatMap(date => sess(date, date, 30, 0.3));
    expect(recoveryCoachSignals(hist, { todayStr: '2026-06-19' })).toHaveLength(1);
    expect(recoveryCoachSignals(hist, { todayStr: '2026-06-20' })).toEqual([]);
    expect(buildCoachNotes(hist, { todayStr: '2026-07-01' })
      .some(n => n.key === 'recovery-warn' || n.key === 'recovery-ok')).toBe(false);
  });
});

// ── recoveryNote + buildCoachNotes wiring ─────────
describe("recoveryNote", () => {
  test("early-warns on a grip whose recent gap is below the band", () => {
    const n = recoveryNote([
      { grip: "Micro", recentGapPct: -15, recoveryDeltaPct: -3, nPoints: 6 },
      { grip: "Crusher", recentGapPct: 2, recoveryDeltaPct: 1, nPoints: 6 },
    ]);
    expect(n).toMatchObject({ key: "recovery-warn", tone: "warn" });
    expect(n.text).toMatch(/Micro/);
    expect(n.text).toMatch(/15pp/);
  });

  test("picks the worst grip when several are slipping", () => {
    const n = recoveryNote([
      { grip: "Micro", recentGapPct: -12, recoveryDeltaPct: 0, nPoints: 6 },
      { grip: "Crusher", recentGapPct: -22, recoveryDeltaPct: 0, nPoints: 6 },
    ]);
    expect(n.text).toMatch(/Crusher/);
  });

  test("reassures when recovery declined but the gap is within the band", () => {
    const n = recoveryNote([
      { grip: "Crusher", recentGapPct: -2, recoveryDeltaPct: -14, nPoints: 8 },
    ]);
    expect(n).toMatchObject({ key: "recovery-ok", tone: "info" });
    expect(n.text).toMatch(/tracking the nonlinear fatigue model/i);
    expect(n.text).toMatch(/Crusher/);
  });

  test("warn takes precedence over reassure", () => {
    const n = recoveryNote([
      { grip: "Micro", recentGapPct: -18, recoveryDeltaPct: -20, nPoints: 8 },
    ]);
    expect(n.key).toBe("recovery-warn");
  });

  test("silent when gaps are within band and recovery is steady", () => {
    expect(recoveryNote([{ grip: "Micro", recentGapPct: -3, recoveryDeltaPct: -2, nPoints: 8 }])).toBeNull();
    expect(recoveryNote([])).toBeNull();
    expect(recoveryNote(null)).toBeNull();
  });

  test("a declining observation without a model comparison does not imply recovery is tracking it", () => {
    expect(recoveryNote([{ grip: 'Micro', recentGapPct: null, recoveryDeltaPct: -20, nPoints: 8 }])).toBeNull();
    expect(recoveryNote([{ grip: 'Micro', recentGapPct: 50, recoveryDeltaPct: -20, nPoints: 8 }])).toBeNull();
  });

  test("band + decline thresholds are exported and sane", () => {
    expect(RECOVERY_BAND_PP).toBe(15);
    expect(RECOVERY_DECLINE_PP).toBeLessThan(0);
  });

  test("buildCoachNotes surfaces an injected recovery warning at high priority", () => {
    const notes = buildCoachNotes([], {
      todayStr: "2026-07-15",
      recoverySignals: [{ grip: "Micro", recentGapPct: -16, recoveryDeltaPct: -4, nPoints: 6 }],
    });
    expect(notes.some(n => n.key === "recovery-warn")).toBe(true);
  });
});
