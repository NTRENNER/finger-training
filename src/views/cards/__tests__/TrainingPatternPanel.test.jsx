import React from 'react';
import { fireEvent, render, screen, within } from '@testing-library/react';
import { TrainingPatternPanel } from '../TrainingPatternPanel.jsx';
import { buildTrainingPattern } from '../../../lib/trainingPattern.js';

const date = '2026-11-18';
const rep = (id, grip = 'Micro') => ({ id, session_id: id, date, grip, hand: 'L', set_num: 1,
  rep_num: 1, actual_time_s: 30, avg_force_kg: 20, peak_force_kg: 25 });
const makePattern = () => buildTrainingPattern([rep('m1'), rep('m2'), rep('c', 'Crusher')],
  [{ id: 'climb', date, type: 'climbing' }], { start: '2026-11-16', end: '2026-11-22' });

test('shows separate days, blocks and reps; reveals the actual blocks and climbing context', () => {
  render(<TrainingPatternPanel pattern={makePattern()} unit="kg" />);
  expect(within(screen.getByRole('group', { name: 'Training days' })).getByText('1')).toBeInTheDocument();
  expect(within(screen.getByRole('group', { name: 'Identified blocks' })).getByText('3')).toBeInTheDocument();
  fireEvent.click(screen.getByText('See days and blocks'));
  const region = screen.getByRole('region', { name: 'Training pattern' });
  expect(within(region).getAllByRole('button')).toHaveLength(7);
  fireEvent.click(screen.getByRole('button', { name: `${date}: 3 identified blocks, climbing logged` }));
  expect(screen.getAllByText('Micro · Unspecified')).toHaveLength(2);
  expect(screen.getByText('Crusher · Unspecified')).toBeInTheDocument();
  expect(screen.getByText('Climbing logged · 1 entry')).toBeInTheDocument();
  expect(screen.getByText(/Their order is not established/)).toBeInTheDocument();
  expect(screen.getByText(/Measured load × time: 1,800 kg·s/)).toBeInTheDocument();
  fireEvent.click(screen.getByRole('button', { name: '2026-11-19: 0 identified blocks' }));
  expect(screen.getByText('No training logged on this date.')).toBeInTheDocument();
  expect(screen.queryByText(/rest day|overdue|recovered/i)).not.toBeInTheDocument();
});

test('selection survives refresh and unknown identities are not invented', () => {
  const view = render(<TrainingPatternPanel pattern={makePattern()} />);
  fireEvent.click(screen.getByText('See days and blocks'));
  fireEvent.click(screen.getByRole('button', { name: '2026-11-19: 0 identified blocks' }));
  const pattern = buildTrainingPattern([{ ...rep('legacy'), session_id: null, date: '2026-11-19' }], [],
    { start: '2026-11-16', end: '2026-11-22' });
  view.rerender(<TrainingPatternPanel pattern={pattern} />);
  expect(screen.getByRole('button', { name: /2026-11-19:/ })).toHaveAttribute('aria-pressed', 'true');
  expect(screen.getByText(/Block identity is missing for 1 rep/)).toBeInTheDocument();
  expect(screen.getByText('Micro · Block identity unknown')).toBeInTheDocument();
});
