import {historicalCurve} from '../historicalCurve.js';
const rows=Array.from({length:6},(_,i)=>({id:String(i),session_id:String(i),date:`2026-07-${10+i}`,grip:'Micro',hand:'L',rep_num:1,set_num:1,avg_force_kg:30-i,peak_force_kg:32-i,actual_time_s:10+i*20}));
test('stale history retains its curve and a session bootstrap interval',()=>{
 const result=historicalCurve(rows,'Micro','L','2026-09-15');
 expect(result.age).toBeGreaterThan(30);
 expect(result.sessions).toBe(6);
 expect(result.hasBand).toBe(true);
 expect(result.points.every(p=>p.force>0 && p.range[0]<=p.range[1])).toBe(true);
 expect(historicalCurve(rows,'Micro','L','2027-09-15').points).toEqual(result.points);
});
test('new acquisition evidence does not alter the historical reference',()=>{
 const added={...rows[0],id:'new',session_id:'new',date:'2026-09-15',avg_force_kg:100,force_recording:{basis:'target_acquired'}};
 const result=historicalCurve([...rows,added],'Micro','L');
 expect(result.points).toEqual(historicalCurve(rows,'Micro','L').points);
 expect(result.newSessions).toBe(1);
 expect(result.transition).toBe(true);
});
test('bands require independent sessions, not repeated reps',()=>{
 expect(historicalCurve(rows.slice(0,3),'Micro','L').hasBand).toBe(false);
 expect(historicalCurve(rows.map(r=>({...r,session_id:'one'})),'Micro','L')).toBeNull();
});
test('scope and interruption exclusions are retained',()=>{
 expect(historicalCurve(rows,'Micro','R')).toBeNull();
 expect(historicalCurve(rows,'Crusher')).toBeNull();
 expect(historicalCurve(rows.map(r=>({...r,failure_valid:false})),'Micro')).toBeNull();
});
