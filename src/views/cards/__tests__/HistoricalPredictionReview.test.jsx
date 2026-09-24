import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { HistoricalPredictionReview } from '../HistoricalPredictionReview.jsx';
import { evaluateHistorical } from '../../../model/historicalEvaluation.js';
import { recoveryRows } from '../../../testHelpers/recoveryRows.js';
import { createHistoricalReviewWorker } from '../../../model/historicalWorkerClient.js';
jest.mock('../../../model/historicalWorkerClient.js', () => ({ createHistoricalReviewWorker: jest.fn() }));

test('review runs on demand, shows original records separately, and discards stale worker results', async () => {
  const w = { postMessage: jest.fn(), terminate: jest.fn() };
  createHistoricalReviewWorker.mockReturnValue(w);
  const rows = recoveryRows('measured');
  const { rerender, unmount } = render(<HistoricalPredictionReview history={rows} unit="lbs" />);
  expect(w.postMessage).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'Review earlier workouts' }));
  await waitFor(() => expect(w.postMessage).toHaveBeenCalledWith(rows));
  expect(screen.getByRole('status')).toHaveTextContent('You can keep using the app');
  act(() => w.onmessage({ data: { report: evaluateHistorical(rows) } }));
  expect(screen.getByText('Recorded targets and results')).toBeInTheDocument();
  expect(screen.getByText(/1 opening holds on 1 days/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Download historical review' })).toBeInTheDocument();
  const changed = [...rows, { ...rows[0], id: 'next', date: '2026-09-21' }];
  rerender(<HistoricalPredictionReview history={changed} unit="lbs" />);
  act(() => w.onmessage({ data: { report: evaluateHistorical(rows) } }));
  expect(screen.queryByText('Recorded targets and results')).not.toBeInTheDocument();
  expect(screen.getByRole('button', { name: 'Review earlier workouts' })).toBeInTheDocument();
  unmount();
  expect(w.terminate).toHaveBeenCalled();
});

test('worker failure exposes a retry instead of a fabricated zero-error score', async () => {
  const w = { postMessage: jest.fn(), terminate: jest.fn() };
  createHistoricalReviewWorker.mockReturnValue(w);
  render(<HistoricalPredictionReview history={recoveryRows('measured')} unit="kg" />);
  fireEvent.click(screen.getByRole('button', { name: 'Review earlier workouts' }));
  await waitFor(() => expect(w.postMessage).toHaveBeenCalled());
  act(() => w.onerror());
  expect(screen.getByRole('alert')).toHaveTextContent('Please try again');
  expect(screen.getByRole('button', { name: 'Review earlier workouts' })).toBeEnabled();
});
