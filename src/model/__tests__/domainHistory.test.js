import { domainHistory } from '../domainHistory.js';
const rep = { date: '2026-09-20', grip: 'Micro', hand: 'L', set_num: 1, rep_num: 1,
  session_id: 'a', target_duration: 160, actual_time_s: 160, avg_force_kg: 12 };
test('beta exposure is recorded for later planned domains without claiming fresh evidence', () => {
  const beta = { ...rep, rep_num: 3, actual_time_s: 25,
    force_recording: { session_protocol: { id: 'whole_curve_beta', role: 'fatigued_hold', zone: 'strength_endurance' } } };
  const out = domainHistory([beta, { ...beta, hand: 'R' }], 'Micro');
  expect(out.strength_endurance).toEqual({ sessions: 1, lastTrained: rep.date, lastOpeningEvidence: null });
  expect(out.power.lastOpeningEvidence).toBeNull();
});
test('manual, interrupted, future and other-grip records remain distinct', () => {
  const manual = { ...rep, load_provenance: 'nominal_setting' };
  expect(domainHistory([manual], 'Micro').strength_endurance.sessions).toBe(1);
  expect(domainHistory([manual], 'Micro').strength_endurance.lastOpeningEvidence).toBeNull();
  for (const row of [{ ...rep, failure_valid: false }, { ...rep, grip: 'Crusher' }, { ...rep, date: '2027-01-01' }]) {
    expect(domainHistory([row], 'Micro', ['L'], '2026-09-24').strength_endurance.sessions).toBe(0);
  }
});
