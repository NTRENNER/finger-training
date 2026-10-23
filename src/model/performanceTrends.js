import { fitContextualTrend } from './contextualTrendFit.js';
import { trainingDayContext } from './trainingDayContext.js';
// Descriptive analysis only. Never used to prescribe loads. Fit the full
// available history at each date BEFORE applying the chart's visible window.
import { prepareEvaluationRows } from './evaluationRows.js';
import { freshFitReps } from './load.js';
import { loadProvenance } from './forceRecording.js';
import { fitEstablishedTrend } from './capacityTrendFit.js';
import { buildFreshLoadMap, prescription } from './prescription.js';
import { computeBalancedCurveScore, predForceThreeExp, buildThreeExpPriors, THREE_EXP_TAUS } from './threeExp.js';
const dayMs = 86400000;
const mean = values => values.reduce((a,b)=>a+b,0)/values.length;
const nextDate = date => new Date(Date.parse(date)+dayMs).toISOString().slice(0,10);
const positive = value => Number.isFinite(Number(value)) && Number(value) > 0;
const optionalNumber = value => value != null && Number.isFinite(Number(value)) ? Number(value) : null;

function usableCalibratedCurve(model) {
  if (!model || (model.status && model.status !== 'ready')
    || !Array.isArray(model.amps) || model.amps.length !== 3
    || !model.amps.every(value => Number.isFinite(Number(value)) && Number(value) >= 0)
    || !positive(model.scale)) return null;
  const taus = Array.isArray(model.taus) && model.taus.length === 3
    && model.taus.every(positive) ? model.taus.map(Number) : THREE_EXP_TAUS;
  return { ...model, amps:model.amps.map(Number), scale:Number(model.scale), taus,
    min_duration_s:optionalNumber(model.min_duration_s), max_duration_s:optionalNumber(model.max_duration_s) };
}

function savedCalibratedCurve(rep) {
  return usableCalibratedCurve(rep.force_recording?.prediction_check?.models?.current);
}

function comparisonBasis(rep) {
  return rep.force_recording?.basis === 'target_acquired'
    && rep.force_recording?.interval_basis_applied !== 'legacy_elapsed'
    ? 'target_acquired' : 'legacy_elapsed';
}

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
  const baselines = new Map(), cache = new Map(), dateInputs = new Map(), expectationCache = new Map();
  const fit = (grip,h,date) => {
    const key = `${grip}|${h}|${date}`;
    if (!cache.has(key)) cache.set(key,model==='original'
      ? fitEstablishedTrend(clean,h,grip,date,{prepared:true})
      : fitContextualTrend(clean,h,grip,date,{prepared:true,robust:model==='contextRobust'}));
    return cache.get(key);
  };
  const reconstructedCurve = (grip,h,date,target) => {
    const key = `${grip}|${h}|${date}`;
    if (expectationCache.has(key)) return expectationCache.get(key);
    if (!dateInputs.has(date)) {
      const prior = clean.filter(r=>r.date<date);
      dateInputs.set(date,{prior,freshMap:buildFreshLoadMap(prior),threeExpPriors:buildThreeExpPriors(prior)});
    }
    const inputs = dateInputs.get(date);
    const result = prescription(inputs.prior,h,grip,target,
      {referenceDate:date,freshMap:inputs.freshMap,threeExpPriors:inputs.threeExpPriors,captureCurve:true});
    const curve = usableCalibratedCurve(result?.curveSnapshot
      ? {...result.curveSnapshot,source:result.source,taus:THREE_EXP_TAUS,history_before:date}
      : null);
    expectationCache.set(key,curve);
    return curve;
  };
  const expectation = rep => {
    const saved = savedCalibratedCurve(rep);
    const curve = saved || reconstructedCurve(rep.grip,rep.hand,rep.date,
      Number(rep.target_duration)>0?Number(rep.target_duration):rep.actual_time_s);
    if (!curve || (curve.duration_basis && curve.duration_basis!==comparisonBasis(rep))) return null;
    const expectedForce = predForceThreeExp(curve.amps,rep.actual_time_s,curve.taus)*curve.scale;
    if (!positive(expectedForce)) return null;
    const minDuration = Number.isFinite(curve.min_duration_s)?curve.min_duration_s:null;
    const maxDuration = Number.isFinite(curve.max_duration_s)?curve.max_duration_s:null;
    return {expectedForce,expectationSource:saved?'frozen':'reconstructed',calibrationSource:curve.source||null,
      calibrationScale:curve.scale,minDuration,maxDuration,
      extrapolated:(minDuration!=null&&rep.actual_time_s<minDuration)||(maxDuration!=null&&rep.actual_time_s>maxDuration)};
  };
  return dates.map(date => {
    const eligible = eligibleAt(date);
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
      let scored = 0;
      const deviations = hands.map(h=>{
        const values = current.filter(r=>r.hand===h)
          .map(r=>{
            const expected = expectation(r);
            if (!expected) return null;
            const deviation = 100*(r.avg_force_kg/expected.expectedForce-1);
            if (!Number.isFinite(deviation)) return null;
            scored += 1;
            if (onEvidence) observations.push({rep:r,...expected,deviation,context:context(r)});
            // Outside the curve's measured durations the expectation is an
            // extrapolation: show the hold individually, but keep it out of
            // the session-performance average.
            return expected.extrapolated ? null : deviation;
          })
          .filter(Number.isFinite);
        return values.length ? mean(values) : null;
      }).filter(Number.isFinite);
      if (deviations.length) row[`${grip}_short`] = mean(deviations);
      if (scored) row[`${grip}_scored`] = scored;
      row[`${grip}_holds`] = current.length;
      row[`${grip}_laterHolds`] = current.filter(r=>context(r).status==='after_training').length;
      if (onEvidence) onEvidence({date,grip,hands,score,models,history:clean,
        eligible:eligible.filter(r=>r.grip===grip&&hands.includes(r.hand)),observations});
    }
    return row;
  }).filter(row=>grips.some(g=>Number.isFinite(row[`${g}_long`])||Number.isFinite(row[`${g}_short`])||row[`${g}_scored`]>0));
}
