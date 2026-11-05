import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WorkoutTab } from '../../WorkoutTab.jsx';
import { saveLS, loadLS, LS_WORKOUT_LOG_KEY, LS_WORKOUT_PLAN_KEY } from '../../../lib/storage.js';

jest.mock('../../../lib/sync.js', () => ({ pushWorkoutSession: jest.fn(() => Promise.resolve()), enqueueUserSettingsPatch:jest.fn(), flushUserSettingsPatch:() => Promise.resolve() }));
jest.mock('../../BodyWeightEntry.jsx', () => ({ BwPrompt: () => null }));
jest.mock('../StretchPill.jsx', () => ({ StretchPill: () => null }));
jest.mock('../RecommendationCard.jsx', () => ({ RecommendationCard: () => null }));
jest.mock('../SessionExRow.jsx', () => ({ SessionExRow: ({ ex, setsData, onSetsChange }) => <div data-testid={ex.id}>
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
