import React from 'react';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { ResearchView } from '../ResearchView.jsx';
import { createHistoricalReviewWorker } from '../../model/historicalWorkerClient.js';
import { evaluateHistorical } from '../../model/historicalEvaluation.js';
import { recoveryRows } from '../../testHelpers/recoveryRows.js';
import { buildPerformanceTrendAnalysis } from '../../model/performanceTrendEvidence.js';
import { suggestCookedFromClimbs } from '../../model/climbingFatigue.js';
jest.mock('../../model/historicalWorkerClient.js', () => ({ createHistoricalReviewWorker: jest.fn() }));
jest.mock('../../model/performanceTrendEvidence.js', () => ({
  ...jest.requireActual('../../model/performanceTrendEvidence.js'),
  buildPerformanceTrendAnalysis: jest.fn(),
}));
jest.mock('recharts', () => {
  const React = require('react');
  const Wrap = ({ children }) => <div>{children}</div>;
  return { ResponsiveContainer: Wrap,
    ComposedChart: ({ data }) => <div data-testid="research-chart-data">{JSON.stringify(data)}</div>,
    Line: () => null, Scatter: () => null, Bar: () => null, XAxis: () => null, YAxis: () => null,
    Tooltip: () => null, CartesianGrid: () => null, ReferenceLine: () => null };
});

test('Research passes climbing records through the review into both charts and refreshes the overlay', async () => {
  const date = '2026-08-20';
  buildPerformanceTrendAnalysis.mockReturnValue({
    rows: [{ date, timestamp: Date.parse(date), Crusher_long: 2, Crusher_short: -1 }],
    observations: [{
      id: 'crusher-opening-hold', date, timestamp: Date.parse(date), grip: 'Crusher', hand: 'L',
      duration: 30, durationBand: 'short', force: 10, expectedForce: 12.5, deviation: -20,
      context: 'unknown', earlierGrips: [],
    }],
  });
  const history = recoveryRows('measured');
  const activities = [{ type: 'climbing', date, rpe: 9 }];
  const worker = { postMessage: jest.fn(), terminate: jest.fn() };
  createHistoricalReviewWorker.mockReturnValue(worker);
  const props = { history, unit: 'lbs', signedIn: true, historySynced: true };
  const view = render(<ResearchView {...props} activities={activities} />);
  fireEvent.click(screen.getByRole('button', { name: 'Review earlier workouts' }));
  await waitFor(() => expect(worker.postMessage).toHaveBeenCalledWith(history));
  const score = { trainingDays: 1, observations: 1, mae: 2, rmse: 2, bias: -2 };
  const report = { ...evaluateHistorical(history), contextualTrends: {
    all: { original: score, contextOnly: score, contextRobust: score }, byGrip: {}, byContext: {},
  } };
  act(() => worker.onmessage({ data: { report } }));
  fireEvent.click(screen.getByRole('checkbox', { name: 'Compare trend charts', hidden: true }));
  const values = () => screen.getAllByTestId('research-chart-data').map(el => JSON.parse(el.textContent)[0].climbLoad);
  const expected = suggestCookedFromClimbs(activities, date).cooked;
  expect(expected).toBeGreaterThan(0);
  expect(values()).toEqual([expected, expected]);
  expect(screen.getByText('22.0 lbs')).toBeInTheDocument();
  expect(screen.getByText('27.6 lbs')).toBeInTheDocument();
  fireEvent.change(screen.getByLabelText('Research trend model'), { target: { value: 'original' } });
  expect(values()).toEqual([expected, expected]);
  view.rerender(<ResearchView {...props} activities={[]} />);
  expect(values()).toEqual([null, null]);
  expect(worker.postMessage).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('button', { name: 'Download historical review' })).toBeInTheDocument();
});
