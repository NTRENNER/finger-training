import {extendProgressOverlay} from '../progressContinuity.js';
import {forceComparison,progressHoldTime,progressForce} from '../curveComparison.js';
const branch={baselineAmps:[10,20,10],baselineDate:'2026-04-01',baselineMaxHoldS:240,
 dates:['2026-04-01','2026-09-08'],ampsByDate:new Map([['2026-04-01',[10,20,10]],['2026-09-08',[15,30,15]]]),maxHoldByDate:new Map([['2026-04-01',240],['2026-09-08',240]])};
const row=(i,t,kg=20,extra={})=>({id:String(i),session_id:String(i),date:`2026-09-${String(10+i).padStart(2,'0')}`,grip:'Micro',hand:'L',rep_num:1,set_num:1,target_duration:t,actual_time_s:t,avg_force_kg:kg,peak_force_kg:kg+1,failure_valid:true,force_recording:{basis:'target_acquired',acquisition_s:1,capacity_eligible:true},...extra});
test('one new session retains all established percentages, weights and times without mutating rows',()=>{
 const rows=[row(0,50)],before=JSON.stringify(rows),out=extendProgressOverlay(branch,rows,'Micro');
 for(const zone of ['max_strength','power','power_strength','strength','strength_endurance','endurance']) {
  const a=forceComparison(branch,zone,'2026-09-08'),b=forceComparison(out,zone,'2026-09-10');
  expect(a).not.toBeNull(); expect(b).toEqual(a);
 }
 expect(progressHoldTime(out,'2026-09-10',20)).toBe(progressHoldTime(branch,'2026-09-08',20));
 expect(JSON.stringify(rows)).toBe(before);
 expect(out.baselineDate).toBe(branch.baselineDate);
});
test('new-method changes update only after a supported independent comparison; slider excludes future evidence',()=>{
 const rows=[row(0,30),row(1,50),row(2,70),row(3,30),row(4,50),row(5,70,24),row(6,50,24)];
 const out=extendProgressOverlay(branch,rows,'Micro');
 expect(out.continuityByDate.get('2026-09-10').linked).toBe(false);
 expect(out.continuityByDate.get('2026-09-16').linked).toBe(true);
 expect(progressForce(out,'2026-09-16',50)).toBeGreaterThan(progressForce(branch,'2026-09-08',50));
 expect(progressForce(out,'2026-09-11',50)).toBe(progressForce(extendProgressOverlay(branch,rows.slice(0,2),'Micro'),'2026-09-11',50));
 expect(extendProgressOverlay(branch,rows,'Micro','R')).toBe(branch);
});
test('interruptions and duplicate sessions do not establish a new comparison',()=>{
 const rows=[0,1,2,3,4,5].map(i=>row(i,[30,50,70][i%3],20,{session_id:'same'}));
 expect([...extendProgressOverlay(branch,rows,'Micro').continuityByDate.values()].every(v=>!v.linked)).toBe(true);
 expect(extendProgressOverlay(branch,rows.map(r=>({...r,failure_valid:false})),'Micro')).toBe(branch);
});
test('declines can be linked without pushing unsupported durations down',()=>{
 const rows=[row(0,30),row(1,50),row(2,70),row(3,30),row(4,50),row(5,70,5),row(6,50,5)];
 const out=extendProgressOverlay(branch,rows,'Micro');
 expect(progressForce(out,'2026-09-16',50)).toBeLessThan(progressForce(branch,'2026-09-08',50));
 expect(progressForce(out,'2026-09-16',220)).toBe(progressForce(branch,'2026-09-08',220));
 expect(progressForce(out,'2026-09-16',5)).toBe(progressForce(branch,'2026-09-08',5));
 const points=out.progressPointsByDate.get('2026-09-16');
 expect(points.every((p,i)=>i===0 || p.f<=points[i-1].f)).toBe(true);
});
test('adding missing duration coverage can eventually establish its own reference',()=>{
 const base=[row(0,30),row(1,50),row(2,70),row(3,30),row(4,50)];
 const later=[row(5,160),row(6,200),row(7,180),row(8,160,24)];
 const out=extendProgressOverlay(branch,[...base,...later],'Micro');
 expect(out.continuityByDate.get('2026-09-14').evidenceDates.endurance).toBe('2026-09-08');
 expect(out.continuityByDate.get('2026-09-18').evidenceDates.endurance).toBe('2026-09-18');
});
