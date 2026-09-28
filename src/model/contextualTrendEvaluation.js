import {pairedDayInterval} from './capacityTrendExperiment.js';
import {prepareEvaluationRows} from './evaluationRows.js';
import {evaluateForward,evaluationMetrics} from './forwardEvaluation.js';
import {fitEstablishedTrend} from './capacityTrendFit.js';
import {fitContextualTrend,CONTEXT_TREND_POLICY} from './contextualTrendFit.js';
import {trainingDayContext} from './trainingDayContext.js';
import {predForceThreeExp} from './threeExp.js';
const models=['original','contextOnly','contextRobust'];
const scores=rows=>Object.fromEntries(models.map(m=>[m,evaluationMetrics(rows,m)]));
export function evaluateContextualTrends(input,forceObservations=null) {
  const {rows}=prepareEvaluationRows(input),context=trainingDayContext(rows),cache=new Map();
  const lookup=new Map(rows.map(r=>[`${r.date}|${r.session_id}|${r.hand}|${r.grip}`,r]));
  const observations=[];
  for(const r of forceObservations || evaluateForward(rows).observations.force){
    if(r.targetDuration<12)continue;
    const key=`${r.date}|${r.grip}|${r.hand}`;
    if(!cache.has(key))cache.set(key,[fitEstablishedTrend(rows,r.hand,r.grip,r.date,{prepared:true}),
      fitContextualTrend(rows,r.hand,r.grip,r.date,{prepared:true,robust:false}),
      fitContextualTrend(rows,r.hand,r.grip,r.date,{prepared:true})]);
    const fits=cache.get(key);
    if(fits.some(f=>!f))continue;
    const stored=lookup.get(`${r.date}|${r.session}|${r.hand}|${r.grip}`);
    observations.push({...r,context:stored?context(stored).status:'unknown',
      predictions:Object.fromEntries(models.map((m,i)=>[m,predForceThreeExp(fits[i].established,r.duration)]))});
  }
  const group=field=>Object.fromEntries([...new Set(observations.map(r=>r[field]))].map(k=>[k,scores(observations.filter(r=>r[field]===k))]));
  const dates=[...new Set(observations.map(r=>r.date))].sort(),split=dates[Math.floor(dates.length/2)];
  const paired=observations.map(r=>({...r,predictions:{...r.predictions,current:r.predictions.original}}));
  return {policy:CONTEXT_TREND_POLICY,method:'Force at observed duration; strictly earlier training dates; equal weight per test day. Historical comparison, not independent validation. Session order is context, not proof of fatigue.',
    all:scores(observations),pairedDifferences:Object.fromEntries(models.slice(1).map(m=>[m,pairedDayInterval(paired,m)])),
    chronology:{splitDate:split??null,early:scores(observations.filter(r=>r.date<split)),late:scores(observations.filter(r=>r.date>=split))},
    byContext:group('context'),byGrip:group('grip'),observations};
}
