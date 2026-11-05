import { includeRedoAttempts } from '../repRedo.js';
const result = { actualTime: 45, forceRecording: { capacity_eligible:true, activity:{ duration_s:45, impulse_kg_s:135, started_at_ms:40000, ended_at_ms:85000 } } };
const attempt = { actualTime:1.3, failureValid:true, endReason:'target_force_failure', forceRecording:{ recording_stop_reason:'release_not_observed', activity:{ duration_s:20.9, impulse_kg_s:55.9, started_at_ms:1000, ended_at_ms:null } } };
test('redo preserves the disputed work and prevents manufactured recovery/fresh-opener evidence', () => {
  const retried = includeRedoAttempts(result,[attempt],true);
  expect(retried.actualTime).toBe(45);
  expect(retried.forceRecording).toMatchObject({capacity_eligible:false,recovery_eligible:false,redo_attempts:[attempt],activity:{duration_s:65.9,impulse_kg_s:190.9,started_at_ms:1000,ended_at_ms:85000}});
  expect(result.forceRecording.activity.duration_s).toBe(45);
  expect(includeRedoAttempts(result,[attempt],false).forceRecording.capacity_eligible).toBe(true);
});

// Sensor attempt, manual retry, then a sensor retry: each attempt's measured
// work counts once (the manual attempt has none).
test('repeated redos across sensor and manual attempts count each attempt once', () => {
  const { recordedRedoAttempts } = require('../repRedo.js');
  const sensor = d => ({ actualTime: d, avgForce: 3, forceRecording: { activity: { duration_s: d, impulse_kg_s: d * 3, started_at_ms: 1 } } });
  const first = { actual_time_s: 20, failure_valid: true, force_recording: sensor(20).forceRecording };
  const manual = includeRedoAttempts({ actualTime: 15, forceRecording: null }, recordedRedoAttempts(first));
  const second = { actual_time_s: 15, failure_valid: true, force_recording: manual.forceRecording };
  const third = includeRedoAttempts(sensor(30), recordedRedoAttempts(second));
  expect(third.forceRecording.activity).toMatchObject({ duration_s: 50, impulse_kg_s: 150 });
  expect(third.forceRecording.redo_attempts).toHaveLength(2);
});
