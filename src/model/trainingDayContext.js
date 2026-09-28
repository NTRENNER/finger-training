// Evidence about session order, not a physiological fatigue estimate. Never use
// upload/created_at timestamps: an offline sync can make those misleading.
const key = r => `${r.date}|${r.session_id}`;
const timestamp = value => typeof value === 'string' && value.includes('T') && Number.isFinite(Date.parse(value))
  ? Date.parse(value) : null;
export function trainingDayContext(history) {
  const sessions = new Map();
  for (const r of history) {
    if (!r.session_id) continue;
    const k = key(r);
    if (!sessions.has(k)) sessions.set(k, {date:r.date, starts:[], work:[], grips:new Set()});
    const s = sessions.get(k), start = timestamp(r.session_started_at);
    if (start!=null) s.starts.push(start);
    const repStart = r.rep_timing?.started_at_ms ?? r.force_recording?.activity?.started_at_ms;
    if (Number.isFinite(repStart) && repStart>0) s.starts.push(repStart);
    // Interrupted and later Chaos holds are still work. Brief peak measurements
    // alone are not evidence of a preceding training workout.
    if (r.actual_time_s>0 && (r.avg_force_kg>0 || r.manual_load_kg>0)
      && r.force_recording?.session_protocol?.id !== 'peak_test') {
      s.work.push(Number.isFinite(repStart) && repStart>0 ? repStart : start);
      s.grips.add(r.grip);
    }
  }
  const entries=[...sessions.entries()].map(([id,s])=>({...s,id,start:s.starts.length?Math.min(...s.starts):null}));
  const contexts=new Map();
  for (const s of entries) {
    const earlier=entries.filter(p=>p.id!==s.id && p.date===s.date && s.start!=null
      && p.work.some(t=>t!=null && t<s.start));
    const unknown=entries.some(p=>p.id!==s.id && p.date===s.date && p.work.length && p.work.every(t=>t==null));
    contexts.set(s.id,{status:earlier.length?'after_training':s.start==null||unknown?'unknown':'first_recorded',
      earlierSessions:earlier.length, earlierGrips:[...new Set(earlier.flatMap(p=>[...p.grips]))].sort()});
  }
  return r=>contexts.get(key(r)) || {status:'unknown',earlierSessions:0,earlierGrips:[]};
}
