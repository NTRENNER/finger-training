import { sane } from './load.js';
import { uuid } from '../util.js';
import { handOrderMetadata } from './handOrder.js';

export const PEAK_HOLD_S = 3;
export const PEAK_ROUNDS = 3;
export const PEAK_ROUND_REST_S = 60;
export const isPeakMeasurement = r => r?.force_recording?.session_protocol?.id === 'peak_test'
  && r.force_recording.session_protocol.version === 2;
export const isValidPeakMeasurement = r => isPeakMeasurement(r)
  && r.end_reason === 'peak_test_complete'
  && r.force_recording.peak_valid === true
  && sane(r.peak_force_kg) != null;

export function peakMeasurementRecord({ stats, hand, round, grip, sessionId, date, startedAt,
  firstHand, source, previousEnd = null }) {
  const valid = stats.failureValid !== false && stats.endReason !== 'equipment_interruption' && stats.endReason !== 'interrupted'
    && stats.actualTime >= 1 && sane(stats.peakForce) != null;
  const start = stats.startedAtMs ?? null;
  const end = stats.endedAtMs ?? null;
  return {
    id: uuid(), session_id: sessionId, session_started_at: startedAt, date, grip, hand,
    set_num: 1, rep_num: round + 1, target_duration: PEAK_HOLD_S,
    actual_time_s: Math.max(0, stats.actualTime || 0), rest_s: PEAK_ROUND_REST_S,
    weight_kg: 0, prescribed_load_kg: 0, manual_load_kg: null,
    avg_force_kg: sane(stats.avgForce),
    peak_force_kg: sane(stats.peakForce),
    load_provenance: 'measured_force', failure_valid: false, failed: false,
    end_reason: valid ? 'peak_test_complete' : stats.endReason === 'equipment_interruption'
      ? 'equipment_interruption' : 'interrupted',
    rep_timing: { version: 1, started_at_ms: start, ended_at_ms: end,
      rest_before_s: Number.isFinite(previousEnd) && Number.isFinite(start) && start >= previousEnd
        ? (start - previousEnd) / 1000 : null, source: 'device_aligned' },
    force_recording: { ...stats.forceRecording, version: stats.forceRecording?.version || 2, capacity_eligible: false, peak_valid: valid,
      hand_order: handOrderMetadata(firstHand, date),
      session_protocol: { id: 'peak_test', version: 2, source, position: round + 1,
        duration_reference: 'brief_maximum_not_failure' } },
  };
}
