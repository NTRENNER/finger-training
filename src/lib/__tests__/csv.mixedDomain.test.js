import { toCSV, toWorkoutCSV } from '../csv.js';
import { createModifierDefinition, setModifierSelection } from '../../model/workoutModifiers.js';

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

test('workout CSV preserves reusable setup modifier snapshots', () => {
  const modifier = createModifierDefinition({
    name: 'Slingshot', kind: 'assistance', options: ['Red', 'Blue'],
  });
  const set = {
    ...setModifierSelection({ reps: '5', weight: '225', done: true }, modifier, modifier.options[0].id),
  };
  const csv = toWorkoutCSV([{
    date: '2026-10-23', workout: 'C', exercises: { benchPress: { sets: [set] } },
  }], () => 'Bench Press');

  expect(csv.split('\n')[0]).toContain('"setup_modifiers","setup_modifiers_json"');
  expect(csv).toContain('Slingshot: Red');
  expect(csv).toContain(modifier.id);
  expect(csv).not.toContain('[object Object]');
});
