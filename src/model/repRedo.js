// Preserve disputed attempts as observed work without treating a retry as a
// fresh opening measurement or a clean between-rep recovery comparison.
export function includeRedoAttempts(result, attempts = [], opener = false) {
  if (!attempts.length) return result;
  const recording = result.forceRecording || {};
  const activities = [...attempts.map(attempt => attempt.forceRecording?.activity), recording.activity].filter(Boolean);
  const duration = activities.reduce((sum, activity) => sum + (Number(activity.duration_s) || 0), 0);
  const impulse = activities.reduce((sum, activity) => sum + (Number(activity.impulse_kg_s) || 0), 0);
  return { ...result, forceRecording: { ...recording,
    redo_attempts: attempts,
    last_attempt_activity: recording.activity ?? null,
    recovery_eligible: false,
    ...(opener ? { capacity_eligible: false } : {}),
    ...(activities.length ? { activity: { ...recording.activity,
      duration_s: duration, impulse_kg_s: impulse,
      avg_force_kg: duration > 0 ? impulse / duration : null,
      started_at_ms: activities[0].started_at_ms,
      endpoint_quality: recording.activity?.endpoint_quality || 'unknown',
    } } : {}),
  } };
}

export function recordedRedoAttempts(rep) {
  const { redo_attempts = [], last_attempt_activity, ...recording } = rep.force_recording || {};
  const activity = last_attempt_activity || recording.activity;
  return [...redo_attempts, {
    actualTime: rep.actual_time_s, avgForce: rep.avg_force_kg, peakForce: rep.peak_force_kg,
    failureValid: rep.failure_valid, endReason: rep.end_reason,
    forceRecording: { ...recording, ...(activity ? { activity } : {}) },
  }];
}
