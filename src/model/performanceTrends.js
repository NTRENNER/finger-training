import { fitContextualTrend } from './contextualTrendFit.js';
import { trainingDayContext } from './trainingDayContext.js';
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

export const DEFAULT_PERFORMANCE_TREND_MODEL = 'contextOnly';

// The optional read-only evidence sink shares these exact fits and scored holds
// with the analysis view. It never changes the returned rows or the model.
export function buildPerformanceTrends(history, grips, hand = 'pooled', {model = DEFAULT_PERFORMANCE_TREND_MODEL, onEvidence = null} = {}) {
  const clean = prepareEvaluationRows(history || []).rows;
  const context = trainingDayContext(clean);
  const eligibleAt = date => freshFitReps(clean.filter(r=>r.date<=date), { includeLaterSessions: true }).filter(r => grips.includes(r.grip)
    && ['legacy_measured','measured_force'].includes(loadProvenance(r))
    && Number.isFinite(r.avg_force_kg) && r.avg_force_kg > 0
    && r.actual_time_s > 0 && r.actual_time_s <= 600);
  const dates = [...new Set(clean.filter(r=>grips.includes(r.grip)).map(r=>r.date))].sort();
  const hands = hand === 'pooled' ? ['L','R'] : [hand];
  const baselines = new Map(), cache = new Map();
  const fit = (grip,h,date) => {
    const key = `${grip}|${h}|${date}`;
    if (!cache.has(key)) cache.set(key,model==='original'
      ? fitEstablishedTrend(clean,h,grip,date,{prepared:true})
      : fitContextualTrend(clean,h,grip,date,{prepared:true,robust:model==='contextRobust'}));
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
      const models = hands.map(h=>fit(grip,h,nextDate(date)));
      const scores = models.map(model=>{
        return model ? computeBalancedCurveScore(model.established) : null;
      });
      let score = null;
      if (scores.every(s=>Number.isFinite(s)&&s>0)) {
        score = Math.exp(mean(scores.map(Math.log)));
        if (!baselines.has(grip)) baselines.set(grip,score);
        row[`${grip}_long`] = (score/baselines.get(grip)-1)*100;
      }
      const observations = [];
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
          .map(r=>{
            const expectedForce = predForceThreeExp(prior.established,r.actual_time_s);
            const deviation = 100*(r.avg_force_kg/expectedForce-1);
            if (onEvidence && Number.isFinite(deviation)) observations.push({rep:r,expectedForce,deviation,context:context(r)});
            return deviation;
          })
          .filter(Number.isFinite);
        return values.length ? mean(values) : null;
      }).filter(Number.isFinite);
      if (deviations.length) row[`${grip}_short`] = mean(deviations);
      row[`${grip}_holds`] = current.length;
      row[`${grip}_laterHolds`] = current.filter(r=>context(r).status==='after_training').length;
      if (onEvidence) onEvidence({date,grip,hands,score,models,history:clean,
        eligible:eligible.filter(r=>r.grip===grip&&hands.includes(r.hand)),observations});
    }
    return row;
  }).filter(row=>grips.some(g=>Number.isFinite(row[`${g}_long`])||Number.isFinite(row[`${g}_short`])));
}
