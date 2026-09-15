// Synthetic storage-shape fixtures, based on sync.js and useSessionRunner.js.
// These are not production data exports. Do not normalize missing metadata
// through measuredRecoveryFields: its absence is what these tests exercise.
export const RECOVERY_ROW_SHAPES = ['measured', 'legacy', 'legacy_nullable', 'manual', 'interrupted'];

export function recoveryRows(shape, { sessionId = 'fixture-session', date = '2026-08-20', interruptedRep = 1 } = {}) {
  if (!RECOVERY_ROW_SHAPES.includes(shape)) throw new Error(`Unknown row shape: ${shape}`);
  return [40, 24, 16, 12].map((seconds, index) => {
    const base = {
      id: `${sessionId}-${index + 1}`, session_id: sessionId, date,
      grip: 'Crusher', hand: 'L', set_num: 1, rep_num: index + 1,
      target_duration: 30, actual_time_s: seconds, rest_s: 20,
      weight_kg: 30, prescribed_load_kg: 30, manual_load_kg: null,
      avg_force_kg: 30, peak_force_kg: 32, failed: true,
    };
    if (shape === 'legacy') return base;
    if (shape === 'legacy_nullable') return { ...base,
      rep_timing: null, load_provenance: null, force_recording: null,
      failure_valid: null, end_reason: null };
    const start = Date.parse(`${date}T12:00:00Z`)
      + [0, 60, 104, 140][index] * 1000;
    const timing = { version: 1, started_at_ms: start,
      ended_at_ms: start + seconds * 1000, rest_before_s: index ? 20 : null };
    if (shape === 'manual') return { ...base,
      avg_force_kg: null, peak_force_kg: null, manual_load_kg: 30,
      load_provenance: 'nominal_setting', force_recording: null,
      rep_timing: { ...timing, source: 'manual_tap' },
      failure_valid: true, end_reason: 'muscular_failure' };
    const interrupted = shape === 'interrupted' && index + 1 === interruptedRep;
    return { ...base, load_provenance: 'measured_force',
      force_recording: { version: 2, method: 'time_weighted',
        capacity_eligible: true, signal_quality: 'complete',
        duration_s: seconds, observed_time_s: seconds, impulse_kg_s: 30 * seconds },
      rep_timing: { ...timing, source: 'device_aligned' },
      failure_valid: !interrupted,
      end_reason: interrupted ? 'interrupted' : 'muscular_failure' };
  });
}
