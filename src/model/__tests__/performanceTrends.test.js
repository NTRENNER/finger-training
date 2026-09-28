import {buildPerformanceTrends} from '../performanceTrends.js';
import {recoveryRows} from '../../testHelpers/recoveryRows.js';
const history=()=>Array.from({length:10},(_,i)=>recoveryRows('legacy',{
 date:`2026-08-${String(i+1).padStart(2,'0')}`,sessionId:`s${i}`
})).flat();
test('future workouts cannot rewrite historical points; incomplete hands stay unavailable',()=>{
 const base=history();
 const before=buildPerformanceTrends(base,['Crusher'],'L');
 expect(before.length).toBe(6);
 expect(before[0].Crusher_long).toBe(0);
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
test('new unmeasured durations are not short-term underperformance',()=>{
 const base=history();
 const extra=recoveryRows('legacy',{date:'2026-08-11',sessionId:'newDuration'}).map(r=>({...r,actual_time_s:220}));
 expect(buildPerformanceTrends([...base,...extra],['Crusher'],'L').at(-1).Crusher_short).toBeUndefined();
});
