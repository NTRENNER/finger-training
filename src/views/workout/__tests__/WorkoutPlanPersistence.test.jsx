import React from 'react';
import { render, screen, fireEvent, within } from '@testing-library/react';
import { WorkoutTab } from '../../WorkoutTab.jsx';
import { saveLS, loadLS, LS_WORKOUT_LOG_KEY } from '../../../lib/storage.js';

jest.mock('../../../lib/sync.js', () => ({ pushWorkoutSession: jest.fn(() => Promise.resolve()) }));
jest.mock('../../BodyWeightEntry.jsx', () => ({ BwPrompt: () => null }));
jest.mock('../StretchPill.jsx', () => ({ StretchPill: () => null }));
jest.mock('../RecommendationCard.jsx', () => ({ RecommendationCard: () => null }));
jest.mock('../SessionExRow.jsx', () => ({ SessionExRow: ({ ex, setsData, onSetsChange }) => <div data-testid={ex.id}>
  <span>{setsData.sets.length} sets</span>
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
  render(<WorkoutTab unit="lbs" onSessionSaved={saved} />);
  fireEvent.click(screen.getByRole('button', { name: /Start Workout A/ }));
  const row = within(screen.getByTestId('weightedPullup'));
  expect(row.getByText('2 sets')).toBeInTheDocument();
  fireEvent.click(row.getByRole('button', { name: 'Complete one' }));
  fireEvent.click(screen.getByRole('button', { name: 'At my limit' }));
  fireEvent.click(row.getByRole('button', { name: 'Remove sets' }));
  fireEvent.click(screen.getByRole('button', { name: 'Save Session' }));
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
