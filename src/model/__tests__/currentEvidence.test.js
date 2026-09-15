import { demonstratedCapacityKg, prescription } from '../prescription.js';
const rep = (date, load, extra={}) => ({id:date,session_id:date,date,grip:'Micro',hand:'L',
 rep_num:1,set_num:1,actual_time_s:160,avg_force_kg:load,peak_force_kg:load+1,
 target_duration:160,prescribed_load_kg:load,failure_valid:true,...extra});
const best=rep('2026-07-10',30);
const lower=['2026-09-01','2026-09-04','2026-09-08'].map(d=>rep(d,10));
const floor=h=>demonstratedCapacityKg(h,'L','Micro',160,'2026-09-10');
test('three recent lower opening efforts revise the working floor by at most 25 percent',()=>{
 expect(floor([best,...lower])).toBe(22.5);
 expect(floor([...lower].reverse().concat(best))).toBe(22.5);
 expect(prescription([best,...lower],'L','Micro',160,{referenceDate:'2026-09-10'}).capacityFloorKg).toBe(22.5);
});
test('one bad day or interrupted attempts cannot erase the best',()=>{
 expect(floor([best,...lower.slice(0,2)])).toBe(30);
 expect(floor([best,...lower.map(r=>({...r,failure_valid:false}))])).toBe(30);
});
test('multiple sets from one workout cannot count as independent evidence',()=>{
 expect(floor([best,...lower.map((r,i)=>({...r,session_id:'one',set_num:i+1}))])).toBe(30);
});
test('later higher performance restores the floor; future data is excluded',()=>{
 expect(floor([best,...lower,rep('2026-09-09',32)])).toBe(32);
 expect(floor([best,...lower,rep('2026-09-11',32)])).toBe(22.5);
});
test('longer, lighter work or a different setup does not contradict the old hold',()=>{
 expect(floor([best,...lower.map(r=>({...r,actual_time_s:300}))])).toBe(30);
 expect(floor([best,...lower.map(r=>({...r,setup_id:'new'}))])).toBe(30);
});
test('same-day morning/evening anchor is stable under input reversal',()=>{
 const morning=rep('2026-09-09',10,{id:'am',session_id:'am',actual_time_s:10,session_started_at:'2026-09-09T08:00:00Z'});
 const evening=rep('2026-09-09',20,{id:'pm',session_id:'pm',actual_time_s:10,session_started_at:'2026-09-09T18:00:00Z'});
 const a=prescription([morning,evening],'L','Micro',20,{referenceDate:'2026-09-10'});
 const b=prescription([evening,morning],'L','Micro',20,{referenceDate:'2026-09-10'});
 expect(a).toEqual(b);
 expect(a.anchor.F).toBe(20);
});
test('later set opener cannot replace the actual fresh opener',()=>{
 const first=rep('2026-09-09',20,{set_num:1,actual_time_s:10});
 const later={...first,id:'later',set_num:2,avg_force_kg:5,peak_force_kg:6};
 const a=prescription([first,later],'L','Micro',20,{referenceDate:'2026-09-10'});
 const b=prescription([later,first],'L','Micro',20,{referenceDate:'2026-09-10'});
 expect(a.anchor).toEqual(b.anchor);
});

test('missing timestamps have deterministic session fallback',()=>{
 const h=[rep('2026-09-09',10,{session_id:'a',actual_time_s:10}),rep('2026-09-09',20,{session_id:'b',actual_time_s:10})];
 const opts={referenceDate:'2026-09-10'};
 expect(prescription(h,'L','Micro',20,opts)).toEqual(prescription([...h].reverse(),'L','Micro',20,opts));
});
test('later sets cannot establish a fresh capacity floor',()=>{
 expect(floor([rep('2026-09-09',30,{set_num:2})])).toBeNull();
});


test.each([160, 200, 300])('comparison uses target duration even when the old best lasted %s seconds', duration => {
 expect(floor([{...best,actual_time_s:duration},...lower])).toBe(22.5);
});
test('very light evidence cannot collapse the floor in one revision', () => {
 expect(floor([best,...lower.map(r=>({...r,avg_force_kg:2,peak_force_kg:3,actual_time_s:190}))])).toBe(22.5);
});
test('repeated calls and reordered unchanged history never lower the floor again', () => {
 const h=[best,...lower]; const before=JSON.stringify(h);
 for(let i=0;i<10;i++) expect(floor(i%2 ? [...h].reverse() : h)).toBe(22.5);
 expect(JSON.stringify(h)).toBe(before);
});
test('each further reduction requires three new independent sessions', () => {
 const extra=['2026-09-08','2026-09-09','2026-09-09'].map((d,i)=>rep(d,10,{id:'extra'+i,session_id:'extra'+i,
  session_started_at:d+'T18:0'+i+':00Z'}));
 expect(floor([best,...lower,...extra.slice(0,1)])).toBe(22.5);
 expect(floor([best,...lower,...extra.slice(0,2)])).toBe(22.5);
 expect(floor([best,...lower,...extra])).toBe(16.875);
});
test('duplicated rows do not provide another independent revision', () => {
 expect(floor([best,...lower,...lower.map(r=>({...r,id:r.id+'copy'}))])).toBe(22.5);
});
test('a stronger session restores the working floor and resets the lower-evidence count', () => {
 const h=[best,...lower,rep('2026-09-09',26,{session_id:'early',session_started_at:'2026-09-09T08:00:00Z'}),
  rep('2026-09-09',10,{session_id:'late',session_started_at:'2026-09-09T18:00:00Z'})];
 expect(floor(h)).toBe(26);
});
test('target comparability includes the upper boundary and excludes shorter or longer holds', () => {
 expect(floor([best,...lower.map(r=>({...r,actual_time_s:200}))])).toBe(22.5);
 for(const duration of [159,201]) expect(floor([best,...lower.map(r=>({...r,actual_time_s:duration}))])).toBe(30);
});
