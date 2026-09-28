import {trainingDayContext} from '../trainingDayContext.js';
import {fitContextualTrend,contextualTrendPoints} from '../contextualTrendFit.js';
import {fitEstablishedTrend} from '../capacityTrendFit.js';
import {predForceThreeExp} from '../threeExp.js';
import {evaluateContextualTrends} from '../contextualTrendEvaluation.js';
import {buildPerformanceTrends} from '../performanceTrends.js';
const date=n=>new Date(Date.UTC(2026,0,1+n*3)).toISOString().slice(0,10);
const row=(n,{factor=1,grip='Micro',hour='08',id=`s${n}`,t=[30,70,115,160,220][n%5]}={})=>({
 id,session_id:id,date:date(n),grip,hand:'L',rep_num:1,set_num:1,
 session_started_at:`${date(n)}T${hour}:00:00Z`,target_duration:t,actual_time_s:t,
 avg_force_kg:predForceThreeExp([20,25,30],t)*factor,peak_force_kg:90,
 load_provenance:'measured_force',failure_valid:true,end_reason:'target_force_failure',
 force_recording:{capacity_eligible:true,signal_quality:'complete'},
});
const baseline=()=>Array.from({length:30},(_,i)=>row(i));
const force=(h,robust=true)=>predForceThreeExp(fitContextualTrend(h,'L','Micro','2027-01-01',{robust}).established,160);

test('context sees earlier work across grips including non-capacity Chaos holds',()=>{
 const earlier={...row(0),rep_num:4,failure_valid:false,force_recording:{capacity_eligible:false,session_protocol:{id:'whole_curve_beta',role:'fatigued_hold'}}};
 const next=row(0,{grip:'Crusher',hour:'10',id:'next'});
 expect(trainingDayContext([next,earlier])(next)).toMatchObject({status:'after_training',earlierGrips:['Micro'],earlierSessions:1});
 expect(trainingDayContext([next,earlier])(earlier).status).toBe('first_recorded');
});
test('upload times, absent times, tied starts and peak tests do not invent preceding fatigue',()=>{
 const next=row(0,{hour:'10',id:'next'});
 const unknown={...row(0),session_started_at:null,created_at:`${date(0)}T07:00:00Z`};
 expect(trainingDayContext([unknown,next])(next).status).toBe('unknown');
 expect(trainingDayContext([row(0,{hour:'10'}),next])(next).status).toBe('first_recorded');
 const peak={...row(0),force_recording:{session_protocol:{id:'peak_test'}}};
 expect(trainingDayContext([peak,next])(next).status).toBe('first_recorded');
 expect(trainingDayContext([row(0),row(1)])(row(1)).status).toBe('first_recorded');
});
test('rep timestamps can establish order when session starts are absent',()=>{
 const first={...row(0),session_started_at:null,rep_timing:{started_at_ms:Date.parse(`${date(0)}T08:00:00Z`)}};
 const second=row(0,{hour:'10',id:'next'});
 expect(trainingDayContext([first,second])(second).status).toBe('after_training');
});
test('later sessions share a bounded confidence budget; they cannot multiply a day',()=>{
 const first=row(0),later=Array.from({length:20},(_,i)=>row(0,{hour:'12',id:`late${i}`,factor:.6}));
 const context=trainingDayContext([first,...later]);
 const points=contextualTrendPoints([first,...later],context);
 expect(points.reduce((s,p)=>s+p.w,0)).toBeCloseTo(1);
 expect(points[0].w).toBeCloseTo(.8);
 expect(points.slice(1).reduce((s,p)=>s+p.w,0)).toBeCloseTo(.2);
 expect(contextualTrendPoints(later,context).reduce((s,p)=>s+p.w,0)).toBeCloseTo(.25);
});
test('later depleted sessions have less influence than equally low first sessions',()=>{
 const base=baseline(),strong=row(30),weak=row(30,{hour:'12',id:'late',factor:.5});
 const before=force([...base,strong],false),later=force([...base,strong,weak],false);
 const unknown=force([...base,strong,{...weak,session_started_at:null}],false);
 expect(Math.abs(later-before)).toBeLessThan(Math.abs(unknown-before));
});
test('uncertain legacy chronology stays equivalent to the original when robust weighting is off',()=>{
 const rows=baseline().map(r=>({...r,session_started_at:null}));
 expect(fitContextualTrend(rows,'L','Micro','2027-01-01',{robust:false}).established)
  .toEqual(fitEstablishedTrend(rows,'L','Micro','2027-01-01').established);
});
test('isolated positive and negative outliers are damped, but sustained decline and growth remain visible',()=>{
 const base=baseline(),initial=force(base);
 for(const factor of [.5,1.5]){
   const changed=[...base,row(30,{factor,t:160})];
   expect(Math.abs(force(changed)-initial)).toBeLessThan(Math.abs(force(changed,false)-initial));
 }
 const once=force([...base,row(30,{factor:.6})]);
 const sustained=force([...base,...Array.from({length:24},(_,i)=>row(30+i,{factor:.6}))]);
 expect(sustained).toBeLessThan(once);
 expect(sustained).toBeLessThan(initial*.9);
 expect(force([...base,...Array.from({length:12},(_,i)=>row(30+i,{factor:1.2}))])).toBeGreaterThan(initial);
});
test('fits are causal, order-independent, positive and monotone; duplicates and rest days add no information',()=>{
 const base=baseline(),a=fitContextualTrend(base,'L','Micro',date(30));
 expect(fitContextualTrend([...base,row(30,{factor:.1})],'L','Micro',date(30))).toEqual(a);
 expect(fitContextualTrend([...base,...base].reverse(),'L','Micro',date(30))).toEqual(a);
 expect(fitContextualTrend(base,'L','Micro','2027-01-01')).toEqual(a);
 let prev=Infinity;
 for(const t of [0,30,70,160,220,600]){const f=predForceThreeExp(a.established,t);expect(f).toBeGreaterThan(0);expect(f).toBeLessThanOrEqual(prev);prev=f;}
});
test('evaluation uses earlier days and separates session contexts; chart default remains original',()=>{
 const h=baseline(),held=row(30,{hour:'12',id:'held'}),earlier=row(30,{grip:'Crusher',id:'prior'});
 const observation={date:date(30),session:'held',grip:'Micro',hand:'L',targetDuration:160,duration:160,actual:20};
 const a=evaluateContextualTrends([...h,earlier,held],[observation]);
 const b=evaluateContextualTrends([...h,earlier,{...held,avg_force_kg:100}],[{...observation,actual:100}]);
 expect(a.observations[0].predictions).toEqual(b.observations[0].predictions);
 expect(a.byContext.after_training.original.observations).toBe(1);
 const defaultRows=buildPerformanceTrends(h,['Micro'],'L');
 expect(buildPerformanceTrends(h,['Micro'],'L',{model:'original'})).toEqual(defaultRows);
 const candidate=buildPerformanceTrends(h,['Micro'],'L',{model:'contextOnly'});
 expect(buildPerformanceTrends([...h,held],['Micro'],'L',{model:'contextOnly'}).filter(r=>r.date<held.date)).toEqual(candidate);
});
