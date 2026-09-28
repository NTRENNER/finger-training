// Descriptive analysis only. Never used to prescribe loads. Fit the full
// available history at each date BEFORE applying the chart's visible window.
import { prepareEvaluationRows } from './evaluationRows.js';
import { freshFitReps } from './load.js';
import { loadProvenance } from './forceRecording.js';
import { fitEstablishedTrend } from './capacityTrendFit.js';
import { computeBalancedCurveScore, predForceThreeExp } from './threeExp.js';
const dayMs = 86400000;
const mean = values => values.reduce((a,b)=>a+b,0)/values.length;
const nextDate = date => new Date(Date.parse(date)+dayMs).toISOString().slice(0,10);

export function buildPerformanceTrends(history, grips, hand = 'pooled') {
  const clean = prepareEvaluationRows(history || []).rows;
  const eligibleAt = date => freshFitReps(clean.filter(r=>r.date<=date)).filter(r => grips.includes(r.grip)
    && ['legacy_measured','measured_force'].includes(loadProvenance(r))
    && Number.isFinite(r.avg_force_kg) && r.avg_force_kg > 0
    && r.actual_time_s > 0 && r.actual_time_s <= 600);
  const dates = [...new Set(clean.filter(r=>grips.includes(r.grip)).map(r=>r.date))].sort();
  const hands = hand === 'pooled' ? ['L','R'] : [hand];
  const baselines = new Map(), cache = new Map();
  const fit = (grip,h,date) => {
    const key = `${grip}|${h}|${date}`;
    if (!cache.has(key)) cache.set(key,fitEstablishedTrend(clean,h,grip,date,{prepared:true}));
    return cache.get(key);
  };
  return dates.map(date => {
    const eligible = eligibleAt(date);
    const previousDate = new Date(Date.parse(date)-dayMs).toISOString().slice(0,10);
    const priorEligible = eligibleAt(previousDate);
    const row = {date, timestamp:Date.parse(date)};
    for (const grip of grips) {
      const current = eligible.filter(r=>r.grip===grip && r.date===date && hands.includes(r.hand));
      if (!current.length) continue;
      // Both-hand views require both curves, weighted equally. Extra reps on
      // one hand never change the hand weighting of the capacity index.
      const scores = hands.map(h=>{
        const model = fit(grip,h,nextDate(date));
        return model ? computeBalancedCurveScore(model.established) : null;
      });
      if (scores.every(s=>Number.isFinite(s)&&s>0)) {
        const score = Math.exp(mean(scores.map(Math.log)));
        if (!baselines.has(grip)) baselines.set(grip,score);
        row[`${grip}_long`] = (score/baselines.get(grip)-1)*100;
      }
      const deviations = hands.map(h=>{
        const prior = fit(grip,h,date);
        if (!prior) return null;
        const old = priorEligible.filter(r=>r.grip===grip&&r.hand===h);
        const priorAcquired = priorEligible.filter(r=>r.grip===grip).every(r=>r.force_recording?.basis==='target_acquired');
        const minT = Math.min(...old.map(r=>r.actual_time_s));
        const maxT = Math.max(...old.map(r=>r.actual_time_s));
        // Do not score a new duration outside that hand's observed coverage.
        const values = current.filter(r=>r.hand===h&&r.actual_time_s>=minT&&r.actual_time_s<=maxT
          && (!priorAcquired || (r.force_recording?.basis==='target_acquired' && r.force_recording?.interval_basis_applied!=='legacy_elapsed')))
          .map(r=>100*(r.avg_force_kg/predForceThreeExp(prior.established,r.actual_time_s)-1))
          .filter(Number.isFinite);
        return values.length ? mean(values) : null;
      }).filter(Number.isFinite);
      if (deviations.length) row[`${grip}_short`] = mean(deviations);
      row[`${grip}_holds`] = current.length;
    }
    return row;
  }).filter(row=>grips.some(g=>Number.isFinite(row[`${g}_long`])||Number.isFinite(row[`${g}_short`])));
}
