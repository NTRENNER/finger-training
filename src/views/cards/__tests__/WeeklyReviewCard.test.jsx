import React from 'react';
import { fireEvent, render, screen } from '@testing-library/react';
import { WeeklyReviewCard } from '../WeeklyReviewCard.jsx';
import { buildCheckIn } from '../../../model/weeklyReview.js';
import { deloadStatus } from '../../../model/deload.js';
import { LS_WORKOUT_LOG_KEY } from '../../../lib/storage.js';
import { C } from '../../../ui/theme.js';

let mockStored = {};

jest.mock('../../../hooks/useLSValue.js', () => ({
  useLSValue: key => mockStored[key] ?? null,
}));
jest.mock('../../../util.js', () => ({ today: () => '2026-10-27' }));
jest.mock('../../../model/weeklyReview.js', () => ({ buildCheckIn: jest.fn() }));
jest.mock('../../../model/deload.js', () => ({
  ...jest.requireActual('../../../model/deload.js'),
  deloadStatus: jest.fn(),
  buildDeloadGuidance: jest.fn(),
}));

const review = {
  range: { weekStart: '2026-10-26', weekEnd: '2026-10-27' },
  headline: 'Current summary',
  points: [],
  sections: { did: [], moving: [], stuck: [], focus: [], headsUp: [] },
};
const detailedReview = {
  range: { weekStart: '2026-10-26', weekEnd: '2026-10-27' },
  headline: "Strong week — you've got a win to bank.",
  points: [
    { kind: 'win', text: 'Colored win summary.' },
    { kind: 'concern', text: 'Colored recovery summary.' },
  ],
  sections: {
    did: ['Two climbing sessions.'],
    moving: ['Capacity moved up.'],
    stuck: [],
    focus: ['The engine will queue Micro.'],
    headsUp: ['Data looks clean.'],
  },
};

beforeEach(() => {
  mockStored = {};
  buildCheckIn.mockReturnValue(review);
  deloadStatus.mockReturnValue({ level: 'green', deload: { deload: false, severity: 'none' } });
});

test('frames the live card as analysis and refreshes after the workout log changes', () => {
  const history = [{ id: 'finger-1' }];
  const view = render(<WeeklyReviewCard history={history} activities={[]} />);

  expect(screen.getByText(/Current training analysis/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Details ▾' })).toBeInTheDocument();
  expect(buildCheckIn).toHaveBeenLastCalledWith(history, [], [], expect.objectContaining({ refDate: '2026-10-27' }));

  const completedWorkout = [{ id: 'strength-1', date: '2026-10-27' }];
  mockStored = { [LS_WORKOUT_LOG_KEY]: completedWorkout };
  view.rerender(<WeeklyReviewCard history={history} activities={[]} />);

  expect(buildCheckIn).toHaveBeenLastCalledWith(history, [], completedWorkout,
    expect.objectContaining({ refDate: '2026-10-27' }));
});

test('keeps the colored digest above the expanded analysis', () => {
  buildCheckIn.mockReturnValue(detailedReview);
  render(<WeeklyReviewCard />);

  const win = screen.getByText('Colored win summary.');
  const concern = screen.getByText('Colored recovery summary.');
  expect(win).toHaveStyle(`color: ${C.green}`);
  expect(concern).toHaveStyle(`color: ${C.orange}`);
  expect(screen.queryByText('Training completed')).not.toBeInTheDocument();

  fireEvent.click(screen.getByRole('button', { name: 'Details ▾' }));

  expect(screen.getByRole('button', { name: '− Summary' })).toHaveAttribute('aria-expanded', 'true');
  expect(win).toBeInTheDocument();
  expect(concern).toBeInTheDocument();
  expect(screen.getByText('Training completed')).toBeInTheDocument();
  expect(screen.getByText('Two climbing sessions.')).toBeInTheDocument();
  expect(screen.getByText('Recommendation inputs')).toBeInTheDocument();
});

test('collapsing hides only the expanded analysis', () => {
  buildCheckIn.mockReturnValue(detailedReview);
  render(<WeeklyReviewCard />);

  fireEvent.click(screen.getByRole('button', { name: 'Details ▾' }));
  fireEvent.click(screen.getByRole('button', { name: '− Summary' }));

  expect(screen.getByText('Colored win summary.')).toBeInTheDocument();
  expect(screen.queryByText('Training completed')).not.toBeInTheDocument();
});
