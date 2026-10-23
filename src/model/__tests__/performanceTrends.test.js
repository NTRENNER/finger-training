import {buildPerformanceTrendAnalysis, buildPerformanceObservations} from '../performanceTrendEvidence.js';
import {buildPerformanceTrends} from '../performanceTrends.js';
import {recoveryRows} from '../../testHelpers/recoveryRows.js';
const history=()=>Array.from({length:10},(_,i)=>recoveryRows('legacy',{
 date:`2026-08-${String(i+1).padStart(2,'0')}`,sessionId:`s${i}`
})).flat();
test('future workouts cannot rewrite historical points; incomplete hands stay unavailable',()=>{
 const base=history();
 const before=buildPerformanceTrends(base,['Crusher'],'L');
 const capacityBefore=before.filter(r=>Number.isFinite(r.Crusher_long));
 expect(capacityBefore.length).toBe(6);
 expect(capacityBefore[0].Crusher_long).toBe(0);
 const extra=recoveryRows('measured',{date:'2026-09-20',sessionId:'later'}).map(r=>({...r,avg_force_kg:90,
 force_recording:{...r.force_recording,basis:'target_acquired',acquisition_s:1}}));
 expect(buildPerformanceTrends([...base,...extra],['Crusher'],'L').filter(r=>r.date<'2026-09-20')).toEqual(before);
 expect(buildPerformanceTrends(base,['Crusher'],'pooled').every(r=>r.Crusher_long==null)).toBe(true);
});
test('short-term observations compare against an unchanged pre-day curve',()=>{
 const base=history();
 const a=buildPerformanceTrends(base,['Crusher'],'L').at(-1).Crusher_short;
 const changed=base.map(r=>r.date==='2026-08-10'?{...r,avg_force_kg:36,peak_force_kg:40}:r);
 const b=buildPerformanceTrends(changed,['Crusher'],'L').at(-1).Crusher_short;
 expect((1+b/100)/(1+a/100)).toBeCloseTo(1.2,8);
});
test('invalid, duplicate and later fatigued holds cannot create progress',()=>{
 const base=history(), expected=buildPerformanceTrends(base,['Crusher'],'L');
 expect(buildPerformanceTrends([...base,...base],['Crusher'],'L')).toEqual(expected);
 const extras=recoveryRows('interrupted',{date:'2026-08-11',sessionId:'invalid'});
 expect(buildPerformanceTrends([...base,...extras],['Crusher'],'L')).toEqual(expected);
 const late={...base[0],id:'fatigued',date:'2026-08-12',rep_num:2,avg_force_kg:90};
 expect(buildPerformanceTrends([...base,late],['Crusher'],'L')).toEqual(expected);
});
test('new unmeasured durations are shown as extrapolated but kept out of the session average',()=>{
 const base=history();
 const extra=recoveryRows('legacy',{date:'2026-08-11',sessionId:'newDuration'}).map(r=>({...r,actual_time_s:220}));
 const result=buildPerformanceTrendAnalysis([...base,...extra],['Crusher'],'L');
 const last=result.rows.at(-1);
 expect(last.date).toBe('2026-08-11');
 expect(last.Crusher_short).toBeUndefined();
 expect(last.Crusher_scored).toBeGreaterThan(0);
 expect(result.observations.find(item=>item.id===extra.find(item=>item.hand==='L').id))
   .toMatchObject({expectationSource:'reconstructed',extrapolated:true});
});
test('the observations-only path matches the full analysis without fitting capacity',()=>{
 const records=history();
 for (const hand of ['L','R','pooled']) {
  const full=buildPerformanceTrendAnalysis(records,['Crusher'],hand);
  const lean=buildPerformanceObservations(records,['Crusher'],hand);
  expect(lean.observations).toEqual(full.observations);
  expect(lean.rows.every(row=>row.Crusher_long===undefined)).toBe(true);
  const shortByDate=rows=>Object.fromEntries(rows.filter(r=>Number.isFinite(r.Crusher_short)).map(r=>[r.date,r.Crusher_short]));
  expect(shortByDate(lean.rows)).toEqual(shortByDate(full.rows));
 }
});
