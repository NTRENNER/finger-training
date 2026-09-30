export function isSeedArtifactRep(r) {
  if (!r) return false;
  if (r.force_recording?.version >= 1) return false;
  const a = Number(r.avg_force_kg);
  const p = Number(r.peak_force_kg);
  return Number.isFinite(a) && Number.isFinite(p) && a > 0 && p > 0
    && Math.abs(a - p) < 1e-6;
}

// Session order is established before filtering measurement quality, domain,
// or set number. An interrupted opener or earlier Chaos workout is still work.
// This is per grip and hand; another grip's work remains separate context.
const peak = r => r?.force_recording?.session_protocol?.id === 'peak_test'
  || (Number(r?.target_duration) > 0 && Number(r.target_duration) <= 5 && Number(r.actual_time_s) <= 12)
  || (r?.actual_time_s == null && !(Number(r?.force_recording?.activity?.duration_s) > 0) && Number(r?.peak_force_kg) > 0);
const time = value => typeof value === 'string' && value.includes('T')
  && Number.isFinite(Date.parse(value)) ? Date.parse(value) : null;
const measuredStart = r => {
  const t = r.rep_timing?.started_at_ms ?? r.force_recording?.activity?.started_at_ms;
  return Number.isFinite(t) && t > 0 ? t : null;
};

export function firstSessionEvidence(history = []) {
  const scopes = new Map(), membership = new Map();
  for (const r of history || []) {
    if (!r || peak(r) || isSeedArtifactRep(r)) continue;
    if (!(Number(r.actual_time_s) > 0 || Number(r.force_recording?.activity?.duration_s) > 0)) continue;
    const scope = JSON.stringify([r.date || '', r.grip || '', r.hand || 'L']);
    if (!scopes.has(scope)) scopes.set(scope, new Map());
    const groups = scopes.get(scope);
    const key = r.session_id || r.session_started_at || 'legacy-unidentified';
    if (!groups.has(key)) groups.set(key, { rows: [], starts: [], repStarts: [] });
    const group = groups.get(key);
    group.rows.push(r); membership.set(r, group);
    const start = time(r.session_started_at), repStart = measuredStart(r);
    if (start != null) group.starts.push(start);
    if (repStart != null) group.repStarts.push(repStart);
  }
  const statuses = new Map();
  for (const groups of scopes.values()) {
    const entries = [...groups.values()].map(group => {
      const times = group.starts.length ? group.starts : group.repStarts;
      const start = times.length ? Math.min(...times) : null;
      // A lone legacy session has no competing session to order. Keep it
      // explicitly uncertain rather than inventing timestamps or identifiers.
      return { group, start };
    });
    const unknown = entries.some(e => e.start == null);
    const minimum = Math.min(...entries.filter(e => e.start != null).map(e => e.start));
    const first = entries.filter(e => e.start === minimum);
    for (const e of entries) {
      const status = entries.length === 1 ? (e.start == null ? 'legacy_single_session' : 'only_recorded_session')
        : e.start != null && e.start > minimum ? 'later_session'
        : unknown || first.length !== 1 ? 'unknown' : 'first_session';
      statuses.set(e.group, status);
    }
  }
  return r => peak(r) ? 'peak_measurement' : statuses.get(membership.get(r)) || 'unknown';
}

export function firstTrainingSessionRows(history = []) {
  const status = firstSessionEvidence(history);
  return (history || []).filter(r => ['legacy_single_session', 'only_recorded_session', 'first_session', 'peak_measurement'].includes(status(r)));
}
