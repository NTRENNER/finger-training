// Descriptive/research candidate. The live prescription and frozen forecast
// versions continue to use their original models.
import {prepareEvaluationRows} from './evaluationRows.js';
import {freshFitReps, sane} from './load.js';
import {loadProvenance} from './forceRecording.js';
import {fitThreeExpAmps,predForceThreeExp} from './threeExp.js';
import {TREND_EXPERIMENT} from './capacityTrendFit.js';
import {trainingDayContext} from './trainingDayContext.js';

export const CONTEXT_TREND_POLICY=Object.freeze({version:1,laterSessionWeight:0.25,
  robustLogThreshold:Math.log(1.15),robustIterations:3});
const sumWeight=ps=>ps.reduce((sum,p)=>sum+p.w,0);

export function contextualTrendPoints(rows,context) {
  const days=new Map();
  for(const r of rows){if(!days.has(r.date))days.set(r.date,[]);days.get(r.date).push(r);}
  const latest=Math.max(...[...days.keys()].map(Date.parse));
  return [...days].sort(([a],[b])=>a.localeCompare(b)).flatMap(([date,rs])=>{
    const early=rs.filter(r=>context(r).status!=='after_training');
    const late=rs.filter(r=>context(r).status==='after_training');
    const low=CONTEXT_TREND_POLICY.laterSessionWeight;
    // Later sessions share one reduced budget, however many are recorded.
    // A day containing only later-grip work stays below a full fresh day.
    const total=early.length && late.length?1+low:1;
    const recency=2**(-(latest-Date.parse(date))/86400000/TREND_EXPERIMENT.longHalfLifeDays);
    return rs.map(r=>({T:r.actual_time_s,F:r.avg_force_kg,
      w:recency*(loadProvenance(r)==='legacy_measured'?TREND_EXPERIMENT.legacyWeight:1)
        *(context(r).status==='after_training'?low/late.length:1/early.length)/total}));
  });
}
// Symmetric robust weighting: isolated unexpectedly high AND low observations
// get less leverage. Repeated evidence on separate days still changes the fit.
function robustFit(points,options={},robust=true) {
  let amps=fitThreeExpAmps(points,options);
  if(!robust)return amps;
  for(let i=0;i<CONTEXT_TREND_POLICY.robustIterations;i++){
    const currentAmps=amps;
    const weighted=points.map(p=>({...p,w:p.w*Math.min(1,CONTEXT_TREND_POLICY.robustLogThreshold/
      Math.max(1e-9,Math.abs(Math.log(p.F/Math.max(1e-9,predForceThreeExp(currentAmps,p.T))))))}));
    amps=fitThreeExpAmps(weighted,options);
  }
  return amps;
}
export function fitContextualTrend(history,hand,grip,referenceDate,{prepared=false,robust=true}={}) {
  const clean=(prepared?history:prepareEvaluationRows(history).rows).filter(r=>r.date<referenceDate);
  const context=trainingDayContext(clean); // all grips, before filtering capacity evidence
  const all=freshFitReps(clean, { includeLaterSessions: true }).filter(r=>r.grip===grip && sane(r.avg_force_kg)!=null
    && r.actual_time_s>0 && r.actual_time_s<=600
    && ['legacy_measured','measured_force'].includes(loadProvenance(r)));
  const own=all.filter(r=>r.hand===hand),days=new Set(own.map(r=>r.date)).size;
  if(days<TREND_EXPERIMENT.minPriorDays)return null;
  const points=contextualTrendPoints(own,context),pooled=contextualTrendPoints(all,context);
  const effectiveDays=sumWeight(points),prior=robustFit(pooled,{},robust);
  const established=robustFit(points,{prior,lambda:100/effectiveDays},robust);
  return {days,effectiveDays,established,maxDuration:Math.max(...own.map(r=>r.actual_time_s)),
    laterOpeners:own.filter(r=>context(r).status==='after_training').length,
    lastDate:own.map(r=>r.date).sort().at(-1)};
}
