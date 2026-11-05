import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WorkoutTab } from '../../WorkoutTab.jsx';
import { saveLS, loadLS, LS_WORKOUT_LOG_KEY, LS_WORKOUT_PLAN_KEY } from '../../../lib/storage.js';

jest.mock('../../../lib/sync.js', () => ({ pushWorkoutSession: jest.fn(() => Promise.resolve()), enqueueUserSettingsPatch:jest.fn(), flushUserSettingsPatch:() => Promise.resolve() }));
jest.mock('../../BodyWeightEntry.jsx', () => ({ BwPrompt: () => null }));
jest.mock('../StretchPill.jsx', () => ({ StretchPill: () => null }));
jest.mock('../RecommendationCard.jsx', () => ({ RecommendationCard: () => null }));
jest.mock('../SessionExRow.jsx', () => ({ SessionExRow: ({ ex, setsData, onSetsChange, modifierCatalog = [], onCreateModifier, onDeleteModifier }) => <div data-testid={ex.id}>
  <output data-testid={`${ex.id}-menu`}>{JSON.stringify(modifierCatalog.map(m => m.name))}</output>
  <button onClick={() => onDeleteModifier?.(modifierCatalog.find(m => m.name === 'Tempo'))}>Delete Tempo</button>
  <button onClick={() => onDeleteModifier?.(modifierCatalog.find(m => m.name === 'Band'))}>Delete Band</button>
  <button onClick={() => onCreateModifier?.({ id: 'modifier_custom_rings', name: 'Rings', kind: 'setup', control: 'standard', options: [] })}>Create Rings</button>
  <span>{setsData.sets.length} sets</span><output data-testid={`${ex.id}-state`}>{JSON.stringify(setsData)}</output><span>{setsData.sets[0]?.weight}</span>
  <button onClick={() => onSetsChange({ sets: [...setsData.sets, {weight:'155',reps:'5',done:true}].map(s=>({...s,weight:'155',reps:'5',done:true})) })}>Complete four</button>
  <button onClick={() => onSetsChange({ sets: setsData.sets.map((s,i) => ({ ...s, done: i === 0 })) })}>Complete one</button>
  <button onClick={() => onSetsChange({ sets: setsData.sets.slice(0,1) })}>Remove sets</button>
</div> }));

