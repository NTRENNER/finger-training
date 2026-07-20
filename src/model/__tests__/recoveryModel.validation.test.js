// ──────────────────────────────────────────────────────────────
// RECOVERY-MODEL VALIDATION HARNESS  (nonlinear solver, July 2026)
// ──────────────────────────────────────────────────────────────
// Re-runnable, time-separated (forward-chained) holdout that reproduces
// EVERY headline number in scripts/recovery-validation.md, so the writeup
// stays verifiable. It answers:
//   1. Do PERSONAL recovery taus beat the population prior on HELD-OUT
//      sessions under the nonlinear constant-force solver?
//   2. What is the real gap noise on each statistic the app reads —
//      the 3-session SMOOTHED gap (chart band + coaching = GAP_NOISE_BAND)
//      and the 2-session MEAN (deload gate = DELOAD_GAP_TRIGGER)?
//   3. How often would the cross-grip deload gate have fired historically?
//
// It reuses the EXACT production code (recoveryFit + fatigue + the deload
// detector's own recentGapHeldOut), so it can't drift from what ships.
// Runs only when RECOVERY_VALIDATION_JSON points at an export of the
// user's multi-rep sets — that data is private and NOT committed, so the
// harness self-skips in CI. Export shape:
//   [{ grip, hand, session_id, set_num, date, rest_s, times:[t1,t2,...] }]
import fs from "fs";
import { computePersonalRecoveryTausForGrip } from "../recoveryFit.js";
import { predictRepTimes, PHYS_MODEL_DEFAULT } from "../fatigue.js";
import { GAP_NOISE_BAND } from "../recoveryDynamics.js";
import { recentGapHeldOut, DELOAD_GAP_TRIGGER, DELOAD_MIN_SESSIONS } from "../deload.js";

const DATA_PATH = process.env.RECOVERY_VALIDATION_JSON;
const maybe = (DATA_PATH && fs.existsSync(DATA_PATH)) ? test : test.skip;

const repsFromSets = (sets) => sets.flatMap(s => s.times.map((t, i) => ({
  session_id: s.session_id, hand: s.hand, set_num: s.set_num, grip: s.grip,
  date: s.date, rep_num: i + 1, actual_time_s: t, rest_s: s.rest_s,
})));
const predict = (pm, set) => predictRepTimes({
  numReps: set.times.length, firstRepTime: set.times[0],
  restSeconds: set.rest_s, physModel: pm, roundTo: null });
const physFromTaus = (t) => ({ weights: PHYS_MODEL_DEFAULT.weights, tauD: PHYS_MODEL_DEFAULT.tauD,
  tauR: t ? { fast: t.fast, medium: t.medium, slow: t.slow } : PHYS_MODEL_DEFAULT.tauR });
const mean = a => a.length ? a.reduce((s, x) => s + x, 0) / a.length : NaN;
const std  = a => Math.sqrt(mean(a.map(x => x * x)) - mean(a) ** 2);
const rmse = a => Math.sqrt(mean(a.map(x => x * x)));
const r3 = x => +x.toFixed(3);

maybe("nonlinear recovery model: personalization wins + noise/deload calibration", () => {
  const SETS = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const hist = repsFromSets(SETS);
  const grips = [...new Set(SETS.map(s => s.grip))].filter(g => SETS.filter(x => x.grip === g).length >= 8);
  const report = {};
  const win2Series = {};

  for (const grip of grips) {
    const gs = SETS.filter(s => s.grip === grip).sort((a, b) => (a.date < b.date ? -1 : 1));
    const ePers = [], ePop = [], gaps = [];
    let nMature = 0;
    for (const t of gs) {
      const prior = gs.filter(s => s.date < t.date);   // strictly-earlier days: no leakage
      if (prior.length < 5) continue;
      nMature++;
      const taus = computePersonalRecoveryTausForGrip(repsFromSets(prior), grip);
      const pm = physFromTaus(taus);
      const pp = predict(pm, t), po = predict(PHYS_MODEL_DEFAULT, t);
      for (let j = 1; j < t.times.length; j++) { ePers.push(t.times[j] - pp[j]); ePop.push(t.times[j] - po[j]); }
      if (t.times.length >= 2 && t.times[0] > 0) gaps.push({ date: t.date, g: t.times[1] / t.times[0] - pp[1] / pp[0] });
    }
    const raw = gaps.map(x => x.g);
    const sm3 = gaps.map((_, i) => mean(gaps.slice(Math.max(0, i - 2), i + 1).map(x => x.g)));
    // production deload statistic, via the SHIPPING recentGapHeldOut
    const dates = [...new Set(gs.map(s => s.date))].sort();
    const w2 = dates.map(d => { const r = recentGapHeldOut(hist, grip, d, DELOAD_MIN_SESSIONS); return r ? { date: d, m: r.mean } : null; }).filter(Boolean);
    win2Series[grip] = w2;
    report[grip] = {
      nMature,
      rmsePersonal: r3(rmse(ePers)), rmsePopulation: r3(rmse(ePop)),
      rawGapMean: r3(mean(raw)), rawGapStd: r3(std(raw)),
      smoothed3Std: r3(std(sm3)),
      pctRawOutside_010: r3(raw.filter(g => Math.abs(g) > 0.10).length / raw.length),
      pctRawOutside_015: r3(raw.filter(g => Math.abs(g) > 0.15).length / raw.length),
      deloadStat_2sessMean: r3(mean(w2.map(x => x.m))),
      deloadStat_2sessStd: r3(std(w2.map(x => x.m))),
    };
  }

  // Cross-grip deload firing: over ref dates where every grip has a
  // 2-session held-out mean, fraction where ALL are below the trigger.
  const allDates = [...new Set(SETS.map(s => s.date))].sort();
  const fireAt = (trig) => {
    let elig = 0, fired = 0;
    for (const d of allDates) {
      const vals = grips.map(g => { const w = win2Series[g].filter(x => x.date <= d).pop(); return w ? w.m : null; }).filter(v => v != null);
      if (vals.length < grips.length) continue;
      elig++; if (vals.every(v => v < trig)) fired++;
    }
    return { eligibleRefDates: elig, firedRate: r3(fired / elig) };
  };
  const firing = { "-0.10": fireAt(-0.10), "-0.15": fireAt(-0.15), "-0.20": fireAt(-0.20),
                   [`production(-${DELOAD_GAP_TRIGGER})`]: fireAt(-DELOAD_GAP_TRIGGER) };

  // eslint-disable-next-line no-console
  console.log("RECOVERY VALIDATION\n" + JSON.stringify({
    GAP_NOISE_BAND, DELOAD_GAP_TRIGGER, DELOAD_MIN_SESSIONS, perGrip: report, crossGripDeloadFiring: firing,
  }, null, 2));

  for (const [, r] of Object.entries(report)) {
    // 1. personalization must not do WORSE out-of-sample than population.
    if (r.nMature >= 10) expect(r.rmsePersonal).toBeLessThanOrEqual(r.rmsePopulation * 1.02);
  }
  // 3. the shipping deload trigger must not over-fire historically for a
  //    mostly-recovered athlete (guards against a mis-set trigger).
  expect(firing[`production(-${DELOAD_GAP_TRIGGER})`].firedRate).toBeLessThanOrEqual(0.15);
});
