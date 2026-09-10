// Synthetic protocol fixture: explicitly measured stable force and actual rest.
// Tests for unknown/legacy data omit these fields deliberately.
export function measuredRecoveryFields(rest = 20) {
  return { avg_force_kg: 25, load_provenance: 'measured_force',
    force_recording: { version: 2, capacity_eligible: true, signal_quality: 'complete' },
    rep_timing: { version: 1, rest_before_s: rest } };
}