beforeEach(() => { localStorage.clear(); jest.useFakeTimers(); jest.setSystemTime(new Date(2026,8,30,12)); });
afterEach(() => { jest.useRealTimers(); localStorage.clear(); });
test('saved workout retains planned sets and effort when actual sets are changed', () => {
  saveLS(LS_WORKOUT_LOG_KEY, [{ id:'old', date:'2026-07-29', workout:'C', exercises:{ weightedPullup:{ sets:[
    {weight:'50',reps:'4',done:true}, {weight:'50',reps:'4',done:true}, {weight:'70',reps:'2',done:false}
  ] } } }]);
  const saved = jest.fn();
  const onTrainingStateChange = jest.fn();
  render(<WorkoutTab unit="lbs" onSessionSaved={saved} onTrainingStateChange={onTrainingStateChange} />);
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(false);
  fireEvent.click(screen.getByRole('button', { name: /Start Workout A/ }));
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(true);
  const row = within(screen.getByTestId('weightedPullup'));
  expect(row.getByText('2 sets')).toBeInTheDocument();
  fireEvent.click(row.getByRole('button', { name: 'Complete one' }));
  fireEvent.click(screen.getByRole('button', { name: 'At my limit' }));
  fireEvent.click(row.getByRole('button', { name: 'Remove sets' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Session' }));
  expect(onTrainingStateChange).toHaveBeenLastCalledWith(false);
  const exercise = saved.mock.calls[0][0].exercises.weightedPullup;
  expect(exercise.sets).toHaveLength(1);
  expect(exercise.effort).toBe('at_limit');
  expect(exercise.prescription.sets).toHaveLength(2);
  expect(exercise.prescription.returnStartedOn).toBe('2026-09-30');
  expect(exercise.prescription.sets.every(s => s.weight === '50')).toBe(true);
  expect(loadLS(LS_WORKOUT_LOG_KEY).at(-1).exercises.weightedPullup).toEqual(exercise);
});

test('bands and variants seed only completed history across workout letters', () => {
  const { findLastSessionFor } = require('../workoutHelpers.js');
  const log = [{ date:'2026-09-29', workout:'C', exercises:{ row:{ sets:[
    { variant:'One-arm', reps:'8', done:true }, { variant:'Archer', reps:'12', done:false }
  ] } } }, { date:'2026-08-01', workout:'A', exercises:{ row:{ sets:[{ variant:'Two-arm', done:true }] } } }];
  expect(findLastSessionFor(log, 'A', 'row').exercises.row.sets).toEqual([{ variant:'One-arm', reps:'8', done:true }]);
  expect(log[0].exercises.row.sets).toHaveLength(2);
});


test('one-off fourth set earns the next load without changing the template; explicit update persists targets', () => {
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  const program = {...defaultWorkoutProgram(),mode:'block'};
  program.templates.A = ['benchPress'];
  saveLS(LS_WORKOUT_PLAN_KEY,program);
  saveLS(LS_WORKOUT_LOG_KEY, []);
  render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button',{name:'Choose Workout A'}));
  fireEvent.click(screen.getByRole('button',{name:'Start Workout A'}));
  const choice = screen.getByRole('checkbox',{name:/Update Workout A/});
  expect(choice).not.toBeChecked();
  fireEvent.click(screen.getByRole('button',{name:'Complete four'}));
  fireEvent.click(screen.getByRole('button',{name:'Save Session'}));
  expect(loadLS(LS_WORKOUT_PLAN_KEY)).toEqual(program);
  expect(loadLS(LS_WORKOUT_LOG_KEY).at(-1).exercises.benchPress.sets).toHaveLength(4);
  expect(loadLS(LS_WORKOUT_LOG_KEY).at(-1).exercises.benchPress.prescription.sets).toHaveLength(3);
  fireEvent.click(screen.getByRole('button',{name:'Choose Workout A'}));
  fireEvent.click(screen.getByRole('button',{name:'Start Workout A'}));
  expect(within(screen.getByTestId('benchPress')).getByText('3 sets')).toBeInTheDocument();
  expect(within(screen.getByTestId('benchPress')).getByText('160')).toBeInTheDocument();
  fireEvent.click(screen.getByRole('checkbox',{name:/Update Workout A/}));
  fireEvent.click(screen.getByRole('button',{name:'Save Session'}));
  expect(loadLS(LS_WORKOUT_PLAN_KEY).templateDefaults.A.benchPress.sets).toHaveLength(3);
});


test('saved curl template does not overwrite bridge progression from six to seven reps', () => {
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  const sets = Array.from({length:4},()=>({leftReps:'6',rightReps:'6',leftWeight:'25',rightWeight:'25',done:true}));
  const program = {...defaultWorkoutProgram(),mode:'block'};
  program.templates.A = ['bicepCurls'];
  program.templateDefaults = {A:{bicepCurls:{sets:sets.map(({done,...target})=>target)}}};
  saveLS(LS_WORKOUT_PLAN_KEY,program);
  saveLS(LS_WORKOUT_LOG_KEY,[{id:'curls',date:'2026-09-29',workout:'A',exercises:{bicepCurls:{sets,prescription:{sets}}}}]);
  render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button',{name:'Choose Workout A'}));
  fireEvent.click(screen.getByRole('button',{name:'Start Workout A'}));
  const next = JSON.parse(screen.getByTestId('bicepCurls-state').textContent);
  expect(next.sets).toHaveLength(3);
  expect(next.sets[0]).toMatchObject({leftWeight:'25',rightWeight:'25',leftReps:'7',rightReps:'7'});
});

// The template sets targets; what the athlete progressed to (variant, band,
// hold time, weight) comes from completed history once there is some.
test('a saved template sets rep targets but never resets a progressed variant', () => {
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  const program = defaultWorkoutProgram();
  program.templates.A = ['trxRow'];
  program.templateDefaults = { A: { trxRow: { sets: Array.from({ length: 3 }, () => ({ variant: 'Two-arm', reps: '8' })) } } };
  saveLS(LS_WORKOUT_PLAN_KEY, program);
  saveLS(LS_WORKOUT_LOG_KEY, []);
  const { unmount } = render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose Workout A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Workout A' }));
  expect(JSON.parse(screen.getByTestId('trxRow-state').textContent).sets[0]).toMatchObject({ variant: 'Two-arm', reps: '8' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  unmount();
  saveLS(LS_WORKOUT_LOG_KEY, [{ id: 'rows', date: '2026-09-29', workout: 'A', exercises: { trxRow: { sets:
    Array.from({ length: 3 }, () => ({ variant: 'Feet-elevated', reps: '10', done: true })) } } }]);
  render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose Workout A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Workout A' }));
  expect(JSON.parse(screen.getByTestId('trxRow-state').textContent).sets[0]).toMatchObject({ variant: 'Feet-elevated', reps: '8' });
});

test('a timed hold keeps last session\'s band and seeds seconds from that banded setup', () => {
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  const program = defaultWorkoutProgram();
  program.templates.A = ['frontLever'];
  program.modifierDefinitions = [{ id: 'modifier_band', name: 'Band', kind: 'assistance', control: 'standard', options: [{ id: 'red', label: 'Red' }] }];
  program.exerciseModifierIds = { frontLever: ['modifier_band'] };
  saveLS(LS_WORKOUT_PLAN_KEY, program);
  saveLS(LS_WORKOUT_LOG_KEY, [{ id: 'lever', date: '2026-09-29', workout: 'A', exercises: { frontLever: { sets: [
    { variant: 'Tuck', reps: '3', seconds: '12', done: true,
      modifiers: { modifier_band: { name: 'Band', kind: 'assistance', value: 'red', valueLabel: 'Red' } } }] } } }]);
  render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose Workout A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Workout A' }));
  const seeded = JSON.parse(screen.getByTestId('frontLever-state').textContent).sets[0];
  // Chosen once, the band persists into the next workout until changed.
  expect(seeded.modifiers).toMatchObject({ modifier_band: { name: 'Band', value: 'red' } });
  expect(seeded.seconds).toBe('12');
});

// Nathan's front lever history carries an old "Band" beside its
// replacement: the next workout starts with one Band, and the menu offers
// one band option, the athlete's own modifiers, and saved custom ones.
test('modifiers carry forward once, and the menu list can be grown or trimmed', () => {
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  const program = defaultWorkoutProgram();
  program.templates.A = ['frontLever'];
  program.modifierDefinitions = [{ id: 'modifier_band_mglzk', name: 'Band', kind: 'setup', control: 'bands',
    options: [{ id: 'red', label: 'Red' }] }];
  program.exerciseModifierIds = { frontLever: ['modifier_band_mglzk'] };
  saveLS(LS_WORKOUT_PLAN_KEY, program);
  const bandSet = { variant: 'Full', reps: '4', seconds: '10', done: true, modifiers: {
    modifier_band_iqdun: { name: 'Band', kind: 'assistance', value: 'red_1', valueLabel: 'Red' },
    modifier_band_mglzk: { name: 'Band', kind: 'setup', value: 'red', valueLabel: 'Red' } } };
  saveLS(LS_WORKOUT_LOG_KEY, [{ id: 'lever', date: '2026-09-29', workout: 'A', exercises: { frontLever: { sets: [bandSet, bandSet] } } }]);
  render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: 'Choose Workout A' }));
  fireEvent.click(screen.getByRole('button', { name: 'Start Workout A' }));
  const seeded = JSON.parse(screen.getByTestId('frontLever-state').textContent).sets[0];
  expect(Object.keys(seeded.modifiers)).toEqual(['modifier_band_mglzk']);
  expect(seeded.seconds).toBe('10');                 // history in the same (banded) setup still matches
  const menu = () => JSON.parse(screen.getByTestId('frontLever-menu').textContent);
  expect(menu().filter(name => /band/i.test(name))).toEqual(['Band']);
  fireEvent.click(screen.getByRole('button', { name: 'Delete Tempo' }));
  expect(menu()).not.toContain('Tempo');
  expect(loadLS(LS_WORKOUT_PLAN_KEY).hiddenModifierIds).toEqual(['modifier_tempo']);
  fireEvent.click(screen.getByRole('button', { name: 'Create Rings' }));
  expect(menu()).toContain('Rings');
  fireEvent.click(screen.getByRole('button', { name: 'Delete Band' }));
  expect(loadLS(LS_WORKOUT_PLAN_KEY).modifierDefinitions.map(m => m.id)).toEqual(['modifier_custom_rings']);
  expect(loadLS(LS_WORKOUT_PLAN_KEY).exerciseModifierIds).toEqual({});
  // With the athlete's Band gone, the built-in band option takes its place.
  expect(menu()).toContain('Band assistance');
});

// A phone can discard a backgrounded page, and switching tabs unmounts the
// Workout tab: entered sets must survive both until saved or cancelled.
test('a workout in progress survives a reload until it is saved', () => {
  const { LS_WORKOUT_DRAFT_KEY } = require('../../../lib/storage.js');
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  saveLS(LS_WORKOUT_PLAN_KEY, defaultWorkoutProgram());
  saveLS(LS_WORKOUT_LOG_KEY, []);
  const { unmount: reload } = render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: /Start Workout A/ }));
  const row = within(screen.getByTestId('weightedPullup'));
  fireEvent.click(row.getByRole('button', { name: 'Complete one' }));
  fireEvent.change(screen.getByPlaceholderText(/notes/i), { target: { value: 'felt strong' } });
  const entered = JSON.parse(screen.getByTestId('weightedPullup-state').textContent);
  reload();                                          // page reload or tab switch

  const saved = jest.fn();
  const { unmount: reloadAgain } = render(<WorkoutTab unit="lbs" onSessionSaved={saved} />);
  expect(JSON.parse(screen.getByTestId('weightedPullup-state').textContent)).toEqual(entered);
  expect(screen.getByPlaceholderText(/notes/i)).toHaveValue('felt strong');
  fireEvent.click(screen.getByRole('button', { name: 'Save Session' }));
  expect(saved.mock.calls[0][0]).toMatchObject({ workout: 'A', date: '2026-09-30', notes: 'felt strong',
    exercises: { weightedPullup: { sets: entered.sets } } });
  expect(loadLS(LS_WORKOUT_DRAFT_KEY)).toBeNull();
  reloadAgain();

  render(<WorkoutTab unit="lbs" />);
  expect(screen.getByRole('button', { name: /^Start Workout/ })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: 'Save Session' })).not.toBeInTheDocument();
});

