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
