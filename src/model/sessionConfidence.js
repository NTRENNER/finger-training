import { isCapacityEvidenceRep } from './forceRecording.js';
// A session can contribute at most one nearby observation. Repeated reps
// improve its force-duration coverage, but cannot manufacture repeatability.
export function effectiveSessionCount(reps, duration, today, bandwidth = .35) {
  const sessions = new Map();
  const ref = Date.parse(today);
  for (const r of reps || []) {
    if (!isCapacityEvidenceRep(r) || !(r.actual_time_s > 0) || !(duration > 0)) continue;
    const date = Date.parse(r.date);
    if (!Number.isFinite(date) || date > ref) continue;
    const age = Math.max(0, (ref-date)/86400000);
    const proximity = Math.exp(-(Math.log(r.actual_time_s/duration)**2)/(2*bandwidth**2));
    // Recency half-life is a confidence heuristic, not a recovery time.
    const recency = Math.pow(.5, age/90);
    const quality = r.force_recording?.signal_quality === 'incomplete' ? 0
      : r.load_provenance === 'measured_force' || r.load_provenance === 'known_external_load' ? 1 : .75;
    const key = r.session_id || r.date; // legacy same-day rows count once
    sessions.set(key, Math.max(sessions.get(key)||0, proximity*recency*quality));
  }
  return [...sessions.values()].reduce((a,b)=>a+b,0);
}
