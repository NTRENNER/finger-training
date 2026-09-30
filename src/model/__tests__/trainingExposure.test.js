import { trainingExposure } from '../trainingExposure.js';
import { isCapacityEvidenceRep } from '../forceRecording.js';
const chaos = (over = {}) => ({ date: '2026-09-29', grip: 'Micro', hand: 'L', rep_num: 3,
  actual_time_s: 150, target_duration: 160, avg_force_kg: 8, failure_valid: true,
  force_recording: { capacity_eligible: false, session_protocol: { id: 'whole_curve_beta', role: 'fatigued_hold', zone: 'strength_endurance' } }, ...over });
test('later Chaos exposure never becomes a fresh measurement or a capacity point', () => {
  const r = chaos();
  expect(trainingExposure([r]).strength_endurance).toMatchObject({ trainedDate: r.date, measuredDate: null });
  expect(isCapacityEvidenceRep(r)).toBe(false);
});
test('short and interrupted attempts remain visible without refreshing exposure', () => {
  for (const r of [chaos({ actual_time_s: 6 }), chaos({ failure_valid: false })])
    expect(trainingExposure([r]).strength_endurance).toEqual({ trainedDate: null, measuredDate: null, attemptedDate: r.date });
});
test('ordinary later reps and future records cannot refresh exposure', () => {
  const r = { ...chaos(), force_recording: undefined, actual_time_s: 30 };
  expect(trainingExposure([r]).power.trainedDate).toBeNull();
  expect(trainingExposure([chaos()], '2026-09-28').strength_endurance.attemptedDate).toBeNull();
});
test('ordinary valid opener supplies both exposure and measurement at actual duration', () => {
  const r = { ...chaos(), rep_num: 1, force_recording: undefined, actual_time_s: 30 };
  expect(trainingExposure([r]).power).toEqual({ trainedDate: r.date, measuredDate: r.date, attemptedDate: r.date });
});
