// ──────────────────────────────────────────────────────────────
// RECOVERY-MODEL VALIDATION HARNESS  (nonlinear solver, July 2026)
// ──────────────────────────────────────────────────────────────
// Re-runnable, time-separated (forward-chained) holdout that answers two
// questions the linear→nonlinear predictor swap re-opened:
//   1. Do PERSONAL recovery taus still beat the population prior on
//      HELD-OUT sessions under the nonlinear constant-force solver?
//   2. What is the real session-to-session gap noise, so the ±band and
//      the deload trigger (GAP_NOISE_BAND) are set to the right scale?
//
// It reuses the exact production code (recoveryFit + fatigue), so it can
// never drift from what ships. It runs only when RECOVERY_VALIDATION_JSON
// points at an export of the user's multi-rep sets — that data is private
// and NOT committed, so the harness self-skips in CI. Export shape:
//   [{ grip, hand, session_id, set_num, date, rest_s, times:[t1,t2,...] }]
//   (one row per (session,hand,set) with >=2 timed reps)
// Findings from the 2026-07 run are written up in
// scripts/recovery-validation.md.
import fs from "fs";
import { computePersonalRecoveryTausForGrip } from "../recoveryFit.js";
import { predictRepTimes, PHYS_MODEL_DEFAULT } from "../fatigue.js";
import { GAP_NOISE_BAND } from "../recoveryDynamics.js";

const DATA_PATH = process.env.RECOVERY_VALIDATION_JSON;
const hasData = DATA_PATH && fs.existsSync(DATA_PATH);
const maybe = hasData ? test : test.skip;

const repsFromSets = (sets) => sets.flatMap(s => s.times.map((t, i) => ({
  session_id: s.session_id, hand: s.hand, set_num: s.set_num, grip: s.grip,
  date: s.date, rep_num: i + 1, actual_time_s: t, rest_s: s.rest_s,
})));
const predict = (pm, set) => predictRepTimes({
  numReps: set.times.length, firstRepTime: set.times[0],
  restSeconds: set.rest_s, physModel: pm, roundTo: null });
const mean = a => a.reduce((s, x) => s + x, 0) / a.length;
const std  = a => Math.sqrt(mean(a.map(x => x * x)) - mean(a) ** 2);
const rmse = a => Math.sqrt(mean(a.map(x => x * x)));

maybe("personal recovery taus beat population out-of-sample under the nonlinear solver", () => {
  const SETS = JSON.parse(fs.readFileSync(DATA_PATH, "utf8"));
  const grips = [...new Set(SETS.map(s => s.grip))];
  const report = {};

  for (const grip of grips) {
    const gs = SETS.filter(s => s.grip === grip).sort((a, b) => (a.date < b.date ? -1 : 1));
    const ePers = [], ePop = [], gaps = [];
    let nMature = 0;
    for (const t of gs) {
      const prior = gs.filter(s => s.date < t.date);      // strictly-earlier days: no leakage
      if (prior.length < 5) continue;                     // "mature": prior comparable to PRIOR_WEIGHT
      nMature++;
      const taus = computePersonalRecoveryTausForGrip(repsFromSets(prior), grip);
      const pm = taus ? { ...PHYS_MODEL_DEFAULT, tauR: { fast: taus.fast, medium: taus.medium, slow: taus.slow } } : PHYS_MODEL_DEFAULT;
      const pp = predict(pm, t), po = predict(PHYS_MODEL_DEFAULT, t);
      for (let j = 1; j < t.times.length; j++) { ePers.push(t.times[j] - pp[j]); ePop.push(t.times[j] - po[j]); }
      if (t.times.length >= 2 && t.times[0] > 0) gaps.push(t.times[1] / t.times[0] - pp[1] / pp[0]);
    }
    if (ePers.length === 0) continue;
    report[grip] = {
      nMature, rmsePersonal: +rmse(ePers).toFixed(2), rmsePopulation: +rmse(ePop).toFixed(2),
      gapMean: +mean(gaps).toFixed(3), gapStd: +std(gaps).toFixed(3),
    };
  }

  // eslint-disable-next-line no-console
  console.log("RECOVERY VALIDATION\n" + JSON.stringify(report, null, 2) + `\nGAP_NOISE_BAND=${GAP_NOISE_BAND}`);

  // Invariant: for any grip with a mature training history, personalizing
  // the recovery taus must not do WORSE out-of-sample than the population
  // prior (a small tolerance absorbs sampling noise).
  for (const [grip, r] of Object.entries(report)) {
    if (r.nMature >= 10) {
      expect(r.rmsePersonal).toBeLessThanOrEqual(r.rmsePopulation * 1.02);
    }
  }
});
