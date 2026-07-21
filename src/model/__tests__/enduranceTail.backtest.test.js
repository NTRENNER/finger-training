// ─────────────────────────────────────────────────────
// ENDURANCE-TAIL CEILING BACKTEST  (real data, self-skips in CI)
// ─────────────────────────────────────────────────────
// Reproduces scripts/endurance-tail-backtest.md via the shipping
// prescription() + enduranceCeilingKg(). Forward-chained: for each
// measured fresh failure, fit on prior-only history and predict the load
// actually sustained at that duration. Asserts the ceiling does not raise
// long-hold error and leaves mid-zone targets untouched.
//
// Private rep data is never committed. Point ENDURANCE_BACKTEST_JSON at an
// export of measured rep-1 rows: [{ d, g, h, td, t, af }]
// (date, grip, hand, target_duration, actual_time_s, avg_force_kg).
import fs from "fs";
import { prescription, buildFreshLoadMap } from "../prescription.js";
import { buildThreeExpPriors } from "../threeExp.js";
import { enduranceCeilingKg, CEIL_MIN_T } from "../enduranceTail.js";

const DATA = process.env.ENDURANCE_BACKTEST_JSON;
const maybe = (DATA && fs.existsSync(DATA)) ? test : test.skip;
const med = (a) => { const s = [...a].sort((x, y) => x - y); const n = s.length;
  return n ? s[Math.floor(n / 2)] : NaN; };
const mean = (a) => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const r3 = (x) => Number.isFinite(x) ? +x.toFixed(3) : null;

maybe("endurance ceiling lowers long-hold error, leaves mid-zone untouched", () => {
  const RAW = JSON.parse(fs.readFileSync(DATA, "utf8"));
  const reps = RAW.map(o => ({
    date: o.d, grip: o.g, hand: o.h, target_duration: o.td, actual_time_s: o.t,
    avg_force_kg: o.af, rep_num: 1, set_num: 1, session_id: `${o.d}${o.g}${o.h}`,
  })).filter(r => r.avg_force_kg > 0);

  const eLong = [], cLong = [];
  let midCapped = 0;
  for (const g of [...new Set(reps.map(r => r.grip))]) {
    for (const h of ["L", "R"]) {
      const seq = reps.filter(r => r.grip === g && r.hand === h).sort((a, b) => a.date < b.date ? -1 : 1);
      for (const p of seq) {
        const T = p.actual_time_s;
        if (T < 90) continue;
        const prior = seq.filter(q => q.date < p.date);
        if (prior.length < 5 || new Set(prior.map(q => Math.round(q.actual_time_s))).size < 3) continue;
        const priors = buildThreeExpPriors(prior), fm = buildFreshLoadMap(prior);
        const base = { threeExpPriors: priors, freshMap: fm, referenceDate: p.date };
        const eng = prescription(prior, h, g, T, { ...base, enduranceCeiling: false });
        const cei = prescription(prior, h, g, T, base);
        if (!eng || !(eng.value > 0) || !cei || !(cei.value > 0)) continue;
        const act = p.avg_force_kg;
        if (T >= CEIL_MIN_T) {
          eLong.push(Math.abs(eng.value - act) / act);
          cLong.push(Math.abs(cei.value - act) / act);
        } else if (cei.enduranceCeiled) {
          midCapped++;   // must be zero: ceiling never fires mid-zone
        }
      }
    }
  }
  // eslint-disable-next-line no-console
  console.log("ENDURANCE CEILING BACKTEST\n" + JSON.stringify({
    longN: cLong.length,
    engine: { med: r3(med(eLong)), mean: r3(mean(eLong)) },
    ceiling: { med: r3(med(cLong)), mean: r3(mean(cLong)) },
    midZoneEngagements: midCapped,
  }, null, 2));

  expect(midCapped).toBe(0);                                  // never touches mid-zone
  expect(mean(cLong)).toBeLessThanOrEqual(mean(eLong) + 1e-9); // tail no worse (it's a cap)
});