test('cancelling a workout discards its draft', () => {
  const { LS_WORKOUT_DRAFT_KEY } = require('../../../lib/storage.js');
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  saveLS(LS_WORKOUT_PLAN_KEY, defaultWorkoutProgram());
  saveLS(LS_WORKOUT_LOG_KEY, []);
  const { unmount: reload } = render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: /Start Workout A/ }));
  expect(loadLS(LS_WORKOUT_DRAFT_KEY)).toMatchObject({ version: 1, workoutId: 'A', date: '2026-09-30' });
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(loadLS(LS_WORKOUT_DRAFT_KEY)).toBeNull();
  reload();
  render(<WorkoutTab unit="lbs" />);
  expect(screen.queryByRole('button', { name: 'Save Session' })).not.toBeInTheDocument();
});

test('a workout restored the next day is saved on the day it was started', () => {
  const { LS_WORKOUT_DRAFT_KEY } = require('../../../lib/storage.js');
  const { defaultWorkoutProgram } = require('../../../model/workoutProgram.js');
  saveLS(LS_WORKOUT_PLAN_KEY, defaultWorkoutProgram());
  saveLS(LS_WORKOUT_LOG_KEY, []);
  const { unmount: reload } = render(<WorkoutTab unit="lbs" />);
  fireEvent.click(screen.getByRole('button', { name: /Start Workout A/ }));
  reload();
  jest.setSystemTime(new Date(2026, 9, 1, 9));        // next morning
  const saved = jest.fn();
  render(<WorkoutTab unit="lbs" onSessionSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: 'Save Session' }));
  expect(saved.mock.calls[0][0].date).toBe('2026-09-30');
  expect(loadLS(LS_WORKOUT_DRAFT_KEY)).toBeNull();
});
