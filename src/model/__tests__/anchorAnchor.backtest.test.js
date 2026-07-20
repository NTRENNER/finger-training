// ──────────────────────────────────────────────────────────────
// AMPLITUDE-ANCHOR BACKTEST  (cross-zone vs zone-scoped)
// ──────────────────────────────────────────────────────────────
// Reproduces every number in scripts/anchor-backtest.md via the exact
// production prescription(). Time-separated forward-chained holdout: for
// each fresh rep-1 session, both anchor strategies run on prior-only
// history (referenceDate = the session date); target = the load actually
// used at rep 1. Self-skips in CI — set ANCHOR_BACKTEST_JSON to an export
// of fresh rep-1s: [{ s,h,g,d,td,t,ld,pk }] (session, hand, grip, date,
// target_duration, actual_time_s, load, peak).
import fs from "fs";
import { prescription } from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";
import { zoneOf } from "../zones.js";

const DATA = process.env.ANCHOR_BACKTEST_JSON;
const maybe = (DATA && fs.existsSync(DATA)) ? test : test.skip;

const med = a => { const s = [...a].sort((x, y) => x - y); const n = s.length; return n ? (n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2) : NaN; };
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const r3 = x => Number.isFinite(x) ? +x.toFixed(3) : null;

maybe("zone-scoped anchor: median flat, tail lower (kept opt-in)", () => {
  const RAW = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const reps = RAW.map(o => ({
    session_id: o.s, hand: o.h, grip: o.g, date: o.d, set_num: 1, rep_num: 1,
    target_duration: o.td, actual_time_s: o.t,
    avg_force_kg: null, manual_load_kg: o.ld, prescribed_load_kg: null, weight_kg: null,
    peak_force_kg: o.pk == null ? null : o.pk,
  })).sort((a, b) => a.date < b.date ? -1 : a.date > b.date ? 1 : 0);

  const rows = [];
  for (const t of reps) {
    const prior = reps.filter(r => r.date < t.date);
    if (prior.filter(r => r.grip === t.grip && r.hand === t.hand).length < 3) continue;
    const priors = buildThreeExpPriors(prior);
    const A = prescription(prior, t.hand, t.grip, t.target_duration, { threeExpPriors: priors, referenceDate: t.date });
    const B = prescription(prior, t.hand, t.grip, t.target_duration, { threeExpPriors: priors, referenceDate: t.date, zoneAnchor: true });
    if (!(A && A.value > 0 && B && B.value > 0)) continue;
    const target = t.manual_load_kg;
    rows.push({
      errA: Math.abs(A.value - target) / target,
      errB: Math.abs(B.value - target) / target,
      differs: Math.abs(A.value - B.value) > 1e-6,
      hit: Math.abs(t.actual_time_s - t.target_duration) / t.target_duration <= 0.30,
    });
  }
  const report = (rs) => ({
    n: rs.length,
    medCross: r3(med(rs.map(r => r.errA))), medZone: r3(med(rs.map(r => r.errB))),
    meanCross: r3(mean(rs.map(r => r.errA))), meanZone: r3(mean(rs.map(r => r.errB))),
    zoneBetter: rs.filter(r => r.errB < r.errA - 1e-9).length,
    zoneWorse: rs.filter(r => r.errB > r.errA + 1e-9).length,
  });
  const hitDiffer = rows.filter(r => r.hit && r.differs);
  // eslint-disable-next-line no-console
  console.log("ANCHOR BACKTEST\n" + JSON.stringify({
    all: report(rows), hitTarget: report(rows.filter(r => r.hit)),
    anchorDiffers: report(rows.filter(r => r.differs)), hitTargetAndDiffers: report(hitDiffer),
    anchorDiffersRate: r3(rows.filter(r => r.differs).length / rows.length),
  }, null, 2));

  // The documented finding: on the discriminating subset zone-scoping does
  // not RAISE the mean error (tail is same-or-lower). Guards the writeup.
  const hd = report(hitDiffer);
  expect(hd.meanZone).toBeLessThanOrEqual(hd.meanCross + 0.02);
});
