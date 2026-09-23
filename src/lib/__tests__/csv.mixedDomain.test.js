import { toCSV } from '../csv.js';

test('CSV preserves beta identity and evidence flags with correctly quoted JSON', () => {
  const force = { capacity_eligible: false, session_protocol: {
    id: 'whole_curve_beta', zone: 'strength', role: 'fatigued_hold', position: 3,
  } };
  const csv = toCSV([{ id: 'beta', actual_time_s: 18, failure_valid: true,
    load_provenance: 'measured_force', end_reason: 'muscular_failure', force_recording: force }]);
  expect(csv.split('\n')[0]).toContain('load_provenance,failure_valid,end_reason,force_recording');
  expect(csv).toContain('measured_force,true,muscular_failure,');
  expect(csv).toContain(`"${JSON.stringify(force).replace(/"/g, '""')}"`);
  expect(csv).not.toContain('[object Object]');
});
